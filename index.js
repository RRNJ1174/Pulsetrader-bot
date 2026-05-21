// ╔══════════════════════════════════════════════════════════════════════════╗
// ║         PULSETRADER — FINAL BACKEND v3.2 (GROQ FREE VERSION)            ║
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
// SYSTEM PROMPT — defined first so helpers can reference it
// ════════════════════════════════════════════════════════════════════════════

const SYSTEM = `You are PulseTrader — a sharp, street-smart AI trading assistant.
Personality: confident, concise, zero fluff. Talk like a seasoned trader, not a textbook.
Use emojis sparingly. Only reference data you are given — never fabricate prices or tickers.

You will receive real market data from Finnhub and Alpaca. Analyze it directly.

Formatting rules:
- Movers   → ticker | % move | one-line catalyst
- Earnings → ticker | date | EPS est | key thing to watch
- Analysis → trend → key levels → catalyst → bull/bear lean + reason
- Always close with one bold actionable takeaway.`;

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

// ── Groq single prompt ───────────────────────────────────────────────────────
const groq = async (prompt, maxTokens = 1024) => {
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

// ── Groq multi-turn chat ─────────────────────────────────────────────────────
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

// ── Supabase ─────────────────────────────────────────────────────────────────
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

// ── Alpaca Paper Trading ─────────────────────────────────────────────────────
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

// ── Finnhub ──────────────────────────────────────────────────────────────────
const finnhub = async (path) => {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(
    `https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`
  );
  return res.json();
};

// ════════════════════════════════════════════════════════════════════════════
// AI CHAT
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "No messages" });
  try {
    const spy = await finnhub("/quote?symbol=SPY").catch(() => null);
    const qqq = await finnhub("/quote?symbol=QQQ").catch(() => null);
    const context = spy?.c
      ? `\n[Live market: SPY $${spy.c} (${spy.dp > 0 ? "+" : ""}${spy.dp}%), QQQ $${qqq?.c} (${qqq?.dp > 0 ? "+" : ""}${qqq?.dp}%)]`
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
// MARKET DATA
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/movers", async (req, res) => {
  try {
    const tickers = ["NVDA","TSLA","AAPL","META","AMZN","MSFT","GOOGL","COIN","PLTR","SOFI","AMD","SPY","QQQ"];
    const quotes  = await Promise.all(
      tickers.map(t => finnhub(`/quote?symbol=${t}`).then(q => ({ ticker: t, ...q })).catch(() => null))
    );
    const sorted = quotes
      .filter(q => q && q.c > 0)
      .sort((a, b) => Math.abs(b.dp) - Math.abs(a.dp));

    const data = sorted.map(q =>
      `${q.ticker}: $${q.c} | ${q.dp > 0 ? "+" : ""}${q.dp?.toFixed(2)}% | H:$${q.h} L:$${q.l}`
    ).join("\n");

    const analysis = await groq(
      `Here are today's top movers by % change:\n${data}\n\n` +
      `Format as 🟢 GAINERS and 🔴 LOSERS. ` +
      `For each: ticker | % move | one-line reason. ` +
      `End with one actionable trade idea.`
    );
    res.json({ data: analysis, raw: sorted, ts: new Date().toISOString() });
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
    res.json({
      ticker, price: quote.c, change: quote.d, pct: quote.dp,
      high: quote.h, low: quote.l, open: quote.o, prev: quote.pc,
      name: profile.name, industry: profile.finnhubIndustry,
      market_cap: profile.marketCapitalization,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/edgar", async (req, res) => {
  const { ticker = "NVDA" } = req.query;
  try {
    const week = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [profile, news] = await Promise.all([
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
      finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),
    ]);
    const headlines = Array.isArray(news)
      ? news.slice(0, 8).map(n => `- ${n.headline}`).join("\n")
      : "No recent news.";
    const analysis = await groq(
      `Company: ${profile.name || ticker} (${ticker.toUpperCase()})\n` +
      `Industry: ${profile.finnhubIndustry || "Unknown"}\n` +
      `Market Cap: $${profile.marketCapitalization}B\n\n` +
      `Recent headlines:\n${headlines}\n\n` +
      `Summarize the 3 most important things an investor needs to know right now. ` +
      `Focus on risks, catalysts, and financials. Be direct.`
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
    const top  = calendar?.earningsCalendar?.slice(0, 15) || [];
    const list = top.map(e =>
      `${e.symbol} | ${e.date} | EPS est: ${e.epsEstimate ?? "N/A"} | Rev: ${e.revenueEstimate ? "$" + e.revenueEstimate + "B" : "N/A"}`
    ).join("\n");
    const analysis = await groq(
      `This week's earnings:\n${list || "No data."}\n\n` +
      `Pick the top 5 most market-moving. For each: ticker | date | EPS est | key thing to watch. ` +
      `End with which one you'd trade and why.`
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
      ? news.slice(0, 6).map(n => `- ${n.headline}`).join("\n") : "";
    const analysis = await groq(
      `Analyze ${ticker.toUpperCase()} for a trade.\n\n` +
      `Price: $${quote.c} | Open $${quote.o} | H $${quote.h} | L $${quote.l} | Prev $${quote.pc} | ${quote.dp?.toFixed(2)}%\n` +
      `${profile.name} | ${profile.finnhubIndustry}\n\n` +
      `News:\n${headlines}\n\n` +
      `Give: (1) trend/setup (2) key levels (3) catalysts (4) bull/bear lean + why. No fluff.`,
      1000
    );
    res.json({ ticker: ticker.toUpperCase(), price: quote.c, change: quote.dp, analysis, ts: new Date().toISOString() });
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
    const d = await alpaca("/v2/account");
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
  res.json({ status: "ok", version: "3.2.0", ai: "groq-llama3-70b", mode: "paper", ts: new Date().toISOString() })
);

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`⚡ PulseTrader v3.2 LIVE on port ${PORT}`);
  console.log(`   AI    : Groq LLaMA3-70B (FREE)`);
  console.log(`   Mode  : PAPER TRADING`);
  console.log(`   Fix   : SYSTEM prompt moved above helpers`);
});
