// ╔══════════════════════════════════════════════════════════════════════════╗
// ║      PULSETRADER — SELF-LEARNING AUTO TRADER v6.0                       ║
// ║      Scans → Learns → Improves → Trades → Gets smarter every cycle      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import express from "express";
import cors    from "cors";
import fetch   from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ════════════════════════════════════════════════════════════════════════════
// BOT CONFIG — dynamically adjusted by self-learning
// ════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  MAX_POSITIONS:      5,
  POSITION_SIZE:      1000,
  MIN_SPIKE_PCT:      3,
  MAX_PRICE:          20,
  MIN_PRICE:          0.50,
  MIN_VOLUME:         50000,     // min daily volume — avoids illiquid traps
  PROFIT_TARGET_PCT:  25,
  STOP_LOSS_PCT:      10,
  SCAN_INTERVAL_MS:   5 * 60 * 1000,
  MIN_CONVICTION:     7,         // only take conviction 7+ trades
  MAX_SPREAD_PCT:     5,         // max bid/ask spread
};

// Bot brain — learns over time
const BRAIN = {
  totalTrades:      0,
  wins:             0,
  losses:           0,
  totalPnL:         0,
  avgWinPct:        0,
  avgLossPct:       0,
  bestSetups:       {},   // which setups win most
  bestHours:        {},   // best hours to trade
  bestSectors:      {},   // best sectors
  worstTickers:     [],   // tickers to avoid
  bestTickers:      [],   // tickers that keep winning
  recentPerformance:[],   // last 20 trades
  adjustedTarget:   25,   // dynamically adjusted profit target
  adjustedStop:     10,   // dynamically adjusted stop loss
  lastLearned:      null,
};

// Session state
const tradeLog     = [];
const openTrades   = {};  // track entry time for each position
let autoTraderActive = false;
let scanInterval     = null;
let lastScanTime     = null;
let lastScanResults  = [];

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — evolves with learning
// ════════════════════════════════════════════════════════════════════════════

const buildSystem = () => {
  const winRate = BRAIN.totalTrades > 0
    ? ((BRAIN.wins / BRAIN.totalTrades) * 100).toFixed(1)
    : "unknown";

  const bestSetupStr = Object.entries(BRAIN.bestSetups)
    .sort((a,b) => b[1].winRate - a[1].winRate)
    .slice(0,3)
    .map(([k,v]) => `${k}: ${v.winRate.toFixed(0)}% win rate`)
    .join(", ") || "still learning";

  const avoidStr = BRAIN.worstTickers.slice(0,5).join(", ") || "none yet";
  const bestStr  = BRAIN.bestTickers.slice(0,5).join(", ")  || "none yet";

  return `You are PulseTrader — an elite self-learning AI momentum trader.
You specialize in small cap stocks under $20 with spike potential.

YOUR CURRENT PERFORMANCE:
- Win rate: ${winRate}% (${BRAIN.wins}W / ${BRAIN.losses}L)
- Total P&L: $${BRAIN.totalPnL.toFixed(2)}
- Best setups: ${bestSetupStr}
- Tickers to AVOID (losers): ${avoidStr}
- Proven winners: ${bestStr}
- Optimal target: +${BRAIN.adjustedTarget}% | Stop: -${BRAIN.adjustedStop}%

WHAT YOU KNOW WORKS:
1. Volume surge 3x+ above average BEFORE price explodes
2. Low float under 10M shares — small buys = big moves
3. Strong catalyst: FDA, earnings beat, contract, short squeeze
4. Breakout above key resistance with conviction
5. First 30 min of market open (9:30-10:00 AM ET) = highest success
6. Never buy stocks already up 50%+ — too late

WHAT YOU KNOW FAILS:
1. Low volume under 50k shares/day — can't exit
2. No catalyst — just random movement
3. Stocks already at 52-week highs with no news
4. Buying after a big gap with no continuation volume

ENTRY RULES:
- Only take conviction 7/10 or higher
- Must have real catalyst or volume surge
- Price must be $0.50-$20
- Volume must be meaningful
- Check if ticker is on avoid list

EXIT RULES:
- Profit target: +${BRAIN.adjustedTarget}% (take 50% off, trail rest)
- Stop loss: -${BRAIN.adjustedStop}%
- Volume dry-up = exit immediately regardless of P&L
- Never hold through unknown binary events

FORMAT: BUY: TICKER | CONVICTION: X | SETUP: type | REASON: one line`;
};

// ════════════════════════════════════════════════════════════════════════════
// SMALL CAP UNIVERSE — 200 tickers
// ════════════════════════════════════════════════════════════════════════════

