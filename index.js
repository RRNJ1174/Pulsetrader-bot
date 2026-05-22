// ╔══════════════════════════════════════════════════════════════════════════╗
// ║   PULSETRADER v10.0 — KEV'S STRATEGY + ORDER FLOW INTELLIGENCE         ║
// ║                                                                          ║
// ║   Strategy: @trade.momentum (Kev) — 9+ years, 15,000+ students         ║
// ║   Setups:   S/D Flip | Dip & Rip EMA | VWAP Reclaim | AH Gapper       ║
// ║   OrderFlow: Footprint Charts | Liquidity Heat Map | Volume Profile     ║
// ║   Security: Passcode protected — set PASSCODE env var on Render         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import express from "express";
import cors    from "cors";
import fetch   from "node-fetch";
import crypto  from "crypto";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ════════════════════════════════════════════════════════════════════════════
// AUTH — session tokens, 24h expiry
// ════════════════════════════════════════════════════════════════════════════

const sessions = new Map(); // token → expiresAt

const createToken = () => crypto.randomBytes(32).toString("hex");

const isValidToken = (token) => {
  if (!token || !sessions.has(token)) return false;
  if (Date.now() > sessions.get(token)) { sessions.delete(token); return false; }
  return true;
};

// Middleware — protect all /api/* except /api/auth and /api/status
const requireAuth = (req, res, next) => {
  const token = req.headers["x-auth-token"] || req.query._token;
  if (!isValidToken(token)) return res.status(401).json({ error: "Unauthorized. Invalid or expired token." });
  next();
};

// Auth route — must come BEFORE the requireAuth middleware block
app.post("/api/auth", (req, res) => {
  const { passcode } = req.body;
  const correct = process.env.PASSCODE || "pulse2024";
  if (passcode !== correct) return res.status(403).json({ error: "Wrong passcode." });
  const token    = createToken();
  const expires  = Date.now() + 24 * 60 * 60 * 1000; // 24h
  sessions.set(token, expires);
  // Clean old sessions
  for (const [t, exp] of sessions) { if (Date.now() > exp) sessions.delete(t); }
  res.json({ token, expires });
});

app.get("/api/ping", (_, res) => res.json({ ok: true })); // health check, no auth

// Apply auth to everything else under /api/
app.use("/api", requireAuth);

// ════════════════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  POSITION_PCT:         0.20,
  MAX_POSITIONS:        20,
  MIN_POSITION_USD:     100,
  MIN_SPIKE_PCT:        5,
  MIN_VOLUME_RATIO:     10,
  MIN_FLOAT_ROTATION:   5,
  MIN_CONVICTION:       7,
  MAX_PRICE:            9999,
  MIN_PRICE:            0.01,
  FIRST_TARGET_PCT:     20,
  TRAIL_STOP_PCT:       10,
  HARD_STOP_PCT:        15,
  VOLUME_DRY_REDUCE:    0.50,
  SCAN_INTERVAL:        3 * 60 * 1000,
  TOP_GAINERS_COUNT:    100,
  L2_BID_ASK_RATIO:     1.2,
  // Order flow thresholds
  MIN_BUY_PCT:          52,   // min % buy volume to confirm entry
  SELL_IMBALANCE_EXIT:  40,   // exit if buy % drops below this
  MIN_VPOC_ALIGNMENT:   true, // price must be above VPOC to enter
};

// ════════════════════════════════════════════════════════════════════════════
// SELF-LEARNING BRAIN
// ════════════════════════════════════════════════════════════════════════════

const BRAIN = {
  totalTrades: 0, wins: 0, losses: 0, totalPnL: 0,
  bestSetups: {}, bestTickers: [], recentPerformance: [],
  adjustedFirstTarget: 20, adjustedStop: 15, adjustedConviction: 7,
  lessons: [], lastLearned: null,
};

const tradeLog       = [];
const openTrades     = {};
let autoTraderActive = false;
let scanInterval     = null;
let lastScanTime     = null;
let lastGainers      = [];
let lastAnalysis     = "";

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Kev's strategy + Order Flow awareness
// ════════════════════════════════════════════════════════════════════════════

const buildSystem = () => {
  const wr = BRAIN.totalTrades > 0
    ? ((BRAIN.wins / BRAIN.totalTrades) * 100).toFixed(1) + "%" : "learning";
  const topSetups = Object.entries(BRAIN.bestSetups)
    .sort((a, b) => b[1].winRate - a[1].winRate).slice(0, 3)
    .map(([k, v]) => `${k}(${v.winRate.toFixed(0)}%win)`).join(", ") || "collecting data";
  const lessons = BRAIN.lessons.slice(0, 5).map(l => `- ${l}`).join("\n") || "none yet";

  return `You are PulseTrader v10 — elite momentum trader combining Kev's (@trade.momentum) exact strategy with institutional order flow analysis.

ONLY analyze real stocks from data provided. NEVER invent tickers or prices.

YOUR PERFORMANCE: Win rate ${wr} (${BRAIN.wins}W/${BRAIN.losses}L) | P&L: $${BRAIN.totalPnL.toFixed(2)}
Best setups: ${topSetups}
Target: +${BRAIN.adjustedFirstTarget}% first exit | Stop: -${BRAIN.adjustedStop}%

LESSONS LEARNED:
${lessons}

═══ KEV'S 5 SETUPS ═══

SETUP 1 — S/D FLIP (Primary, highest win rate)
• Wait for price to BREAK ABOVE supply zone
• Confirm: higher lows forming ABOVE the broken supply
• NO BREAK = NO TRADE. After break: target gap fill or next supply above.

SETUP 2 — AFTER-HOURS GAPPER CONTINUATION
• Stock gaps up AH, must maintain VWAP overnight
• Enter at open if holding demand/VWAP with higher lows in premarket
• Target: retest AH highs, then new highs

SETUP 3 — DIP & RIP OFF 9/20 EMA
• Pullback to 9 or 20 EMA with volume DROP on dip
• Enter on curl back up with volume increasing
• Exit when volume dries or tape slows

SETUP 4 — VWAP RECLAIM
• Stock fades below VWAP, reclaims with volume = strength
• Trail stop below VWAP, target previous highs

SETUP 5 — 200MA + DEMAND ZONE CONFLUENCE
• Price at BOTH 200MA AND demand zone = highest conviction
• Use larger size

═══ ORDER FLOW RULES (NEW — REQUIRED for entry) ═══
• Footprint: Buy volume must be >52% of total volume — buyers are aggressive
• Footprint: Delta must be positive at entry price level — more buys than sells
• Liquidity Map: Large bid wall BELOW price = support, protects from downside
• Liquidity Map: Thin ask wall ABOVE price = easy to break through (bullish)
• Volume Profile: Price must be AT or ABOVE VPOC — trading in value
• Volume Profile: If price is below VAL (value area low), skip — institutional selling
• Footprint + L2 agree = HIGHEST conviction entry
• Footprint shows sell imbalance = EXIT signal regardless of other factors

═══ ENTRY RULES ═══
• 10x+ relative volume REQUIRED
• Buy volume >52% on footprint
• Bid wall support below price
• Above VPOC and VWAP
• S/D flip or EMA curl as trigger

═══ EXIT RULES ═══
• Sell 50% at +${BRAIN.adjustedFirstTarget}%
• Trail stop remaining 50%
• EXIT if: buy volume drops below 40% (sellers taking over)
• EXIT if: price breaks BELOW large bid wall (support lost)
• EXIT if: -${BRAIN.adjustedStop}% hard stop
• Reduce 50% on volume dry-up

FORMAT RESPONSE:
BUY: TICKER | CONVICTION: X | SETUP: name | REASON: one line
SKIP: TICKER | REASON: order flow against
Setup names: sd_flip, ah_gapper, dip_rip_ema, vwap_reclaim, ma200_confluence`;
};

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

const groq = async (prompt, maxTokens = 1200) => {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", max_tokens: maxTokens, messages: [{ role: "system", content: buildSystem() }, { role: "user", content: prompt }] }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    return d.choices?.[0]?.message?.content || "No response.";
  } catch (e) { console.error("Groq:", e.message); return `Error: ${e.message}`; }
};

const groqChat = async (messages, maxTokens = 1200) => {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", max_tokens: maxTokens, messages: [{ role: "system", content: buildSystem() }, ...messages] }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    return d.choices?.[0]?.message?.content || "No response.";
  } catch (e) { return `Error: ${e.message}`; }
};

const supabase = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" }, ...opts,
  });
  const t = await res.text();
  return t ? JSON.parse(t) : [];
};

const alpaca = async (path, opts = {}) => {
  const res = await fetch(`https://paper-api.alpaca.markets${path}`, {
    headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET, "Content-Type": "application/json" }, ...opts,
  });
  return res.json();
};

const alpacaData = async (path) => {
  const res = await fetch(`https://data.alpaca.markets${path}`, {
    headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET },
  });
  return res.json();
};

