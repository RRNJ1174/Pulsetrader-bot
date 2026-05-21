// ╔══════════════════════════════════════════════════════════════════════════╗
// ║      PULSETRADER — AUTO TRADER v5.0                                     ║
// ║      Scans → Finds spikes → Auto buys → Auto sells at profit            ║
// ║                                                                          ║
// ║  Render Environment Variables:                                           ║
// ║    GROQ_API_KEY  → Groq API key                                          ║
// ║    SUPABASE_URL  → https://xxxx.supabase.co                              ║
// ║    SUPABASE_KEY  → Supabase anon key                                     ║
// ║    ALPACA_KEY    → Alpaca paper key ID                                   ║
// ║    ALPACA_SECRET → Alpaca paper secret                                   ║
// ║    FINNHUB_KEY   → Finnhub token                                         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import express from "express";
import cors    from "cors";
import fetch   from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER CONFIG
// ════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  MAX_POSITIONS:      5,       // max open trades at once
  POSITION_SIZE:      1000,    // $ per trade
  MIN_SPIKE_PCT:      3,       // min % move to consider
  MAX_PRICE:          20,      // max stock price (small caps)
  MIN_PRICE:          0.50,    // min price (avoid pennies)
  PROFIT_TARGET_PCT:  25,      // sell when up 25%
  STOP_LOSS_PCT:      10,      // sell when down 10%
  SCAN_INTERVAL_MS:   5 * 60 * 1000,  // scan every 5 minutes
  MARKET_OPEN_HOUR:   9,       // 9 AM ET
  MARKET_CLOSE_HOUR:  16,      // 4 PM ET
};

// Trade log for this session
const tradeLog = [];
let autoTraderActive = false;
let scanInterval     = null;
let lastScanTime     = null;
let lastScanResults  = [];

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════════════════════════════

const SYSTEM = `You are PulseTrader — an elite AI momentum trader specializing in small cap stocks.
You find pre-spike setups and give exact entry/exit instructions.
Talk like a seasoned momentum trader. Concise, no fluff. Trap money don't sleep 💰

When analyzing trades give: ticker | entry | target | stop | conviction 1-10 | reason`;

// ════════════════════════════════════════════════════════════════════════════
// SMALL CAP UNIVERSE
// ════════════════════════════════════════════════════════════════════════════

const SMALL_CAPS = [
  "HCWB","IMVT","SLXN","PHGE","CCTG","NNNN","CUE","CODX","SIGA","ATOS",
  "MGNX","OCGN","NVAX","ADMA","NKTR","ALDX","BNGO","EDSA","FBRX","HTBX",
  "MLGO","SOUN","CLSK","MARA","RIOT","CIFR","BTBT","BITF","HUT","WULF",
  "EGHT","GMEX","KULR","MULN","STEM","VERB","XCUR","INPX","PAYO","RVNC",
  "TE","PETZ","GCL","MEHA","BTM","ORBS","AMMO","BORR","DUNE","FLNC",
  "RRGB","STFS","JDZG","CAPS","CTEV","SLQT","GIPR","CDT","WNW","MSGY",
  "BBCP","CLFD","HIMS","JSPR","KPLT","LMND","MNMD","OPEN","SMAR","TDUP",
  "SPCE","NKLA","WKHS","RIDE","FSR","LCID","GOEV","ARVL","ACTC","EMBK",
  "COIN","PLTR","SOFI","HOOD","FUTU","TIGR","UWMC","MARA","RIOT","SOUN",
  "IRNC","ALTTF","LAUR","TRCH","MMTIF","CLOV","WISH","IDEX","NAKD","SNDL",
];

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

const groq = async (prompt, maxTokens = 1000) => {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", max_tokens: maxTokens,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || "No response.";
  } catch (err) {
    console.error("Groq error:", err.message);
    return `Error: ${err.message}`;
  }
};

const groqChat = async (messages, maxTokens = 1200) => {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", max_tokens: maxTokens,
        messages: [{ role: "system", content: SYSTEM }, ...messages],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || "No response.";
  } catch (err) {
    return `Error: ${err.message}`;
  }
};

