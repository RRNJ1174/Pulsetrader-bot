// ╔══════════════════════════════════════════════════════════════════════════╗
// ║      PULSETRADER — SMALL CAP SPIKE HUNTER v4.0                         ║
// ║                                                                          ║
// ║  Render Environment Variables:                                           ║
// ║    GROQ_API_KEY  → Groq API key (free at console.groq.com)              ║
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
// SYSTEM PROMPT — Spike Hunter
// ════════════════════════════════════════════════════════════════════════════

const SYSTEM = `You are PulseTrader — an elite AI momentum trader specializing in small cap stocks BEFORE they spike.

Your #1 job: find low-float small caps with catalysts BEFORE the big move happens.

PRE-SPIKE SIGNALS YOU HUNT:
1. VOLUME SURGE — unusual volume 3-10x above 30-day average BEFORE price explodes
2. LOW FLOAT — under 10M shares outstanding. Small buy pressure = massive price moves
3. CATALYST — FDA approval/rejection, earnings beat, contract win, short squeeze setup, SEC filing, news
4. TECHNICAL SETUP — tight consolidation, breakout above key resistance, bull flag, gap and go
5. SHORT INTEREST — high short interest + catalyst = short squeeze rocket fuel
6. TIMING — pre-market gap ups, after-hours news drops, first 15-30 min of market open

ENTRY RULES:
- Enter on confirmed volume surge (2x+ avg volume) with catalyst
- Pre-market: enter only if news is confirmed, not rumor
- Set entry just above resistance breakout level
- Never chase a stock already up 50%+ without a new catalyst

EXIT / PROFIT TAKING RULES:
- Take 30-50% off at first target (+15-25%)
- Move stop to breakeven after first target hit
- Let remaining position run with trailing stop
- Hard exit: if volume dries up = sell immediately
- Never hold through unknown binary events without sizing down
- Max loss per trade: -10% from entry

WHAT TO LOOK FOR:
- Biotech: FDA catalysts, clinical trial results
- Mining/Energy: commodity price spikes, contract wins  
- Tech micro-cap: product launches, partnership announcements
- Any sector: short squeeze candidates (high SI% + low float)

FORMAT ALL RESPONSES:
📈 TICKER | Price | % Move | Float | Catalyst | Entry Zone | Target | Stop
🎯 Trade type: DAY TRADE or SWING TRADE
⚡ Conviction: HIGH / MEDIUM / LOW + reason

Always end with the #1 highest conviction trade right now.
Trap money don't sleep 💰`;

// ════════════════════════════════════════════════════════════════════════════
// SMALL CAP UNIVERSE — 200+ tickers scanned every request
// ════════════════════════════════════════════════════════════════════════════