const finnhub = async (path) => {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`);
  return res.json();
};

// ════════════════════════════════════════════════════════════════════════════
// TECHNICAL ANALYSIS (unchanged)
// ════════════════════════════════════════════════════════════════════════════

const calcEMA = (data, period) => {
  if (!data || data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
};
const calcVWAP = (bars) => {
  if (!bars?.length) return 0;
  let pv = 0, vol = 0;
  for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; pv += tp * (b.v || 0); vol += (b.v || 0); }
  return vol > 0 ? pv / vol : 0;
};
const calcAvgVolume = (bars, periods = 20) => {
  if (!bars?.length) return 0;
  const recent = bars.slice(-Math.min(periods, bars.length));
  return recent.reduce((s, b) => s + (b.v || 0), 0) / recent.length;
};
const detectSDFlip = (bars, currentPrice) => {
  if (!bars || bars.length < 5) return { detected: false };
  const recent = bars.slice(-20);
  const prevHigh = Math.max(...recent.slice(0, -3).map(b => b.h));
  const brokeAbove = currentPrice > prevHigh;
  const last3Closes = recent.slice(-3).map(b => b.c);
  const higherLows = last3Closes.length >= 3 && last3Closes[1] > last3Closes[0] && last3Closes[2] > last3Closes[1];
  return { detected: brokeAbove && higherLows, prevHigh: prevHigh.toFixed(4), brokeAbove, higherLows };
};
const detectDipRip = (bars, currentPrice) => {
  if (!bars || bars.length < 20) return { detected: false };
  const closes = bars.map(b => b.c);
  const ema9 = calcEMA(closes, 9), ema20 = calcEMA(closes, 20);
  if (!ema9 || !ema20) return { detected: false };
  const nearEMA9 = Math.abs(currentPrice - ema9) / ema9 < 0.03;
  const nearEMA20 = Math.abs(currentPrice - ema20) / ema20 < 0.05;
  const aboveEMA9 = currentPrice >= ema9;
  const vols = bars.slice(-5).map(b => b.v || 0);
  const volDecline = vols[0] > vols[2] && vols[2] <= vols[4];
  return { detected: (nearEMA9 || nearEMA20) && aboveEMA9 && volDecline, ema9: ema9?.toFixed(4), ema20: ema20?.toFixed(4), nearEMA9, nearEMA20, aboveEMA9, volDecline };
};

const getFullTechnicals = async (ticker, currentPrice) => {
  try {
    const now = new Date(), start = new Date(now);
    start.setHours(4, 0, 0, 0);
    const barsData = await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=5Min&start=${start.toISOString()}&limit=78&feed=iex`);
    const bars = barsData.bars || [];
    if (bars.length < 5) return null;
    const closes = bars.map(b => b.c);
    const vwap = calcVWAP(bars), ema9 = calcEMA(closes, 9), ema20 = calcEMA(closes, 20), ema200 = calcEMA(closes, Math.min(200, closes.length));
    const avgVol = calcAvgVolume(bars), lastVol = bars[bars.length - 1]?.v || 0;
    const volRatio = avgVol > 0 ? lastVol / avgVol : 0;
    const totalDayVol = bars.reduce((s, b) => s + (b.v || 0), 0);
    const sdFlip = detectSDFlip(bars, currentPrice), dipRip = detectDipRip(bars, currentPrice);
    const vwapReclaim = currentPrice >= vwap && bars.slice(-3).some(b => b.l < vwap);
    const ma200Conf = ema200 && Math.abs(currentPrice - ema200) / ema200 < 0.05;
    const aboveVWAP = currentPrice >= vwap;
    const stillRising = closes.length >= 3 && closes[closes.length - 1] > closes[closes.length - 3];
    const recentVols = bars.slice(-6).map(b => b.v || 0);
    const volDryUp = recentVols.length >= 4 && recentVols.slice(-2).every(v => v < recentVols.slice(0, -2).reduce((s, x) => s + x, 0) / recentVols.slice(0, -2).length * 0.5);
    return { vwap: vwap.toFixed(4), ema9: ema9?.toFixed(4), ema20: ema20?.toFixed(4), ema200: ema200?.toFixed(4), aboveVWAP, volRatio: volRatio.toFixed(1), totalDayVol, avgVol: Math.round(avgVol), sdFlip, dipRip, vwapReclaim, ma200Conf, aboveVWAP, stillRising, volDryUp, bars: bars.length };
  } catch (e) { console.log(`Tech error ${ticker}:`, e.message); return null; }
};

// ════════════════════════════════════════════════════════════════════════════
// LEVEL 2 ORDER FLOW (enhanced)
// ════════════════════════════════════════════════════════════════════════════

const getLevel2 = async (ticker) => {
  try {
    const data = await alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`);
    const q = data.quote;
    if (!q) return null;
    const bidSize = q.bs || 0, askSize = q.as || 0, bid = q.bp || 0, ask = q.ap || 0;
    const spread = ask > 0 ? ((ask - bid) / ask * 100) : 999;
    const bidAskRatio = askSize > 0 ? bidSize / askSize : 0;
    const strongBids = bidAskRatio >= CONFIG.L2_BID_ASK_RATIO, tightSpread = spread < 3;
    const goodL2 = strongBids && tightSpread;
    return { bid, ask, spread: spread.toFixed(2), bidSize, askSize, bidAskRatio: bidAskRatio.toFixed(2), strongBids, tightSpread, goodL2, signal: goodL2 ? "STRONG BIDS — buyers in control" : strongBids ? "Moderate bids" : "Weak bids — sellers in control" };
  } catch (e) { return null; }
};

// ════════════════════════════════════════════════════════════════════════════
// 🔥 FOOTPRINT CHART — buy vs sell volume at each price level
// ════════════════════════════════════════════════════════════════════════════

const getFootprint = async (ticker) => {
  try {
    // Get last 500 trades + current quote for bid/ask midpoint
    const [tradesData, quoteData] = await Promise.all([
      alpacaData(`/v2/stocks/${ticker}/trades?limit=500&feed=iex`),
      alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`),
    ]);
    const trades = tradesData.trades || [];
    if (!trades.length) return null;

    const q   = quoteData.quote;
    const mid = q ? (parseFloat(q.bp || 0) + parseFloat(q.ap || 0)) / 2 : 0;

    // Build footprint: price level → { buyVol, sellVol }
    const footprint = {};
    let totalBuy = 0, totalSell = 0;

    for (const t of trades) {
      const rawPrice = parseFloat(t.p || 0);
      const size     = parseInt(t.s  || 0);
      // Round to nearest cent for grouping
      const price    = rawPrice.toFixed(2);
      if (!footprint[price]) footprint[price] = { buyVol: 0, sellVol: 0 };
      // Classify: trades AT OR ABOVE midpoint = buy aggressor
      if (rawPrice >= mid && mid > 0) { footprint[price].buyVol += size; totalBuy += size; }
      else                            { footprint[price].sellVol += size; totalSell += size; }
    }

    const totalVol = totalBuy + totalSell;
    const buyPct   = totalVol > 0 ? (totalBuy / totalVol) * 100 : 50;
    const delta    = totalBuy - totalSell;

    // Classify imbalance
    const imbalance =
      buyPct > 65 ? "STRONG_BUY" :
      buyPct > 52 ? "BUY" :
      buyPct < 35 ? "STRONG_SELL" :
      buyPct < 48 ? "SELL" : "NEUTRAL";

    // Sort price levels by price desc, find biggest walls
    const levels = Object.entries(footprint).map(([price, v]) => ({
      price:    parseFloat(price),
      buyVol:   v.buyVol,
      sellVol:  v.sellVol,
      delta:    v.buyVol - v.sellVol,
      total:    v.buyVol + v.sellVol,
    })).sort((a, b) => b.price - a.price);

    const biggestBuyWall  = levels.reduce((b, l) => (!b || l.delta > b.delta) ? l : b, null);
    const biggestSellWall = levels.reduce((b, l) => (!b || l.delta < b.delta) ? l : b, null);
    const biggestVolLevel = levels.reduce((b, l) => (!b || l.total > b.total) ? l : b, null);

    // Entry/exit signals
    const buySignal = imbalance.includes("BUY");
    const sellSignal = imbalance.includes("SELL");

    return {
      totalBuy, totalSell, totalVol,
      buyPct:   buyPct.toFixed(1),
      sellPct:  (100 - buyPct).toFixed(1),
      delta, imbalance,
      biggestBuyWall:  biggestBuyWall  ? { price: biggestBuyWall.price,  delta: biggestBuyWall.delta  } : null,
      biggestSellWall: biggestSellWall ? { price: biggestSellWall.price, delta: biggestSellWall.delta } : null,
      biggestVolLevel: biggestVolLevel ? { price: biggestVolLevel.price, vol: biggestVolLevel.total }  : null,
      levels:   levels.slice(0, 10),
      signal:   imbalance === "STRONG_BUY"  ? "🟢🟢 Strong buyers — aggressive entry" :
                imbalance === "BUY"         ? "🟢 Buy side dominant" :
                imbalance === "STRONG_SELL" ? "🔴🔴 Strong sellers — AVOID or EXIT" :
                imbalance === "SELL"        ? "🔴 Sell side dominant" : "⚪ Balanced — wait for direction",
      entryOk:  buyPct >= CONFIG.MIN_BUY_PCT,
      exitNow:  buyPct <= CONFIG.SELL_IMBALANCE_EXIT,
    };
  } catch (e) {
    console.log(`Footprint error ${ticker}:`, e.message);
    return null;
  }
};

