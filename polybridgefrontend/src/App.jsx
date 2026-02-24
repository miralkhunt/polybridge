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

// Order book: asks ascending (best ask = lowest price first), bids descending (best bid first)
const sortAsks = (asks) =>
  (asks || []).slice().sort((a, b) => parseFloat(a.price || 0) - parseFloat(b.price || 0));
const sortBids = (bids) =>
  (bids || []).slice().sort((a, b) => parseFloat(b.price || 0) - parseFloat(a.price || 0));
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

const API_BASE = "http://localhost:3000";

// ─── EventDetailModal (Trading view with order book) ──────────────────────────
function EventDetailModal({
  eventId,
  seedEvent,
  liveEvent,
  onClose,
  orderbookByTokenId,
  selectedOutcomeTokenId,
  setSelectedOutcomeTokenId,
  onFetchOrderbook,
  orderbookTab,
  setOrderbookTab,
  tradeSide,
  setTradeSide,
  tradeAmount,
  setTradeAmount,
}) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [orderbookLoading, setOrderbookLoading] = useState(false);

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

  const effectiveDetail = liveEvent || detail;

  const mergedMarkets = useMemo(() => {
    if (!effectiveDetail?.markets?.length) return [];
    return effectiveDetail.markets.map((m) => ({ ...m }));
  }, [effectiveDetail]);

  // Order markets so Moneyline is first (matches Polymarket Order Book)
  const sortedMarkets = useMemo(() => {
    const list = [...mergedMarkets];
    list.sort((a, b) => {
      const at = (a.sportsMarketType || a.marketType || "").toLowerCase();
      const bt = (b.sportsMarketType || b.marketType || "").toLowerCase();
      if (at === "moneyline") return -1;
      if (bt === "moneyline") return 1;
      if (at === "spread") return -1;
      if (bt === "spread") return 1;
      return 0;
    });
    return list;
  }, [mergedMarkets]);

  // Flatten outcome options with Moneyline first (uses sortedMarkets)
  const outcomeOptions = useMemo(() => {
    const out = [];
    sortedMarkets.forEach((market) => {
      const outcomes = parseList(market.outcomes);
      const tokens = parseList(market.clobTokenIds);
      const prices = parseList(market.outcomePrices);
      outcomes.forEach((label, i) => {
        const tokenId = tokens[i];
        if (tokenId) out.push({ market, label, tokenId, price: prices[i], outcomeIndex: i });
      });
    });
    return out;
  }, [sortedMarkets]);

  const selectedOption = useMemo(
    () => outcomeOptions.find((o) => o.tokenId === selectedOutcomeTokenId),
    [outcomeOptions, selectedOutcomeTokenId]
  );
  const selectedOutcomeLabel = selectedOption?.label ?? "—";
  const orderbook = selectedOutcomeTokenId ? orderbookByTokenId[String(selectedOutcomeTokenId)] : null;

  const handleMarketBuy = async (e, tradeAmount, selectedOutcomeTokenId, tradeSide) => {
    const res = await fetch("http://localhost:3000/marketbuy?tokenId=" + selectedOutcomeTokenId + "&amount=" + tradeAmount + "&side=" + tradeSide);
    const data = await res.json();
    alert(JSON.stringify(data));
  }

  // Live price: Buy = best ask (price to buy), Sell = best bid (price to sell); fallback to outcome price or last trade
  const getLivePriceForOutcome = useCallback(
    (tokenId, fallbackPrice) => {
      const ob = orderbookByTokenId[String(tokenId)];
      if (tradeSide === "buy") {
        const ask = ob?.best_ask ?? (ob?.asks?.length ? ob.asks[0]?.price : undefined);
        return ask != null ? parseFloat(ask) : parseFloat(fallbackPrice) ?? null;
      }
      const bid = ob?.best_bid ?? ob?.bids?.[0]?.price;
      return bid != null ? parseFloat(bid) : parseFloat(fallbackPrice) ?? null;
    },
    [orderbookByTokenId, tradeSide]
  );

  const avgPrice =
    selectedOutcomeTokenId && orderbook
      ? tradeSide === "buy"
        ? parseFloat(orderbook.best_ask ?? (orderbook.asks?.length ? orderbook.asks[0]?.price : undefined) ?? orderbook.last_trade_price) || parseFloat(selectedOption?.price) || null
        : parseFloat(orderbook.best_bid ?? orderbook.bids?.[0]?.price ?? orderbook.last_trade_price) || parseFloat(selectedOption?.price) || null
      : selectedOption
        ? parseFloat(selectedOption.price)
        : orderbook?.last_trade_price
          ? parseFloat(orderbook.last_trade_price)
          : null;

  const amountNum = Number(tradeAmount) || 0;
  const toWin = tradeSide === "buy" && avgPrice != null && avgPrice > 0 && amountNum > 0
    ? (amountNum / avgPrice).toFixed(2)
    : tradeSide === "sell" && avgPrice != null && amountNum > 0
      ? (amountNum * avgPrice).toFixed(2)
      : "0.00";

  useEffect(() => {
    if (!effectiveDetail || outcomeOptions.length === 0) return;
    const ids = outcomeOptions.map((o) => o.tokenId);
    if (!selectedOutcomeTokenId || !ids.includes(selectedOutcomeTokenId)) {
      setSelectedOutcomeTokenId(outcomeOptions[0]?.tokenId ?? null);
    }
  }, [effectiveDetail?.id, outcomeOptions]);

  useEffect(() => {
    if (!selectedOutcomeTokenId || orderbookByTokenId[selectedOutcomeTokenId]) return;
    let cancelled = false;
    setOrderbookLoading(true);
    onFetchOrderbook(selectedOutcomeTokenId)
      .then(() => { if (!cancelled) setOrderbookLoading(false); })
      .catch(() => { if (!cancelled) setOrderbookLoading(false); });
    return () => { cancelled = true; };
  }, [selectedOutcomeTokenId, orderbookByTokenId, onFetchOrderbook]);

  const addAmount = (delta) => setTradeAmount((prev) => Math.max(0, (parseFloat(prev) || 0) + delta));
  const maxAmount = 10000;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm overflow-y-auto py-4 px-4"
      onClick={handleBackdrop}
    >
      <div
        className="relative bg-[#0f1419] border border-gray-800 rounded-2xl w-full max-w-5xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 text-gray-400 hover:text-white transition-colors p-1 rounded"
          aria-label="Close"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {loading && !effectiveDetail && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <svg className="animate-spin h-10 w-10 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-gray-400 text-sm">Loading event…</p>
          </div>
        )}

        {error && (
          <div className="p-8 text-center">
            <p className="text-red-400 font-medium">{error}</p>
            <button onClick={onClose} className="mt-4 text-sm text-gray-400 hover:text-white">Close</button>
          </div>
        )}

        {effectiveDetail && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr,320px] min-h-[520px]">
            {/* Left: Event + Order Book */}
            <div className="flex flex-col border-r border-gray-800">
              {/* Event header */}
              <div className="p-4 border-b border-gray-800">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-gray-400">{effectiveDetail.category || "League of Legends"}</span>
                  {effectiveDetail.live && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/20 text-red-400 text-xs font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> LIVE
                    </span>
                  )}
                  <span className="text-sm text-gray-500">Game 1 • Best of 5</span>
                </div>
                <p className="mt-1 text-sm text-gray-300">
                  {fmt(effectiveDetail.volume)} Vol. {effectiveDetail.title}
                </p>
                <button type="button" className="mt-2 flex items-center gap-1.5 text-gray-400 hover:text-white text-sm transition-colors">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-gray-700 text-xs">B</span>
                  Game View &gt;
                </button>
              </div>

              {/* Market options (Moneyline first to match Polymarket Order Book) */}
              <div className="p-4 border-b border-gray-800">
                <div className="flex flex-wrap gap-3">
                  {[...mergedMarkets]
                    .sort((a, b) => {
                      const at = (a.sportsMarketType || a.marketType || "").toLowerCase();
                      const bt = (b.sportsMarketType || b.marketType || "").toLowerCase();
                      if (at === "moneyline") return -1;
                      if (bt === "moneyline") return 1;
                      if (at === "spread") return -1;
                      if (bt === "spread") return 1;
                      return 0;
                    })
                    .slice(0, 3)
                    .map((market) => {
                      const outcomes = parseList(market.outcomes);
                      const tokens = parseList(market.clobTokenIds);
                      const prices = parseList(market.outcomePrices);
                      const marketType = market.sportsMarketType || market.question?.toLowerCase().slice(0, 6) || "market";
                      return (
                        <div key={market.id} className="flex flex-col gap-1.5">
                          <span className="text-xs text-gray-500 uppercase tracking-wide">{marketType}</span>
                          <div className="flex gap-2 flex-wrap">
                            {outcomes.map((outcome, i) => {
                              const tokenId = tokens[i];
                              const ob = tokenId ? orderbookByTokenId[String(tokenId)] : null;
                              const livePrice = ob?.best_ask ?? (ob?.asks?.length ? ob.asks[0]?.price : undefined) ?? ob?.last_trade_price ?? prices[i];
                              const p = pct(livePrice);
                              const isSelected = selectedOutcomeTokenId === tokenId;
                              return (
                                <button
                                  key={`${market.id}-${i}`}
                                  type="button"
                                  onClick={() => {
                                    setSelectedOutcomeTokenId(tokenId);
                                    if (!orderbookByTokenId[String(tokenId)]) onFetchOrderbook(tokenId);
                                  }}
                                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${i === 0
                                    ? isSelected
                                      ? "bg-red-600/30 border-red-500 text-red-300"
                                      : "bg-gray-800 border-gray-700 text-red-300 hover:border-red-900"
                                    : isSelected
                                      ? "bg-red-600/30 border-red-500 text-red-300"
                                      : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600"
                                    }`}
                                >
                                  {outcome} {p}¢
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Order Book / Graph tabs */}
              <div className="flex items-center gap-4 px-4 pt-3 border-b border-gray-800">
                <button
                  type="button"
                  onClick={() => setOrderbookTab("book")}
                  className={`pb-3 text-sm font-medium transition-colors border-b-2 ${orderbookTab === "book" ? "text-blue-400 border-blue-500" : "text-gray-500 border-transparent hover:text-gray-300"
                    }`}
                >
                  Order Book
                </button>

              </div>

              {/* Order book table */}
              <div className="flex-1 overflow-auto p-4">
                {orderbookTab === "book" && (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-semibold text-white">TRADE {selectedOutcomeLabel}</span>
                      <div className="flex gap-1">
                        <button type="button" className="p-1.5 text-gray-500 hover:text-white" aria-label="Filter">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                          </svg>
                        </button>
                        <button type="button" className="p-1.5 text-gray-500 hover:text-white" aria-label="Sort">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-gray-500 text-left border-b border-gray-800">
                          <th className="pb-2 font-medium">PRICE</th>
                          <th className="pb-2 font-medium text-right">SHARES</th>
                          <th className="pb-2 font-medium text-right">TOTAL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orderbookLoading && !orderbook && (
                          <tr><td colSpan={3} className="py-8 text-center text-gray-500">Loading order book…</td></tr>
                        )}
                        {!orderbookLoading && orderbook && (
                          <>
                            {sortAsks(orderbook.asks).slice(0, 8).reverse().map((row, i) => {
                              const price = parseFloat(row.price);
                              const size = parseFloat(row.size);
                              const total = price * size;
                              return (
                                <tr key={`ask-${i}`} className="border-b border-gray-800/50">
                                  <td className="py-1.5 text-red-400 font-medium">{pct(price)}¢</td>
                                  <td className="py-1.5 text-right text-gray-300">{size.toFixed(2)}</td>
                                  <td className="py-1.5 text-right text-gray-400">${total.toFixed(2)}</td>
                                </tr>
                              );
                            })}
                            <tr className="bg-gray-800/30">
                              <td colSpan={3} className="py-2 px-2 text-xs text-gray-400">
                                Last: {orderbook.last_trade_price != null ? `${pct(orderbook.last_trade_price)}¢` : "—"} &nbsp; Spread: {orderbook.spread != null ? `${pct(orderbook.spread)}¢` : "—"}
                              </td>
                            </tr>
                            {sortBids(orderbook.bids).slice(0, 8).map((row, i) => {
                              const price = parseFloat(row.price);
                              const size = parseFloat(row.size);
                              const total = price * size;
                              return (
                                <tr key={`bid-${i}`} className="border-b border-gray-800/50">
                                  <td className="py-1.5 text-green-400 font-medium">{pct(price)}¢</td>
                                  <td className="py-1.5 text-right text-gray-300">{size.toFixed(2)}</td>
                                  <td className="py-1.5 text-right text-gray-400">${total.toFixed(2)}</td>
                                </tr>
                              );
                            })}
                          </>
                        )}
                        {!orderbookLoading && selectedOutcomeTokenId && !orderbook && (
                          <tr><td colSpan={3} className="py-8 text-center text-gray-500">No order book data</td></tr>
                        )}
                        {!selectedOutcomeTokenId && (
                          <tr><td colSpan={3} className="py-8 text-center text-gray-500">Select a market to view order book</td></tr>
                        )}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            </div>

            {/* Right: Trade panel */}
            <div className="flex flex-col bg-[#12161c] p-5 border-t lg:border-t-0 lg:border-l border-gray-800">
              <div className="flex gap-2 mb-4">
                <button
                  type="button"
                  onClick={() => setTradeSide("buy")}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${tradeSide === "buy" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-200"
                    }`}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() => setTradeSide("sell")}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${tradeSide === "sell" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-200"
                    }`}
                >
                  Sell
                </button>
              </div>
              <div className="mb-2 text-sm text-gray-500">Market</div>
              <div className="flex gap-2 mb-4">
                {outcomeOptions.slice(0, 2).map((o) => {
                  const isSelected = selectedOutcomeTokenId === o.tokenId;
                  const livePrice = getLivePriceForOutcome(o.tokenId, o.price);
                  const p = livePrice != null ? pct(livePrice) : pct(o.price);
                  return (
                    <button
                      key={o.tokenId}
                      type="button"
                      onClick={() => setSelectedOutcomeTokenId(o.tokenId)}
                      className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${isSelected ? "bg-red-600/20 border-red-500 text-red-300 shadow-md" : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600"
                        }`}
                    >
                      {o.label} {p}¢
                    </button>
                  );
                })}
              </div>
              <label className="block text-sm text-gray-500 mb-1">Amount</label>
              <input
                type="number"
                min={0}
                step={1}
                value={tradeAmount}
                onChange={(e) => setTradeAmount(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-full mb-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-2xl font-bold focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <div className="flex flex-wrap gap-2 mb-4">
                {[1, 5, 10, 100].map((n) => (
                  <button key={n} type="button" onClick={() => addAmount(n)} className="px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm font-medium">
                    +${n}
                  </button>
                ))}
                <button type="button" onClick={() => setTradeAmount(maxAmount)} className="px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm font-medium">
                  Max
                </button>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-400 mb-1">
                <span>To win</span>
                <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8 8.114 8 8c0-.114.07-.34.433-.582zM11 12.849v-1.698c.22.071.412.164.567.267.364.243.433.468.433.582 0 .114-.07.34-.433.582a2.305 2.305 0 01-.567.267z" />
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6 7.009 6 8c0 .99.602 1.765 1.324 2.246.48.32 1.054.545 1.676.662v1.941c-.391-.127-.68-.317-.843-.504a1 1 0 10-1.51 1.31c.562.649 1.413 1.076 2.353 1.253V15a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.765 14 12.991 14 12c0-.99-.602-1.765-1.324-2.246A4.535 4.535 0 0011 9.092V7.151c.391.127.68.317.843.504a1 1 0 101.511-1.31c-.563-.649-1.413-1.076-2.354-1.253V5z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="text-2xl font-bold text-green-400 mb-2">${toWin}</div>
              {avgPrice != null && (
                <p className="text-xs text-gray-500 mb-4 flex items-center gap-1">
                  Avg. Price {pct(avgPrice)}¢
                  <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-600 text-gray-400 cursor-help" title="Price info">ⓘ</span>
                </p>
              )}
              <button type="button"
                id="1"
                onClick={(e) => handleMarketBuy(e, tradeAmount, selectedOutcomeTokenId, tradeSide)}
                className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-colors">
                Trade
              </button>
              <p className="mt-4 text-xs text-gray-500">
                By trading, you agree to the <a href="#" className="text-blue-400 hover:underline">Terms of Use</a>.
              </p>
            </div>
          </div>
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
  const [orderbookByTokenId, setOrderbookByTokenId] = useState({});
  const [selectedOutcomeTokenId, setSelectedOutcomeTokenId] = useState(null);
  const [orderbookTab, setOrderbookTab] = useState("book");
  const [tradeSide, setTradeSide] = useState("buy");
  const [tradeAmount, setTradeAmount] = useState(1);
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

  const closeModal = useCallback(() => {
    setSelectedEvent(null);
    setSelectedOutcomeTokenId(null);
    setTradeAmount(1);
  }, []);

  const fetchOrderbook = useCallback(async (tokenId) => {
    const id = String(tokenId);
    const r = await fetch(`${API_BASE}/orderbook?token_id=${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error("Failed to fetch orderbook");
    const data = await r.json();
    const asks = sortAsks(data.asks);
    const bids = sortBids(data.bids);
    setOrderbookByTokenId((prev) => ({
      ...prev,
      [id]: {
        bids,
        asks,
        last_trade_price: data.last_trade_price ?? null,
        spread: data.spread ?? (asks.length && bids.length
          ? (parseFloat(asks[0].price) - parseFloat(bids[0].price)).toFixed(4)
          : null),
      },
    }));
  }, []);

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
          assets_ids: tokenIdsRef.current,
          type: "market",
          custom_feature_enabled: true,
        };
        ws.send(JSON.stringify(subscribePayload));
      };

      const processOrderbookMessage = (msg) => {
        const et = msg?.event_type ?? msg?.eventType;
        const aid = msg?.asset_id ?? msg?.assetId;
        const assetId = aid != null ? String(aid) : null;

        if (et === "book" && assetId) {
          setOrderbookByTokenId((prev) => {
            const cur = prev[assetId] || {};
            const asks = sortAsks(msg.asks);
            const bids = sortBids(msg.bids);
            const spread = asks.length && bids.length
              ? (parseFloat(asks[0].price) - parseFloat(bids[0].price)).toFixed(4)
              : cur.spread;
            return {
              ...prev,
              [assetId]: {
                bids,
                asks,
                last_trade_price: msg.last_trade_price ?? cur.last_trade_price,
                spread: msg.spread ?? spread,
              },
            };
          });
        } else if (et === "last_trade_price" && assetId) {
          setOrderbookByTokenId((prev) => {
            const cur = prev[assetId] || {};
            return {
              ...prev,
              [assetId]: { ...cur, last_trade_price: msg.price ?? cur.last_trade_price },
            };
          });
        } else if (et === "best_bid_ask" && assetId) {
          setOrderbookByTokenId((prev) => {
            const cur = prev[assetId] || {};
            return {
              ...prev,
              [assetId]: {
                ...cur,
                best_bid: msg.best_bid ?? cur.best_bid,
                best_ask: msg.best_ask ?? cur.best_ask,
                spread: msg.spread ?? cur.spread,
              },
            };
          });
        } else if (et === "price_change" && msg.price_changes?.length) {
          setOrderbookByTokenId((prev) => {
            let next = { ...prev };
            msg.price_changes.forEach((pc) => {
              const rawId = pc.asset_id ?? pc.assetId;
              if (rawId == null) return;
              const aidStr = String(rawId);
              const cur = next[aidStr] || {};
              const bids = cur.bids ? [...cur.bids] : [];
              const asks = cur.asks ? [...cur.asks] : [];
              const price = String(pc.price ?? "");
              const size = String(pc.size ?? "0");
              const side = (pc.side || "").toUpperCase();
              if (side === "BUY") {
                const idx = bids.findIndex((l) => String(l.price) === price);
                if (parseFloat(size) === 0) {
                  if (idx >= 0) bids.splice(idx, 1);
                } else {
                  if (idx >= 0) bids[idx] = { price, size };
                  else bids.push({ price, size });
                  bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
                }
              } else {
                const idx = asks.findIndex((l) => String(l.price) === price);
                if (parseFloat(size) === 0) {
                  if (idx >= 0) asks.splice(idx, 1);
                } else {
                  if (idx >= 0) asks[idx] = { price, size };
                  else asks.push({ price, size });
                  asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
                }
              }
              const spread = asks.length && bids.length
                ? (parseFloat(asks[0].price) - parseFloat(bids[0].price)).toFixed(4)
                : cur.spread;
              next = {
                ...next,
                [aidStr]: {
                  ...cur,
                  bids,
                  asks,
                  best_bid: pc.best_bid ?? cur.best_bid,
                  best_ask: pc.best_ask ?? cur.best_ask,
                  spread,
                },
              };
            });
            return next;
          });
        }
      };

      ws.onmessage = (evt) => {
        let payload;
        try {
          payload = JSON.parse(evt.data);
        } catch {
          return;
        }

        const messages = Array.isArray(payload) ? payload : [payload];
        for (const msg of messages) {
          processOrderbookMessage(msg);
        }

        const updates = extractWsPriceUpdates(payload);
        if (!updates.length) return;

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
            if (targets.length === 0) return;

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
                  className={`flex-1 flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium border transition-colors ${i === 0
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
          orderbookByTokenId={orderbookByTokenId}
          selectedOutcomeTokenId={selectedOutcomeTokenId}
          setSelectedOutcomeTokenId={setSelectedOutcomeTokenId}
          onFetchOrderbook={fetchOrderbook}
          orderbookTab={orderbookTab}
          setOrderbookTab={setOrderbookTab}
          tradeSide={tradeSide}
          setTradeSide={setTradeSide}
          tradeAmount={tradeAmount}
          setTradeAmount={setTradeAmount}
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
              <span className={`ml-3 text-[11px] px-2 py-1 rounded-full border ${wsStatus === "live"
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