const SMALL_CAPS = [
  // Biotech/Pharma
  "HCWB","IMVT","SLXN","PHGE","CCTG","NNNN","CUE","CODX","SIGA","ATOS",
  "MGNX","OCGN","NVAX","ADMA","NKTR","ALDX","BNGO","EDSA","FBRX","HTBX",
  "SAVA","ACIU","NERV","OPGN","SRNE","TGTX","KMPH","LXRX","FREQ","DCPH",
  // Tech micro-cap
  "MLGO","SOUN","CLSK","MARA","RIOT","CIFR","BTBT","BITF","HUT","WULF",
  "EGHT","GMEX","KULR","MULN","STEM","VERB","XCUR","INPX","RVNC","QUBT",
  "SMAR","KPLT","LMND","MNMD","VERB","PAYO","DFIN","JFIN","NXTP","OPRX",
  // Energy/Mining
  "TE","PETZ","GCL","MEHA","BTM","ORBS","AMMO","BORR","DUNE","FLNC",
  "GPOR","HPCO","ENSV","CALI","NINE","MIND","TPIC","LOOP","KALI","SOLO",
  // Consumer
  "RRGB","STFS","JDZG","CAPS","CTEV","SLQT","GIPR","CDT","WNW","MSGY",
  "BBCP","CLFD","HIMS","JSPR","OPEN","TDUP","ACMR","IRNT","FBRT","GBOX",
  // Squeeze candidates
  "SPCE","NKLA","WKHS","RIDE","FSR","LCID","GOEV","ARVL","ACTC","EMBK",
  "CLOV","WISH","IDEX","NAKD","SNDL","BBBY","EXPR","HYLN","XL","AMC",
  // Crypto/Blockchain
  "COIN","MARA","RIOT","CIFR","BTBT","BITF","HUT","WULF","CLSK","MSTR",
  // Growth small caps
  "PLTR","SOFI","HOOD","FUTU","TIGR","UWMC","OPEN","LMND","HIMS","SMAR",
  // Hot sectors
  "IRNC","ALTTF","LAUR","TRCH","MMTIF","ATXI","GNPX","NKGN","EDSA","IMVT",
  "AGEN","AGIO","AKBA","ALBO","ALEC","ALGT","ALNA","ALNY","ALRM","ALRS",
];

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

const groq = async (prompt, maxTokens = 1000) => {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization:`Bearer ${process.env.GROQ_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", max_tokens: maxTokens,
        messages: [{ role:"system", content:buildSystem() }, { role:"user", content:prompt }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || "No response.";
  } catch(err) { console.error("Groq:",err.message); return `Error: ${err.message}`; }
};

const groqChat = async (messages, maxTokens = 1200) => {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization:`Bearer ${process.env.GROQ_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", max_tokens: maxTokens,
        messages: [{ role:"system", content:buildSystem() }, ...messages],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || "No response.";
  } catch(err) { return `Error: ${err.message}`; }
};

const supabase = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey:process.env.SUPABASE_KEY, Authorization:`Bearer ${process.env.SUPABASE_KEY}`,
      "Content-Type":"application/json", Prefer:"return=representation",
    },
    ...opts,
  });
  const text = await res.text();
  return text ? JSON.parse(text) : [];
};

const alpaca = async (path, opts = {}) => {
  const res = await fetch(`https://paper-api.alpaca.markets${path}`, {
    headers: {
      "APCA-API-KEY-ID":process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY":process.env.ALPACA_SECRET,
      "Content-Type":"application/json",
    },
    ...opts,
  });
  return res.json();
};

const alpacaData = async (path) => {
  const res = await fetch(`https://data.alpaca.markets${path}`, {
    headers: {
      "APCA-API-KEY-ID":process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY":process.env.ALPACA_SECRET,
    },
  });
  return res.json();
};

