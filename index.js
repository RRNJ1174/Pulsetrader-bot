/**
 * PulseTrader Bot — Paper Trading
 * Stack: Express + Alpaca + SEC EDGAR + Finnhub
 * Deploy on Render as a Node web service
 */

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const FINNHUB_KEY   = process.env.FINNHUB_API_KEY;

const ALPACA_BASE   = 'https://paper-api.alpaca.markets/v2';
const FINNHUB_BASE  = 'https://finnhub.io/api/v1';

const MAX_POSITION_USD = 500;
const STOP_LOSS_PCT    = 0.05;
const TAKE_PROFIT_PCT  = 0.12;

const alpaca = axios.create({
  baseURL: ALPACA_BASE,
  headers: {
    'APCA-API-KEY-ID':     ALPACA_KEY,
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

async function placeOrder({ symbol, qty, side, stopLoss, takeProfit }) {
  const order = { symbol, qty, side, type: 'market', time_in_force: 'day' };
  if (side === 'buy' && stopLoss && takeProfit) {
    order.order_class = 'bracket';
    order.stop_loss   = { stop_price: stopLoss.toFixed(2) };
    order.take_profit = { limit_price: takeProfit.toFixed(2) };
  }
  const { data } = await alpaca.post('/orders', order);
  console.log(`[ORDER] ${side.toUpperCase()} ${qty} ${symbol} — id: ${data.id}`);
  return data;
}

async function getOpenOrders() {
  const { data } = await alpaca.get('/orders?status=open');
  return data;
}

async function getPrice(symbol) {
  try {
    const { data } = await axios.get(`${FINNHUB_BASE}/quote`, {
      params: { symbol, token: FINNHUB_KEY },
    });
    return { price: data.c, prevClose: data.pc, change: data.dp };
  } catch (e) {
    console.error(`[PRICE] Error fetching ${symbol}:`, e.message);
    return null;
  }
}

async function scanEdgarFilings() {
  try {
    const { data } = await axios.get('https://efts.sec.gov/LATEST/search-index?q=%228-K%22&dateRange=custom&startdt=TODAY&enddt=TODAY&forms=8-K', {
      headers: { 'User-Agent': 'PulseTrader bot@pulsetrader.io' },
      timeout: 10000,
    });
    const hits = data?.hits?.hits || [];
    console.log(`[EDGAR] Found ${hits.length} 8-K filings today`);
    const signals = [];
    for (const hit of hits.slice(0, 20)) {
      const src = hit._source;
      const ticker = src?.tickers?.[0];
      if (!ticker) continue;
      const title = src?.file_description || src?.form_type || '';
      if (/merger|acquisition|fda|approval|earnings|revenue|guidance/i.test(title)) {
        signals.push({ ticker, title, filedAt: src?.period_of_report });
      }
    }
    return signals;
  } catch (e) {
    console.error('[EDGAR] Scan error:', e.message);
    return [];
  }
}

async function scanEdgarByKeyword(keyword = 'record revenue') {
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q="${encodeURIComponent(keyword)}"&forms=8-K&dateRange=custom&startdt=TODAY&enddt=TODAY`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'PulseTrader bot@pulsetrader.io' },
      timeout: 10000,
    });
    const hits = data?.hits?.hits || [];
    return hits.map(h => ({
      ticker: h._source?.tickers?.[0],
      title:  h._source?.file_description,
      filed:  h._source?.period_of_report,
    })).filter(s => s.ticker);
  } catch (e) {
    console.error('[EDGAR keyword]', e.message);
    return [];
  }
}

async function getNewsSentiment(symbol) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const week  = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const { data } = await axios.get(`${FINNHUB_BASE}/company-news`, {
      params: { symbol, from: week, to: today, token: FINNHUB_KEY },
    });
    const bull = data.filter(n => /beat|surge|record|growth|bullish|buy/i.test(n.headline)).length;
    const bear = data.filter(n => /miss|fall|loss|risk|sell|bearish/i.test(n.headline)).length;
    return { bull, bear, score: bull - bear, total: data.length };
  } catch (e) {
    return { bull: 0, bear: 0, score: 0, total: 0 };
  }
}

async function scoreSignal(ticker) {
  const [priceData, sentiment] = await Promise.all([
    getPrice(ticker),
    getNewsSentiment(ticker),
  ]);
  if (!priceData || !priceData.price) return null;
  let score = 0;
  if (priceData.change > 1)  score += 2;
  if (priceData.change > 3)  score += 2;
  if (priceData.change < -2) score -= 3;
  score += Math.min(sentiment.score, 4);
  return { ticker, price: priceData.price, prevClose: priceData.prevClose, changePct: priceData.change, sentiment, score };
}

async function runScan() {
  console.log('\n[SCAN] Starting scan at', new Date().toISOString());
  const account = await getAccount();
  const buyingPower = parseFloat(account.buying_power);
  console.log(`[ACCOUNT] Buying power: $${buyingPower.toFixed(2)}`);
  if (buyingPower < 100) { console.log('[SCAN] Insufficient buying power, skipping.'); return; }
  const edgarSignals   = await scanEdgarFilings();
  const revenueSignals = await scanEdgarByKeyword('record revenue');
  const allTickers = [...new Set([...edgarSignals.map(s => s.ticker), ...revenueSignals.map(s => s.ticker)])].filter(Boolean);
  console.log(`[SCAN] Scoring ${allTickers.length} tickers from EDGAR`);
  const scored = [];
  for (const ticker of allTickers.slice(0, 10)) {
    const result = await scoreSignal(ticker);
    if (result) scored.push(result);
    await new Promise(r => setTimeout(r, 300));
  }
  const topPicks = scored.sort((a, b) => b.score - a.score).slice(0, 3);
  console.log('[SCAN] Top picks:', topPicks.map(p => `${p.ticker}(${p.score})`));
  const positions   = await getPositions();
  const heldTickers = new Set(positions.map(p => p.symbol));
  for (const pick of topPicks) {
    if (pick.score < 4) { console.log(`[SKIP] ${pick.ticker} score ${pick.score} below threshold`); continue; }
    if (heldTickers.has(pick.ticker)) { console.log(`[SKIP] Already holding ${pick.ticker}`); continue; }
    const qty = Math.floor(Math.min(MAX_POSITION_USD, buyingPower * 0.1) / pick.price);
    if (qty < 1) { console.log(`[SKIP] ${pick.ticker} price too high`); continue; }
    const stopLoss   = pick.price * (1 - STOP_LOSS_PCT);
    const takeProfit = pick.price * (1 + TAKE_PROFIT_PCT);
    try {
      await placeOrder({ symbol: pick.ticker, qty, side: 'buy', stopLoss, takeProfit });
    } catch (e) {
      console.error(`[ORDER ERROR] ${pick.ticker}:`, e.response?.data || e.message);
    }
  }
}

app.get('/', (req, res) => res.json({ status: 'PulseTrader running', time: new Date().toISOString() }));
app.get('/account', async (req, res) => { try { const data = await getAccount(); res.json({ buying_power: data.buying_power, equity: data.equity, status: data.status }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/positions', async (req, res) => { try { const data = await getPositions(); res.json(data.map(p => ({ symbol: p.symbol, qty: p.qty, avg_entry: p.avg_entry_price, current: p.current_price, pnl: p.unrealized_pl, pnl_pct: p.unrealized_plpc }))); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/orders', async (req, res) => { try { res.json(await getOpenOrders()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/scan', async (req, res) => { try { await runScan(); res.json({ message: 'Scan complete' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/price/:symbol', async (req, res) => { const data = await getPrice(req.params.symbol.toUpperCase()); data ? res.json(data) : res.status(404).json({ error: 'Not found' }); });
app.get('/score/:symbol', async (req, res) => { const data = await scoreSignal(req.params.symbol.toUpperCase()); data ? res.json(data) : res.status(404).json({ error: 'Could not score' }); });

cron.schedule('32 13 * * 1-5', runScan);
cron.schedule('0 15 * * 1-5',  runScan);
console.log('[SCHEDULER] Scan jobs registered: 9:32 AM ET and 11:00 AM ET weekdays');

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 PulseTrader bot listening on port ${PORT}`);
  try {
    const acct = await getAccount();
    console.log(`✅ Alpaca connected — equity: $${acct.equity}, buying power: $${acct.buying_power}`);
  } catch (e) {
    console.error('❌ Alpaca connection failed:', e.message);
  }
});