// ════════════════════════════════════════════════════════════════════════════
// 🗺️ LIQUIDITY HEAT MAP — order book depth, bid/ask walls
// ════════════════════════════════════════════════════════════════════════════

const getLiquidityMap = async (ticker) => {
  try {
    // Try multi-level orderbook first (may need premium feed)
    let bids = [], asks = [];
    try {
      const obData = await alpacaData(`/v2/stocks/${ticker}/orderbook/latest?feed=iex`);
      const ob = obData.orderbook;
      if (ob?.b?.length) {
        bids = ob.b.slice(0, 10).map(b => ({ price: parseFloat(b.p), size: parseInt(b.s) }));
        asks = ob.a.slice(0, 10).map(a => ({ price: parseFloat(a.p), size: parseInt(a.s) }));
      }
    } catch (_) {}

    // Fallback: use quotes endpoint for single-level
    if (!bids.length) {
      const qData = await alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`);
      const q = qData.quote;
      if (q) {
        bids = [{ price: parseFloat(q.bp || 0), size: parseInt(q.bs || 0) }];
        asks = [{ price: parseFloat(q.ap || 0), size: parseInt(q.as || 0) }];
      }
    }

    if (!bids.length) return null;

    const totalBidLiq = bids.reduce((s, b) => s + b.size, 0);
    const totalAskLiq = asks.reduce((s, a) => s + a.size, 0);
    const liqRatio    = totalAskLiq > 0 ? totalBidLiq / totalAskLiq : 1;

    // Find walls — large concentrations of orders
    const bigBidWall = bids.reduce((b, x) => (!b || x.size > b.size) ? x : b, null);
    const bigAskWall = asks.reduce((b, x) => (!b || x.size > b.size) ? x : b, null);

    // Wall strength signal
    const bidWallStrong = bigBidWall && bigBidWall.size > totalBidLiq * 0.4;
    const askWallThin   = !bigAskWall || bigAskWall.size < totalAskLiq * 0.3;

    // Classify
    const signal =
      liqRatio > 2.0 ? "🟢🟢 MASSIVE bid wall — strong support" :
      liqRatio > 1.5 ? "🟢 Strong bid support below" :
      liqRatio > 1.1 ? "🟡 Slight bid favor" :
      liqRatio < 0.5 ? "🔴🔴 Ask wall dominant — sellers stacked above" :
      liqRatio < 0.8 ? "🔴 Sellers stacking" : "⚪ Balanced book";

    return {
      bids: bids.slice(0, 5),
      asks: asks.slice(0, 5),
      totalBidLiq, totalAskLiq,
      liqRatio: liqRatio.toFixed(2),
      bigBidWall, bigAskWall,
      bidWallStrong, askWallThin,
      signal,
      // Entry: bid support below, thin ask above = easy breakout
      entryFavorable: liqRatio >= 1.1 && askWallThin,
      // Exit: ask wall building or bids pulled
      exitSignal: liqRatio < 0.8 || (bigAskWall && bigAskWall.size > totalAskLiq * 0.6),
    };
  } catch (e) {
    console.log(`LiqMap error ${ticker}:`, e.message);
    return null;
  }
};

// ════════════════════════════════════════════════════════════════════════════
// 📊 VOLUME PROFILE — VPOC, Value Area High/Low
// ════════════════════════════════════════════════════════════════════════════

const getVolumeProfile = async (ticker) => {
  try {
    // Get 1-min bars for the full session
    const data = await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=1Min&limit=390&feed=iex`);
    const bars  = data.bars || [];
    if (bars.length < 5) return null;

    // Build volume-at-price profile using typical price
    const profile = {};
    let totalVol  = 0;

    for (const bar of bars) {
      const tp    = parseFloat(((bar.h + bar.l + bar.c) / 3).toFixed(2));
      profile[tp] = (profile[tp] || 0) + (bar.v || 0);
      totalVol   += (bar.v || 0);
    }

    if (totalVol === 0) return null;

    const levels = Object.entries(profile)
      .map(([price, vol]) => ({ price: parseFloat(price), vol }))
      .sort((a, b) => b.vol - a.vol);

    // VPOC = price with highest volume
    const vpoc = levels[0];

    // Value Area = 70% of volume centered around VPOC
    const vaTarget = totalVol * 0.70;
    let   vaAccum  = 0;
    const vaLevels = [];
    for (const l of levels) {
      vaAccum += l.vol;
      vaLevels.push(l.price);
      if (vaAccum >= vaTarget) break;
    }
    const vah = Math.max(...vaLevels);
    const val = Math.min(...vaLevels);

    const currentPrice = parseFloat(bars[bars.length - 1].c);
    const aboveVPOC    = currentPrice >= vpoc.price;
    const inValueArea  = currentPrice >= val && currentPrice <= vah;
    const aboveVAH     = currentPrice > vah; // extended, possible fade

    // High volume node / low volume node near price
    const nearbyLevels = levels.filter(l => Math.abs(l.price - currentPrice) / currentPrice < 0.05);
    const hvnNearby    = nearbyLevels.length > 0 && nearbyLevels[0].vol > totalVol * 0.05;

    return {
      vpoc:       vpoc.price,
      vah:        parseFloat(vah.toFixed(2)),
      val:        parseFloat(val.toFixed(2)),
      totalVol,
      currentPrice,
      aboveVPOC,
      inValueArea,
      aboveVAH,
      hvnNearby,
      topLevels:  levels.slice(0, 5),
      signal:
        aboveVAH     ? "⚠️ Above value area — extended, watch for fade" :
        aboveVPOC    ? "🟢 Above VPOC — in value, bullish" :
        inValueArea  ? "🟡 In value area — neutral, watch VPOC reclaim" :
                       "🔴 Below value area — institutional selling",
      // Entry: above VPOC and in value area = strong
      entryOk:    aboveVPOC && !aboveVAH,
      // Exit: dropped below VAL or VPOC after entry
      exitSignal: !aboveVPOC && !inValueArea,
    };
  } catch (e) {
    console.log(`VolProfile error ${ticker}:`, e.message);
    return null;
  }
};

// ════════════════════════════════════════════════════════════════════════════
// 🧠 COMBINED ORDER FLOW ANALYSIS — footprint + heatmap + vol profile
// ════════════════════════════════════════════════════════════════════════════

const getOrderFlow = async (ticker, currentPrice) => {
  try {
    const [footprint, liqMap, volProfile] = await Promise.all([
      getFootprint(ticker).catch(() => null),
      getLiquidityMap(ticker).catch(() => null),
      getVolumeProfile(ticker).catch(() => null),
    ]);

    // Score the entry 0-3 (one point each for footprint, liquidity, volume profile)
    let entryScore  = 0;
    let exitSignals = 0;

    if (footprint?.entryOk)    entryScore++;
    if (liqMap?.entryFavorable) entryScore++;
    if (volProfile?.entryOk)   entryScore++;

    if (footprint?.exitNow)     exitSignals++;
    if (liqMap?.exitSignal)     exitSignals++;
    if (volProfile?.exitSignal) exitSignals++;

    const entryGrade =
      entryScore === 3 ? "A+ — all 3 signals aligned" :
      entryScore === 2 ? "B  — 2 of 3 signals OK" :
      entryScore === 1 ? "C  — weak setup" : "D  — order flow against";

    const summary = [
      footprint  ? `Footprint: ${footprint.buyPct}% buys | ${footprint.signal}` : "Footprint: no data",
      liqMap     ? `LiqMap: ${liqMap.signal} | Ratio: ${liqMap.liqRatio}x` : "LiqMap: no data",
      volProfile ? `VolProfile: VPOC $${volProfile.vpoc} | VAH $${volProfile.vah} | VAL $${volProfile.val} | ${volProfile.signal}` : "VolProfile: no data",
    ].join("\n");

    return {
      footprint,
      liqMap,
      volProfile,
      entryScore,
      entryGrade,
      exitSignals,
      shouldEnter: entryScore >= 2,
      shouldExit:  exitSignals >= 2,
      summary,
    };
  } catch (e) {
    console.log(`OrderFlow error ${ticker}:`, e.message);
    return null;
  }
};

// ════════════════════════════════════════════════════════════════════════════
// MARKET-WIDE TOP GAINERS SCANNER
// ════════════════════════════════════════════════════════════════════════════