const finnhub = async (path) => {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`);
  return res.json();
};

// ════════════════════════════════════════════════════════════════════════════
// SELF-LEARNING ENGINE
// ════════════════════════════════════════════════════════════════════════════

const learnFromTrade = async (trade) => {
  const won = trade.pnl > 0;

  // Update brain stats
  BRAIN.totalTrades++;
  won ? BRAIN.wins++ : BRAIN.losses++;
  BRAIN.totalPnL += trade.pnl;
  BRAIN.lastLearned = new Date().toISOString();

  // Track setup performance
  if (trade.setup) {
    if (!BRAIN.bestSetups[trade.setup]) {
      BRAIN.bestSetups[trade.setup] = { trades:0, wins:0, winRate:0 };
    }
    BRAIN.bestSetups[trade.setup].trades++;
    if (won) BRAIN.bestSetups[trade.setup].wins++;
    BRAIN.bestSetups[trade.setup].winRate =
      (BRAIN.bestSetups[trade.setup].wins / BRAIN.bestSetups[trade.setup].trades) * 100;
  }

  // Track ticker performance
  if (won) {
    if (!BRAIN.bestTickers.includes(trade.symbol)) {
      BRAIN.bestTickers.unshift(trade.symbol);
      BRAIN.bestTickers = BRAIN.bestTickers.slice(0, 10);
    }
    // Remove from worst list if it won
    BRAIN.worstTickers = BRAIN.worstTickers.filter(t => t !== trade.symbol);
  } else {
    if (!BRAIN.worstTickers.includes(trade.symbol)) {
      BRAIN.worstTickers.unshift(trade.symbol);
      BRAIN.worstTickers = BRAIN.worstTickers.slice(0, 15);
    }
  }

  // Track by hour
  const hour = new Date(trade.entryTime || Date.now()).getHours();
  if (!BRAIN.bestHours[hour]) BRAIN.bestHours[hour] = { trades:0, wins:0 };
  BRAIN.bestHours[hour].trades++;
  if (won) BRAIN.bestHours[hour].wins++;

  // Add to recent performance
  BRAIN.recentPerformance.unshift({ ...trade, won });
  BRAIN.recentPerformance = BRAIN.recentPerformance.slice(0, 20);

  // Dynamically adjust targets based on recent performance
  const recentWins = BRAIN.recentPerformance.filter(t => t.won).length;
  const recentTotal = BRAIN.recentPerformance.length;
  const recentWinRate = recentTotal > 0 ? recentWins / recentTotal : 0.5;

  if (recentWinRate > 0.65) {
    // Winning streak — be more aggressive
    BRAIN.adjustedTarget = Math.min(35, BRAIN.adjustedTarget + 2);
    BRAIN.adjustedStop   = Math.min(15, BRAIN.adjustedStop + 1);
    CONFIG.MIN_CONVICTION = Math.max(6, CONFIG.MIN_CONVICTION - 1);
  } else if (recentWinRate < 0.35) {
    // Losing streak — be more conservative
    BRAIN.adjustedTarget = Math.max(15, BRAIN.adjustedTarget - 2);
    BRAIN.adjustedStop   = Math.max(5,  BRAIN.adjustedStop - 1);
    CONFIG.MIN_CONVICTION = Math.min(9, CONFIG.MIN_CONVICTION + 1);
  }

  CONFIG.PROFIT_TARGET_PCT = BRAIN.adjustedTarget;
  CONFIG.STOP_LOSS_PCT      = BRAIN.adjustedStop;

  // Ask AI to analyze the trade and extract lessons
  const lesson = await groq(
    `I just closed a trade:\n` +
    `${trade.symbol} | ${won?"WIN":"LOSS"} | P&L: $${trade.pnl?.toFixed(2)} (${trade.pnlPct?.toFixed(1)}%)\n` +
    `Entry: $${trade.entryPrice} | Exit: $${trade.exitPrice}\n` +
    `Reason bought: ${trade.reason}\n` +
    `Setup: ${trade.setup}\n\n` +
    `In 1-2 sentences: what can we learn from this trade to improve future entries?`,
    200
  );

  console.log(`🧠 LEARNED from ${trade.symbol}: ${lesson}`);

  // Save to Supabase memory
  await supabase("bot_trade_memory", {
    method: "POST",
    body: JSON.stringify({
      symbol:      trade.symbol,
      side:        "LONG",
      entry_price: trade.entryPrice,
      exit_price:  trade.exitPrice,
      pnl:         trade.pnl,
      pnl_pct:     trade.pnlPct,
      entry_reason: trade.reason,
      exit_reason:  trade.exitReason,
      setup_type:   trade.setup,
      won,
      entry_hour:   hour,
      day_of_week:  new Date().getDay(),
    }),
  }).catch(() => {});

  return lesson;
};

// Load past learning from Supabase on startup
const loadMemory = async () => {
  try {
    const memories = await supabase("bot_trade_memory?order=created_at.desc&limit=100");
    if (!Array.isArray(memories) || !memories.length) return;

    BRAIN.totalTrades = memories.length;
    BRAIN.wins   = memories.filter(m => m.won).length;
    BRAIN.losses = memories.filter(m => !m.won).length;
    BRAIN.totalPnL = memories.reduce((s,m) => s + parseFloat(m.pnl||0), 0);

    // Rebuild setup stats
    memories.forEach(m => {
      if (m.setup_type) {
        if (!BRAIN.bestSetups[m.setup_type])
          BRAIN.bestSetups[m.setup_type] = { trades:0, wins:0, winRate:0 };
        BRAIN.bestSetups[m.setup_type].trades++;
        if (m.won) BRAIN.bestSetups[m.setup_type].wins++;
        BRAIN.bestSetups[m.setup_type].winRate =
          (BRAIN.bestSetups[m.setup_type].wins / BRAIN.bestSetups[m.setup_type].trades) * 100;
      }
      if (m.won && !BRAIN.bestTickers.includes(m.symbol))
        BRAIN.bestTickers.push(m.symbol);
      if (!m.won && !BRAIN.worstTickers.includes(m.symbol))
        BRAIN.worstTickers.push(m.symbol);
    });

    // Keep only top performers
    BRAIN.bestTickers  = BRAIN.bestTickers.slice(0, 10);
    BRAIN.worstTickers = BRAIN.worstTickers.slice(0, 15);

    console.log(`🧠 Loaded ${memories.length} past trades from memory`);
    console.log(`   Win rate: ${((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)}%`);
    console.log(`   Best tickers: ${BRAIN.bestTickers.join(",")}`);
    console.log(`   Avoid: ${BRAIN.worstTickers.join(",")}`);
  } catch(e) {
    console.log("No memory yet — starting fresh");
  }
};

// ════════════════════════════════════════════════════════════════════════════
// MARKET HOURS
// ════════════════════════════════════════════════════════════════════════════

const isMarketOpen = () => {
  const et = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const d  = et.getDay();
  if (d===0||d===6) return false;
  const t = et.getHours()*100 + et.getMinutes();
  return t>=930 && t<1600;
};

const isPreMarket = () => {
  const et = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const d  = et.getDay();
  if (d===0||d===6) return false;
  const t = et.getHours()*100 + et.getMinutes();
  return t>=400 && t<930;
};

const getCurrentHour = () =>
  new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"})).getHours();

// ════════════════════════════════════════════════════════════════════════════
// SCANNER
// ════════════════════════════════════════════════════════════════════════════

const scanMarket = async () => {
  const results = [];
  const batchSize = 15;
  for (let i=0; i<SMALL_CAPS.length; i+=batchSize) {
    const batch  = SMALL_CAPS.slice(i, i+batchSize);
    const quotes = await Promise.all(
      batch.map(t =>
        finnhub(`/quote?symbol=${t}`)
          .then(q => ({ ticker:t, ...q }))
          .catch(() => null)
      )
    );
    results.push(...quotes.filter(Boolean));
    if (i+batchSize < SMALL_CAPS.length) await new Promise(r=>setTimeout(r,250));
  }
  return results
    .filter(q =>
      q.c >= CONFIG.MIN_PRICE &&
      q.c <= CONFIG.MAX_PRICE &&
      q.dp >= CONFIG.MIN_SPIKE_PCT &&
      q.v  >= CONFIG.MIN_VOLUME &&
      !BRAIN.worstTickers.includes(q.ticker) // skip known losers
    )
    .sort((a,b) => b.dp - a.dp);
};

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER ENGINE
// ════════════════════════════════════════════════════════════════════════════

const autoTrade = async () => {
  if (!isMarketOpen() && !isPreMarket()) {
    console.log("⏸️  Market closed");
    return;
  }

  console.log("🔍 Scanning...");
  lastScanTime = new Date().toISOString();

  try {
    const [positions, account] = await Promise.all([
      alpaca("/v2/positions").catch(()=>[]),
      alpaca("/v2/account").catch(()=>null),
    ]);

    // ── Manage existing positions ──────────────────────────────────────────
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        const pnlPct = parseFloat(pos.unrealized_plpc) * 100;
        const sym    = pos.symbol;
        const entry  = openTrades[sym];

        if (pnlPct >= CONFIG.PROFIT_TARGET_PCT) {
          console.log(`🎯 PROFIT HIT: ${sym} +${pnlPct.toFixed(1)}%`);
          await alpaca("/v2/orders",{
            method:"POST",
            body:JSON.stringify({ symbol:sym, qty:pos.qty, side:"sell", type:"market", time_in_force:"day" }),
          });
          const trade = {
            symbol:sym, pnl:parseFloat(pos.unrealized_pl),
            pnlPct, entryPrice:pos.avg_entry_price,
            exitPrice:pos.current_price, reason:entry?.reason||"",
            setup:entry?.setup||"unknown", exitReason:"PROFIT TARGET",
            entryTime:entry?.time, type:"SELL",
            price:pos.current_price, ts:new Date().toISOString(),
          };
          tradeLog.unshift(trade);
          await learnFromTrade(trade);
          delete openTrades[sym];

        } else if (pnlPct <= -CONFIG.STOP_LOSS_PCT) {
          console.log(`🛑 STOP LOSS: ${sym} ${pnlPct.toFixed(1)}%`);
          await alpaca("/v2/orders",{
            method:"POST",
            body:JSON.stringify({ symbol:sym, qty:pos.qty, side:"sell", type:"market", time_in_force:"day" }),
          });
          const trade = {
            symbol:sym, pnl:parseFloat(pos.unrealized_pl),
            pnlPct, entryPrice:pos.avg_entry_price,
            exitPrice:pos.current_price, reason:entry?.reason||"",
            setup:entry?.setup||"unknown", exitReason:"STOP LOSS",
            entryTime:entry?.time, type:"STOP",
            price:pos.current_price, ts:new Date().toISOString(),
          };
          tradeLog.unshift(trade);
          await learnFromTrade(trade);
          delete openTrades[sym];
        }
      }
    }

    // ── Find new entries ───────────────────────────────────────────────────
    const openCount = Array.isArray(positions) ? positions.length : 0;
    if (openCount >= CONFIG.MAX_POSITIONS) return;

    const cash = account ? parseFloat(account.cash) : 0;
    if (cash < CONFIG.POSITION_SIZE) return;

    // Check best trading hours from brain
    const hour = getCurrentHour();
    const hourStats = BRAIN.bestHours[hour];
    if (hourStats && hourStats.trades >= 5 && (hourStats.wins/hourStats.trades) < 0.3) {
      console.log(`⚠️  Brain says avoid hour ${hour} (${((hourStats.wins/hourStats.trades)*100).toFixed(0)}% win rate) — skipping`);
      return;
    }

    const movers = await scanMarket();
    lastScanResults = movers.slice(0, 10);
    if (!movers.length) return;

    const candidates = movers.slice(0,8).map(q =>
      `${q.ticker}: $${q.c} | +${q.dp?.toFixed(2)}% | Vol:${q.v?.toLocaleString()} | H:$${q.h} L:$${q.l}`
    ).join("\n");

    // Brain context for AI
    const brainContext = BRAIN.totalTrades > 0
      ? `\nMy win rate: ${((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)}% | ` +
        `Avoid: ${BRAIN.worstTickers.slice(0,5).join(",")} | ` +
        `Best setups: ${Object.entries(BRAIN.bestSetups).sort((a,b)=>b[1].winRate-a[1].winRate).slice(0,2).map(([k,v])=>k).join(",")}`
      : "";

    const verdict = await groq(
      `Small caps spiking NOW:${brainContext}\n\n${candidates}\n\n` +
      `Based on my trading history and these setups, pick TOP 2 to buy.\n` +
      `Only pick conviction ${CONFIG.MIN_CONVICTION}+. Skip any on my avoid list.\n` +
      `Reply ONLY in this format:\n` +
      `BUY: TICKER | CONVICTION: X | SETUP: type | REASON: one line\n` +
      `(setup types: volume_surge, breakout, short_squeeze, catalyst, bull_flag, gap_up)`,
      400
    );

    console.log("🤖 AI verdict:", verdict);

    const buyLines = verdict.split("\n").filter(l => l.startsWith("BUY:"));
    const owned    = Array.isArray(positions) ? positions.map(p=>p.symbol) : [];
    const slots    = CONFIG.MAX_POSITIONS - openCount;
    let buys = 0;

    for (const line of buyLines) {
      if (buys >= slots) break;
      const match  = line.match(/BUY:\s*([A-Z]+)\s*\|\s*CONVICTION:\s*(\d+)/i);
      if (!match) continue;
      const ticker     = match[1].toUpperCase();
      const conviction = parseInt(match[2]);
      if (conviction < CONFIG.MIN_CONVICTION) continue;
      if (owned.includes(ticker)) continue;
      if (BRAIN.worstTickers.includes(ticker)) {
        console.log(`🚫 Skipping ${ticker} — on avoid list`);
        continue;
      }

      const quote = movers.find(m=>m.ticker===ticker);
      if (!quote || quote.c<=0) continue;
      const qty = Math.floor(CONFIG.POSITION_SIZE / quote.c);
      if (qty < 1) continue;

      const setupMatch = line.match(/SETUP:\s*([a-z_]+)/i);
      const setup      = setupMatch?.[1] || "unknown";
      const reason     = line.match(/REASON:\s*(.+)/i)?.[1] || "AI spike signal";

      console.log(`🚀 BUY: ${ticker} | ${qty} @ $${quote.c} | Conviction:${conviction} | Setup:${setup}`);

      const order = await alpaca("/v2/orders",{
        method:"POST",
        body:JSON.stringify({ symbol:ticker, qty:String(qty), side:"buy", type:"market", time_in_force:"day" }),
      });

      if (order.id) {
        openTrades[ticker] = { reason, setup, time:new Date().toISOString(), conviction };
        tradeLog.unshift({
          type:"BUY", symbol:ticker, qty, price:quote.c, conviction, reason, setup,
          target:(quote.c*(1+CONFIG.PROFIT_TARGET_PCT/100)).toFixed(2),
          stop:  (quote.c*(1-CONFIG.STOP_LOSS_PCT/100)).toFixed(2),
          ts:    new Date().toISOString(),
        });
        await supabase("pulsetrader_trades",{
          method:"POST",
          body:JSON.stringify({
            symbol:ticker, side:"LONG", qty, entry_price:quote.c,
            reason:`AUTO[${setup}|c${conviction}]: ${reason}`,
          }),
        }).catch(()=>{});
        buys++;
      }
    }

    if (buys===0) console.log("⏭️  No qualifying buys this cycle");

  } catch(err) {
    console.error("Auto-trade error:", err.message);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER CONTROLS
// ════════════════════════════════════════════════════════════════════════════

const startAutoTrader = () => {
  if (autoTraderActive) return;
  autoTraderActive = true;
  console.log("🤖 Auto-trader STARTED");
  autoTrade();
  scanInterval = setInterval(autoTrade, CONFIG.SCAN_INTERVAL_MS);
};

const stopAutoTrader = () => {
  if (scanInterval) clearInterval(scanInterval);
  autoTraderActive = false;
  scanInterval = null;
  console.log("⏹️  Auto-trader STOPPED");
};

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — AUTO TRADER
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/autotrader/start", (req,res) => {
  startAutoTrader();
  res.json({ status:"started", config:CONFIG, brain:BRAIN });
});
app.get("/api/autotrader/start", (req,res) => {
  startAutoTrader();
  res.json({ status:"started", config:CONFIG });
});
app.post("/api/autotrader/stop",  (req,res) => { stopAutoTrader(); res.json({status:"stopped"}); });

app.get("/api/autotrader/status", async (req,res) => {
  const [positions, account] = await Promise.all([
    alpaca("/v2/positions").catch(()=>[]),
    alpaca("/v2/account").catch(()=>null),
  ]);
  const todayPnL = account ? parseFloat(account.equity)-parseFloat(account.last_equity) : 0;
  res.json({
    active:         autoTraderActive,
    last_scan:      lastScanTime,
    open_positions: Array.isArray(positions)?positions.length:0,
    max_positions:  CONFIG.MAX_POSITIONS,
    position_size:  CONFIG.POSITION_SIZE,
    profit_target:  CONFIG.PROFIT_TARGET_PCT+"%",
    stop_loss:      CONFIG.STOP_LOSS_PCT+"%",
    min_conviction: CONFIG.MIN_CONVICTION,
    market_open:    isMarketOpen(),
    pre_market:     isPreMarket(),
    equity:         account?parseFloat(account.equity).toFixed(2):"—",
    cash:           account?parseFloat(account.cash).toFixed(2):"—",
    today_pnl:      todayPnL.toFixed(2),
    today_pnl_pct:  account?((todayPnL/parseFloat(account.last_equity))*100).toFixed(2)+"%":"—",
    recent_trades:  tradeLog.slice(0,20),
    last_movers:    lastScanResults,
    brain: {
      total_trades:   BRAIN.totalTrades,
      wins:           BRAIN.wins,
      losses:         BRAIN.losses,
      win_rate:       BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"0%",
      total_pnl:      BRAIN.totalPnL.toFixed(2),
      best_setups:    BRAIN.bestSetups,
      best_tickers:   BRAIN.bestTickers,
      avoid_tickers:  BRAIN.worstTickers,
      adjusted_target:BRAIN.adjustedTarget+"%",
      adjusted_stop:  BRAIN.adjustedStop+"%",
      last_learned:   BRAIN.lastLearned,
    },
  });
});

app.get("/api/autotrader/brain", (req,res) => res.json(BRAIN));

app.post("/api/autotrader/scan", async (req,res) => {
  res.json({message:"Scan triggered"});
  autoTrade();
});

app.post("/api/autotrader/sellall", async (req,res) => {
  try {
    const positions = await alpaca("/v2/positions");
    if (!Array.isArray(positions)||!positions.length) return res.json({message:"No positions"});
    await Promise.all(positions.map(p=>alpaca("/v2/orders",{
      method:"POST",
      body:JSON.stringify({symbol:p.symbol,qty:p.qty,side:"sell",type:"market",time_in_force:"day"}),
    })));
    res.json({message:`Sold ${positions.length} positions`});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/autotrader/memory", async (req,res) => {
  try {
    const memories = await supabase("bot_trade_memory?order=created_at.desc&limit=50");
    res.json({ memories:Array.isArray(memories)?memories:[], brain:BRAIN });
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — AI CHAT
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/chat", async (req,res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({error:"No messages"});
  try {
    const [spy, account] = await Promise.all([
      finnhub("/quote?symbol=SPY").catch(()=>null),
      alpaca("/v2/account").catch(()=>null),
    ]);
    const context = [
      spy?.c?`[SPY $${spy.c} (${spy.dp>0?"+":""}${spy.dp?.toFixed(2)}%)]`:"",
      account?`[Portfolio: $${parseFloat(account.equity).toFixed(0)} | Cash: $${parseFloat(account.cash).toFixed(0)}]`:"",
      autoTraderActive?`[Bot: RUNNING | Target:+${CONFIG.PROFIT_TARGET_PCT}% | Stop:-${CONFIG.STOP_LOSS_PCT}% | Conviction:${CONFIG.MIN_CONVICTION}+]`:"[Bot: PAUSED]",
      BRAIN.totalTrades>0?`[Brain: ${BRAIN.totalTrades} trades, ${((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0)}% win rate, $${BRAIN.totalPnL.toFixed(0)} P&L]`:"",
    ].filter(Boolean).join(" ");
    const last = messages[messages.length-1];
    const enriched = [...messages.slice(0,-1),{...last,content:last.content+"\n"+context}];
    const reply = await groqChat(enriched);
    res.json({reply});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — MARKET DATA
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/movers", async (req,res) => {
  try {
    const movers = await scanMarket();
    lastScanResults = movers.slice(0,10);
    const top  = movers.slice(0,15);
    const data = top.map((q,i)=>
      `${i+1}. ${q.ticker}: $${q.c} | +${q.dp?.toFixed(2)}% | Vol:${q.v?.toLocaleString()} | H:$${q.h}`
    ).join("\n");
    const analysis = await groq(
      `Scanned ${movers.length} small caps. Top movers:\n${data}\n\n` +
      `For top 5: setup type, entry, target, stop, conviction 1-10.\n` +
      `Skip any on avoid list. End with #1 trade right now.`,1200
    );
    res.json({data:analysis, raw:top, scanned:movers.length, ts:new Date().toISOString()});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/spikes", async (req,res) => {
  try {
    const movers   = await scanMarket();
    const preSpike = movers.filter(q=>q.dp>2&&q.dp<25&&q.c<15).slice(0,8);
    const data     = preSpike.map(q=>`${q.ticker}: $${q.c} | +${q.dp?.toFixed(2)}%`).join("\n");
    const analysis = await groq(
      `Pre-spike candidates:\n${data}\n\nBest 2-3 to buy NOW? Entry, target, stop, conviction.`,800
    );
    res.json({data:analysis, candidates:preSpike, ts:new Date().toISOString()});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/quote", async (req,res) => {
  const {ticker="SPY"} = req.query;
  try {
    const [q,p] = await Promise.all([
      finnhub(`/quote?symbol=${ticker.toUpperCase()}`),
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
    ]);
    res.json({ticker,price:q.c,change:q.d,pct:q.dp,high:q.h,low:q.l,open:q.o,prev:q.pc,
      name:p.name,industry:p.finnhubIndustry,market_cap:p.marketCapitalization,float:p.shareOutstanding});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/edgar", async (req,res) => {
  const {ticker="NVDA"} = req.query;
  try {
    const week  = new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [p,n] = await Promise.all([
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
      finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),
    ]);
    const headlines = Array.isArray(n)?n.slice(0,8).map(x=>`- ${x.headline}`).join("\n"):"No news.";
    const analysis  = await groq(
      `${ticker.toUpperCase()} | Float:${p.shareOutstanding}M | Cap:$${p.marketCapitalization}B\n` +
      `News:\n${headlines}\n\nSpike catalyst? STRONG/WEAK/NONE. Entry, target, stop, conviction.`
    );
    res.json({ticker:ticker.toUpperCase(),data:analysis,ts:new Date().toISOString()});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/earnings", async (req,res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const next7 = new Date(Date.now()+7*86400000).toISOString().split("T")[0];
    const cal   = await finnhub(`/calendar/earnings?from=${today}&to=${next7}`);
    const top   = cal?.earningsCalendar?.slice(0,20)||[];
    const list  = top.map(e=>`${e.symbol}|${e.date}|EPS:${e.epsEstimate??'N/A'}`).join("\n");
    const ai    = await groq(`Earnings:\n${list}\n\nTop 5 small cap spike plays? Entry, target, stop.`);
    res.json({calendar:top,ai_summary:ai,ts:new Date().toISOString()});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/news", async (req,res) => {
  const {ticker} = req.query;
  try {
    const today = new Date().toISOString().split("T")[0];
    const week  = new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const news  = ticker
      ? await finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`)
      : await finnhub("/news?category=general");
    res.json((Array.isArray(news)?news:[]).slice(0,15));
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — ALPACA
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/account", async (req,res) => {
  try {
    const d=await alpaca("/v2/account");
    const pnl=parseFloat(d.equity)-parseFloat(d.last_equity);
    res.json({equity:parseFloat(d.equity).toFixed(2),cash:parseFloat(d.cash).toFixed(2),
      buying_power:parseFloat(d.buying_power).toFixed(2),portfolio_value:parseFloat(d.portfolio_value).toFixed(2),
      pnl_today:pnl.toFixed(2),pnl_today_pct:((pnl/parseFloat(d.last_equity))*100).toFixed(2)+"%",
      day_trade_count:d.daytrade_count,status:d.status,paper:true});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/holdings", async (req,res) => {
  try {
    const positions=await alpaca("/v2/positions");
    if (!Array.isArray(positions)||!positions.length)
      return res.json({holdings:[],total_value:"0.00",total_pnl:"0.00",total_pnl_today:"0.00",count:0});
    const holdings=positions.map(p=>({
      symbol:p.symbol,qty:parseFloat(p.qty),side:p.side,
      avg_entry:parseFloat(p.avg_entry_price).toFixed(2),
      current_price:parseFloat(p.current_price).toFixed(2),
      market_value:parseFloat(p.market_value).toFixed(2),
      cost_basis:parseFloat(p.cost_basis).toFixed(2),
      unrealized_pnl:parseFloat(p.unrealized_pl).toFixed(2),
      unrealized_pnl_pct:(parseFloat(p.unrealized_plpc)*100).toFixed(2)+"%",
      today_pnl:parseFloat(p.unrealized_intraday_pl).toFixed(2),
      today_pnl_pct:(parseFloat(p.unrealized_intraday_plpc)*100).toFixed(2)+"%",
      target_price:(parseFloat(p.avg_entry_price)*(1+CONFIG.PROFIT_TARGET_PCT/100)).toFixed(2),
      stop_price:(parseFloat(p.avg_entry_price)*(1-CONFIG.STOP_LOSS_PCT/100)).toFixed(2),
    }));
    res.json({holdings,
      total_value:holdings.reduce((s,h)=>s+parseFloat(h.market_value),0).toFixed(2),
      total_pnl:holdings.reduce((s,h)=>s+parseFloat(h.unrealized_pnl),0).toFixed(2),
      total_pnl_today:holdings.reduce((s,h)=>s+parseFloat(h.today_pnl),0).toFixed(2),
      count:holdings.length});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/orders", async (req,res) => {
  try {
    const orders=await alpaca("/v2/orders?status=all&limit=25&direction=desc");
    if (!Array.isArray(orders)) return res.json([]);
    res.json(orders.map(o=>({id:o.id,symbol:o.symbol,side:o.side,type:o.type,
      qty:o.qty,filled_qty:o.filled_qty,price:o.filled_avg_price||o.limit_price||null,
      status:o.status,submitted:o.submitted_at,filled:o.filled_at})));
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.post("/api/order", async (req,res) => {
  const {symbol,side,qty,type="market",limit_price,time_in_force="day"}=req.body;
  if (!symbol||!side||!qty) return res.status(400).json({error:"symbol,side,qty required"});
  try {
    const body={symbol:symbol.toUpperCase(),side,qty:String(qty),type,time_in_force};
    if (type==="limit"&&limit_price) body.limit_price=String(limit_price);
    const order=await alpaca("/v2/orders",{method:"POST",body:JSON.stringify(body)});
    res.json({success:true,order});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/bars", async (req,res) => {
  const {ticker="SPY",timeframe="1Day",limit=30}=req.query;
  try {
    const data=await alpacaData(`/v2/stocks/${ticker.toUpperCase()}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`);
    res.json({ticker:ticker.toUpperCase(),bars:data.bars||[]});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — SUPABASE
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/pnl", async (req,res) => {
  try {
    const trades=await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    if (!Array.isArray(trades)) return res.status(500).json({error:"DB error"});
    const closed=trades.filter(t=>t.pnl!=null);
    const open=trades.filter(t=>t.pnl==null);
    const total=closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0);
    const winners=closed.filter(t=>parseFloat(t.pnl)>0).length;
    const best=closed.reduce((b,t)=>(!b||parseFloat(t.pnl)>parseFloat(b.pnl)?t:b),null);
    const worst=closed.reduce((b,t)=>(!b||parseFloat(t.pnl)<parseFloat(b.pnl)?t:b),null);
    res.json({summary:{total_pnl:total.toFixed(2),avg_pnl:closed.length?(total/closed.length).toFixed(2):"0.00",
      win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",
      total_trades:trades.length,closed:closed.length,open:open.length,winners,losers:closed.length-winners,
      best_trade:best?{symbol:best.symbol,pnl:best.pnl}:null,
      worst_trade:worst?{symbol:worst.symbol,pnl:worst.pnl}:null},
      recent:trades.slice(0,15),open_positions:open});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get("/api/trades", async (req,res) => {
  try {
    const trades=await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    res.json(Array.isArray(trades)?trades:[]);
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.post("/api/trade", async (req,res) => {
  const {symbol,side,qty,entry_price,exit_price,reason}=req.body;
  if (!symbol||!side||!qty||!entry_price) return res.status(400).json({error:"required fields missing"});
  let pnl=null,pnl_pct=null;
  if (exit_price){const dir=side.toUpperCase()==="SHORT"?-1:1;
    pnl=((+exit_price-+entry_price)*+qty*dir).toFixed(2);
    pnl_pct=(((+exit_price-+entry_price)/+entry_price)*100*dir).toFixed(2);}
  try {
    const result=await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({
      symbol:symbol.toUpperCase(),side:side.toUpperCase(),qty:+qty,entry_price:+entry_price,
      exit_price:exit_price?+exit_price:null,pnl:pnl?+pnl:null,pnl_pct:pnl_pct?+pnl_pct:null,reason:reason||null})});
    res.json({success:true,trade:Array.isArray(result)?result[0]:result});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.delete("/api/trade/:id", async (req,res) => {
  try {
    await supabase(`pulsetrader_trades?id=eq.${req.params.id}`,{method:"DELETE"});
    res.json({success:true,deleted:req.params.id});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// HEALTH + DASHBOARD
// ════════════════════════════════════════════════════════════════════════════

app.get("/health", (_,res) => res.json({
  status:"ok",version:"6.0.0",ai:"groq-llama-3.3-70b",mode:"paper",
  auto_trader:autoTraderActive,scanner:`${SMALL_CAPS.length} tickers`,
  brain_trades:BRAIN.totalTrades,
  win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"learning",
  market_open:isMarketOpen(),ts:new Date().toISOString(),
}));

app.get("/api/dashboard", async (req,res) => {
  try {
    const [account,positions,trades]=await Promise.all([
      alpaca("/v2/account").catch(()=>null),
      alpaca("/v2/positions").catch(()=>[]),
      supabase("pulsetrader_trades?order=created_at.desc&limit=500").catch(()=>[]),
    ]);
    const t=Array.isArray(trades)?trades:[];
    const closed=t.filter(x=>x.pnl!=null);
    const total=closed.reduce((s,x)=>s+parseFloat(x.pnl||0),0);
    const winners=closed.filter(x=>parseFloat(x.pnl)>0).length;
    const todayPnL=account?parseFloat(account.equity)-parseFloat(account.last_equity):0;
    res.json({
      account:account?{equity:parseFloat(account.equity).toFixed(2),cash:parseFloat(account.cash).toFixed(2),
        buying_power:parseFloat(account.buying_power).toFixed(2),pnl_today:todayPnL.toFixed(2),
        pnl_today_pct:((todayPnL/parseFloat(account.last_equity))*100).toFixed(2)+"%"}:null,
      auto_trader:{active:autoTraderActive,last_scan:lastScanTime,recent_trades:tradeLog.slice(0,5)},
      brain:{win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"0%",
        total_trades:BRAIN.totalTrades,total_pnl:BRAIN.totalPnL.toFixed(2)},
      holdings:Array.isArray(positions)?positions.map(p=>({
        symbol:p.symbol,qty:parseFloat(p.qty),side:p.side,
        avg_entry:parseFloat(p.avg_entry_price).toFixed(2),
        current_price:parseFloat(p.current_price).toFixed(2),
        market_value:parseFloat(p.market_value).toFixed(2),
        unrealized_pnl:parseFloat(p.unrealized_pl).toFixed(2),
        unrealized_pnl_pct:(parseFloat(p.unrealized_plpc)*100).toFixed(2)+"%",
        today_pnl:parseFloat(p.unrealized_intraday_pl).toFixed(2),
        today_pnl_pct:(parseFloat(p.unrealized_intraday_plpc)*100).toFixed(2)+"%"})):[],
      trade_summary:{total_pnl:total.toFixed(2),
        win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",
        total_trades:t.length,open:t.filter(x=>x.pnl==null).length,closed:closed.length},
      recent_trades:t.slice(0,5),
    });
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// START — auto-boot the trader
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`⚡ PulseTrader v6.0 SELF-LEARNING AUTO TRADER on port ${PORT}`);
  console.log(`   AI      : Groq LLaMA 3.3-70B (FREE)`);
  console.log(`   Scanner : ${SMALL_CAPS.length} small cap tickers`);
  console.log(`   Target  : +${CONFIG.PROFIT_TARGET_PCT}% | Stop: -${CONFIG.STOP_LOSS_PCT}%`);
  console.log(`   Mode    : PAPER TRADING`);

  // Load past learning from Supabase
  await loadMemory();

  // Auto-start the trader on every boot
  console.log("🤖 Auto-starting trader...");
  startAutoTrader();
});
