const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const FINNHUB_KEY   = process.env.FINNHUB_API_KEY;
const GROQ_KEY      = process.env.GROQ_API_KEY;

const ALPACA_BASE  = 'https://paper-api.alpaca.markets/v2';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

const MAX_POSITION_USD = 500;
const STOP_LOSS_PCT    = 0.05;
const TAKE_PROFIT_PCT  = 0.12;

const alpaca = axios.create({
  baseURL: ALPACA_BASE,
  headers: {
    'APCA-API-KEY-ID': ALPACA_KEY,
    'APCA-API-SECRET-KEY': ALPACA_SECRET,
  },
});

async function getAccount() {
  const { data } = await alpaca.get('/account');
  return data;
}
async function getPositions() {
  const { data } = await alpaca.get('/positions');
  return data;
}
async function getOpenOrders() {
  const { data } = await alpaca.get('/orders?status=open');
  return data;
}
async function placeOrder({ symbol, qty, side, stopLoss, takeProfit }) {
  const order = { symbol, qty, side, type: 'market', time_in_force: 'day' };
  if (side === 'buy' && stopLoss && takeProfit) {
    order.order_class = 'bracket';
    order.stop_loss   = { stop_price: stopLoss.toFixed(2) };
    order.take_profit = { limit_price: takeProfit.toFixed(2) };
  }
  const { data } = await alpaca.post('/orders', order);
  return data;
}

async function getPrice(symbol) {
  try {
    const { data } = await axios.get(`${FINNHUB_BASE}/quote`, {
      params: { symbol, token: FINNHUB_KEY },
    });
    return { price: data.c, prevClose: data.pc, change: data.dp };
  } catch (e) { return null; }
}

async function getNewsSentiment(symbol) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const week  = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    const { data } = await axios.get(`${FINNHUB_BASE}/company-news`, {
      params: { symbol, from: week, to: today, token: FINNHUB_KEY },
    });
    const bull = data.filter(n => /beat|surge|record|growth|bullish|buy/i.test(n.headline)).length;
    const bear = data.filter(n => /miss|fall|loss|risk|sell|bearish/i.test(n.headline)).length;
    return { bull, bear, score: bull - bear, total: data.length };
  } catch (e) { return { bull:0, bear:0, score:0, total:0 }; }
}

async function scanEdgarFilings() {
  try {
    const { data } = await axios.get('https://efts.sec.gov/LATEST/search-index?q=%228-K%22&forms=8-K', {
      headers: { 'User-Agent': 'PulseTrader bot@pulsetrader.io' },
      timeout: 10000,
    });
    const hits = data?.hits?.hits || [];
    const signals = [];
    for (const hit of hits.slice(0, 20)) {
      const src = hit._source;
      const ticker = src?.tickers?.[0];
      if (!ticker) continue;
      const title = src?.file_description || '';
      if (/merger|acquisition|fda|approval|earnings|revenue|guidance/i.test(title)) {
        signals.push({ ticker, title });
      }
    }
    return signals;
  } catch (e) { return []; }
}

async function scoreSignal(ticker) {
  const [priceData, sentiment] = await Promise.all([getPrice(ticker), getNewsSentiment(ticker)]);
  if (!priceData?.price) return null;
  let score = 0;
  if (priceData.change > 1) score += 2;
  if (priceData.change > 3) score += 2;
  if (priceData.change < -2) score -= 3;
  score += Math.min(sentiment.score, 4);
  return { ticker, price: priceData.price, changePct: priceData.change, sentiment, score };
}

async function runScan() {
  console.log('[SCAN] Starting at', new Date().toISOString());
  const account = await getAccount();
  const buyingPower = parseFloat(account.buying_power);
  if (buyingPower < 100) return;
  const signals = await scanEdgarFilings();
  const allTickers = [...new Set(signals.map(s => s.ticker))].filter(Boolean);
  const scored = [];
  for (const ticker of allTickers.slice(0, 10)) {
    const result = await scoreSignal(ticker);
    if (result) scored.push(result);
    await new Promise(r => setTimeout(r, 300));
  }
  const topPicks = scored.sort((a, b) => b.score - a.score).slice(0, 3);
  const positions = await getPositions();
  const held = new Set(positions.map(p => p.symbol));
  for (const pick of topPicks) {
    if (pick.score < 4 || held.has(pick.ticker)) continue;
    const qty = Math.floor(Math.min(MAX_POSITION_USD, buyingPower * 0.1) / pick.price);
    if (qty < 1) continue;
    await placeOrder({
      symbol: pick.ticker, qty, side: 'buy',
      stopLoss: pick.price * (1 - STOP_LOSS_PCT),
      takeProfit: pick.price * (1 + TAKE_PROFIT_PCT),
    });
  }
}