// Broad small/micro cap watchlist covering all sectors
const SMALL_CAPS = [
  // Biotech/Pharma (highest spike potential)
  "HCWB","IMVT","SLXN","PHGE","CCTG","NNNN","CUE","CODX","SIGA","ATOS",
  "MGNX","KALA","FREQ","ADMA","NKTR","OCGN","NVAX","SAVA","ACIU","ALDX",
  "BNGO","CLOV","CRON","DCPH","EDSA","FBRX","GILD","HTBX","IDEX","JZXN",
  "KMPH","LXRX","MITI","NERV","OPGN","PNTM","QNRX","RLAY","SRNE","TGTX",

  // Tech micro-cap
  "MLGO","SOUN","CLSK","MARA","RIOT","CIFR","BTBT","BITF","HUT","WULF",
  "CODA","DFIN","EGHT","GMEX","INPX","JFIN","KULR","LIQT","MULN","NXTP",
  "OPRX","PAYO","QMCO","RVNC","STEM","TPVG","UVSP","VERB","WISA","XCUR",

  // Energy/Mining micro-cap
  "TE","PETZ","GCL","MEHA","JYD","WYHG","HAO","EGHT","BTM","ORBS",
  "AMMO","BORR","CALI","DUNE","ENSV","FLNC","GPOR","HPCO","IMXI","JOUT",
  "KALI","LOOP","MIND","NINE","OBCI","PHUN","QUBT","RCAT","SOLO","TPIC",

  // Consumer/Retail small cap
  "RRGB","STFS","JDZG","CAPS","CTEV","SLQT","MSGY","GIPR","CDT","WNW",
  "ACMR","BBCP","CLFD","DWAC","EVTL","FBRT","GBOX","HIMS","IRNT","JSPR",
  "KPLT","LMND","MNMD","NKGN","OPEN","PAYO","QTEK","RLAY","SMAR","TDUP",

  // Special situation / squeeze candidates
  "BBBY","EXPR","CLOV","WISH","WKHS","SPCE","NKLA","HYLN","RIDE","FSR",
  "LCID","GOEV","XL","ARVL","ACTC","AJAX","BRPM","CCIV","DGNX","EMBK",

  // Large movers watchlist
  "NVDA","TSLA","AAPL","META","AMD","AMZN","GOOGL","MSFT","COIN","PLTR",
  "SOFI","MARA","RIOT","SOUN","HOOD","ROBX","FUTU","TIGR","UWMC","OPEN",
];

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

const groq = async (prompt, maxTokens = 1500) => {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model:      "llama-3.3-70b-versatile",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user",   content: prompt },
        ],
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
      headers: {
        Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model:      "llama-3.3-70b-versatile",
        max_tokens: maxTokens,
        messages:   [{ role: "system", content: SYSTEM }, ...messages],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || "No response.";
  } catch (err) {
    console.error("GroqChat error:", err.message);
    return `Error: ${err.message}`;
  }
};

const supabase = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey:         process.env.SUPABASE_KEY,
      Authorization:  `Bearer ${process.env.SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer:         "return=representation",
    },
    ...opts,
  });
  const text = await res.text();
  return text ? JSON.parse(text) : [];
};

const alpaca = async (path, opts = {}) => {
  const res = await fetch(`https://paper-api.alpaca.markets${path}`, {
    headers: {
      "APCA-API-KEY-ID":     process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET,
      "Content-Type":        "application/json",
    },
    ...opts,
  });
  return res.json();
};

const alpacaData = async (path) => {
  const res = await fetch(`https://data.alpaca.markets${path}`, {
    headers: {
      "APCA-API-KEY-ID":     process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET,
    },
  });
  return res.json();
};

const finnhub = async (path) => {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(
    `https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`
  );
  return res.json();
};

// ════════════════════════════════════════════════════════════════════════════
// SPIKE SCANNER — core algorithm
// ════════════════════════════════════════════════════════════════════════════

