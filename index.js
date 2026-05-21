// ╔══════════════════════════════════════════════════════════════════════════╗
// ║           PULSETRADER — FINAL COMPLETE BACKEND v3                       ║
// ║                                                                          ║
// ║  Replit Secrets required:                                                ║
// ║    ANTHROPIC_API_KEY  → Claude API key                                   ║
// ║    SUPABASE_URL       → https://xxxx.supabase.co                         ║
// ║    SUPABASE_KEY       → Supabase anon key                                ║
// ║    ALPACA_KEY         → Alpaca paper key ID                              ║
// ║    ALPACA_SECRET      → Alpaca paper secret                              ║
// ║    FINNHUB_KEY        → Finnhub token                                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import Anthropic from "@anthropic-ai/sdk";
import express   from "express";
import cors      from "cors";
import fetch     from "node-fetch";

const app    = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ════════════════════════════════════════════════════════════════════════════
// CLIENT HELPERS
// ════════════════════════════════════════════════════════════════════════════

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

// ── Alpaca Paper Trading ──────────────────────────────────────────────────────
const ALPACA_BASE      = "https://paper-api.alpaca.markets";
const ALPACA_DATA_BASE = "https://data.alpaca.markets";

const alpaca = async (path, opts = {}) => {
  const res = await fetch(`${ALPACA_BASE}${path}`, {
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
  const res = await fetch(`${ALPACA_DATA_BASE}${path}`, {
    headers: {
      "APCA-API-KEY-ID":     process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET,
    },
  });
  return res.json();
};

// ── Finnhub ───────────────────────────────────────────────────────────────────
const finnhub = async (path) => {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(
    `https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`
  );
  return res.json();
};

// ── Claude AI with web search ─────────────────────────────────────────────────
const ai = async (prompt, maxTokens = 1000) => {
  const response = await client.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system:     SYSTEM,
    tools:      [{ type: "web_search_20250305", name: "web_search" }],
    messages:   [{ role: "user", content: prompt }],
  });
  return response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
};

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════════════════════════════

const SYSTEM = `You are PulseTrader — a sharp, street-smart AI trading assistant.
Personality: confident, concise, zero fluff. Talk like a seasoned trader.
Use emojis sparingly. NEVER fabricate price or ticker data — always search first.

You have live web search. Use it for:
- Real-time pre-market/after-hours movers and catalysts
- Latest SEC EDGAR filings (8-K, 10-Q, S-1)
- Upcoming earnings: dates, EPS & revenue estimates
- Breaking market news, Fed events, macro catalysts
- Analyst upgrades/downgrades and price target changes

Formatting rules:
- Movers   → ticker | % move | one-line catalyst
- Earnings → ticker | date | EPS est | key thing to watch
- EDGAR    → 3 bullet points: most important disclosures only
- Analysis → trend → key levels → upcoming catalyst → bull/bear lean + reason
- Always close with one bold actionable takeaway.`;

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — AI CHAT
// ════════════════════════════════════════════════════════════════════════════

// ── POST /api/chat ────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "No messages" });
  try {
    const response = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system:     SYSTEM,
      tools:      [{ type: "web_search_20250305", name: "web_search" }],
      messages,
    });
    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");
    res.json({ reply: text, stop_reason: response.stop_reason });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — MARKET DATA
// ════════════════════════════════════════════════════════════════════════════

