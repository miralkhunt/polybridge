const express = require('express');
const cors = require('cors');

const dotenv = require('dotenv');
dotenv.config();

const app = express();

app.use(cors());
const EVENT_CACHE_TTL_MS = 60 * 1000;
const eventCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wrapper around fetch with a configurable timeout
const fetchWithTimeout = (url, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { method: 'GET', signal: controller.signal })
    .finally(() => clearTimeout(timer));
};

const isRetryableStatus = (status) =>
  status === 408 || status === 429 || (status >= 500 && status <= 599);

const isRetryableError = (err) =>
  err?.name === 'AbortError' ||
  err?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
  err?.code === 'ECONNRESET' ||
  err?.code === 'ETIMEDOUT' ||
  /fetch failed/i.test(err?.message || '');

const fetchWithRetry = async (url, { retries = 2, timeoutMs = 12000 } = {}) => {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, timeoutMs);
      if (response.ok || !isRetryableStatus(response.status) || attempt === retries) {
        return response;
      }
    } catch (err) {
      if (!isRetryableError(err) || attempt === retries) {
        throw err;
      }
    }
    // Exponential backoff: 250ms, 500ms, 1000ms
    await sleep(250 * (2 ** attempt));
  }
  throw new Error('Unable to fetch data');
};

const getCachedEvent = (id) => {
  const cached = eventCache.get(id);
  if (!cached) return null;
  if (Date.now() - cached.ts > EVENT_CACHE_TTL_MS) {
    eventCache.delete(id);
    return null;
  }
  return cached.data;
};

const setCachedEvent = (id, data) => {
  eventCache.set(id, { data, ts: Date.now() });
};

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

app.get("/health", (req, res) => {
  res.send('OK');
});

app.get('/events', async (req, res) => {
  try {
    const data = await fetchWithRetry(`${process.env.GAMMA_API_URL}/events`);
    if (!data.ok) {
      return res.status(data.status).json({ error: "Failed to fetch events" });
    }
    const json = await data.json();
    // Gamma events use `tags` not `category` — filter by sports tag
    const sportsData = json.filter(event =>
      event.tags?.some(t => t.slug === 'sports') ||
      event.category?.toLowerCase() === 'sports'
    );
    return res.json(sportsData);
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return res.status(504).json({
      error: timedOut ? "Request to Gamma API timed out" : "Failed to fetch events",
      message: err.message,
    });
  }
});

app.get("/events/search", async (req, res) => {
  const userQuery = req.query.q?.trim();

  if (!userQuery) {
    return res.status(400).json({ error: "Query parameter 'q' is required" });
  }

  try {
    // req.query.q is already URL-decoded by Express — re-encode for Gamma API
    const url = `${process.env.GAMMA_API_URL}/public-search?q=${encodeURIComponent(userQuery)}&optimized=true`;
    const data = await fetchWithRetry(url);
    if (!data.ok) {
      return res.status(data.status).json({ error: "Search request failed", status: data.status });
    }
    const json = await data.json();
    return res.json(json);
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return res.status(timedOut ? 504 : 500).json({
      error: timedOut ? "Request to Gamma API timed out" : "Search failed",
      message: err.message,
    });
  }
});

app.get("/events/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const cached = getCachedEvent(id);
    if (cached) {
      return res.json(cached);
    }

    const data = await fetchWithRetry(`${process.env.GAMMA_API_URL}/events/${id}`, {
      retries: 1,
      timeoutMs: 9000,
    });
    if (!data.ok) {
      return res.status(data.status).json({ error: "Event not found" });
    }
    const json = await data.json();
    setCachedEvent(id, json);
    return res.json(json);
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return res.status(timedOut ? 504 : 500).json({
      error: timedOut ? "Request to Gamma API timed out" : "Failed to fetch event",
      message: err.message,
    });
  }
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