const scanForSpikes = async () => {
  // Batch fetch quotes in parallel (max 20 at a time to avoid rate limits)
  const batchSize = 20;
  const results = [];

  for (let i = 0; i < SMALL_CAPS.length; i += batchSize) {
    const batch = SMALL_CAPS.slice(i, i + batchSize);
    const quotes = await Promise.all(
      batch.map(t =>
        finnhub(`/quote?symbol=${t}`)
          .then(q => ({ ticker: t, ...q }))
          .catch(() => null)
      )
    );
    results.push(...quotes.filter(q => q && q.c > 0));
    // Small delay between batches to respect rate limits
    if (i + batchSize < SMALL_CAPS.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Score each stock for spike potential
  const scored = results
    .filter(q => q.c > 0 && q.c < 20) // small cap price range $0-$20
    .map(q => {
      const changeAbs = Math.abs(q.dp || 0);
      const volumeRatio = q.v && q.pc ? q.v / (q.pc * 1000) : 0; // rough volume proxy
      const priceRange = q.h && q.l ? ((q.h - q.l) / q.l) * 100 : 0; // intraday range %
      const spikeScore = (changeAbs * 2) + (priceRange * 1.5) + (volumeRatio * 0.5);
      return { ...q, spikeScore, priceRange: priceRange.toFixed(2) };
    })
    .sort((a, b) => b.spikeScore - a.spikeScore);

  return scored;
};

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — AI CHAT
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "No messages" });
  try {
    const [spy, qqq] = await Promise.all([
      finnhub("/quote?symbol=SPY").catch(() => null),
      finnhub("/quote?symbol=QQQ").catch(() => null),
    ]);
    const context = spy?.c
      ? `\n[Live: SPY $${spy.c} (${spy.dp > 0 ? "+" : ""}${spy.dp?.toFixed(2)}%), QQQ $${qqq?.c} (${qqq?.dp > 0 ? "+" : ""}${qqq?.dp?.toFixed(2)}%)]`
      : "";
    const lastMsg  = messages[messages.length - 1];
    const enriched = [
      ...messages.slice(0, -1),
      { ...lastMsg, content: lastMsg.content + context },
    ];
    const reply = await groqChat(enriched);
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — SPIKE SCANNER
// ════════════════════════════════════════════════════════════════════════════

// ── GET /api/movers — full small cap spike scan ───────────────────────────────
app.get("/api/movers", async (req, res) => {
  try {
    console.log("🔍 Scanning small caps for spikes...");
    const scored = await scanForSpikes();
    const top20  = scored.slice(0, 20);

    const data = top20.map((q, i) =>
      `${i + 1}. ${q.ticker}: $${q.c} | ${q.dp > 0 ? "+" : ""}${q.dp?.toFixed(2)}% | ` +
      `Range: ${q.priceRange}% | H:$${q.h} L:$${q.l} | Vol:${q.v?.toLocaleString()}`
    ).join("\n");

    const gainers = scored.filter(q => q.dp > 0).slice(0, 8);
    const losers  = scored.filter(q => q.dp < 0).slice(0, 3);

    const gainersStr = gainers.map(q =>
      `${q.ticker} +${q.dp?.toFixed(2)}% | $${q.c} | Range ${q.priceRange}%`
    ).join("\n");

    const losersStr = losers.map(q =>
      `${q.ticker} ${q.dp?.toFixed(2)}% | $${q.c}`
    ).join("\n");

    const analysis = await groq(
      `I just scanned ${scored.length} small cap stocks. Here are the top movers:\n\n` +
      `🟢 TOP GAINERS:\n${gainersStr}\n\n` +
      `🔴 TOP LOSERS:\n${losersStr}\n\n` +
      `Full top 20 by spike score:\n${data}\n\n` +
      `Analyze these for pre-spike potential. For each notable one:\n` +
      `- Is this a volume-driven move or just noise?\n` +
      `- What type of catalyst likely caused this?\n` +
      `- Entry zone, first target, and stop loss\n` +
      `- DAY TRADE or SWING TRADE?\n\n` +
      `End with your #1 highest conviction trade right now with exact entry/exit plan.`,
      1500
    );

    res.json({
      data:    analysis,
      raw:     top20,
      scanned: scored.length,
      ts:      new Date().toISOString(),
    });
  } catch (err) {
    console.error("Movers error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/spikes — pre-spike candidates only ───────────────────────────────
app.get("/api/spikes", async (req, res) => {
  try {
    const scored  = await scanForSpikes();
    // Pre-spike: moving but not yet exploded (1-15% move, high range)
    const preSpike = scored.filter(q =>
      q.dp > 1 && q.dp < 30 &&        // moving but not already blown up
      parseFloat(q.priceRange) > 5 &&  // significant intraday range
      q.c < 10                         // penny/small cap price
    ).slice(0, 10);

    const data = preSpike.map(q =>
      `${q.ticker}: $${q.c} | +${q.dp?.toFixed(2)}% | Range:${q.priceRange}% | H:$${q.h} L:$${q.l}`
    ).join("\n");

    const analysis = await groq(
      `These small cap stocks are showing early movement — potential pre-spike setups:\n\n${data}\n\n` +
      `For each one identify:\n` +
      `1. Is the move sustainable or a fake-out?\n` +
      `2. What catalyst could cause a 2-5x move from here?\n` +
      `3. Exact entry, target (+20-50%), and stop (-10%)\n` +
      `4. Risk level: HIGH/MEDIUM/LOW\n\n` +
      `Rank them by highest profit potential. Which one would you buy RIGHT NOW?`,
      1500
    );

    res.json({
      data:      analysis,
      candidates: preSpike,
      ts:        new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/scanner — raw scan data ─────────────────────────────────────────
app.get("/api/scanner", async (req, res) => {
  try {
    const scored = await scanForSpikes();
    res.json({
      total_scanned: scored.length,
      top_movers:    scored.slice(0, 30),
      gainers:       scored.filter(q => q.dp > 5).slice(0, 15),
      pre_spike:     scored.filter(q => q.dp > 1 && q.dp < 20 && q.c < 10).slice(0, 10),
      ts:            new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — MARKET DATA
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/quote", async (req, res) => {
  const { ticker = "SPY" } = req.query;
  try {
    const [quote, profile] = await Promise.all([
      finnhub(`/quote?symbol=${ticker.toUpperCase()}`),
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
    ]);
    res.json({
      ticker, price: quote.c, change: quote.d, pct: quote.dp,
      high: quote.h, low: quote.l, open: quote.o, prev: quote.pc,
      name: profile.name, industry: profile.finnhubIndustry,
      market_cap: profile.marketCapitalization,
      shares_outstanding: profile.shareOutstanding,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/edgar", async (req, res) => {
  const { ticker = "NVDA" } = req.query;
  try {
    const week  = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [profile, news] = await Promise.all([
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
      finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),
    ]);
    const headlines = Array.isArray(news)
      ? news.slice(0, 8).map(n => `- ${n.headline}`).join("\n")
      : "No recent news.";
    const analysis = await groq(
      `Small cap stock: ${profile.name || ticker} (${ticker.toUpperCase()})\n` +
      `Float: ${profile.shareOutstanding}M shares | Market Cap: $${profile.marketCapitalization}B\n` +
      `Industry: ${profile.finnhubIndustry || "Unknown"}\n\n` +
      `Recent news:\n${headlines}\n\n` +
      `Is there a spike catalyst here? Rate: STRONG/WEAK/NONE.\n` +
      `What price target is realistic if catalyst plays out?\n` +
      `Entry, target, and stop. Is this tradeable right now?`
    );
    res.json({ ticker: ticker.toUpperCase(), data: analysis, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/earnings", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const next7 = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
    const calendar = await finnhub(`/calendar/earnings?from=${today}&to=${next7}`);
    const top  = calendar?.earningsCalendar?.slice(0, 20) || [];
    const list = top.map(e =>
      `${e.symbol} | ${e.date} | EPS est: ${e.epsEstimate ?? "N/A"} | Rev: ${e.revenueEstimate ? "$" + e.revenueEstimate + "B" : "N/A"}`
    ).join("\n");
    const analysis = await groq(
      `Upcoming earnings this week:\n${list || "No data."}\n\n` +
      `Which of these are small caps under $20 with spike potential?\n` +
      `For each: expected move %, entry before earnings, target, stop.\n` +
      `Which would you trade for maximum profit? Give exact plan.`,
      1200
    );
    res.json({ calendar: top, ai_summary: analysis, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/analyze", async (req, res) => {
  const { ticker = "SPY" } = req.query;
  try {
    const week  = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [quote, profile, news] = await Promise.all([
      finnhub(`/quote?symbol=${ticker.toUpperCase()}`),
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
      finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),
    ]);
    const headlines = Array.isArray(news)
      ? news.slice(0, 8).map(n => `- ${n.headline}`).join("\n") : "No news.";
    const analysis = await groq(
      `Spike analysis for ${ticker.toUpperCase()}:\n\n` +
      `Price: $${quote.c} | Change: ${quote.dp?.toFixed(2)}% | Open: $${quote.o} | H: $${quote.h} | L: $${quote.l}\n` +
      `Float: ${profile.shareOutstanding}M | Market Cap: $${profile.marketCapitalization}B\n` +
      `${profile.name} | ${profile.finnhubIndustry}\n\n` +
      `News:\n${headlines}\n\n` +
      `Is this a spike candidate? Analyze:\n` +
      `1. Float size — is it low enough for a big move?\n` +
      `2. Current momentum — early or late in the move?\n` +
      `3. Catalyst quality — strong/weak/none?\n` +
      `4. Entry zone, profit target (+20/50/100%), hard stop\n` +
      `5. Max risk/reward ratio\n` +
      `Give a CONVICTION SCORE 1-10 for buying this right now.`,
      1200
    );
    res.json({
      ticker: ticker.toUpperCase(), price: quote.c, change: quote.dp,
      float: profile.shareOutstanding, analysis, ts: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/news", async (req, res) => {
  const { ticker } = req.query;
  try {
    const today = new Date().toISOString().split("T")[0];
    const week  = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const news  = ticker
      ? await finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`)
      : await finnhub("/news?category=general");
    res.json((Array.isArray(news) ? news : []).slice(0, 15));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ALPACA PAPER TRADING
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/account", async (req, res) => {
  try {
    const d   = await alpaca("/v2/account");
    const pnl = parseFloat(d.equity) - parseFloat(d.last_equity);
    res.json({
      equity:          parseFloat(d.equity).toFixed(2),
      cash:            parseFloat(d.cash).toFixed(2),
      buying_power:    parseFloat(d.buying_power).toFixed(2),
      portfolio_value: parseFloat(d.portfolio_value).toFixed(2),
      pnl_today:       pnl.toFixed(2),
      pnl_today_pct:   ((pnl / parseFloat(d.last_equity)) * 100).toFixed(2) + "%",
      day_trade_count: d.daytrade_count,
      status:          d.status,
      paper:           true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/holdings", async (req, res) => {
  try {
    const positions = await alpaca("/v2/positions");
    if (!Array.isArray(positions) || positions.length === 0) {
      return res.json({ holdings: [], total_value: "0.00", total_pnl: "0.00", total_pnl_today: "0.00", count: 0 });
    }
    const holdings = positions.map(p => ({
      symbol:             p.symbol,
      qty:                parseFloat(p.qty),
      side:               p.side,
      avg_entry:          parseFloat(p.avg_entry_price).toFixed(2),
      current_price:      parseFloat(p.current_price).toFixed(2),
      market_value:       parseFloat(p.market_value).toFixed(2),
      cost_basis:         parseFloat(p.cost_basis).toFixed(2),
      unrealized_pnl:     parseFloat(p.unrealized_pl).toFixed(2),
      unrealized_pnl_pct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + "%",
      today_pnl:          parseFloat(p.unrealized_intraday_pl).toFixed(2),
      today_pnl_pct:      (parseFloat(p.unrealized_intraday_plpc) * 100).toFixed(2) + "%",
    }));
    res.json({
      holdings,
      total_value:     holdings.reduce((s, h) => s + parseFloat(h.market_value), 0).toFixed(2),
      total_pnl:       holdings.reduce((s, h) => s + parseFloat(h.unrealized_pnl), 0).toFixed(2),
      total_pnl_today: holdings.reduce((s, h) => s + parseFloat(h.today_pnl), 0).toFixed(2),
      count:           holdings.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const orders = await alpaca("/v2/orders?status=all&limit=25&direction=desc");
    if (!Array.isArray(orders)) return res.json([]);
    res.json(orders.map(o => ({
      id: o.id, symbol: o.symbol, side: o.side, type: o.type,
      qty: o.qty, filled_qty: o.filled_qty,
      price: o.filled_avg_price || o.limit_price || null,
      status: o.status, submitted: o.submitted_at, filled: o.filled_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/order", async (req, res) => {
  const { symbol, side, qty, type = "market", limit_price, time_in_force = "day" } = req.body;
  if (!symbol || !side || !qty) return res.status(400).json({ error: "symbol, side, qty required" });
  try {
    const body = { symbol: symbol.toUpperCase(), side, qty: String(qty), type, time_in_force };
    if (type === "limit" && limit_price) body.limit_price = String(limit_price);
    const order = await alpaca("/v2/orders", { method: "POST", body: JSON.stringify(body) });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/order/:id", async (req, res) => {
  try {
    await alpaca(`/v2/orders/${req.params.id}`, { method: "DELETE" });
    res.json({ success: true, cancelled: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bars", async (req, res) => {
  const { ticker = "SPY", timeframe = "1Day", limit = 30 } = req.query;
  try {
    const data = await alpacaData(
      `/v2/stocks/${ticker.toUpperCase()}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`
    );
    res.json({ ticker: ticker.toUpperCase(), bars: data.bars || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SUPABASE TRADE LOG
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/pnl", async (req, res) => {
  try {
    const trades  = await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    if (!Array.isArray(trades)) return res.status(500).json({ error: "DB error" });
    const closed  = trades.filter(t => t.pnl != null);
    const open    = trades.filter(t => t.pnl == null);
    const total   = closed.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    const winners = closed.filter(t => parseFloat(t.pnl) > 0).length;
    const best    = closed.reduce((b, t) => (!b || parseFloat(t.pnl) > parseFloat(b.pnl) ? t : b), null);
    const worst   = closed.reduce((b, t) => (!b || parseFloat(t.pnl) < parseFloat(b.pnl) ? t : b), null);
    res.json({
      summary: {
        total_pnl:    total.toFixed(2),
        avg_pnl:      closed.length ? (total / closed.length).toFixed(2) : "0.00",
        win_rate:     closed.length ? ((winners / closed.length) * 100).toFixed(1) + "%" : "0%",
        total_trades: trades.length, closed: closed.length, open: open.length,
        winners, losers: closed.length - winners,
        best_trade:  best  ? { symbol: best.symbol,  pnl: best.pnl  } : null,
        worst_trade: worst ? { symbol: worst.symbol, pnl: worst.pnl } : null,
      },
      recent:         trades.slice(0, 15),
      open_positions: open,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/trades", async (req, res) => {
  try {
    const trades = await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    res.json(Array.isArray(trades) ? trades : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/trade", async (req, res) => {
  const { symbol, side, qty, entry_price, exit_price, reason } = req.body;
  if (!symbol || !side || !qty || !entry_price)
    return res.status(400).json({ error: "symbol, side, qty, entry_price required" });
  let pnl = null, pnl_pct = null;
  if (exit_price) {
    const dir = side.toUpperCase() === "SHORT" ? -1 : 1;
    pnl     = ((+exit_price - +entry_price) * +qty * dir).toFixed(2);
    pnl_pct = (((+exit_price - +entry_price) / +entry_price) * 100 * dir).toFixed(2);
  }
  try {
    const result = await supabase("pulsetrader_trades", {
      method: "POST",
      body: JSON.stringify({
        symbol: symbol.toUpperCase(), side: side.toUpperCase(),
        qty: +qty, entry_price: +entry_price,
        exit_price: exit_price ? +exit_price : null,
        pnl: pnl ? +pnl : null, pnl_pct: pnl_pct ? +pnl_pct : null,
        reason: reason || null,
      }),
    });
    res.json({ success: true, trade: Array.isArray(result) ? result[0] : result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/trade/:id/close", async (req, res) => {
  const { exit_price } = req.body;
  const { id } = req.params;
  if (!exit_price) return res.status(400).json({ error: "exit_price required" });
  try {
    const rows  = await supabase(`pulsetrader_trades?id=eq.${id}`);
    const trade = Array.isArray(rows) ? rows[0] : null;
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    const dir     = trade.side === "SHORT" ? -1 : 1;
    const pnl     = ((+exit_price - +trade.entry_price) * +trade.qty * dir).toFixed(2);
    const pnl_pct = (((+exit_price - +trade.entry_price) / +trade.entry_price) * 100 * dir).toFixed(2);
    const updated = await supabase(`pulsetrader_trades?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ exit_price: +exit_price, pnl: +pnl, pnl_pct: +pnl_pct }),
    });
    res.json({ success: true, trade: Array.isArray(updated) ? updated[0] : updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/trade/:id", async (req, res) => {
  try {
    await supabase(`pulsetrader_trades?id=eq.${req.params.id}`, { method: "DELETE" });
    res.json({ success: true, deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD + HEALTH
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/dashboard", async (req, res) => {
  try {
    const [account, positions, trades] = await Promise.all([
      alpaca("/v2/account").catch(() => null),
      alpaca("/v2/positions").catch(() => []),
      supabase("pulsetrader_trades?order=created_at.desc&limit=500").catch(() => []),
    ]);
    const t       = Array.isArray(trades) ? trades : [];
    const closed  = t.filter(x => x.pnl != null);
    const total   = closed.reduce((s, x) => s + parseFloat(x.pnl || 0), 0);
    const winners = closed.filter(x => parseFloat(x.pnl) > 0).length;
    const todayPnL = account ? parseFloat(account.equity) - parseFloat(account.last_equity) : 0;
    res.json({
      account: account ? {
        equity:        parseFloat(account.equity).toFixed(2),
        cash:          parseFloat(account.cash).toFixed(2),
        buying_power:  parseFloat(account.buying_power).toFixed(2),
        pnl_today:     todayPnL.toFixed(2),
        pnl_today_pct: ((todayPnL / parseFloat(account.last_equity)) * 100).toFixed(2) + "%",
      } : null,
      holdings: Array.isArray(positions) ? positions.map(p => ({
        symbol:             p.symbol, qty: parseFloat(p.qty), side: p.side,
        avg_entry:          parseFloat(p.avg_entry_price).toFixed(2),
        current_price:      parseFloat(p.current_price).toFixed(2),
        market_value:       parseFloat(p.market_value).toFixed(2),
        unrealized_pnl:     parseFloat(p.unrealized_pl).toFixed(2),
        unrealized_pnl_pct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + "%",
        today_pnl:          parseFloat(p.unrealized_intraday_pl).toFixed(2),
        today_pnl_pct:      (parseFloat(p.unrealized_intraday_plpc) * 100).toFixed(2) + "%",
      })) : [],
      trade_summary: {
        total_pnl:    total.toFixed(2),
        win_rate:     closed.length ? ((winners / closed.length) * 100).toFixed(1) + "%" : "0%",
        total_trades: t.length, open: t.filter(x => x.pnl == null).length, closed: closed.length,
      },
      recent_trades: t.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) =>
  res.json({
    status:   "ok",
    version:  "4.0.0",
    ai:       "groq-llama-3.3-70b",
    mode:     "paper",
    scanner:  `${SMALL_CAPS.length} small caps`,
    ts:       new Date().toISOString(),
  })
);

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`⚡ PulseTrader v4.0 SPIKE HUNTER on port ${PORT}`);
  console.log(`   AI      : Groq LLaMA 3.3-70B (FREE)`);
  console.log(`   Scanner : ${SMALL_CAPS.length} small cap tickers`);
  console.log(`   Mode    : PAPER TRADING`);
  console.log(`   Endpoints: /api/movers /api/spikes /api/scanner`);
});