// ─── GROQ CHAT ───────────────────────────────────────────────────────────────
async function buildMarketContext() {
  try {
    const [account, positions, orders, signals] = await Promise.all([
      getAccount(),
      getPositions(),
      getOpenOrders(),
      scanEdgarFilings(),
    ]);
    return {
      buying_power: account.buying_power,
      equity: account.equity,
      positions: positions.map(p => ({
        symbol: p.symbol,
        qty: p.qty,
        entry: p.avg_entry_price,
        current: p.current_price,
        pnl: p.unrealized_pl,
        pnl_pct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + '%',
      })),
      open_orders: orders.length,
      edgar_catalysts: signals.slice(0, 5),
    };
  } catch (e) {
    return { error: 'Could not load market data' };
  }
}

app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  const context = await buildMarketContext();

  const systemPrompt = `You are PulseTrader, an AI trading assistant that talks like Jeezy — street smart, confident, direct, uses Atlanta slang naturally but stays focused on the money. You have real-time access to the user's paper trading account and market data.

Current Account Data:
${JSON.stringify(context, null, 2)}

Rules:
- Keep responses short and punchy like Jeezy would
- Reference actual numbers from the account data when relevant
- Give real trading insight mixed with the street energy
- If asked about a stock, give your honest take
- Never be corny or forced with the slang — keep it natural
- You scan SEC EDGAR filings for catalysts and use Finnhub for prices`;

  try {
    const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      max_tokens: 300,
      temperature: 0.85,
    }, {
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const reply = data.choices[0].message.content;
    res.json({ reply });
  } catch (e) {
    console.error('[CHAT ERROR]', e.response?.data || e.message);
    res.status(500).json({ error: 'Chat failed', detail: e.message });
  }
});

// ─── CHAT UI ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PulseTrader</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0a; color: #fff; font-family: -apple-system, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  #header { padding: 16px; background: #111; border-bottom: 1px solid #222; }
  #header h1 { font-size: 18px; font-weight: 700; color: #00ff88; }
  #header p { font-size: 12px; color: #666; margin-top: 2px; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 85%; padding: 10px 14px; border-radius: 16px; font-size: 14px; line-height: 1.5; }
  .user { background: #1a1a2e; align-self: flex-end; border-bottom-right-radius: 4px; }
  .bot { background: #111; border: 1px solid #222; align-self: flex-start; border-bottom-left-radius: 4px; color: #00ff88; }
  .bot-name { font-size: 11px; color: #555; margin-bottom: 4px; }
  #input-area { padding: 12px 16px; background: #111; border-top: 1px solid #222; display: flex; gap: 8px; }
  #input { flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 20px; padding: 10px 16px; color: #fff; font-size: 14px; outline: none; }
  #send { background: #00ff88; color: #000; border: none; border-radius: 20px; padding: 10px 18px; font-weight: 700; font-size: 14px; cursor: pointer; }
  .typing { color: #555; font-size: 13px; font-style: italic; }
</style>
</head>
<body>
<div id="header">
  <h1>⚡ PulseTrader</h1>
  <p>Real-time market intelligence</p>
</div>
<div id="messages">
  <div class="msg bot">
    <div class="bot-name">PULSETRADER</div>
    Yeen ready for dis. Ask me what we holdin, what EDGAR droppin today, or gimme a ticker and I'll break it down. Trap money don't sleep 💰
  </div>
</div>
<div id="input-area">
  <input id="input" placeholder="Ask about stocks, positions..." />
  <button id="send">Send</button>
</div>
<script>
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');

  function addMsg(text, type) {
    const div = document.createElement('div');
    div.className = 'msg ' + type;
    if (type === 'bot') {
      div.innerHTML = '<div class="bot-name">PULSETRADER</div>' + text;
    } else {
      div.textContent = text;
    }
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  async function sendMessage() {
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    addMsg(msg, 'user');
    const typing = addMsg('thinking...', 'bot typing');
    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      typing.remove();
      addMsg(data.reply || data.error, 'bot');
    } catch (e) {
      typing.remove();
      addMsg('Connection error', 'bot');
    }
  }

  send.addEventListener('click', sendMessage);
  input.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage(); });
</script>
</body>
</html>`);
});

app.get('/account', async (req, res) => { try { const d = await getAccount(); res.json({ buying_power: d.buying_power, equity: d.equity, status: d.status }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/positions', async (req, res) => { try { const d = await getPositions(); res.json(d); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/scan', async (req, res) => { try { await runScan(); res.json({ message: 'Scan complete' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/price/:symbol', async (req, res) => { const d = await getPrice(req.params.symbol.toUpperCase()); d ? res.json(d) : res.status(404).json({ error: 'Not found' }); });
app.get('/score/:symbol', async (req, res) => { const d = await scoreSignal(req.params.symbol.toUpperCase()); d ? res.json(d) : res.status(404).json({ error: 'Could not score' }); });

cron.schedule('32 13 * * 1-5', runScan);
cron.schedule('0 15 * * 1-5', runScan);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 PulseTrader listening on port ${PORT}`);
  try {
    const acct = await getAccount();
    console.log(`✅ Alpaca connected — equity: $${acct.equity}`);
  } catch (e) {
    console.error('❌ Alpaca failed:', e.message);
  }
});