const getTopGainers = async () => {
  const gainers = [];
  try {
    const urls = [
      `/v1beta1/screener/stocks/movers?by=percent_change&top=${CONFIG.TOP_GAINERS_COUNT}&market_type=sip`,
      `/v1beta1/screener/stocks/movers?by=percent_change&top=${CONFIG.TOP_GAINERS_COUNT}`,
    ];
    for (const url of urls) {
      try {
        const data = await alpacaData(url);
        if (data.gainers?.length) {
          for (const g of data.gainers) {
            if (g.price >= CONFIG.MIN_PRICE && g.price <= CONFIG.MAX_PRICE && g.percent_change >= CONFIG.MIN_SPIKE_PCT) {
              gainers.push({ ticker: g.symbol, c: g.price, dp: g.percent_change, v: g.volume || 0, source: "alpaca_screener" });
            }
          }
          console.log(`📡 Alpaca screener: ${gainers.length} gainers`);
          break;
        }
      } catch (_) { continue; }
    }
  } catch (e) { console.log("Alpaca screener error:", e.message); }

  if (gainers.length < 5) {
    const SCAN = [
      "WHLR","PCLA","EDHL","ATPC","LIMN","ILLR","NCPL","VIDA","DGNX","JUNS",
      "HCWB","SLXN","PHGE","GCL","MLGO","SOUN","MARA","RIOT","CIFR","BTBT",
      "HUT","WULF","CLSK","OCGN","NVAX","ADMA","BNGO","SRNE","TGTX","EDSA",
      "FBRX","HTBX","SAVA","TE","PETZ","BTM","ORBS","AMMO","STFS","JDZG",
      "ATXI","NKGN","IMVT","CYRX","TRIL","IRNC","LAUR","TRCH","SNAL","AIIO",
      "AUUD","MTVA","NXXT","QUCY","AMST","SACH","POET","UCAR","CODX","GMEX",
      "KULR","MULN","STEM","RVNC","QUBT","KPLT","BBCP","CLFD","JSPR","COIN",
      "PLTR","SOFI","HOOD","LMND","HIMS","MNMD","SMAR","ACMR","GBOX","SLXN",
    ];
    const batchSize = 15;
    for (let i = 0; i < SCAN.length; i += batchSize) {
      const batch  = SCAN.slice(i, i + batchSize);
      const quotes = await Promise.all(batch.map(t => finnhub(`/quote?symbol=${t}`).then(q => ({ ticker: t, ...q })).catch(() => null)));
      for (const q of quotes.filter(Boolean)) {
        if (q.c >= CONFIG.MIN_PRICE && q.c <= CONFIG.MAX_PRICE && q.dp >= CONFIG.MIN_SPIKE_PCT && q.v > 10000 && !gainers.find(g => g.ticker === q.ticker)) {
          gainers.push({ ticker: q.ticker, c: q.c, dp: q.dp, v: q.v, h: q.h, l: q.l, source: "finnhub" });
        }
      }
      if (i + batchSize < SCAN.length) await new Promise(r => setTimeout(r, 250));
    }
  }
  return gainers.sort((a, b) => b.dp - a.dp);
};

// ════════════════════════════════════════════════════════════════════════════
// DEEP STOCK ANALYSIS
// ════════════════════════════════════════════════════════════════════════════

const analyzeStock = async (ticker, price, pct) => {
  try {
    const week  = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [profile, news] = await Promise.all([finnhub(`/stock/profile2?symbol=${ticker}`), finnhub(`/company-news?symbol=${ticker}&from=${week}&to=${today}`)]);
    const headlines = Array.isArray(news) ? news.slice(0, 4).map(n => `- ${n.headline}`).join("\n") : "No news";
    return { ticker, price, pct, float: profile.shareOutstanding || "?", mktCap: profile.marketCapitalization || "?", industry: profile.finnhubIndustry || "?", headlines, name: profile.name || ticker };
  } catch (e) {
    return { ticker, price, pct, float: "?", mktCap: "?", industry: "?", headlines: "No data", name: ticker };
  }
};

// ════════════════════════════════════════════════════════════════════════════
// SELF-LEARNING ENGINE
// ════════════════════════════════════════════════════════════════════════════

const learnFromTrade = async (trade) => {
  const won = trade.pnl > 0;
  BRAIN.totalTrades++; won ? BRAIN.wins++ : BRAIN.losses++;
  BRAIN.totalPnL += trade.pnl || 0;
  if (trade.setup) {
    if (!BRAIN.bestSetups[trade.setup]) BRAIN.bestSetups[trade.setup] = { trades: 0, wins: 0, winRate: 0 };
    BRAIN.bestSetups[trade.setup].trades++;
    if (won) BRAIN.bestSetups[trade.setup].wins++;
    BRAIN.bestSetups[trade.setup].winRate = (BRAIN.bestSetups[trade.setup].wins / BRAIN.bestSetups[trade.setup].trades) * 100;
  }
  if (won && !BRAIN.bestTickers.includes(trade.symbol)) { BRAIN.bestTickers.unshift(trade.symbol); BRAIN.bestTickers = BRAIN.bestTickers.slice(0, 20); }
  BRAIN.recentPerformance.unshift({ ...trade, won }); BRAIN.recentPerformance = BRAIN.recentPerformance.slice(0, 20);
  const rw = BRAIN.recentPerformance.filter(t => t.won).length, rt = BRAIN.recentPerformance.length;
  if (rt >= 5) {
    const rate = rw / rt;
    if (rate > 0.65) { BRAIN.adjustedFirstTarget = Math.min(35, BRAIN.adjustedFirstTarget + 2); BRAIN.adjustedConviction = Math.max(6, BRAIN.adjustedConviction - 1); }
    else if (rate < 0.35) { BRAIN.adjustedFirstTarget = Math.max(15, BRAIN.adjustedFirstTarget - 2); BRAIN.adjustedStop = Math.max(8, BRAIN.adjustedStop - 1); BRAIN.adjustedConviction = Math.min(9, BRAIN.adjustedConviction + 1); }
    CONFIG.FIRST_TARGET_PCT = BRAIN.adjustedFirstTarget; CONFIG.HARD_STOP_PCT = BRAIN.adjustedStop; CONFIG.MIN_CONVICTION = BRAIN.adjustedConviction;
  }
  try {
    const lesson = await groq(`Trade: ${trade.symbol} | ${won ? "WIN ✅" : "LOSS ❌"}\nP&L: $${trade.pnl?.toFixed(2)} (${trade.pnlPct?.toFixed(1)}%)\nEntry: $${trade.entryPrice} → Exit: $${trade.exitPrice}\nSetup: ${trade.setup} | Exit: ${trade.exitReason}\nOrderFlow at exit: ${trade.orderFlowAtExit || "unknown"}\n\nONE specific lesson combining Kev's strategy + order flow for future trades:`, 100);
    BRAIN.lessons.unshift(lesson.trim()); BRAIN.lessons = BRAIN.lessons.slice(0, 10); BRAIN.lastLearned = new Date().toISOString();
  } catch (_) {}
  await supabase("bot_trade_memory", { method: "POST", body: JSON.stringify({ symbol: trade.symbol, side: "LONG", entry_price: trade.entryPrice, exit_price: trade.exitPrice, pnl: trade.pnl, pnl_pct: trade.pnlPct, entry_reason: trade.reason, exit_reason: trade.exitReason, setup_type: trade.setup, won, entry_hour: new Date().getHours(), day_of_week: new Date().getDay() }) }).catch(() => {});
};

const loadMemory = async () => {
  try {
    const mem = await supabase("bot_trade_memory?order=created_at.desc&limit=200");
    if (!Array.isArray(mem) || !mem.length) { console.log("🧠 Fresh start"); return; }
    BRAIN.totalTrades = mem.length; BRAIN.wins = mem.filter(m => m.won).length; BRAIN.losses = mem.filter(m => !m.won).length; BRAIN.totalPnL = mem.reduce((s, m) => s + parseFloat(m.pnl || 0), 0);
    mem.forEach(m => {
      if (m.setup_type) {
        if (!BRAIN.bestSetups[m.setup_type]) BRAIN.bestSetups[m.setup_type] = { trades: 0, wins: 0, winRate: 0 };
        BRAIN.bestSetups[m.setup_type].trades++;
        if (m.won) BRAIN.bestSetups[m.setup_type].wins++;
        BRAIN.bestSetups[m.setup_type].winRate = (BRAIN.bestSetups[m.setup_type].wins / BRAIN.bestSetups[m.setup_type].trades) * 100;
      }
      if (m.won && !BRAIN.bestTickers.includes(m.symbol)) BRAIN.bestTickers.push(m.symbol);
    });
    BRAIN.bestTickers = BRAIN.bestTickers.slice(0, 20);
    const lessons = await supabase("bot_lessons?order=created_at.desc&limit=20");
    if (Array.isArray(lessons)) BRAIN.lessons = lessons.map(l => l.lesson).filter(Boolean);
    console.log(`🧠 Memory: ${mem.length} trades | ${((BRAIN.wins / BRAIN.totalTrades) * 100).toFixed(0)}% WR | $${BRAIN.totalPnL.toFixed(0)} P&L`);
  } catch (e) { console.log("Memory load:", e.message); }
};

// ════════════════════════════════════════════════════════════════════════════
// MARKET HOURS
// ════════════════════════════════════════════════════════════════════════════

const getET  = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const isOpen = () => { const et = getET(), d = et.getDay(); if (d === 0 || d === 6) return false; const t = et.getHours() * 100 + et.getMinutes(); return t >= 930 && t < 1600; };
const isPre  = () => { const et = getET(), d = et.getDay(); if (d === 0 || d === 6) return false; const t = et.getHours() * 100 + et.getMinutes(); return t >= 400 && t < 930; };

// ════════════════════════════════════════════════════════════════════════════
// POSITION MANAGER — order flow aware exits
// ════════════════════════════════════════════════════════════════════════════

