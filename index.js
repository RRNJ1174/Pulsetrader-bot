// ─── PulseTrader Backend v2 ─────────────────────────────────────────────────
// Drop this in as your index.js on Render. Set env vars in Render dashboard.
//
// Required env vars:
//   ANTHROPIC_API_KEY   → your Claude key
//   SUPABASE_URL        → https://xxxx.supabase.co
//   SUPABASE_KEY        → your anon/service key
//   PORT                → (Render sets this automatically)
// ────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import express   from "express";
import cors      from "cors";
import fetch     from "node-fetch";

const app    = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // serves your frontend from /public

// ── Supabase helper ──────────────────────────────────────────────────────────
const supabase = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey:        process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer:        "return=representation",
    },
    ...opts,
  });
  const text = await res.text();
  return text ? JSON.parse(text) : [];
};

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM = `You are PulseTrader — a sharp, street-smart AI trading assistant.
Personality: confident, concise, no fluff. Talk like a trader, not a textbook.
Use emojis sparingly but effectively. Never make up ticker data — always search first.

You have access to web search. Use it for:
- Real-time pre-market/after-hours movers
- Latest EDGAR filings (8-K, 10-Q, S-1)
- Upcoming earnings dates & estimates
- Breaking market news & catalysts

When showing movers: format as a clean list with ticker, % move, and one-line reason.
When showing earnings: include date, EPS estimate, revenue estimate.
When showing EDGAR: summarize the key risk or catalyst in plain English.

Always end responses with 1 actionable takeaway.`;

// ── POST /api/chat — main chat endpoint ──────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "No messages" });

  try {
    const response = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system:     SYSTEM,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
        },
      ],
      messages,
    });

    // Pull text blocks from response
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

// ── GET /api/movers — pre-market movers via AI + web search ──────────────────
app.get("/api/movers", async (req, res) => {
  try {
    const response = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 800,
      system:     SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role:    "user",
        content: "Search for today's top pre-market stock movers right now. Show top 8 gainers and top 3 losers with % move and catalyst. Be concise.",
      }],
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    res.json({ data: text, ts: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/edgar?ticker=NVDA — latest EDGAR filings ────────────────────────
app.get("/api/edgar", async (req, res) => {
  const { ticker = "NVDA" } = req.query;
  try {
    const response = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 800,
      system:     SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role:    "user",
        content: `Search SEC EDGAR for the latest 8-K or 10-Q filing for ${ticker.toUpperCase()}. Summarize the key catalyst, risk, or financial highlight in 3-4 bullet points. Be direct.`,
      }],
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    res.json({ ticker: ticker.toUpperCase(), data: text, ts: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/earnings — upcoming earnings this week ───────────────────────────
app.get("/api/earnings", async (req, res) => {
  try {
    const response = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 800,
      system:     SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role:    "user",
        content: "Search for this week's most important earnings reports. List the top 10 companies with: ticker, report date, EPS estimate, and one key thing to watch. Focus on high-impact names.",
      }],
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    res.json({ data: text, ts: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pnl — fetch P&L from Supabase ───────────────────────────────────
app.get("/api/pnl", async (req, res) => {
  try {
    const trades = await supabase(
      "pulsetrader_trades?order=created_at.desc&limit=200"
    );

    if (!Array.isArray(trades)) return res.status(500).json({ error: "DB error" });

    const closed  = trades.filter(t => t.pnl != null);
    const open    = trades.filter(t => t.pnl == null);
    const total   = closed.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    const winners = closed.filter(t => t.pnl > 0).length;
    const winRate = closed.length ? ((winners / closed.length) * 100).toFixed(1) : "0.0";
    const best    = closed.reduce((b, t) => (!b || t.pnl > b.pnl ? t : b), null);
    const worst   = closed.reduce((b, t) => (!b || t.pnl < b.pnl ? t : b), null);

    res.json({
      summary: {
        total_pnl:   total.toFixed(2),
        win_rate:    winRate + "%",
        total_trades: trades.length,
        closed:      closed.length,
        open:        open.length,
        winners,
        losers:      closed.length - winners,
        best_trade:  best  ? { symbol: best.symbol,  pnl: best.pnl  } : null,
        worst_trade: worst ? { symbol: worst.symbol, pnl: worst.pnl } : null,
      },
      recent: trades.slice(0, 10),
      open_positions: open,
    });

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

  let pnl     = null;
  let pnl_pct = null;
  if (exit_price) {
    const dir = side === "SHORT" ? -1 : 1;
    pnl     = ((+exit_price - +entry_price) * +qty * dir).toFixed(2);
    pnl_pct = (((+exit_price - +entry_price) / +entry_price) * 100 * dir).toFixed(2);
  }

  try {
    const result = await supabase("pulsetrader_trades", {
      method: "POST",
      body: JSON.stringify({
        symbol: symbol.toUpperCase(),
        side:   side.toUpperCase(),
        qty:    +qty,
        entry_price: +entry_price,
        exit_price:  exit_price ? +exit_price : null,
        pnl:     pnl     ? +pnl     : null,
        pnl_pct: pnl_pct ? +pnl_pct : null,
        reason:  reason || null,
      }),
    });
    res.json({ success: true, trade: Array.isArray(result) ? result[0] : result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/trade/:id ─────────────────────────────────────────────────────
app.delete("/api/trade/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await supabase(`pulsetrader_trades?id=eq.${id}`, { method: "DELETE" });
    res.json({ success: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analyze?ticker=TSLA — AI trade analysis ─────────────────────────
app.get("/api/analyze", async (req, res) => {
  const { ticker = "SPY" } = req.query;
  try {
    const response = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 900,
      system:     SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role:    "user",
        content: `Search for current news, recent price action, and analyst sentiment on ${ticker.toUpperCase()}. Give me: (1) current setup/trend, (2) key levels to watch, (3) upcoming catalysts, (4) your lean — bullish or bearish and why. Be direct, no fluff.`,
      }],
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    res.json({ ticker: ticker.toUpperCase(), analysis: text, ts: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", v: "2.0.0", ts: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`⚡ PulseTrader v2 running on port ${PORT}`));
