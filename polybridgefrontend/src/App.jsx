import { useState, useEffect, useCallback, useMemo, useRef } from "react";

// ─── helpers ────────────────────────────────────────────────────────────────

// Gamma API returns outcomes/prices as either a JSON array string '["A","B"]'
// or a plain CSV string 'A,B' — handle both safely
const parseList = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  const str = String(val).trim();
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // fallback: split by comma
    return str.split(",").map((s) => s.trim()).filter(Boolean);
  }
};

const fmt = (n) => {
  if (n == null) return "—";
  const num = parseFloat(n);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
};

const pct = (price) => Math.round(parseFloat(price || 0) * 100);
const normalizeWsPrice = (value) => {
  const num = parseFloat(value);
  if (Number.isNaN(num)) return null;
  const normalized = num > 1 && num <= 100 ? num / 100 : num;
  if (normalized < 0 || normalized > 1) return null;
  return Number(normalized.toFixed(4));
};

const extractWsPriceUpdates = (payload) => {
  const updates = [];
  const seen = new Set();

  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;

    const assetId =
      node.asset_id ??
      node.assetId ??
      node.token_id ??
      node.tokenId ??
      node.asset;

    const tradeLikePrice =
      node.price ?? node.last_trade_price ?? node.lastTradePrice;
    const bestBid = normalizeWsPrice(node.best_bid ?? node.bestBid);
    const bestAsk = normalizeWsPrice(node.best_ask ?? node.bestAsk);
    const parsedPrice = normalizeWsPrice(tradeLikePrice);
    const effectivePrice = parsedPrice ?? bestBid ?? bestAsk;

    if (assetId != null && effectivePrice != null) {
      const key = `${assetId}:${effectivePrice}:${bestBid ?? ""}:${bestAsk ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        updates.push({
          assetId: String(assetId),
          price: effectivePrice,
          bestBid,
          bestAsk,
          lastTradePrice: parsedPrice,
        });
      }
    }

    Object.values(node).forEach((v) => {
      if (v && typeof v === "object") walk(v);
    });
  };

  walk(payload);
  return updates;
};
const EVENT_DETAIL_CACHE_TTL_MS = 60 * 1000;
const eventDetailCache = new Map();

const getCachedEventDetail = (id) => {
  const cached = eventDetailCache.get(id);
  if (!cached) return null;
  if (Date.now() - cached.ts > EVENT_DETAIL_CACHE_TTL_MS) {
    eventDetailCache.delete(id);
    return null;
  }
  return cached.data;
};

const setCachedEventDetail = (id, data) => {
  eventDetailCache.set(id, { data, ts: Date.now() });
};

// ─── EventDetailModal ────────────────────────────────────────────────────────
function EventDetailModal({ eventId, seedEvent, liveEvent, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;

    const load = async () => {
      const cached = getCachedEventDetail(eventId);
      if (cached) {
        setDetail(cached);
        setError(null);
        setLoading(false);
        return;
      }

      // Show the card payload instantly for perceived performance while full data loads
      if (seedEvent) {
        setDetail(seedEvent);
      } else {
        setDetail(null);
      }

      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`http://localhost:3000/events/${eventId}`);
        if (!r.ok) throw new Error("Failed to load event");
        const json = await r.json();
        if (!cancelled) {
          setDetail(json);
          setCachedEventDetail(eventId, json);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [eventId, seedEvent]);

  // close on backdrop click
  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  // close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Use liveEvent as primary source if available, fallback to detail
  const effectiveDetail = liveEvent || detail;
  
  const mergedMarkets = useMemo(() => {
    if (!effectiveDetail?.markets?.length) return [];
    return effectiveDetail.markets.map((market) => {
      const outcomes = parseList(market.outcomes);
      const tokens = parseList(market.clobTokenIds);
      const prices = parseList(market.outcomePrices);
      
      // Debug: Log token-to-outcome mapping for verification
      if (market.question?.includes('India') || market.question?.includes('South Africa')) {
        console.log(`[WS Debug] Market: ${market.question}`);
        console.log(`[WS Debug] Outcomes:`, outcomes);
        console.log(`[WS Debug] Token IDs:`, tokens);
        console.log(`[WS Debug] Prices:`, prices);
        outcomes.forEach((outcome, idx) => {
          console.log(`[WS Debug]   ${outcome} (index ${idx}) -> Token: ${tokens[idx] || 'N/A'} -> Price: ${prices[idx] || 'N/A'}`);
        });
      }
      
      return market;
    });
  }, [effectiveDetail]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm overflow-y-auto py-8 px-4"
      onClick={handleBackdrop}
    >
      <div className="relative bg-[#12161c] border border-gray-700 rounded-2xl w-full max-w-3xl shadow-2xl">
        {/* close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors z-10"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* loading */}
        {loading && !effectiveDetail && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <svg className="animate-spin h-10 w-10 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-gray-400 text-sm">Loading event details…</p>
          </div>
        )}

        {/* error */}
        {error && (
          <div className="p-8 text-center">
            <p className="text-red-400 font-medium">{error}</p>
            <button onClick={onClose} className="mt-4 text-sm text-gray-400 hover:text-white">Close</button>
          </div>
        )}

        {/* content */}
        {effectiveDetail && (
          <>
            {/* hero */}
            <div className="flex gap-4 p-6 border-b border-gray-800">
              <img
                src={effectiveDetail.image || effectiveDetail.icon || `https://ui-avatars.com/api/?name=${encodeURIComponent(effectiveDetail.title)}&background=1e2329&color=fff`}
                alt={effectiveDetail.title}
                className="w-16 h-16 rounded-xl object-cover bg-gray-800 shrink-0"
                onError={(e) => { e.target.onerror = null; e.target.src = `https://ui-avatars.com/api/?name=E&background=1e2329&color=fff`; }}
              />
              <div className="flex-1 min-w-0">
                <h2 className="text-xl font-bold text-white leading-snug mb-1">{effectiveDetail.title}</h2>
                <div className="flex flex-wrap gap-2 text-xs text-gray-400">
                  {effectiveDetail.tags?.map((t) => (
                    <span key={t.id} className="bg-gray-800 px-2 py-0.5 rounded-full">{t.label}</span>
                  ))}
                </div>
              </div>
            </div>
            {loading && (
              <div className="px-6 py-2 text-xs text-blue-300 border-b border-gray-800 bg-blue-900/10">
                Refreshing full event details...
              </div>
            )}

            {/* stats row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-gray-800 border-b border-gray-800">
              {[
                { label: "Total Volume", value: fmt(effectiveDetail.volume) },
                { label: "Liquidity", value: fmt(effectiveDetail.liquidity) },
                { label: "24h Volume", value: fmt(effectiveDetail.volume24hr) },
                { label: "Status", value: effectiveDetail.closed ? "Closed" : effectiveDetail.active ? "Active" : "Inactive" },
              ].map(({ label, value }) => (
                <div key={label} className="bg-[#12161c] px-4 py-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">{label}</p>
                  <p className="text-base font-bold text-white">{value}</p>
                </div>
              ))}
            </div>

            {/* markets */}
            <div className="p-6">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Markets ({mergedMarkets.length})
              </h3>
              <div className="flex flex-col gap-4">
                {mergedMarkets.map((market) => {
                  const outcomes = parseList(market.outcomes);
                  const prices = parseList(market.outcomePrices);

                  return (
                    <div key={market.id} className="bg-[#1e2329] rounded-xl border border-gray-800 p-4">
                      <div className="flex justify-between items-start gap-2 mb-4">
                        <p className="text-sm font-semibold text-gray-100 leading-snug">{market.question}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 font-medium ${
                          market.closed
                            ? "bg-gray-700 text-gray-400"
                            : market.active
                            ? "bg-green-900/50 text-green-400"
                            : "bg-yellow-900/50 text-yellow-400"
                        }`}>
                          {market.closed ? "Closed" : market.active ? "Active" : "Pending"}
                        </span>
                      </div>

                      {/* outcome buttons */}
                      <div className="flex gap-2 flex-wrap mb-4">
                        {outcomes.map((outcome, i) => {
                          const p = pct(prices[i]);
                          const isFirst = i === 0;
                          return (
                            <button
                              key={outcome}
                              className={`flex-1 min-w-[80px] flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                                isFirst
                                  ? "bg-[#1a3a29] hover:bg-[#1f4532] text-[#4ade80] border-[#2a523a]"
                                  : "bg-[#3a1a1a] hover:bg-[#451f1f] text-[#f87171] border-[#522a2a]"
                              }`}
                            >
                              <span>{outcome}</span>
                              <span className="ml-2 opacity-80">{p}¢</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* market stats */}
                      <div className="flex items-center gap-4 text-xs text-gray-500 pt-3 border-t border-gray-800">
                        <span>Vol: <span className="text-gray-300">{fmt(market.volumeNum)}</span></span>
                        <span>Liq: <span className="text-gray-300">{fmt(market.liquidityNum)}</span></span>
                        {market.lastTradePrice != null && (
                          <span>Last: <span className="text-gray-300">{pct(market.lastTradePrice)}¢</span></span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* description */}
            {effectiveDetail.description && (
              <div className="px-6 pb-6">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">About</h3>
                <p className="text-sm text-gray-400 leading-relaxed whitespace-pre-line line-clamp-6">
                  {effectiveDetail.description}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────
function App() {
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [wsStatus, setWsStatus] = useState("offline");
  const tokenMapRef = useRef(new Map());
  const tokenIdsRef = useRef([]);

  useEffect(() => { fetchEvents(); }, []);

  const fetchEvents = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("http://localhost:3000/events");
      if (!response.ok) throw new Error("Failed to fetch events");
      const data = await response.json();
      setEvents(data || []);
      setHasSearched(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return fetchEvents();

    setLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const response = await fetch(`http://localhost:3000/events/search?q=${encodeURIComponent(trimmedQuery)}`);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || errData.message || "Failed to search events");
      }
      const data = await response.json();

      let found = [];
      if (Array.isArray(data)) found = data;
      else if (data && Array.isArray(data.markets)) found = data.markets;
      else if (data && Array.isArray(data.events)) found = data.events;
      else if (data && Array.isArray(data.results)) found = data.results;
      else if (data && Array.isArray(data.data)) found = data.data;

      // Search results might not have full market data with clobTokenIds
      // Fetch full details for events that are missing token IDs
      const eventsNeedingDetails = found.filter(event => {
        if (!event.markets?.length) return false;
        return event.markets.some(m => !m.clobTokenIds);
      });

      if (eventsNeedingDetails.length > 0) {
        // Fetch full event details in parallel
        const detailPromises = eventsNeedingDetails.map(async (event) => {
          try {
            const detailRes = await fetch(`http://localhost:3000/events/${event.id}`);
            if (detailRes.ok) {
              const detail = await detailRes.json();
              // Merge full detail data into the event
              return { ...event, ...detail, markets: detail.markets || event.markets };
            }
          } catch (e) {
            console.warn(`Failed to fetch details for event ${event.id}:`, e);
          }
          return event;
        });

        const enrichedEvents = await Promise.all(detailPromises);
        // Replace events that were enriched
        const enrichedMap = new Map(enrichedEvents.map(e => [String(e.id), e]));
        found = found.map(e => enrichedMap.get(String(e.id)) || e);
      }

      setEvents(found);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const closeModal = useCallback(() => setSelectedEvent(null), []);

  const { tokenIds, tokenMap } = useMemo(() => {
    const ids = [];
    const idSet = new Set();
    const lookup = new Map();
    const pushToken = (id, mapping) => {
      if (!id) return;
      if (!lookup.has(id)) lookup.set(id, []);
      lookup.get(id).push(mapping);
      if (!idSet.has(id)) {
        idSet.add(id);
        ids.push(id);
      }
    };

    const preferredEvent =
      events.find((e) => String(e.id) === String(selectedEvent?.id)) || selectedEvent;

    // Always prioritize selected event subscriptions so its card/modal updates first.
    if (preferredEvent?.markets?.length) {
      preferredEvent.markets.forEach((market) => {
        const tokens = parseList(market.clobTokenIds);
        const outcomes = parseList(market.outcomes);
        
        // Debug: Log token-to-outcome mapping for selected event
        if (market.question?.includes('India') || market.question?.includes('South Africa')) {
          console.log(`[WS Subscribe] Selected Market: ${market.question}`);
          console.log(`[WS Subscribe] Outcomes:`, outcomes);
          console.log(`[WS Subscribe] Token IDs:`, tokens);
          outcomes.forEach((outcome, idx) => {
            console.log(`[WS Subscribe]   ${outcome} (index ${idx}) -> Token: ${tokens[idx] || 'MISSING'}`);
          });
        }
        
        tokens.forEach((tokenId, outcomeIndex) => {
          const id = String(tokenId || "").trim();
          if (!id) return;
          pushToken(id, {
            eventId: String(preferredEvent.id),
            marketId: String(market.id),
            outcomeIndex,
          });
        });
      });
    }

    events.forEach((event) => {
      (event.markets || []).forEach((market) => {
        const tokens = parseList(market.clobTokenIds);
        tokens.forEach((tokenId, outcomeIndex) => {
          const id = String(tokenId || "").trim();
          if (!id) return;
          pushToken(id, {
            eventId: String(event.id),
            marketId: String(market.id),
            outcomeIndex,
          });
        });
      });
    });

    // Avoid oversized subscribe payloads
    const cappedIds = ids.slice(0, 300);
    const cappedLookup = new Map(
      cappedIds.map((id) => [id, lookup.get(id) || []])
    );

    return { tokenIds: cappedIds, tokenMap: cappedLookup };
  }, [events, selectedEvent]);

  const tokenIdsKey = useMemo(() => tokenIds.join(","), [tokenIds]);

  useEffect(() => {
    tokenMapRef.current = tokenMap;
  }, [tokenMap, tokenIdsKey]);

  useEffect(() => {
    tokenIdsRef.current = tokenIds;
  }, [tokenIds, tokenIdsKey]);

  const eventsLengthRef = useRef(events.length);
  useEffect(() => {
    eventsLengthRef.current = events.length;
  }, [events.length]);

  useEffect(() => {
    // Don't disconnect if we temporarily have no tokens (e.g., during search)
    // Only set offline if we explicitly have no events at all
    if (!tokenIdsKey) {
      // If we have events but no tokens, it means they're missing clobTokenIds
      // Keep status as-is (don't force offline) to avoid flickering during search
      // Only go offline if we truly have no events
      if (eventsLengthRef.current === 0) {
        setWsStatus("offline");
      }
      return;
    }

    let ws;
    let reconnectTimer;
    let stopped = false;
    let reconnectDelay = 1000;

    const connect = () => {
      if (stopped) return;
      setWsStatus((prev) => (prev === "live" ? "reconnecting" : "connecting"));
      ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");

      ws.onopen = () => {
        if (stopped) return;
        setWsStatus("live");
        reconnectDelay = 1000;
        
        const subscribePayload = {
          type: "subscribe",
          channel: "market",
          assets_ids: tokenIdsRef.current,
        };
        
        console.log(`[WS] ✅ Connected to WebSocket`);
        console.log(`[WS] Subscribing to ${tokenIdsRef.current.length} token IDs`);
        console.log(`[WS] First 5 token IDs:`, tokenIdsRef.current.slice(0, 5));
        
        // Log token mappings for debugging
        const allMappings = Array.from(tokenMapRef.current.entries());
        if (allMappings.length > 0) {
          console.log(`[WS] Found ${allMappings.length} token mappings`);
          allMappings.slice(0, 3).forEach(([tokenId, mappings]) => {
            console.log(`[WS]   Token ${tokenId.substring(0, 20)}... maps to ${mappings.length} target(s):`, mappings.slice(0, 2));
          });
        }
        
        console.log(`[WS] Subscribe payload:`, JSON.stringify({
          ...subscribePayload,
          assets_ids: subscribePayload.assets_ids.slice(0, 3).map(id => id.substring(0, 20) + '...')
        }));
        
        ws.send(JSON.stringify(subscribePayload));
      };

      ws.onmessage = (evt) => {
        let payload;
        try {
          payload = JSON.parse(evt.data);
        } catch {
          console.log(`[WS] Failed to parse message:`, evt.data);
          return;
        }

        // Log raw messages for debugging
        if (Array.isArray(payload) && payload.length > 0) {
          console.log(`[WS] Received message with ${payload.length} items`);
        } else if (typeof payload === 'object') {
          console.log(`[WS] Received message:`, Object.keys(payload));
        }

        const updates = extractWsPriceUpdates(payload);
        if (!updates.length) {
          console.log(`[WS] No price updates extracted from message`);
          return;
        }
        
        console.log(`[WS] Extracted ${updates.length} price updates:`, updates.map(u => ({ assetId: u.assetId, price: u.price })));

        setEvents((prev) => {
          const eventIndexById = new Map(
            prev.map((event, index) => [String(event.id), index])
          );

          let next = prev;
          const clonedEvents = new Set();
          const clonedMarkets = new Set();
          let changed = false;

          const ensureEventCloned = (eventIndex) => {
            if (next === prev) next = [...prev];
            if (!clonedEvents.has(eventIndex)) {
              next[eventIndex] = {
                ...next[eventIndex],
                markets: [...(next[eventIndex].markets || [])],
              };
              clonedEvents.add(eventIndex);
            }
          };

          updates.forEach((update) => {
            const assetIdStr = String(update.assetId);
            const targets = tokenMapRef.current.get(assetIdStr) || [];
            
            if (targets.length === 0) {
              console.log(`[WS] WARNING: No mapping found for token ${assetIdStr}`);
              console.log(`[WS] Available tokens in map:`, Array.from(tokenMapRef.current.keys()).slice(0, 10));
              return;
            }
            
            console.log(`[WS] Token ${assetIdStr} maps to ${targets.length} target(s)`);
            
            targets.forEach(({ eventId, marketId, outcomeIndex }) => {
              const eventIndex = eventIndexById.get(String(eventId));
              if (eventIndex == null) return;
              ensureEventCloned(eventIndex);

              const event = next[eventIndex];
              const marketIndex = event.markets.findIndex(
                (m) => String(m.id) === String(marketId)
              );
              if (marketIndex < 0) return;

              const marketCloneKey = `${eventIndex}:${marketIndex}`;
              if (!clonedMarkets.has(marketCloneKey)) {
                event.markets[marketIndex] = { ...event.markets[marketIndex] };
                clonedMarkets.add(marketCloneKey);
              }

              const market = event.markets[marketIndex];
              const outcomes = parseList(market.outcomes);
              const prices = parseList(market.outcomePrices);
              const tokens = parseList(market.clobTokenIds);
              const nextPrice = String(update.price);
              const outcomeName = outcomes[outcomeIndex] || `Outcome ${outcomeIndex}`;

              // Debug logging for India/South Africa markets
              if (market.question?.includes('India') || market.question?.includes('South Africa')) {
                console.log(`[WS Update] Token ${update.assetId} -> ${outcomeName} (index ${outcomeIndex})`);
                console.log(`[WS Update]   Old price: ${prices[outcomeIndex]}, New price: ${nextPrice}`);
                console.log(`[WS Update]   Expected token at index ${outcomeIndex}: ${tokens[outcomeIndex]}`);
              }

              if (prices[outcomeIndex] !== nextPrice) {
                prices[outcomeIndex] = nextPrice;
                market.outcomePrices = prices;
                changed = true;
              }
              if (update.lastTradePrice != null) {
                market.lastTradePrice = String(update.lastTradePrice);
                changed = true;
              }
              if (update.bestBid != null) {
                market.bestBid = String(update.bestBid);
                changed = true;
              }
              if (update.bestAsk != null) {
                market.bestAsk = String(update.bestAsk);
                changed = true;
              }
            });
          });

          return changed ? next : prev;
        });
      };

      ws.onclose = (event) => {
        if (stopped) return;
        console.log(`[WS] ❌ Connection closed: code=${event.code}, reason=${event.reason || 'none'}, wasClean=${event.wasClean}`);
        setWsStatus("reconnecting");
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      };

      ws.onerror = (error) => {
        console.log(`[WS] ⚠️ WebSocket error:`, error);
        // onclose handles reconnection
      };
    };

    connect();

    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // noop
      }
    };
  }, [tokenIdsKey]);

  const activeSelectedEvent = useMemo(() => {
    if (!selectedEvent?.id) return null;
    return events.find((e) => String(e.id) === String(selectedEvent.id)) || selectedEvent;
  }, [events, selectedEvent]);

  const renderEventCard = (event, index) => {
    const title = event.title || event.name || event.headline || "Untitled Event";
    const imageUrl =
      event.image || event.icon || event.logo ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(title)}&background=1e2329&color=fff`;

    // Pick the primary market (first active non-toss/non-completed one)
    const primaryMarket = event.markets?.find(
      (m) => m.active && !m.closed && m.sportsMarketType === "moneyline"
    ) || event.markets?.[0];

    const outcomes = parseList(primaryMarket?.outcomes);
    const prices = parseList(primaryMarket?.outcomePrices);
    const volDisplay = fmt(event.volume);

    return (
      <div
        key={event.id || index}
        className="bg-[#1e2329] rounded-xl overflow-hidden border border-gray-800 hover:border-gray-600 transition-colors duration-200 flex flex-col p-4 cursor-pointer"
        onClick={() => setSelectedEvent(event)}
      >
        {/* top row: image + title + chance */}
        <div className="flex justify-between items-start mb-4">
          <div className="flex gap-3 min-w-0">
            <div className="w-10 h-10 rounded-md overflow-hidden bg-gray-800 shrink-0">
              <img
                src={imageUrl}
                alt={title}
                className="w-full h-full object-cover"
                onError={(e) => { e.target.onerror = null; e.target.src = "https://ui-avatars.com/api/?name=E&background=333&color=fff"; }}
              />
            </div>
            <h3 className="text-[14px] font-semibold text-gray-100 leading-snug line-clamp-2 pr-1">{title}</h3>
          </div>

          {prices[0] != null && (
            <div className="flex flex-col items-center justify-center shrink-0 pl-2 border-l border-gray-700/50">
              <div className="relative flex items-center justify-center w-10 h-10">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                  <path className="text-gray-800" strokeWidth="3" stroke="currentColor" fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                  <path className="text-green-500" strokeDasharray={`${pct(prices[0])}, 100`}
                    strokeWidth="3" stroke="currentColor" fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                </svg>
                <div className="absolute">
                  <span className="text-[10px] font-bold text-white">{pct(prices[0])}%</span>
                </div>
              </div>
              <span className="text-[9px] text-gray-400 mt-0.5">chance</span>
            </div>
          )}
        </div>

        {/* outcome buttons */}
        <div className="mt-auto">
          {outcomes.length > 0 ? (
            <div className="flex gap-2 mb-4">
              {outcomes.slice(0, 2).map((outcome, i) => (
                <button
                  key={outcome}
                  onClick={(e) => e.stopPropagation()}
                  className={`flex-1 flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium border transition-colors ${
                    i === 0
                      ? "bg-[#1a3a29] hover:bg-[#1f4532] text-[#4ade80] border-[#2a523a]"
                      : "bg-[#3a1a1a] hover:bg-[#451f1f] text-[#f87171] border-[#522a2a]"
                  }`}
                >
                  <span className="truncate">{outcome}</span>
                  {prices[i] != null && (
                    <span className="ml-1 opacity-70 shrink-0">{pct(prices[i])}¢</span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex gap-2 mb-4">
              <button onClick={(e) => e.stopPropagation()} className="flex-1 bg-[#1a3a29] hover:bg-[#1f4532] text-[#4ade80] border border-[#2a523a] font-medium py-2 rounded-md text-sm transition-colors">Yes</button>
              <button onClick={(e) => e.stopPropagation()} className="flex-1 bg-[#3a1a1a] hover:bg-[#451f1f] text-[#f87171] border border-[#522a2a] font-medium py-2 rounded-md text-sm transition-colors">No</button>
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t border-gray-800">
            <span>{volDisplay} Vol.</span>
            <div className="flex gap-3">
              <button onClick={(e) => e.stopPropagation()} className="hover:text-gray-300 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
                </svg>
              </button>
              <button onClick={(e) => e.stopPropagation()} className="hover:text-gray-300 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#0b0e14] text-white font-sans">
      {/* Modal */}
      {selectedEvent?.id && (
        <EventDetailModal
          eventId={selectedEvent.id}
          seedEvent={selectedEvent}
          liveEvent={activeSelectedEvent}
          onClose={closeModal}
        />
      )}

      {/* Header */}
      <header className="bg-[#12161c] border-b border-gray-800 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-center">
              <div className="shrink-0 bg-blue-600 rounded-lg p-2">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </div>
              <h1 className="ml-3 text-2xl font-extrabold tracking-tight">
                PolyBridge <span className="text-blue-500">Events</span>
              </h1>
              <span className={`ml-3 text-[11px] px-2 py-1 rounded-full border ${
                wsStatus === "live"
                  ? "text-green-300 border-green-700 bg-green-900/30"
                  : wsStatus === "connecting" || wsStatus === "reconnecting"
                  ? "text-yellow-200 border-yellow-700 bg-yellow-900/30"
                  : "text-gray-300 border-gray-700 bg-gray-900/30"
              }`}>
                WS: {wsStatus}
              </span>
            </div>

            <form onSubmit={handleSearch} className="relative max-w-lg w-full">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                className="block w-full pl-10 pr-24 py-2.5 border border-gray-700 rounded-lg leading-5 bg-[#1a1e24] text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 sm:text-sm transition-all"
                placeholder="Search markets..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                type="submit"
                disabled={loading}
                className="absolute inset-y-1.5 right-1.5 flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : "Search"}
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6 flex justify-between items-end">
          <div>
            <h2 className="text-xl font-bold">
              {hasSearched
                ? <span>Results for <span className="text-blue-500">"{query}"</span></span>
                : "Trending Markets"}
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              {events.length} {events.length === 1 ? "market" : "markets"} available
            </p>
          </div>
          {hasSearched && (
            <button onClick={() => { setQuery(""); fetchEvents(); }} className="text-sm text-gray-400 hover:text-white transition-colors">
              Clear search
            </button>
          )}
        </div>

        {error && (
          <div className="bg-red-900/20 border border-red-500/50 p-4 mb-8 rounded-lg flex gap-3">
            <svg className="h-5 w-5 text-red-400 shrink-0 mt-0.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-red-400">Error</h3>
              <p className="text-sm text-red-300 mt-1">{error}</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-[#1e2329] rounded-xl border border-gray-800 p-4 animate-pulse flex flex-col h-48">
                <div className="flex gap-3 mb-4">
                  <div className="w-10 h-10 bg-gray-700 rounded-md" />
                  <div className="h-4 bg-gray-700 rounded w-1/2 mt-1" />
                </div>
                <div className="mt-auto">
                  <div className="flex gap-2 mb-4">
                    <div className="h-9 bg-gray-700 rounded flex-1" />
                    <div className="h-9 bg-gray-700 rounded flex-1" />
                  </div>
                  <div className="h-3 bg-gray-700 rounded w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : events.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {events.map((event, index) => renderEventCard(event, index))}
          </div>
        ) : (
          <div className="text-center py-16 bg-[#1e2329] rounded-xl border border-gray-800">
            <svg className="mx-auto h-12 w-12 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="mt-2 text-lg font-medium text-white">No markets found</h3>
            <p className="mt-1 text-sm text-gray-400">
              {hasSearched ? "Try different keywords." : "No markets available right now."}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