const managePositions = async (positions) => {
  if (!Array.isArray(positions)) return;
  for (const pos of positions) {
    const sym      = pos.symbol;
    const pnlPct   = parseFloat(pos.unrealized_plpc) * 100;
    const curPrice = parseFloat(pos.current_price);
    const entry    = openTrades[sym];
    if (!entry) continue;
    if (!entry.peakPrice || curPrice > entry.peakPrice) entry.peakPrice = curPrice;
    const fromPeak = entry.peakPrice > 0 ? ((curPrice - entry.peakPrice) / entry.peakPrice) * 100 : 0;

    // 1. Sell 50% at first target
    if (!entry.halfSold && pnlPct >= CONFIG.FIRST_TARGET_PCT) {
      const halfQty = Math.floor(parseFloat(pos.qty) / 2);
      if (halfQty >= 1) {
        await alpaca("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: sym, qty: String(halfQty), side: "sell", type: "market", time_in_force: "day" }) });
        entry.halfSold = true;
        tradeLog.unshift({ type: "PARTIAL_SELL", symbol: sym, qty: halfQty, price: curPrice, pnlPct: pnlPct.toFixed(1), reason: `First target +${CONFIG.FIRST_TARGET_PCT}%`, ts: new Date().toISOString() });
      }
    }

    // 2. Get order flow for intelligent exit decisions
    const [tech, orderFlow] = await Promise.all([
      getFullTechnicals(sym, curPrice).catch(() => null),
      getOrderFlow(sym, curPrice).catch(() => null),
    ]);

    // 3. Order flow exit signal — sellers taking over
    if (orderFlow?.shouldExit && entry.halfSold) {
      console.log(`🔴 ORDER FLOW EXIT: ${sym} — ${orderFlow.footprint?.signal}`);
      await alpaca("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: sym, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }) });
      const t = { symbol: sym, pnl: parseFloat(pos.unrealized_pl), pnlPct, entryPrice: pos.avg_entry_price, exitPrice: curPrice, reason: entry.reason, setup: entry.setup, exitReason: "ORDER FLOW EXIT", orderFlowAtExit: orderFlow?.footprint?.signal, type: "SELL", price: curPrice, ts: new Date().toISOString() };
      tradeLog.unshift(t); await learnFromTrade(t); delete openTrades[sym]; continue;
    }

    // 4. Trailing stop on remaining
    if (entry.halfSold && fromPeak <= -CONFIG.TRAIL_STOP_PCT) {
      await alpaca("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: sym, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }) });
      const t = { symbol: sym, pnl: parseFloat(pos.unrealized_pl), pnlPct, entryPrice: pos.avg_entry_price, exitPrice: curPrice, reason: entry.reason, setup: entry.setup, exitReason: "TRAIL STOP", type: "SELL", price: curPrice, ts: new Date().toISOString() };
      tradeLog.unshift(t); await learnFromTrade(t); delete openTrades[sym]; continue;
    }

    // 5. Hard stop
    if (pnlPct <= -CONFIG.HARD_STOP_PCT) {
      await alpaca("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: sym, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }) });
      const t = { symbol: sym, pnl: parseFloat(pos.unrealized_pl), pnlPct, entryPrice: pos.avg_entry_price, exitPrice: curPrice, reason: entry.reason, setup: entry.setup, exitReason: "HARD STOP", type: "STOP", price: curPrice, ts: new Date().toISOString() };
      tradeLog.unshift(t); await learnFromTrade(t); delete openTrades[sym]; continue;
    }

    // 6. Volume dry-up → reduce 50%
    if (tech?.volDryUp && !entry.volumeReduced) {
      const reduceQty = Math.floor(parseFloat(pos.qty) * CONFIG.VOLUME_DRY_REDUCE);
      if (reduceQty >= 1) {
        await alpaca("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: sym, qty: String(reduceQty), side: "sell", type: "market", time_in_force: "day" }) });
        entry.volumeReduced = true;
        tradeLog.unshift({ type: "REDUCE", symbol: sym, qty: reduceQty, price: curPrice, reason: "Volume dry-up", ts: new Date().toISOString() });
      }
    }

    // 7. Below 9 EMA after half sold
    if (tech?.ema9 && curPrice < parseFloat(tech.ema9) && entry.halfSold) {
      await alpaca("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: sym, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }) });
      const t = { symbol: sym, pnl: parseFloat(pos.unrealized_pl), pnlPct, entryPrice: pos.avg_entry_price, exitPrice: curPrice, reason: entry.reason, setup: entry.setup, exitReason: "BELOW 9 EMA", type: "SELL", price: curPrice, ts: new Date().toISOString() };
      tradeLog.unshift(t); await learnFromTrade(t); delete openTrades[sym];
    }
  }
};

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER ENGINE — order flow integrated
// ════════════════════════════════════════════════════════════════════════════

const autoTrade = async () => {
  lastScanTime = new Date().toISOString();
  const marketStatus = isOpen() ? "OPEN" : isPre() ? "PRE-MARKET" : "AFTER-HOURS";
  console.log(`🔍 Scanning [${marketStatus}]...`);
  try {
    const [positions, account] = await Promise.all([alpaca("/v2/positions").catch(() => []), alpaca("/v2/account").catch(() => null)]);
    await managePositions(positions);
    const cash = account ? parseFloat(account.cash) : 0;
    const posSize = Math.max(CONFIG.MIN_POSITION_USD, cash * CONFIG.POSITION_PCT);
    if (cash < CONFIG.MIN_POSITION_USD) { console.log("⚠️ Low cash"); return; }

    const gainers = await getTopGainers();
    lastGainers   = gainers.slice(0, 20);
    if (!gainers.length) { console.log("⏭️ No gainers"); return; }
    console.log(`📊 ${gainers.length} gainers | Top: ${gainers.slice(0, 5).map(g => `${g.ticker}+${g.dp?.toFixed(0)}%`).join(", ")}`);

    const owned      = Array.isArray(positions) ? positions.map(p => p.symbol) : [];
    const candidates = gainers.filter(g => !owned.includes(g.ticker)).slice(0, 10);
    if (!candidates.length) return;

    // Full analysis including order flow
    const analysisResults = await Promise.all(candidates.map(async g => {
      const [info, tech, l2, orderFlow] = await Promise.all([
        analyzeStock(g.ticker, g.c, g.dp),
        getFullTechnicals(g.ticker, g.c),
        getLevel2(g.ticker),
        getOrderFlow(g.ticker, g.c),
      ]);
      return { ...g, info, tech, l2, orderFlow };
    }));

    // Filter: volume ratio AND order flow must agree
    const qualified = analysisResults.filter(s => {
      const volRatio = parseFloat(s.tech?.volRatio || 0);
      const volOk    = volRatio >= CONFIG.MIN_VOLUME_RATIO || s.dp >= 20;
      const flowOk   = !s.orderFlow || s.orderFlow.entryScore >= 1; // at least 1 signal
      return volOk && flowOk;
    });

    if (!qualified.length) { console.log("⏭️ No stocks passed filters"); return; }

    // Build candidate string WITH order flow data
    const candStr = qualified.slice(0, 6).map(s => {
      const t = s.tech, l = s.l2, of = s.orderFlow;
      return (
        `${s.ticker}: $${s.c} +${s.dp?.toFixed(1)}% | Float:${s.info?.float}M\n` +
        `Tech: VWAP ${t?.aboveVWAP ? "↑ABOVE" : "↓below"} | EMA9:$${t?.ema9} | Vol:${t?.volRatio}x\n` +
        `Setups: SD_Flip:${t?.sdFlip?.detected ? "YES✅" : "no"} | DipRip:${t?.dipRip?.detected ? "YES✅" : "no"} | VWAPreclaim:${t?.vwapReclaim ? "YES✅" : "no"}\n` +
        `L2: ${l?.signal || "no data"} | Bid/Ask: ${l?.bidAskRatio || "?"}\n` +
        `OrderFlow Grade: ${of?.entryGrade || "no data"}\n` +
        `  ${of?.footprint  ? `Footprint: ${of.footprint.buyPct}% buys | ${of.footprint.imbalance} | ${of.footprint.signal}` : "Footprint: no data"}\n` +
        `  ${of?.liqMap     ? `LiqMap: ${of.liqMap.signal} | Ratio: ${of.liqMap.liqRatio}x` : "LiqMap: no data"}\n` +
        `  ${of?.volProfile ? `VolProfile: VPOC $${of.volProfile.vpoc} | ${of.volProfile.signal}` : "VolProfile: no data"}\n` +
        `News: ${s.info?.headlines?.split("\n")[0] || "no news"}`
      );
    }).join("\n\n");

    lastAnalysis = candStr;

    const verdict = await groq(
      `REAL stocks with FULL order flow data — pick using Kev's strategy:\n\n${candStr}\n\n` +
      `Apply combined rules:\n` +
      `1. Kev setup confirmed? (SD flip / dip&rip / VWAP reclaim)\n` +
      `2. Footprint: buy volume >52%? Delta positive?\n` +
      `3. Liquidity map: bid wall below? Thin ask above?\n` +
      `4. Volume profile: above VPOC? In value area?\n` +
      `5. ALL signals aligned = highest conviction\n\n` +
      `Pick ALL that qualify (conviction ${CONFIG.MIN_CONVICTION}+).\n` +
      `Reply ONLY:\nBUY: TICKER | CONVICTION: X | SETUP: name | REASON: one line`, 600
    );

    console.log("🤖 AI verdict:", verdict);
    const buyLines = verdict.split("\n").filter(l => l.startsWith("BUY:"));
    let buys = 0;

    for (const line of buyLines) {
      const m = line.match(/BUY:\s*([A-Z]+)\s*\|\s*CONVICTION:\s*([\d.]+)/i);
      if (!m) continue;
      const ticker     = m[1].toUpperCase();
      const conviction = parseFloat(m[2]);
      if (conviction < CONFIG.MIN_CONVICTION) continue;
      if (owned.includes(ticker)) continue;
      const stock = qualified.find(s => s.ticker === ticker);
      if (!stock || stock.c <= 0) { console.log(`🚫 ${ticker} not in qualified`); continue; }

      // Hard gate: if order flow score is 0 AND conviction < 9, skip
      if (stock.orderFlow && stock.orderFlow.entryScore === 0 && conviction < 9) {
        console.log(`🚫 ${ticker} — order flow all red, skipping`); continue;
      }
      if (stock.l2 && parseFloat(stock.l2.bidAskRatio) < 0.5) {
        console.log(`🚫 ${ticker} — big seller on L2`); continue;
      }

      const qty    = Math.floor(posSize / stock.c);
      if (qty < 1) continue;
      const setup  = line.match(/SETUP:\s*([a-z_]+)/i)?.[1] || "momentum";
      const reason = line.match(/REASON:\s*(.+)/i)?.[1]   || "Kev + OrderFlow signal";

      console.log(`🚀 BUY ${ticker} x${qty} @ $${stock.c} | ${setup} | c${conviction} | OF:${stock.orderFlow?.entryGrade}`);
      const order = await alpaca("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: ticker, qty: String(qty), side: "buy", type: "market", time_in_force: "day" }) });
      if (order.id) {
        openTrades[ticker] = { reason, setup, conviction, entryPrice: stock.c, qty, halfSold: false, peakPrice: stock.c, time: new Date().toISOString(), orderFlowAtEntry: stock.orderFlow?.entryGrade };
        tradeLog.unshift({ type: "BUY", symbol: ticker, qty, price: stock.c, conviction, reason, setup, target: (stock.c * (1 + CONFIG.FIRST_TARGET_PCT / 100)).toFixed(2), stop: (stock.c * (1 - CONFIG.HARD_STOP_PCT / 100)).toFixed(2), l2: stock.l2?.signal, orderFlow: stock.orderFlow?.entryGrade, ts: new Date().toISOString() });
        await supabase("pulsetrader_trades", { method: "POST", body: JSON.stringify({ symbol: ticker, side: "LONG", qty, entry_price: stock.c, reason: `AUTO[${setup}|c${conviction}|OF:${stock.orderFlow?.entryScore}/3]: ${reason}` }) }).catch(() => {});
        buys++; console.log(`✅ Bought ${ticker}`);
      }
    }
    if (buys === 0) console.log("⏭️ No qualifying entries this cycle");
  } catch (e) { console.error("Auto-trade error:", e.message); }
};

// ════════════════════════════════════════════════════════════════════════════
// CONTROLS
// ════════════════════════════════════════════════════════════════════════════

const startAutoTrader = () => {
  if (autoTraderActive) return;
  autoTraderActive = true;
  console.log("🤖 Auto-trader STARTED — Kev + Order Flow");
  autoTrade();
  scanInterval = setInterval(autoTrade, CONFIG.SCAN_INTERVAL);
};
const stopAutoTrader = () => {
  if (scanInterval) clearInterval(scanInterval);
  autoTraderActive = false; scanInterval = null;
  console.log("⏹️ Stopped");
};

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/autotrader/start", (_, res) => { startAutoTrader(); res.json({ status: "started", config: CONFIG }); });
app.get( "/api/autotrader/start", (_, res) => { startAutoTrader(); res.json({ status: "started" }); });
app.post("/api/autotrader/stop",  (_, res) => { stopAutoTrader();  res.json({ status: "stopped" }); });

app.get("/api/autotrader/status", async (req, res) => {
  const [positions, account] = await Promise.all([alpaca("/v2/positions").catch(() => []), alpaca("/v2/account").catch(() => null)]);
  const todayPnL = account ? parseFloat(account.equity) - parseFloat(account.last_equity) : 0;
  res.json({
    active: autoTraderActive, last_scan: lastScanTime,
    open_positions: Array.isArray(positions) ? positions.length : 0,
    market_status: isOpen() ? "OPEN" : isPre() ? "PRE-MARKET" : "AFTER-HOURS",
    equity: account ? parseFloat(account.equity).toFixed(2) : "—",
    cash:   account ? parseFloat(account.cash).toFixed(2) : "—",
    today_pnl: todayPnL.toFixed(2),
    today_pnl_pct: account ? ((todayPnL / parseFloat(account.last_equity)) * 100).toFixed(2) + "%" : "—",
    config: { position_pct: (CONFIG.POSITION_PCT * 100) + "%", first_target: CONFIG.FIRST_TARGET_PCT + "%", trail_stop: CONFIG.TRAIL_STOP_PCT + "%", hard_stop: CONFIG.HARD_STOP_PCT + "%", min_conviction: CONFIG.MIN_CONVICTION, min_volume_ratio: CONFIG.MIN_VOLUME_RATIO + "x", scan_interval: "3 min", order_flow: "footprint+heatmap+volprofile" },
    recent_trades: tradeLog.slice(0, 20), last_gainers: lastGainers, last_analysis: lastAnalysis,
    brain: { total_trades: BRAIN.totalTrades, wins: BRAIN.wins, losses: BRAIN.losses, win_rate: BRAIN.totalTrades > 0 ? ((BRAIN.wins / BRAIN.totalTrades) * 100).toFixed(1) + "%" : "0%", total_pnl: BRAIN.totalPnL.toFixed(2), best_setups: BRAIN.bestSetups, best_tickers: BRAIN.bestTickers, lessons: BRAIN.lessons, adjusted_target: BRAIN.adjustedFirstTarget + "%", adjusted_stop: BRAIN.adjustedStop + "%" },
  });
});

app.post("/api/autotrader/scan",    async (req, res) => { res.json({ message: "Scan triggered" }); autoTrade(); });
app.get( "/api/autotrader/brain",   (_, res) => res.json(BRAIN));
app.get( "/api/autotrader/gainers", (_, res) => res.json({ gainers: lastGainers, analysis: lastAnalysis, ts: lastScanTime }));

app.post("/api/autotrader/sellall", async (req, res) => {
  try {
    const p = await alpaca("/v2/positions");
    if (!Array.isArray(p) || !p.length) return res.json({ message: "No positions" });
    await Promise.all(p.map(x => alpaca("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: x.symbol, qty: x.qty, side: "sell", type: "market", time_in_force: "day" }) })));
    res.json({ message: `Sold ${p.length} positions` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Order Flow Routes ────────────────────────────────────────────────────

app.get("/api/orderflow/:ticker", async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const quote  = await finnhub(`/quote?symbol=${ticker}`);
    const of     = await getOrderFlow(ticker, quote.c || 0);
    res.json({ ticker, price: quote.c, pct: quote.dp, orderFlow: of, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/footprint/:ticker", async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const fp = await getFootprint(ticker);
    res.json({ ticker, footprint: fp, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/heatmap/:ticker", async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const lm = await getLiquidityMap(ticker);
    res.json({ ticker, heatmap: lm, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/volumeprofile/:ticker", async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const vp = await getVolumeProfile(ticker);
    res.json({ ticker, volumeProfile: vp, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Movers ───────────────────────────────────────────────────────────────

app.get("/api/movers", async (req, res) => {
  try {
    const rawGainers = await getTopGainers();
    lastGainers = rawGainers.slice(0, 20);
    if (!rawGainers.length) return res.json({ gainers: [], analysis: "No real gainers right now. Check back at market open.", scanned: 0, ts: new Date().toISOString() });

    const top = rawGainers.slice(0, 15);
    const enriched = await Promise.all(top.map(async (g) => {
      try {
        const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0];
        const today        = new Date().toISOString().split("T")[0];
        const [profile, news] = await Promise.all([finnhub(`/stock/profile2?symbol=${g.ticker}`), finnhub(`/company-news?symbol=${g.ticker}&from=${threeDaysAgo}&to=${today}`)]);
        const topNews  = Array.isArray(news) ? news.slice(0, 3).map(n => ({ headline: n.headline, source: n.source, url: n.url, datetime: n.datetime })) : [];
        const catalyst = topNews[0]?.headline || null;
        const volFmt   = g.v >= 1_000_000 ? (g.v / 1_000_000).toFixed(1) + "M" : g.v >= 1_000 ? (g.v / 1_000).toFixed(0) + "K" : String(g.v || 0);
        return { symbol: g.ticker, name: profile?.name || g.ticker, price: parseFloat(g.c || 0).toFixed(2), change_pct: parseFloat(g.dp || 0).toFixed(2), volume: g.v || 0, volume_fmt: volFmt, float: profile?.shareOutstanding || null, mkt_cap: profile?.marketCapitalization || null, industry: profile?.finnhubIndustry || null, news: topNews, catalyst, source: g.source || "scan" };
      } catch (_) {
        const volFmt = g.v >= 1_000_000 ? (g.v / 1_000_000).toFixed(1) + "M" : g.v >= 1_000 ? (g.v / 1_000).toFixed(0) + "K" : String(g.v || 0);
        return { symbol: g.ticker, name: g.ticker, price: parseFloat(g.c || 0).toFixed(2), change_pct: parseFloat(g.dp || 0).toFixed(2), volume: g.v || 0, volume_fmt: volFmt, float: null, mkt_cap: null, industry: null, news: [], catalyst: null, source: g.source || "scan" };
      }
    }));

    let analysis = "";
    try {
      const top5Str = enriched.slice(0, 5).map(g => `${g.symbol} (${g.name}): $${g.price} +${g.change_pct}% | Vol: ${g.volume_fmt} | Catalyst: ${g.catalyst || "none"}`).join("\n\n");
      analysis = await groq(`REAL top gainers:\n\n${top5Str}\n\nApply Kev's strategy. For each: setup? entry? target? conviction?\nEnd with: #1 PICK: [TICKER] — [reason]`, 600);
    } catch (_) { analysis = "AI analysis unavailable."; }

    res.json({ gainers: enriched, analysis, scanned: rawGainers.length, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── News ─────────────────────────────────────────────────────────────────

app.get("/api/news", async (req, res) => {
  const { ticker } = req.query;
  try {
    const today = new Date().toISOString().split("T")[0];
    const week  = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const news  = ticker
      ? await finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`)
      : await finnhub("/news?category=general");
    res.json((Array.isArray(news) ? news : []).slice(0, 20).map(n => ({ headline: n.headline, summary: n.summary || null, source: n.source, url: n.url, datetime: n.datetime, ticker: ticker?.toUpperCase() || null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Remaining routes (unchanged) ────────────────────────────────────────

app.post("/api/teach", async (req, res) => {
  const { tickers, context, instruction } = req.body;
  if (!tickers?.length) return res.status(400).json({ error: "tickers required" });
  const list = Array.isArray(tickers) ? tickers : [tickers];
  const lessons = [];
  for (const ticker of list) {
    try {
      const week = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
      const today = new Date().toISOString().split("T")[0];
      const [quote, profile, news, tech, l2, orderFlow] = await Promise.all([finnhub(`/quote?symbol=${ticker.toUpperCase()}`), finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`), finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`), getFullTechnicals(ticker.toUpperCase(), 0), getLevel2(ticker.toUpperCase()), getOrderFlow(ticker.toUpperCase(), 0)]);
      const headlines = Array.isArray(news) ? news.slice(0, 6).map(n => `- ${n.headline}`).join("\n") : "No news.";
      const analysis = await groq(`${instruction || "Analyze using Kev's strategy + order flow"}\n\n${ticker.toUpperCase()}: $${quote.c} | +${quote.dp?.toFixed(2)}% | Float:${profile.shareOutstanding}M\nTech: SD_Flip:${tech?.sdFlip?.detected} | DipRip:${tech?.dipRip?.detected} | VWAP:${tech?.aboveVWAP ? "above" : "below"} | Vol:${tech?.volRatio}x\nL2: ${l2?.signal}\nOrderFlow: ${orderFlow?.entryGrade}\n  ${orderFlow?.summary || "no order flow"}\n${context ? "Context: " + context + "\n" : ""}News:\n${headlines}\n\nApply Kev's rules + order flow.`, 1000);
      const lesson = analysis.slice(-150);
      BRAIN.lessons.unshift(lesson); BRAIN.lessons = BRAIN.lessons.slice(0, 10);
      if (!BRAIN.bestTickers.includes(ticker.toUpperCase())) BRAIN.bestTickers.unshift(ticker.toUpperCase());
      await supabase("bot_lessons", { method: "POST", body: JSON.stringify({ ticker: ticker.toUpperCase(), lesson, pattern: instruction || "user taught", catalyst: headlines.slice(0, 200), taught_by: "user" }) }).catch(() => {});
      lessons.push({ ticker: ticker.toUpperCase(), analysis, lesson, tech, l2, orderFlow });
    } catch (e) { lessons.push({ ticker, error: e.message }); }
  }
  res.json({ message: `Studied ${lessons.length} stocks`, lessons });
});

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "No messages" });
  try {
    const [spy, account] = await Promise.all([finnhub("/quote?symbol=SPY").catch(() => null), alpaca("/v2/account").catch(() => null)]);
    const gainersStr = lastGainers.slice(0, 5).map(g => `${g.ticker || g.symbol}+${(g.dp || g.change_pct)?.toFixed ? (g.dp || g.change_pct).toFixed(0) : (g.dp || g.change_pct)}%`).join(",") || "scanning";
    const ctx = [spy?.c ? `[SPY $${spy.c} (${spy.dp > 0 ? "+" : ""}${spy.dp?.toFixed(2)}%)]` : "", account ? `[Portfolio: $${parseFloat(account.equity).toFixed(0)} | Cash: $${parseFloat(account.cash).toFixed(0)}]` : "", autoTraderActive ? `[Bot: RUNNING | Kev+OrderFlow | Top: ${gainersStr}]` : "[Bot: PAUSED]", BRAIN.totalTrades > 0 ? `[Brain: ${BRAIN.totalTrades} trades | ${((BRAIN.wins / BRAIN.totalTrades) * 100).toFixed(0)}% wins | $${BRAIN.totalPnL.toFixed(0)} P&L]` : ""].filter(Boolean).join(" ");
    const last = messages[messages.length - 1];
    const enriched = [...messages.slice(0, -1), { ...last, content: last.content + "\n" + ctx }];
    res.json({ reply: await groqChat(enriched) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/spikes", async (req, res) => {
  try {
    const gainers = await getTopGainers();
    if (!gainers.length) return res.json({ data: "No candidates.", candidates: [], ts: new Date().toISOString() });
    const early = gainers.filter(g => g.dp > 5 && g.dp < 40).slice(0, 8);
    if (!early.length) return res.json({ data: "All movers already extended.", candidates: [], ts: new Date().toISOString() });
    const str = early.map(g => `${g.ticker} +${g.dp?.toFixed(1)}% $${g.c}`).join("\n");
    const ai  = await groq(`Early movers — Kev's rules:\n${str}\n\nS/D flip? Dip & rip entry? Order flow? Best 3 to enter NOW?`, 800);
    res.json({ data: ai, candidates: early, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/quote", async (req, res) => {
  const { ticker = "SPY" } = req.query;
  try {
    const [q, p] = await Promise.all([finnhub(`/quote?symbol=${ticker.toUpperCase()}`), finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`)]);
    res.json({ ticker, price: q.c, change: q.d, pct: q.dp, high: q.h, low: q.l, open: q.o, prev: q.pc, name: p.name, industry: p.finnhubIndustry, market_cap: p.marketCapitalization, float: p.shareOutstanding });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/edgar", async (req, res) => {
  const { ticker = "NVDA" } = req.query;
  try {
    const week = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [p, n, tech, l2, of] = await Promise.all([finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`), finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`), getFullTechnicals(ticker.toUpperCase(), 0), getLevel2(ticker.toUpperCase()), getOrderFlow(ticker.toUpperCase(), 0)]);
    const headlines = Array.isArray(n) ? n.slice(0, 8).map(x => `- ${x.headline}`).join("\n") : "No news.";
    const ai = await groq(`${ticker.toUpperCase()} | Float:${p.shareOutstanding}M | Cap:$${p.marketCapitalization}B\nSD_Flip:${tech?.sdFlip?.detected} | DipRip:${tech?.dipRip?.detected} | Vol:${tech?.volRatio}x\nL2: ${l2?.signal}\nOrderFlow: ${of?.entryGrade}\n${of?.summary || ""}\nNews:\n${headlines}\n\nKev's setup + order flow? Entry, target, stop, conviction.`);
    res.json({ ticker: ticker.toUpperCase(), data: ai, tech, l2, orderFlow: of, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/earnings", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const next7 = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
    const cal   = await finnhub(`/calendar/earnings?from=${today}&to=${next7}`);
    const top   = cal?.earningsCalendar?.slice(0, 20) || [];
    const list  = top.map(e => `${e.symbol}|${e.date}|EPS:${e.epsEstimate ?? "N/A"}`).join("\n");
    const ai    = await groq(`Earnings:\n${list || "No data"}\n\nKev setups? S/D flip potential? Entry, target, stop.`);
    res.json({ calendar: top, ai_summary: ai, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/account", async (req, res) => {
  try {
    const d = await alpaca("/v2/account");
    const pnl = parseFloat(d.equity) - parseFloat(d.last_equity);
    res.json({ equity: parseFloat(d.equity).toFixed(2), cash: parseFloat(d.cash).toFixed(2), buying_power: parseFloat(d.buying_power).toFixed(2), portfolio_value: parseFloat(d.portfolio_value).toFixed(2), pnl_today: pnl.toFixed(2), pnl_today_pct: ((pnl / parseFloat(d.last_equity)) * 100).toFixed(2) + "%", day_trade_count: d.daytrade_count, status: d.status, paper: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/holdings", async (req, res) => {
  try {
    const positions = await alpaca("/v2/positions");
    if (!Array.isArray(positions) || !positions.length) return res.json({ holdings: [], total_value: "0.00", total_pnl: "0.00", total_pnl_today: "0.00", count: 0 });
    const holdings = positions.map(p => ({ symbol: p.symbol, qty: parseFloat(p.qty), side: p.side, avg_entry: parseFloat(p.avg_entry_price).toFixed(2), current_price: parseFloat(p.current_price).toFixed(2), market_value: parseFloat(p.market_value).toFixed(2), unrealized_pnl: parseFloat(p.unrealized_pl).toFixed(2), unrealized_pnl_pct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + "%", today_pnl: parseFloat(p.unrealized_intraday_pl).toFixed(2), today_pnl_pct: (parseFloat(p.unrealized_intraday_plpc) * 100).toFixed(2) + "%", first_target: (parseFloat(p.avg_entry_price) * (1 + CONFIG.FIRST_TARGET_PCT / 100)).toFixed(2), hard_stop: (parseFloat(p.avg_entry_price) * (1 - CONFIG.HARD_STOP_PCT / 100)).toFixed(2), half_sold: openTrades[p.symbol]?.halfSold || false, setup: openTrades[p.symbol]?.setup || "unknown", order_flow_entry: openTrades[p.symbol]?.orderFlowAtEntry || "—" }));
    res.json({ holdings, total_value: holdings.reduce((s, h) => s + parseFloat(h.market_value), 0).toFixed(2), total_pnl: holdings.reduce((s, h) => s + parseFloat(h.unrealized_pnl), 0).toFixed(2), total_pnl_today: holdings.reduce((s, h) => s + parseFloat(h.today_pnl), 0).toFixed(2), count: holdings.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/orders", async (req, res) => {
  try {
    const o = await alpaca("/v2/orders?status=all&limit=25&direction=desc");
    if (!Array.isArray(o)) return res.json([]);
    res.json(o.map(x => ({ id: x.id, symbol: x.symbol, side: x.side, type: x.type, qty: x.qty, filled_qty: x.filled_qty, price: x.filled_avg_price || x.limit_price || null, status: x.status, submitted: x.submitted_at, filled: x.filled_at })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/order", async (req, res) => {
  const { symbol, side, qty, type = "market", limit_price, time_in_force = "day" } = req.body;
  if (!symbol || !side || !qty) return res.status(400).json({ error: "symbol,side,qty required" });
  try {
    const body = { symbol: symbol.toUpperCase(), side, qty: String(qty), type, time_in_force };
    if (type === "limit" && limit_price) body.limit_price = String(limit_price);
    res.json({ success: true, order: await alpaca("/v2/orders", { method: "POST", body: JSON.stringify(body) }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/bars", async (req, res) => {
  const { ticker = "SPY", timeframe = "5Min", limit = 78 } = req.query;
  try {
    const d = await alpacaData(`/v2/stocks/${ticker.toUpperCase()}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`);
    res.json({ ticker: ticker.toUpperCase(), bars: d.bars || [], ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/pnl", async (req, res) => {
  try {
    const trades = await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    if (!Array.isArray(trades)) return res.status(500).json({ error: "DB error" });
    const closed = trades.filter(t => t.pnl != null), open = trades.filter(t => t.pnl == null);
    const total = closed.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    const winners = closed.filter(t => parseFloat(t.pnl) > 0).length;
    const best  = closed.reduce((b, t) => (!b || parseFloat(t.pnl) > parseFloat(b.pnl) ? t : b), null);
    const worst = closed.reduce((b, t) => (!b || parseFloat(t.pnl) < parseFloat(b.pnl) ? t : b), null);
    res.json({ summary: { total_pnl: total.toFixed(2), avg_pnl: closed.length ? (total / closed.length).toFixed(2) : "0.00", win_rate: closed.length ? ((winners / closed.length) * 100).toFixed(1) + "%" : "0%", total_trades: trades.length, closed: closed.length, open: open.length, winners, losers: closed.length - winners, best_trade: best ? { symbol: best.symbol, pnl: best.pnl } : null, worst_trade: worst ? { symbol: worst.symbol, pnl: worst.pnl } : null }, recent: trades.slice(0, 15), open_positions: open });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/trades", async (req, res) => {
  try { res.json(await supabase("pulsetrader_trades?order=created_at.desc&limit=500").then(d => Array.isArray(d) ? d : [])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/trade", async (req, res) => {
  const { symbol, side, qty, entry_price, exit_price, reason } = req.body;
  if (!symbol || !side || !qty || !entry_price) return res.status(400).json({ error: "required fields missing" });
  let pnl = null, pnl_pct = null;
  if (exit_price) { const dir = side.toUpperCase() === "SHORT" ? -1 : 1; pnl = ((+exit_price - +entry_price) * +qty * dir).toFixed(2); pnl_pct = (((+exit_price - +entry_price) / +entry_price) * 100 * dir).toFixed(2); }
  try {
    const r = await supabase("pulsetrader_trades", { method: "POST", body: JSON.stringify({ symbol: symbol.toUpperCase(), side: side.toUpperCase(), qty: +qty, entry_price: +entry_price, exit_price: exit_price ? +exit_price : null, pnl: pnl ? +pnl : null, pnl_pct: pnl_pct ? +pnl_pct : null, reason: reason || null }) });
    res.json({ success: true, trade: Array.isArray(r) ? r[0] : r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/trade/:id", async (req, res) => {
  try { await supabase(`pulsetrader_trades?id=eq.${req.params.id}`, { method: "DELETE" }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const [account, positions, trades] = await Promise.all([alpaca("/v2/account").catch(() => null), alpaca("/v2/positions").catch(() => []), supabase("pulsetrader_trades?order=created_at.desc&limit=500").catch(() => [])]);
    const t = Array.isArray(trades) ? trades : [], closed = t.filter(x => x.pnl != null), total = closed.reduce((s, x) => s + parseFloat(x.pnl || 0), 0), winners = closed.filter(x => parseFloat(x.pnl) > 0).length, todayPnL = account ? parseFloat(account.equity) - parseFloat(account.last_equity) : 0;
    res.json({ account: account ? { equity: parseFloat(account.equity).toFixed(2), cash: parseFloat(account.cash).toFixed(2), pnl_today: todayPnL.toFixed(2), pnl_today_pct: ((todayPnL / parseFloat(account.last_equity)) * 100).toFixed(2) + "%" } : null, auto_trader: { active: autoTraderActive, last_scan: lastScanTime, recent_trades: tradeLog.slice(0, 5) }, brain: { win_rate: BRAIN.totalTrades > 0 ? ((BRAIN.wins / BRAIN.totalTrades) * 100).toFixed(1) + "%" : "0%", total_trades: BRAIN.totalTrades, total_pnl: BRAIN.totalPnL.toFixed(2), lessons: BRAIN.lessons.slice(0, 3) }, holdings: Array.isArray(positions) ? positions.map(p => ({ symbol: p.symbol, qty: parseFloat(p.qty), avg_entry: parseFloat(p.avg_entry_price).toFixed(2), current_price: parseFloat(p.current_price).toFixed(2), unrealized_pnl: parseFloat(p.unrealized_pl).toFixed(2), unrealized_pnl_pct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + "%", setup: openTrades[p.symbol]?.setup || "unknown", half_sold: openTrades[p.symbol]?.halfSold || false })) : [], trade_summary: { total_pnl: total.toFixed(2), win_rate: closed.length ? ((winners / closed.length) * 100).toFixed(1) + "%" : "0%", total_trades: t.length, open: t.filter(x => x.pnl == null).length, closed: closed.length } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (_, res) => res.json({ status: "ok", version: "10.0.0", ai: "groq-llama-3.3-70b", mode: "paper", strategy: "Kev (@trade.momentum) + Footprint + LiquidityMap + VolumeProfile", order_flow: "footprint+heatmap+volprofile", auto_trader: autoTraderActive, brain_trades: BRAIN.totalTrades, win_rate: BRAIN.totalTrades > 0 ? ((BRAIN.wins / BRAIN.totalTrades) * 100).toFixed(1) + "%" : "learning", market_status: isOpen() ? "OPEN" : isPre() ? "PRE-MARKET" : "AFTER-HOURS", ts: new Date().toISOString() }));

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`⚡ PulseTrader v10.0 — Kev's Strategy + Order Flow Intelligence on port ${PORT}`);
  console.log(`   Strategy  : S/D Flip | Dip & Rip EMA | VWAP Reclaim | AH Gapper`);
  console.log(`   OrderFlow : Footprint Charts | Liquidity Heat Map | Volume Profile`);
  console.log(`   Security  : Passcode protected (set PASSCODE env var on Render)`);
  console.log(`   Exits     : 50% at +20% | Trail | OrderFlow exit | Vol dry`);
  console.log(`   Mode      : PAPER TRADING`);
  await loadMemory();
  console.log("🤖 Auto-starting Kev's strategy + Order Flow...");
  startAutoTrader();
});