const supabase = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      "Content-Type": "application/json", Prefer: "return=representation",
    },
    ...opts,
  });
  const text = await res.text();
  return text ? JSON.parse(text) : [];
};

const alpaca = async (path, opts = {}) => {
  const res = await fetch(`https://paper-api.alpaca.markets${path}`, {
    headers: {
      "APCA-API-KEY-ID": process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET,
      "Content-Type": "application/json",
    },
    ...opts,
  });
  return res.json();
};

const alpacaData = async (path) => {
  const res = await fetch(`https://data.alpaca.markets${path}`, {
    headers: {
      "APCA-API-KEY-ID": process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET,
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
// MARKET HOURS CHECK
// ════════════════════════════════════════════════════════════════════════════

const isMarketOpen = () => {
  const now  = new Date();
  const et   = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  const hour = et.getHours();
  const min  = et.getMinutes();
  if (day === 0 || day === 6) return false; // weekend
  const timeNum = hour * 100 + min;
  return timeNum >= 930 && timeNum < 1600;
};

const isPreMarket = () => {
  const now  = new Date();
  const et   = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  const hour = et.getHours();
  const min  = et.getMinutes();
  if (day === 0 || day === 6) return false;
  const timeNum = hour * 100 + min;
  return timeNum >= 400 && timeNum < 930;
};

// ════════════════════════════════════════════════════════════════════════════
// SCANNER
// ════════════════════════════════════════════════════════════════════════════

const scanMarket = async () => {
  const results = [];
  const batchSize = 15;
  for (let i = 0; i < SMALL_CAPS.length; i += batchSize) {
    const batch  = SMALL_CAPS.slice(i, i + batchSize);
    const quotes = await Promise.all(
      batch.map(t => finnhub(`/quote?symbol=${t}`).then(q => ({ ticker: t, ...q })).catch(() => null))
    );
    results.push(...quotes.filter(Boolean));
    if (i + batchSize < SMALL_CAPS.length) await new Promise(r => setTimeout(r, 250));
  }
  return results
    .filter(q => q.c >= CONFIG.MIN_PRICE && q.c <= CONFIG.MAX_PRICE && q.dp >= CONFIG.MIN_SPIKE_PCT)
    .sort((a, b) => b.dp - a.dp);
};

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER ENGINE
// ════════════════════════════════════════════════════════════════════════════

const autoTrade = async () => {
  if (!isMarketOpen() && !isPreMarket()) {
    console.log("⏸️  Market closed — skipping scan");
    return;
  }

  console.log("🔍 Auto-scan starting...");
  lastScanTime = new Date().toISOString();

  try {
    // 1. Get current positions
    const positions = await alpaca("/v2/positions").catch(() => []);
    const account   = await alpaca("/v2/account").catch(() => null);
    const openCount = Array.isArray(positions) ? positions.length : 0;

    // 2. Manage existing positions — sell at target or stop
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        const pnlPct = parseFloat(pos.unrealized_plpc) * 100;
        const symbol = pos.symbol;

        if (pnlPct >= CONFIG.PROFIT_TARGET_PCT) {
          console.log(`🎯 PROFIT TARGET HIT: ${symbol} +${pnlPct.toFixed(1)}% — SELLING`);
          await alpaca("/v2/orders", {
            method: "POST",
            body: JSON.stringify({
              symbol, qty: pos.qty, side: "sell",
              type: "market", time_in_force: "day",
            }),
          });
          const msg = `🎯 AUTO-SOLD ${symbol} at +${pnlPct.toFixed(1)}% profit | $${pos.current_price}`;
          tradeLog.unshift({ type: "SELL", symbol, pnlPct: pnlPct.toFixed(1), price: pos.current_price, reason: "PROFIT TARGET", ts: new Date().toISOString() });
          console.log(msg);
        } else if (pnlPct <= -CONFIG.STOP_LOSS_PCT) {
          console.log(`🛑 STOP LOSS HIT: ${symbol} ${pnlPct.toFixed(1)}% — SELLING`);
          await alpaca("/v2/orders", {
            method: "POST",
            body: JSON.stringify({
              symbol, qty: pos.qty, side: "sell",
              type: "market", time_in_force: "day",
            }),
          });
          tradeLog.unshift({ type: "STOP", symbol, pnlPct: pnlPct.toFixed(1), price: pos.current_price, reason: "STOP LOSS", ts: new Date().toISOString() });
        }
      }
    }

    // 3. Find new entries if we have room
    if (openCount >= CONFIG.MAX_POSITIONS) {
      console.log(`⚠️  Max positions (${CONFIG.MAX_POSITIONS}) reached — no new buys`);
      return;
    }

    const cash = account ? parseFloat(account.cash) : 0;
    if (cash < CONFIG.POSITION_SIZE) {
      console.log("⚠️  Insufficient cash for new positions");
      return;
    }

    // 4. Scan for spikes
    const movers = await scanMarket();
    lastScanResults = movers.slice(0, 10);
    console.log(`📊 Found ${movers.length} movers above ${CONFIG.MIN_SPIKE_PCT}%`);

    if (!movers.length) return;

    // 5. Get AI verdict on top candidates
    const candidates = movers.slice(0, 8).map(q =>
      `${q.ticker}: $${q.c} | +${q.dp?.toFixed(2)}% | H:$${q.h} L:$${q.l}`
    ).join("\n");

    const verdict = await groq(
      `These small cap stocks are spiking RIGHT NOW:\n${candidates}\n\n` +
      `Pick the TOP 2 to buy for maximum profit potential.\n` +
      `Requirements: must have real momentum, low float preferred, strong catalyst.\n` +
      `Reply ONLY in this exact format for each pick:\n` +
      `BUY: TICKER | CONVICTION: 1-10 | REASON: one line\n` +
      `Example:\nBUY: SOUN | CONVICTION: 8 | REASON: volume surge on AI news\n` +
      `BUY: MARA | CONVICTION: 7 | REASON: bitcoin breakout catalyst`,
      400
    );

    console.log("🤖 AI verdict:", verdict);

    // 6. Parse AI picks and execute trades
    const buyLines = verdict.split("\n").filter(l => l.startsWith("BUY:"));
    const alreadyOwned = Array.isArray(positions) ? positions.map(p => p.symbol) : [];
    const slotsAvailable = CONFIG.MAX_POSITIONS - openCount;
    let buysExecuted = 0;

    for (const line of buyLines) {
      if (buysExecuted >= slotsAvailable) break;

      const match = line.match(/BUY:\s*([A-Z]+)\s*\|\s*CONVICTION:\s*(\d+)/i);
      if (!match) continue;

      const ticker      = match[1].toUpperCase();
      const conviction  = parseInt(match[2]);
      if (conviction < 6) continue; // only HIGH conviction trades
      if (alreadyOwned.includes(ticker)) continue;

      // Get current price
      const quote = movers.find(m => m.ticker === ticker);
      if (!quote || quote.c <= 0) continue;

      const qty = Math.floor(CONFIG.POSITION_SIZE / quote.c);
      if (qty < 1) continue;

      console.log(`🚀 AUTO-BUY: ${ticker} | ${qty} shares @ $${quote.c} | Conviction: ${conviction}`);

      const order = await alpaca("/v2/orders", {
        method: "POST",
        body: JSON.stringify({
          symbol: ticker, qty: String(qty), side: "buy",
          type: "market", time_in_force: "day",
        }),
      });

      if (order.id) {
        const reason = line.match(/REASON:\s*(.+)/i)?.[1] || "AI spike signal";
        tradeLog.unshift({
          type: "BUY", symbol: ticker, qty, price: quote.c,
          conviction, reason, target: (quote.c * (1 + CONFIG.PROFIT_TARGET_PCT / 100)).toFixed(2),
          stop: (quote.c * (1 - CONFIG.STOP_LOSS_PCT / 100)).toFixed(2),
          ts: new Date().toISOString(),
        });

        // Save to Supabase
        await supabase("pulsetrader_trades", {
          method: "POST",
          body: JSON.stringify({
            symbol: ticker, side: "LONG", qty,
            entry_price: quote.c, reason: `AUTO: ${reason}`,
          }),
        }).catch(() => {});

        buysExecuted++;
        console.log(`✅ Order placed: ${ticker} x${qty}`);
      } else {
        console.log(`❌ Order failed for ${ticker}:`, order.message || order);
      }
    }

    if (buysExecuted === 0) console.log("⏭️  No qualifying buys this cycle");

  } catch (err) {
    console.error("Auto-trade error:", err.message);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER CONTROLS
// ════════════════════════════════════════════════════════════════════════════

const startAutoTrader = () => {
  if (autoTraderActive) return;
  autoTraderActive = true;
  console.log("🤖 Auto-trader STARTED — scanning every 5 min");
  autoTrade(); // run immediately
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

app.post("/api/autotrader/start", (req, res) => {
  startAutoTrader();
  res.json({ status: "started", message: "Auto-trader is now scanning every 5 minutes", config: CONFIG });
});

app.post("/api/autotrader/stop", (req, res) => {
  stopAutoTrader();
  res.json({ status: "stopped", message: "Auto-trader stopped" });
});

app.get("/api/autotrader/status", async (req, res) => {
  const positions = await alpaca("/v2/positions").catch(() => []);
  const account   = await alpaca("/v2/account").catch(() => null);
  const todayPnL  = account ? parseFloat(account.equity) - parseFloat(account.last_equity) : 0;
  res.json({
    active:          autoTraderActive,
    last_scan:       lastScanTime,
    open_positions:  Array.isArray(positions) ? positions.length : 0,
    max_positions:   CONFIG.MAX_POSITIONS,
    position_size:   CONFIG.POSITION_SIZE,
    profit_target:   CONFIG.PROFIT_TARGET_PCT + "%",
    stop_loss:       CONFIG.STOP_LOSS_PCT + "%",
    scan_interval:   "5 minutes",
    market_open:     isMarketOpen(),
    pre_market:      isPreMarket(),
    equity:          account ? parseFloat(account.equity).toFixed(2) : "—",
    cash:            account ? parseFloat(account.cash).toFixed(2) : "—",
    today_pnl:       todayPnL.toFixed(2),
    today_pnl_pct:   account ? ((todayPnL / parseFloat(account.last_equity)) * 100).toFixed(2) + "%" : "—",
    recent_trades:   tradeLog.slice(0, 20),
    last_movers:     lastScanResults,
  });
});

app.get("/api/autotrader/trades", (req, res) => {
  res.json({ trades: tradeLog, count: tradeLog.length });
});

app.post("/api/autotrader/config", (req, res) => {
  const { profit_target, stop_loss, position_size, max_positions } = req.body;
  if (profit_target)  CONFIG.PROFIT_TARGET_PCT = parseFloat(profit_target);
  if (stop_loss)      CONFIG.STOP_LOSS_PCT      = parseFloat(stop_loss);
  if (position_size)  CONFIG.POSITION_SIZE      = parseFloat(position_size);
  if (max_positions)  CONFIG.MAX_POSITIONS      = parseInt(max_positions);
  res.json({ message: "Config updated", config: CONFIG });
});

// Force a manual scan right now
app.post("/api/autotrader/scan", async (req, res) => {
  res.json({ message: "Scan triggered", ts: new Date().toISOString() });
  autoTrade();
});

// Sell everything now
app.post("/api/autotrader/sellall", async (req, res) => {
  try {
    const positions = await alpaca("/v2/positions");
    if (!Array.isArray(positions) || !positions.length) {
      return res.json({ message: "No positions to sell" });
    }
    const orders = await Promise.all(
      positions.map(p => alpaca("/v2/orders", {
        method: "POST",
        body: JSON.stringify({ symbol: p.symbol, qty: p.qty, side: "sell", type: "market", time_in_force: "day" }),
      }))
    );
    res.json({ message: `Sold ${positions.length} positions`, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — AI CHAT
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "No messages" });
  try {
    const [spy, account] = await Promise.all([
      finnhub("/quote?symbol=SPY").catch(() => null),
      alpaca("/v2/account").catch(() => null),
    ]);
    const context = [
      spy?.c ? `[SPY $${spy.c} (${spy.dp > 0 ? "+" : ""}${spy.dp?.toFixed(2)}%)]` : "",
      account ? `[Portfolio: $${parseFloat(account.equity).toFixed(0)} | Cash: $${parseFloat(account.cash).toFixed(0)}]` : "",
      autoTraderActive ? `[Auto-trader: ACTIVE | Scan: every 5min | Target: +${CONFIG.PROFIT_TARGET_PCT}% | Stop: -${CONFIG.STOP_LOSS_PCT}%]` : "[Auto-trader: PAUSED]",
      lastScanResults.length ? `[Last scan found: ${lastScanResults.slice(0,3).map(m => `${m.ticker} +${m.dp?.toFixed(1)}%`).join(", ")}]` : "",
    ].filter(Boolean).join(" ");

    const lastMsg  = messages[messages.length - 1];
    const enriched = [...messages.slice(0, -1), { ...lastMsg, content: lastMsg.content + "\n" + context }];
    const reply    = await groqChat(enriched);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — MARKET DATA
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/movers", async (req, res) => {
  try {
    const movers = await scanMarket();
    lastScanResults = movers.slice(0, 10);
    const top = movers.slice(0, 15);
    const data = top.map((q, i) =>
      `${i+1}. ${q.ticker}: $${q.c} | +${q.dp?.toFixed(2)}% | H:$${q.h} L:$${q.l}`
    ).join("\n");
    const analysis = await groq(
      `Small cap movers right now:\n${data}\n\n` +
      `For top 5: entry zone, target (+20-50%), stop (-10%), conviction 1-10, DAY/SWING trade.\n` +
      `End with the #1 trade to execute RIGHT NOW.`,
      1200
    );
    res.json({ data: analysis, raw: top, scanned: movers.length, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/spikes", async (req, res) => {
  try {
    const movers   = await scanMarket();
    const preSpike = movers.filter(q => q.dp > 2 && q.dp < 25 && q.c < 15).slice(0, 8);
    const data     = preSpike.map(q => `${q.ticker}: $${q.c} | +${q.dp?.toFixed(2)}% | H:$${q.h}`).join("\n");
    const analysis = await groq(
      `Pre-spike candidates:\n${data}\n\nWhich 2-3 are best to buy NOW before a bigger move? ` +
      `Give entry, target, stop, conviction 1-10.`, 1000
    );
    res.json({ data: analysis, candidates: preSpike, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/quote", async (req, res) => {
  const { ticker = "SPY" } = req.query;
  try {
    const [quote, profile] = await Promise.all([
      finnhub(`/quote?symbol=${ticker.toUpperCase()}`),
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
    ]);
    res.json({ ticker, price: quote.c, change: quote.d, pct: quote.dp,
      high: quote.h, low: quote.l, open: quote.o, prev: quote.pc,
      name: profile.name, industry: profile.finnhubIndustry,
      market_cap: profile.marketCapitalization, float: profile.shareOutstanding });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/edgar", async (req, res) => {
  const { ticker = "NVDA" } = req.query;
  try {
    const week  = new Date(Date.now() - 7*86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [profile, news] = await Promise.all([
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
      finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),
    ]);
    const headlines = Array.isArray(news) ? news.slice(0,8).map(n=>`- ${n.headline}`).join("\n") : "No news.";
    const analysis  = await groq(
      `${ticker.toUpperCase()} | Float: ${profile.shareOutstanding}M | Cap: $${profile.marketCapitalization}B\n` +
      `News:\n${headlines}\n\nIs there a spike catalyst? Rate STRONG/WEAK/NONE. Entry, target, stop.`
    );
    res.json({ ticker: ticker.toUpperCase(), data: analysis, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/earnings", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const next7 = new Date(Date.now()+7*86400000).toISOString().split("T")[0];
    const cal   = await finnhub(`/calendar/earnings?from=${today}&to=${next7}`);
    const top   = cal?.earningsCalendar?.slice(0,20) || [];
    const list  = top.map(e=>`${e.symbol} | ${e.date} | EPS: ${e.epsEstimate??'N/A'}`).join("\n");
    const ai    = await groq(`Earnings this week:\n${list}\n\nTop 5 small cap spike plays? Entry, target, stop.`);
    res.json({ calendar: top, ai_summary: ai, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/analyze", async (req, res) => {
  const { ticker = "SPY" } = req.query;
  try {
    const week  = new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [quote, profile, news] = await Promise.all([
      finnhub(`/quote?symbol=${ticker.toUpperCase()}`),
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
      finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),
    ]);
    const headlines = Array.isArray(news) ? news.slice(0,6).map(n=>`- ${n.headline}`).join("\n") : "";
    const analysis  = await groq(
      `${ticker.toUpperCase()} spike analysis:\n` +
      `$${quote.c} | ${quote.dp?.toFixed(2)}% | H:$${quote.h} L:$${quote.l} | Float:${profile.shareOutstanding}M\n` +
      `News:\n${headlines}\n\nConviction 1-10, entry, target, stop, DAY/SWING.`, 1000
    );
    res.json({ ticker: ticker.toUpperCase(), price: quote.c, change: quote.dp, float: profile.shareOutstanding, analysis, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/news", async (req, res) => {
  const { ticker } = req.query;
  try {
    const today = new Date().toISOString().split("T")[0];
    const week  = new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const news  = ticker
      ? await finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`)
      : await finnhub("/news?category=general");
    res.json((Array.isArray(news)?news:[]).slice(0,15));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — ALPACA
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/account", async (req, res) => {
  try {
    const d   = await alpaca("/v2/account");
    const pnl = parseFloat(d.equity) - parseFloat(d.last_equity);
    res.json({
      equity: parseFloat(d.equity).toFixed(2), cash: parseFloat(d.cash).toFixed(2),
      buying_power: parseFloat(d.buying_power).toFixed(2),
      portfolio_value: parseFloat(d.portfolio_value).toFixed(2),
      pnl_today: pnl.toFixed(2),
      pnl_today_pct: ((pnl/parseFloat(d.last_equity))*100).toFixed(2)+"%",
      day_trade_count: d.daytrade_count, status: d.status, paper: true,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/holdings", async (req, res) => {
  try {
    const positions = await alpaca("/v2/positions");
    if (!Array.isArray(positions)||!positions.length)
      return res.json({ holdings:[], total_value:"0.00", total_pnl:"0.00", total_pnl_today:"0.00", count:0 });
    const holdings = positions.map(p => ({
      symbol: p.symbol, qty: parseFloat(p.qty), side: p.side,
      avg_entry: parseFloat(p.avg_entry_price).toFixed(2),
      current_price: parseFloat(p.current_price).toFixed(2),
      market_value: parseFloat(p.market_value).toFixed(2),
      cost_basis: parseFloat(p.cost_basis).toFixed(2),
      unrealized_pnl: parseFloat(p.unrealized_pl).toFixed(2),
      unrealized_pnl_pct: (parseFloat(p.unrealized_plpc)*100).toFixed(2)+"%",
      today_pnl: parseFloat(p.unrealized_intraday_pl).toFixed(2),
      today_pnl_pct: (parseFloat(p.unrealized_intraday_plpc)*100).toFixed(2)+"%",
      target_price: (parseFloat(p.avg_entry_price)*(1+CONFIG.PROFIT_TARGET_PCT/100)).toFixed(2),
      stop_price:   (parseFloat(p.avg_entry_price)*(1-CONFIG.STOP_LOSS_PCT/100)).toFixed(2),
    }));
    res.json({
      holdings,
      total_value:     holdings.reduce((s,h)=>s+parseFloat(h.market_value),0).toFixed(2),
      total_pnl:       holdings.reduce((s,h)=>s+parseFloat(h.unrealized_pnl),0).toFixed(2),
      total_pnl_today: holdings.reduce((s,h)=>s+parseFloat(h.today_pnl),0).toFixed(2),
      count: holdings.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/orders", async (req, res) => {
  try {
    const orders = await alpaca("/v2/orders?status=all&limit=25&direction=desc");
    if (!Array.isArray(orders)) return res.json([]);
    res.json(orders.map(o=>({
      id:o.id, symbol:o.symbol, side:o.side, type:o.type,
      qty:o.qty, filled_qty:o.filled_qty,
      price:o.filled_avg_price||o.limit_price||null,
      status:o.status, submitted:o.submitted_at, filled:o.filled_at,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/order", async (req, res) => {
  const { symbol, side, qty, type="market", limit_price, time_in_force="day" } = req.body;
  if (!symbol||!side||!qty) return res.status(400).json({ error:"symbol, side, qty required" });
  try {
    const body = { symbol:symbol.toUpperCase(), side, qty:String(qty), type, time_in_force };
    if (type==="limit"&&limit_price) body.limit_price=String(limit_price);
    const order = await alpaca("/v2/orders",{method:"POST",body:JSON.stringify(body)});
    res.json({ success:true, order });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/order/:id", async (req, res) => {
  try {
    await alpaca(`/v2/orders/${req.params.id}`,{method:"DELETE"});
    res.json({ success:true, cancelled:req.params.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/bars", async (req, res) => {
  const { ticker="SPY", timeframe="1Day", limit=30 } = req.query;
  try {
    const data = await alpacaData(`/v2/stocks/${ticker.toUpperCase()}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`);
    res.json({ ticker:ticker.toUpperCase(), bars:data.bars||[] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — SUPABASE TRADE LOG
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/pnl", async (req, res) => {
  try {
    const trades  = await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    if (!Array.isArray(trades)) return res.status(500).json({ error:"DB error" });
    const closed  = trades.filter(t=>t.pnl!=null);
    const open    = trades.filter(t=>t.pnl==null);
    const total   = closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0);
    const winners = closed.filter(t=>parseFloat(t.pnl)>0).length;
    const best    = closed.reduce((b,t)=>(!b||parseFloat(t.pnl)>parseFloat(b.pnl)?t:b),null);
    const worst   = closed.reduce((b,t)=>(!b||parseFloat(t.pnl)<parseFloat(b.pnl)?t:b),null);
    res.json({
      summary:{
        total_pnl:total.toFixed(2), avg_pnl:closed.length?(total/closed.length).toFixed(2):"0.00",
        win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",
        total_trades:trades.length, closed:closed.length, open:open.length,
        winners, losers:closed.length-winners,
        best_trade:best?{symbol:best.symbol,pnl:best.pnl}:null,
        worst_trade:worst?{symbol:worst.symbol,pnl:worst.pnl}:null,
      },
      recent:trades.slice(0,15), open_positions:open,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/trades", async (req, res) => {
  try {
    const trades = await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    res.json(Array.isArray(trades)?trades:[]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/trade", async (req, res) => {
  const { symbol, side, qty, entry_price, exit_price, reason } = req.body;
  if (!symbol||!side||!qty||!entry_price) return res.status(400).json({ error:"required fields missing" });
  let pnl=null, pnl_pct=null;
  if (exit_price) {
    const dir = side.toUpperCase()==="SHORT"?-1:1;
    pnl     = ((+exit_price-+entry_price)*+qty*dir).toFixed(2);
    pnl_pct = (((+exit_price-+entry_price)/+entry_price)*100*dir).toFixed(2);
  }
  try {
    const result = await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({
      symbol:symbol.toUpperCase(), side:side.toUpperCase(), qty:+qty,
      entry_price:+entry_price, exit_price:exit_price?+exit_price:null,
      pnl:pnl?+pnl:null, pnl_pct:pnl_pct?+pnl_pct:null, reason:reason||null,
    })});
    res.json({ success:true, trade:Array.isArray(result)?result[0]:result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/trade/:id/close", async (req, res) => {
  const { exit_price } = req.body;
  const { id } = req.params;
  if (!exit_price) return res.status(400).json({ error:"exit_price required" });
  try {
    const rows  = await supabase(`pulsetrader_trades?id=eq.${id}`);
    const trade = Array.isArray(rows)?rows[0]:null;
    if (!trade) return res.status(404).json({ error:"Trade not found" });
    const dir     = trade.side==="SHORT"?-1:1;
    const pnl     = ((+exit_price-+trade.entry_price)*+trade.qty*dir).toFixed(2);
    const pnl_pct = (((+exit_price-+trade.entry_price)/+trade.entry_price)*100*dir).toFixed(2);
    const updated = await supabase(`pulsetrader_trades?id=eq.${id}`,{method:"PATCH",
      body:JSON.stringify({exit_price:+exit_price,pnl:+pnl,pnl_pct:+pnl_pct})});
    res.json({ success:true, trade:Array.isArray(updated)?updated[0]:updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/trade/:id", async (req, res) => {
  try {
    await supabase(`pulsetrader_trades?id=eq.${req.params.id}`,{method:"DELETE"});
    res.json({ success:true, deleted:req.params.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD + HEALTH
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/dashboard", async (req, res) => {
  try {
    const [account, positions, trades] = await Promise.all([
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
      account:account?{
        equity:parseFloat(account.equity).toFixed(2),
        cash:parseFloat(account.cash).toFixed(2),
        buying_power:parseFloat(account.buying_power).toFixed(2),
        pnl_today:todayPnL.toFixed(2),
        pnl_today_pct:((todayPnL/parseFloat(account.last_equity))*100).toFixed(2)+"%",
      }:null,
      auto_trader:{ active:autoTraderActive, last_scan:lastScanTime, recent_trades:tradeLog.slice(0,5) },
      holdings:Array.isArray(positions)?positions.map(p=>({
        symbol:p.symbol, qty:parseFloat(p.qty), side:p.side,
        avg_entry:parseFloat(p.avg_entry_price).toFixed(2),
        current_price:parseFloat(p.current_price).toFixed(2),
        market_value:parseFloat(p.market_value).toFixed(2),
        unrealized_pnl:parseFloat(p.unrealized_pl).toFixed(2),
        unrealized_pnl_pct:(parseFloat(p.unrealized_plpc)*100).toFixed(2)+"%",
        today_pnl:parseFloat(p.unrealized_intraday_pl).toFixed(2),
        today_pnl_pct:(parseFloat(p.unrealized_intraday_plpc)*100).toFixed(2)+"%",
      })):[],
      trade_summary:{
        total_pnl:total.toFixed(2),
        win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",
        total_trades:t.length, open:t.filter(x=>x.pnl==null).length, closed:closed.length,
      },
      recent_trades:t.slice(0,5),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/health", (_, res) => res.json({
  status:"ok", version:"5.0.0", ai:"groq-llama-3.3-70b",
  mode:"paper", auto_trader:autoTraderActive,
  scanner:`${SMALL_CAPS.length} tickers`,
  market_open:isMarketOpen(), pre_market:isPreMarket(),
  ts:new Date().toISOString(),
}));

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`⚡ PulseTrader v5.0 AUTO TRADER on port ${PORT}`);
  console.log(`   AI       : Groq LLaMA 3.3-70B (FREE)`);
  console.log(`   Scanner  : ${SMALL_CAPS.length} small cap tickers`);
  console.log(`   Target   : +${CONFIG.PROFIT_TARGET_PCT}% | Stop: -${CONFIG.STOP_LOSS_PCT}%`);
  console.log(`   Control  : POST /api/autotrader/start to begin`);
  console.log(`   Mode     : PAPER TRADING`);
});