// ── GET /api/movers — top pre-market movers ───────────────────────────────────
app.get("/api/movers", async (req, res) => {
  try {
    const text = await ai(
      "Search for today's top pre-market stock movers RIGHT NOW. " +
      "List top 8 gainers and top 3 losers: ticker | % move | catalyst. Be concise.",
      800
    );
    res.json({ data: text, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/quote?ticker=NVDA — live quote via Finnhub ───────────────────────
app.get("/api/quote", async (req, res) => {
  const { ticker = "SPY" } = req.query;
  try {
    const [quote, profile] = await Promise.all([
      finnhub(`/quote?symbol=${ticker.toUpperCase()}`),
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
    ]);
    res.json({
      ticker:   ticker.toUpperCase(),
      price:    quote.c,
      change:   quote.d,
      pct:      quote.dp,
      high:     quote.h,
      low:      quote.l,
      open:     quote.o,
      prev:     quote.pc,
      name:     profile.name,
      industry: profile.finnhubIndustry,
      market_cap: profile.marketCapitalization,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/edgar?ticker=NVDA — SEC filing summary ──────────────────────────
app.get("/api/edgar", async (req, res) => {
  const { ticker = "NVDA" } = req.query;
  try {
    const text = await ai(
      `Search SEC EDGAR for the latest 8-K or 10-Q filing for ${ticker.toUpperCase()}. ` +
      `Summarize the 3 most important disclosures, risks, or financial highlights. Be direct.`,
      800
    );
    res.json({ ticker: ticker.toUpperCase(), data: text, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/earnings — this week's earnings ─────────────────────────────────
app.get("/api/earnings", async (req, res) => {
  try {
    // Finnhub earnings calendar for next 7 days
    const today = new Date().toISOString().split("T")[0];
    const next7 = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
    const calendar = await finnhub(`/calendar/earnings?from=${today}&to=${next7}`);

    // AI narrative on top names
    const text = await ai(
      "Search for this week's most important earnings reports. " +
      "List top 10: ticker | date | EPS estimate | key thing to watch. High-impact names only.",
      800
    );

    res.json({
      calendar: calendar?.earningsCalendar?.slice(0, 20) || [],
      ai_summary: text,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analyze?ticker=TSLA — deep AI stock analysis ────────────────────
app.get("/api/analyze", async (req, res) => {
  const { ticker = "SPY" } = req.query;
  try {
    const [text, quote] = await Promise.all([
      ai(
        `Search for current news, price action, and analyst sentiment on ${ticker.toUpperCase()}. ` +
        `Give: (1) trend/setup, (2) key price levels, (3) upcoming catalysts, ` +
        `(4) bull or bear lean and exactly why. No fluff.`,
        1000
      ),
      finnhub(`/quote?symbol=${ticker.toUpperCase()}`),
    ]);
    res.json({
      ticker:   ticker.toUpperCase(),
      price:    quote.c,
      change:   quote.dp,
      analysis: text,
      ts:       new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/news?ticker=AAPL — latest news ───────────────────────────────────
app.get("/api/news", async (req, res) => {
  const { ticker } = req.query;
  try {
    const today = new Date().toISOString().split("T")[0];
    const week  = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const news  = ticker
      ? await finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`)
      : await finnhub(`/news?category=general`);
    res.json((Array.isArray(news) ? news : []).slice(0, 15));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — ALPACA PAPER TRADING
// ════════════════════════════════════════════════════════════════════════════

// ── GET /api/account — paper account balance & today's P&L ───────────────────
app.get("/api/account", async (req, res) => {
  try {
    const data = await alpaca("/v2/account");
    const todayPnL    = parseFloat(data.equity) - parseFloat(data.last_equity);
    const todayPnLPct = ((todayPnL / parseFloat(data.last_equity)) * 100).toFixed(2);
    res.json({
      equity:          parseFloat(data.equity).toFixed(2),
      cash:            parseFloat(data.cash).toFixed(2),
      buying_power:    parseFloat(data.buying_power).toFixed(2),
      portfolio_value: parseFloat(data.portfolio_value).toFixed(2),
      pnl_today:       todayPnL.toFixed(2),
      pnl_today_pct:   todayPnLPct + "%",
      day_trade_count: data.daytrade_count,
      status:          data.status,
      paper:           true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/holdings — all open positions (Holdings tab) ─────────────────────
app.get("/api/holdings", async (req, res) => {
  try {
    const positions = await alpaca("/v2/positions");

    if (!Array.isArray(positions)) {
      return res.json({ holdings: [], total_value: "0.00", total_pnl: "0.00" });
    }

    const holdings = positions.map(p => ({
      symbol:        p.symbol,
      qty:           parseFloat(p.qty),
      side:          p.side,
      avg_entry:     parseFloat(p.avg_entry_price).toFixed(2),
      current_price: parseFloat(p.current_price).toFixed(2),
      market_value:  parseFloat(p.market_value).toFixed(2),
      cost_basis:    parseFloat(p.cost_basis).toFixed(2),
      unrealized_pnl:     parseFloat(p.unrealized_pl).toFixed(2),
      unrealized_pnl_pct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + "%",
      today_pnl:     parseFloat(p.unrealized_intraday_pl).toFixed(2),
      today_pnl_pct: (parseFloat(p.unrealized_intraday_plpc) * 100).toFixed(2) + "%",
      change_today:  parseFloat(p.change_today).toFixed(4),
    }));

    const totalValue = holdings.reduce((s, h) => s + parseFloat(h.market_value), 0);
    const totalPnL   = holdings.reduce((s, h) => s + parseFloat(h.unrealized_pnl), 0);
    const totalToday = holdings.reduce((s, h) => s + parseFloat(h.today_pnl), 0);

    res.json({
      holdings,
      total_value:     totalValue.toFixed(2),
      total_pnl:       totalPnL.toFixed(2),
      total_pnl_today: totalToday.toFixed(2),
      count:           holdings.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/orders — recent orders ──────────────────────────────────────────
app.get("/api/orders", async (req, res) => {
  try {
    const orders = await alpaca("/v2/orders?status=all&limit=25&direction=desc");
    if (!Array.isArray(orders)) return res.json([]);
    res.json(orders.map(o => ({
      id:          o.id,
      symbol:      o.symbol,
      side:        o.side,
      type:        o.type,
      qty:         o.qty,
      filled_qty:  o.filled_qty,
      price:       o.filled_avg_price || o.limit_price || null,
      status:      o.status,
      submitted:   o.submitted_at,
      filled:      o.filled_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/order — place a paper order ────────────────────────────────────
app.post("/api/order", async (req, res) => {
  const { symbol, side, qty, type = "market", limit_price, time_in_force = "day" } = req.body;
  if (!symbol || !side || !qty) {
    return res.status(400).json({ error: "symbol, side, qty required" });
  }
  try {
    const body = { symbol: symbol.toUpperCase(), side, qty: String(qty), type, time_in_force };
    if (type === "limit" && limit_price) body.limit_price = String(limit_price);
    const order = await alpaca("/v2/orders", { method: "POST", body: JSON.stringify(body) });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/order/:id — cancel a paper order ─────────────────────────────
app.delete("/api/order/:id", async (req, res) => {
  try {
    await alpaca(`/v2/orders/${req.params.id}`, { method: "DELETE" });
    res.json({ success: true, cancelled: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/bars?ticker=NVDA&timeframe=1Day — OHLCV bars ────────────────────
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
// ROUTES — SUPABASE TRADE LOG
// ════════════════════════════════════════════════════════════════════════════

// ── GET /api/pnl — full P&L summary from Supabase ────────────────────────────
app.get("/api/pnl", async (req, res) => {
  try {
    const trades = await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    if (!Array.isArray(trades)) return res.status(500).json({ error: "DB error" });

    const closed  = trades.filter(t => t.pnl != null);
    const open    = trades.filter(t => t.pnl == null);
    const total   = closed.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    const winners = closed.filter(t => parseFloat(t.pnl) > 0).length;
    const winRate = closed.length ? ((winners / closed.length) * 100).toFixed(1) : "0.0";
    const best    = closed.reduce((b, t) => (!b || parseFloat(t.pnl) > parseFloat(b.pnl) ? t : b), null);
    const worst   = closed.reduce((b, t) => (!b || parseFloat(t.pnl) < parseFloat(b.pnl) ? t : b), null);
    const avgPnL  = closed.length ? (total / closed.length).toFixed(2) : "0.00";

    res.json({
      summary: {
        total_pnl:    total.toFixed(2),
        avg_pnl:      avgPnL,
        win_rate:     winRate + "%",
        total_trades: trades.length,
        closed:       closed.length,
        open:         open.length,
        winners,
        losers:       closed.length - winners,
        best_trade:   best  ? { symbol: best.symbol,  pnl: best.pnl  } : null,
        worst_trade:  worst ? { symbol: worst.symbol, pnl: worst.pnl } : null,
      },
      recent:         trades.slice(0, 15),
      open_positions: open,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/trades — all trades ──────────────────────────────────────────────
app.get("/api/trades", async (req, res) => {
  try {
    const trades = await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    res.json(Array.isArray(trades) ? trades : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/trade — log a new trade ────────────────────────────────────────
app.post("/api/trade", async (req, res) => {
  const { symbol, side, qty, entry_price, exit_price, reason } = req.body;
  if (!symbol || !side || !qty || !entry_price) {
    return res.status(400).json({ error: "symbol, side, qty, entry_price required" });
  }
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
        symbol:      symbol.toUpperCase(),
        side:        side.toUpperCase(),
        qty:         +qty,
        entry_price: +entry_price,
        exit_price:  exit_price ? +exit_price : null,
        pnl:         pnl     ? +pnl     : null,
        pnl_pct:     pnl_pct ? +pnl_pct : null,
        reason:      reason || null,
      }),
    });
    res.json({ success: true, trade: Array.isArray(result) ? result[0] : result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/trade/:id/close — close an open trade ─────────────────────────
app.patch("/api/trade/:id/close", async (req, res) => {
  const { exit_price } = req.body;
  const { id } = req.params;
  if (!exit_price) return res.status(400).json({ error: "exit_price required" });
  try {
    const rows = await supabase(`pulsetrader_trades?id=eq.${id}`);
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

// ── DELETE /api/trade/:id ─────────────────────────────────────────────────────
app.delete("/api/trade/:id", async (req, res) => {
  try {
    await supabase(`pulsetrader_trades?id=eq.${id}`, { method: "DELETE" });
    res.json({ success: true, deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — UTILITY
// ════════════════════════════════════════════════════════════════════════════

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", version: "3.0.0", mode: "paper", ts: new Date().toISOString() })
);

// ── GET /api/dashboard — single call for full dashboard load ──────────────────
app.get("/api/dashboard", async (req, res) => {
  try {
    const [account, holdings, pnlData] = await Promise.all([
      alpaca("/v2/account").catch(() => null),
      alpaca("/v2/positions").catch(() => []),
      supabase("pulsetrader_trades?order=created_at.desc&limit=500").catch(() => []),
    ]);

    const trades  = Array.isArray(pnlData) ? pnlData : [];
    const closed  = trades.filter(t => t.pnl != null);
    const total   = closed.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    const winners = closed.filter(t => parseFloat(t.pnl) > 0).length;

    const todayPnL = account
      ? parseFloat(account.equity) - parseFloat(account.last_equity)
      : 0;

    res.json({
      account: account ? {
        equity:        parseFloat(account.equity).toFixed(2),
        cash:          parseFloat(account.cash).toFixed(2),
        buying_power:  parseFloat(account.buying_power).toFixed(2),
        pnl_today:     todayPnL.toFixed(2),
        pnl_today_pct: ((todayPnL / parseFloat(account.last_equity)) * 100).toFixed(2) + "%",
      } : null,
      holdings: Array.isArray(holdings) ? holdings.map(p => ({
        symbol:        p.symbol,
        qty:           parseFloat(p.qty),
        side:          p.side,
        avg_entry:     parseFloat(p.avg_entry_price).toFixed(2),
        current_price: parseFloat(p.current_price).toFixed(2),
        market_value:  parseFloat(p.market_value).toFixed(2),
        unrealized_pnl:     parseFloat(p.unrealized_pl).toFixed(2),
        unrealized_pnl_pct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + "%",
        today_pnl:     parseFloat(p.unrealized_intraday_pl).toFixed(2),
        today_pnl_pct: (parseFloat(p.unrealized_intraday_plpc) * 100).toFixed(2) + "%",
      })) : [],
      trade_summary: {
        total_pnl:    total.toFixed(2),
        win_rate:     closed.length ? ((winners / closed.length) * 100).toFixed(1) + "%" : "0%",
        total_trades: trades.length,
        open:         trades.filter(t => t.pnl == null).length,
        closed:       closed.length,
      },
      recent_trades: trades.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`⚡ PulseTrader v3 LIVE on port ${PORT}`);
  console.log(`   Mode: PAPER TRADING`);
  console.log(`   Endpoints: /api/chat /api/holdings /api/account /api/pnl`);
  console.log(`              /api/movers /api/edgar /api/earnings /api/analyze`);
  console.log(`              /api/trades /api/order /api/bars /api/dashboard`);
});
