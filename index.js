const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const ALPACA_KEY        = process.env.ALPACA_API_KEY;
const ALPACA_SECRET     = process.env.ALPACA_SECRET_KEY;
const FINNHUB_KEY       = process.env.FINNHUB_API_KEY;
const GROQ_KEY          = process.env.GROQ_API_KEY;
const ACCESS_PIN        = process.env.ACCESS_PIN;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);
const ALPACA_BASE  = 'https://paper-api.alpaca.markets/v2';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const AV_BASE      = 'https://www.alphavantage.co/query';

const STOP_LOSS_PCT      = 0.10;
const TARGET1_PCT        = 0.30;
const TARGET2_PCT        = 0.60;
const MAX_POS_USD        = 500;
const MAX_PREMARKET_USD  = 250;
const MAX_POSITIONS      = 3;
const MAX_DAILY_LOSS_PCT = 0.20;
const MIN_SCORE          = 7;
const SCORE_WATCHLIST    = 5;

const alpaca = axios.create({
  baseURL: ALPACA_BASE,
  headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
});

const avCache = {};
const profileCache = {};
const trailingStops = {};

async function getAccount() { const { data } = await alpaca.get('/account'); return data; }
async function getPositions() { const { data } = await alpaca.get('/positions'); return data; }
async function getOpenOrders() { const { data } = await alpaca.get('/orders?status=open'); return data; }

async function closePosition(symbol) {
  try {
    await alpaca.delete(`/positions/${symbol}`);
    console.log(`[EXIT] Closed ${symbol}`);
    await supabase.from('pulsetrader_positions').update({ qty_remaining: 0 }).eq('symbol', symbol);
  } catch (e) { console.error(`[EXIT ERROR] ${symbol}:`, e.message); }
}

async function placeOrder({ symbol, qty, side, stopLoss, takeProfit, limitPrice, extendedHours = false }) {
  const order = { symbol, qty, side, type: extendedHours ? 'limit' : 'market', time_in_force: 'day', extended_hours: extendedHours };
  if (extendedHours && limitPrice) order.limit_price = limitPrice.toFixed(2);
  if (!extendedHours && side === 'buy' && stopLoss && takeProfit) {
    order.order_class = 'bracket';
    order.stop_loss   = { stop_price: stopLoss.toFixed(2) };
    order.take_profit = { limit_price: takeProfit.toFixed(2) };
  }
  const { data } = await alpaca.post('/orders', order);
  console.log(`[ORDER] ${side.toUpperCase()} ${qty} ${symbol} extended:${extendedHours}`);
  return data;
}

async function getPrice(symbol) {
  try {
    const { data } = await axios.get(`${FINNHUB_BASE}/quote`, { params: { symbol, token: FINNHUB_KEY } });
    return { price: data.c, prevClose: data.pc, change: data.dp, high: data.h, low: data.l, open: data.o };
  } catch (e) { return null; }
}

async function getCompanyProfile(symbol) {
  if (profileCache[symbol]) return profileCache[symbol];
  try {
    const { data } = await axios.get(`${FINNHUB_BASE}/stock/profile2`, { params: { symbol, token: FINNHUB_KEY } });
    profileCache[symbol] = data;
    return data;
  } catch (e) { return null; }
}

async function getNewsSentiment(symbol) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const week  = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    const { data } = await axios.get(`${FINNHUB_BASE}/company-news`, { params: { symbol, from: week, to: today, token: FINNHUB_KEY } });
    const bull = data.filter(n => /beat|surge|record|growth|bullish|buy|approval|fda|merger|acquisition|partnership|breakthrough/i.test(n.headline)).length;
    const bear = data.filter(n => /miss|fall|loss|risk|sell|bearish|lawsuit|fraud|downgrade|recall/i.test(n.headline)).length;
    return { bull, bear, score: bull - bear, total: data.length, headlines: data.slice(0,3).map(n => n.headline) };
  } catch (e) { return { bull:0, bear:0, score:0, total:0, headlines:[] }; }
}

async function getEarningsCalendar() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const nextWeek = new Date(Date.now() + 7*86400000).toISOString().split('T')[0];
    const { data } = await axios.get(`${FINNHUB_BASE}/calendar/earnings`, { params: { from: today, to: nextWeek, token: FINNHUB_KEY } });
    return data.earningsCalendar?.slice(0, 10) || [];
  } catch (e) { return []; }
}

async function getVolumeSpike(symbol) {
  if (avCache[symbol] && Date.now() - avCache[symbol].ts < 3600000) return avCache[symbol].data;
  try {
    const { data } = await axios.get(AV_BASE, { params: { function: 'TIME_SERIES_DAILY', symbol, apikey: ALPHA_VANTAGE_KEY, outputsize: 'compact' } });
    const series = data['Time Series (Daily)'];
    if (!series) return null;
    const dates   = Object.keys(series).slice(0, 20);
    const volumes = dates.map(d => parseInt(series[d]['5. volume']));
    const avgVol  = volumes.slice(1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
    const todayVol = volumes[0];
    const spike    = todayVol / avgVol;
    const result   = { symbol, todayVolume: todayVol, avgVolume: Math.round(avgVol), spike: parseFloat(spike.toFixed(2)), isSpike: spike > 2 };
    avCache[symbol] = { data: result, ts: Date.now() };
    return result;
  } catch (e) { return null; }
}

async function getYahooGainers() {
  try {
    const { data } = await axios.get('https://finance.yahoo.com/markets/stocks/gainers/?start=0&count=25', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000,
    });
    const tickers = [];
    const regex = /"symbol":"([A-Z]{1,5})"/g;
    let match;
    while ((match = regex.exec(data)) !== null) {
      if (!tickers.includes(match[1])) tickers.push(match[1]);
    }
    return tickers.slice(0, 25);
  } catch (e) { return []; }
}

async function scanEdgarFilings() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const { data } = await axios.get(
      `https://efts.sec.gov/LATEST/search-index?q=%228-K%22&forms=8-K&dateRange=custom&startdt=${yesterday}&enddt=${today}`,
      { headers: { 'User-Agent': 'PulseTrader bot@pulsetrader.io' }, timeout: 10000 }
    );
    const hits = data?.hits?.hits || [];
    const signals = [];
    for (const hit of hits.slice(0, 50)) {
      const src    = hit._source;
      const ticker = src?.tickers?.[0];
      if (!ticker) continue;
      const title    = src?.file_description || '';
      const priority = /fda|approval|breakthrough|merger|acquisition/i.test(title) ? 'HIGH' :
                       /earnings|revenue|guidance|partnership|contract/i.test(title) ? 'MEDIUM' : null;
      if (priority) signals.push({ ticker, title, priority, type: '8-K', filed: src?.period_of_report });
    }
    return signals;
  } catch (e) { return []; }
}

async function scanForm4Insider() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const { data } = await axios.get(
      `https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=${yesterday}&enddt=${today}`,
      { headers: { 'User-Agent': 'PulseTrader bot@pulsetrader.io' }, timeout: 10000 }
    );
    const hits = data?.hits?.hits || [];
    const buys = [];
    for (const hit of hits.slice(0, 30)) {
      const src    = hit._source;
      const ticker = src?.tickers?.[0];
      if (!ticker) continue;
      buys.push({ ticker, filed: src?.period_of_report, type: 'INSIDER' });
    }
    return buys;
  } catch (e) { return []; }
}

async function scoreSignal(ticker, edgarSignals = [], insiderSignals = []) {
  const [priceData, sentiment, volumeData, profile] = await Promise.all([
    getPrice(ticker), getNewsSentiment(ticker), getVolumeSpike(ticker), getCompanyProfile(ticker),
  ]);
  if (!priceData?.price) return null;

  let score = 0;
  const reasons = [];

  if (priceData.change > 20)      { score += 6; reasons.push(`Pre-market +${priceData.change?.toFixed(1)}% 🚀`); }
  else if (priceData.change > 10) { score += 4; reasons.push(`+${priceData.change?.toFixed(1)}% today 🔥`); }
  else if (priceData.change > 5)  { score += 2; reasons.push(`+${priceData.change?.toFixed(1)}% today`); }
  else if (priceData.change > 1)  { score += 1; }
  if (priceData.change < -3) { score -= 3; reasons.push('Dropping ⚠️'); }

  if (volumeData?.spike > 5)      { score += 4; reasons.push(`Volume ${volumeData.spike}x avg 🚀`); }
  else if (volumeData?.spike > 3) { score += 3; reasons.push(`Volume ${volumeData.spike}x avg`); }
  else if (volumeData?.spike > 2) { score += 1; }

  score += Math.min(sentiment.score, 4);
  if (sentiment.bull > 0) reasons.push(`${sentiment.bull} bullish headlines`);

  if (profile) {
    const mktCap = profile.marketCapitalization;
    const sector = profile.finnhubIndustry || '';
    const shares = profile.shareOutstanding;
    const price  = priceData.price;
    if (/biotech|pharma|drug|therapeut|bioscien/i.test(sector)) { score += 3; reasons.push('Biotech 🧬'); }
    if (shares && shares < 50)  { score += 3; reasons.push(`Low float ${shares.toFixed(1)}M shares`); }
    else if (shares && shares < 100) { score += 1; }
    if (mktCap && mktCap < 500) { score += 2; reasons.push(`Small cap $${mktCap.toFixed(0)}M`); }
    if (price < 5) { score += 2; reasons.push('Penny stock squeeze potential'); }
    if (profile.country && profile.country !== 'US' && mktCap < 500) { score += 1; reasons.push('Foreign small cap'); }
  }

  const edgar = edgarSignals.find(s => s.ticker === ticker);
  if (edgar?.priority === 'HIGH')   { score += 4; reasons.push(`${edgar.title} 📋`); }
  if (edgar?.priority === 'MEDIUM') { score += 2; reasons.push(`${edgar.title} 📋`); }
  if (insiderSignals.find(s => s.ticker === ticker)) { score += 3; reasons.push('Insider buying 🏦'); }

  if (priceData.open && priceData.prevClose) {
    const gapPct = ((priceData.open - priceData.prevClose) / priceData.prevClose) * 100;
    if (gapPct > 10) { score += 3; reasons.push(`Gap up ${gapPct.toFixed(1)}%`); }
  }

  return {
    ticker, price: priceData.price, changePct: priceData.change,
    sentiment, volume: volumeData, score, reasons,
    entry:    priceData.price,
    target1:  (priceData.price * (1 + TARGET1_PCT)).toFixed(2),
    target2:  (priceData.price * (1 + TARGET2_PCT)).toFixed(2),
    stopLoss: (priceData.price * (1 - STOP_LOSS_PCT)).toFixed(2),
  };
}

async function updateTrailingStops() {
  try {
    const positions = await getPositions();
    for (const pos of positions) {
      const symbol = pos.symbol;
      const currentPrice = parseFloat(pos.current_price);
      const entryPrice   = parseFloat(pos.avg_entry_price);
      const pnlPct       = (currentPrice - entryPrice) / entryPrice;
      if (pnlPct >= TARGET2_PCT) {
        const trailPrice = currentPrice * 0.85;
        if (!trailingStops[symbol] || trailPrice > trailingStops[symbol]) {
          trailingStops[symbol] = trailPrice;
          await supabase.from('pulsetrader_positions').update({ trailing_stop: trailPrice }).eq('symbol', symbol);
        }
        if (currentPrice <= trailingStops[symbol]) {
          await closePosition(symbol);
          delete trailingStops[symbol];
        }
      }
      if (pnlPct >= 1.0) {
        const { data: rec } = await supabase.from('pulsetrader_positions').select('*').eq('symbol', symbol).maybeSingle();
        if (rec && !rec.sold_75pct) {
          const sellQty = Math.floor(parseInt(pos.qty) * 0.75);
          if (sellQty > 0) {
            await placeOrder({ symbol, qty: sellQty, side: 'sell' });
            await supabase.from('pulsetrader_positions').update({ sold_75pct: true, qty_remaining: parseInt(pos.qty) - sellQty }).eq('symbol', symbol);
          }
        }
      }
    }
  } catch (e) { console.error('[TRAIL ERROR]', e.message); }
}

async function manageExits() {
  try {
    const positions = await getPositions();
    const account   = await getAccount();
    const now       = new Date();
    const etHour    = now.getUTCHours() - 4;
    const etMin     = now.getUTCMinutes();
    const equity    = parseFloat(account.equity);
    if ((equity - 100000) / 100000 <= -MAX_DAILY_LOSS_PCT) {
      for (const pos of positions) await closePosition(pos.symbol);
      return;
    }
    for (const pos of positions) {
      const symbol       = pos.symbol;
      const currentPrice = parseFloat(pos.current_price);
      const entryPrice   = parseFloat(pos.avg_entry_price);
      const qty          = parseInt(pos.qty);
      const pnlPct       = (currentPrice - entryPrice) / entryPrice;
      const { data: rec } = await supabase.from('pulsetrader_positions').select('*').eq('symbol', symbol).maybeSingle();

      if (pnlPct <= -STOP_LOSS_PCT) { await closePosition(symbol); continue; }

      if (pnlPct >= TARGET1_PCT && rec && !rec.sold_50pct) {
        const sellQty = Math.floor(qty * 0.50);
        if (sellQty > 0) {
          await placeOrder({ symbol, qty: sellQty, side: 'sell' });
          await supabase.from('pulsetrader_positions').update({ sold_50pct: true, qty_remaining: qty - sellQty }).eq('symbol', symbol);
        }
        continue;
      }

      if (pnlPct >= TARGET2_PCT && rec && rec.sold_50pct && !rec.sold_25pct) {
        const sellQty = Math.floor(qty * 0.25);
        if (sellQty > 0) {
          await placeOrder({ symbol, qty: sellQty, side: 'sell' });
          await supabase.from('pulsetrader_positions').update({ sold_25pct: true, qty_remaining: (rec.qty_remaining||qty) - sellQty }).eq('symbol', symbol);
        }
        continue;
      }

      if (etHour >= 13 && etMin >= 45 && pnlPct < 0.05 && pnlPct > -STOP_LOSS_PCT) {
        await closePosition(symbol); continue;
      }

      if (rec) {
        const daysHeld = (Date.now() - new Date(rec.created_at).getTime()) / (1000*60*60*24);
        if (daysHeld >= 3) await closePosition(symbol);
      }
    }
  } catch (e) { console.error('[EXIT ERROR]', e.message); }
}

async function runScan(isPreMarket = false) {
  console.log(`\n[SCAN] ${isPreMarket ? 'PRE-MARKET' : 'REGULAR'} at`, new Date().toISOString());
  try {
    const account     = await getAccount();
    const buyingPower = parseFloat(account.buying_power);
    const positions   = await getPositions();
    if (buyingPower < 100 || positions.length >= MAX_POSITIONS) return;

    const [edgarSignals, insiderSignals, yahooTickers] = await Promise.all([
      scanEdgarFilings(), scanForm4Insider(), getYahooGainers()
    ]);

    const allTickers = [...new Set([
      ...edgarSignals.map(s => s.ticker),
      ...insiderSignals.map(s => s.ticker),
      ...yahooTickers.slice(0, 10),
    ])].filter(Boolean);

    const scored = [];
    let avCalls = 0;
    for (const ticker of allTickers.slice(0, 20)) {
      if (avCalls >= 20) break;
      const result = await scoreSignal(ticker, edgarSignals, insiderSignals);
      if (result) scored.push(result);
      avCalls++;
      await new Promise(r => setTimeout(r, 500));
    }

    for (const w of scored.filter(s => s.score >= SCORE_WATCHLIST && s.score < MIN_SCORE)) {
      await supabase.from('pulsetrader_watchlist').upsert({ symbol: w.ticker, reason: w.reasons.join(', '), score: w.score }, { onConflict: 'symbol' });
    }

    const topPicks = scored.filter(s => s.score >= MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, 3);
    const held = new Set(positions.map(p => p.symbol));

    for (const pick of topPicks) {
      if (held.has(pick.ticker) || positions.length >= MAX_POSITIONS) continue;
      const maxUSD = isPreMarket ? MAX_PREMARKET_USD : MAX_POS_USD;
      const qty    = Math.floor(Math.min(maxUSD, buyingPower * 0.05) / pick.price);
      if (qty < 1) continue;
      try {
        if (isPreMarket) {
          await placeOrder({ symbol: pick.ticker, qty, side: 'buy', limitPrice: pick.price * 1.02, extendedHours: true });
        } else {
          await placeOrder({ symbol: pick.ticker, qty, side: 'buy', stopLoss: parseFloat(pick.stopLoss), takeProfit: parseFloat(pick.target1) });
        }
        await supabase.from('pulsetrader_positions').upsert({
          symbol: pick.ticker, entry_price: pick.price, qty_total: qty, qty_remaining: qty,
          sold_50pct: false, sold_25pct: false, sold_75pct: false, trailing_stop: null,
        }, { onConflict: 'symbol' });
      } catch (e) { console.error(`[ORDER ERROR] ${pick.ticker}:`, e.response?.data || e.message); }
    }
  } catch (e) { console.error('[SCAN ERROR]', e.message); }
}

async function getTopMovers() {
  try {
    const [edgarSignals, insiderSignals, yahooTickers] = await Promise.all([scanEdgarFilings(), scanForm4Insider(), getYahooGainers()]);
    const allTickers = [...new Set([...edgarSignals.map(s=>s.ticker), ...insiderSignals.map(s=>s.ticker), ...yahooTickers.slice(0,10)])].slice(0,15);
    const scored = [];
    for (const ticker of allTickers) {
      const result = await scoreSignal(ticker, edgarSignals, insiderSignals);
      if (result && result.score >= 3) scored.push(result);
      await new Promise(r => setTimeout(r, 400));
    }
    return scored.sort((a,b) => b.score - a.score).slice(0,5);
  } catch (e) { return []; }
}

async function getDailyPnL() {
  try {
    const [account, positions] = await Promise.all([getAccount(), getPositions()]);
    const totalPnL    = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl||0), 0);
    const totalPnLPct = positions.length > 0 ? positions.reduce((sum,p) => sum + parseFloat(p.unrealized_plpc||0), 0) / positions.length : 0;
    return {
      equity: account.equity, buying_power: account.buying_power, positions: positions.length,
      total_pnl: totalPnL.toFixed(2), total_pnl_pct: (totalPnLPct*100).toFixed(2),
      positions_detail: positions.map(p => ({
        symbol: p.symbol, qty: p.qty,
        pnl: parseFloat(p.unrealized_pl||0).toFixed(2),
        pnl_pct: (parseFloat(p.unrealized_plpc||0)*100).toFixed(2)+'%',
        current: p.current_price, entry: p.avg_entry_price,
      }))
    };
  } catch (e) { return null; }
}

async function saveChatMessage(role, content) {
  try { await supabase.from('pulsetrader_chats').insert({ role, content }); } catch(e) {}
}

async function loadChatHistory() {
  try {
    const { data } = await supabase.from('pulsetrader_chats').select('role,content').order('created_at',{ascending:true}).limit(20);
    return data || [];
  } catch(e) { return []; }
}

async function buildMarketContext() {
  try {
    const [account, positions, orders, signals, earnings] = await Promise.all([
      getAccount(), getPositions(), getOpenOrders(), scanEdgarFilings(), getEarningsCalendar()
    ]);
    const pnl = await getDailyPnL();
    return {
      buying_power: account.buying_power, equity: account.equity,
      daily_pnl: pnl?.total_pnl, daily_pnl_pct: pnl?.total_pnl_pct+'%',
      positions_count: positions.length, max_positions: MAX_POSITIONS,
      positions: positions.map(p => ({
        symbol: p.symbol, qty: p.qty, entry: p.avg_entry_price, current: p.current_price,
        pnl: parseFloat(p.unrealized_pl||0).toFixed(2),
        pnl_pct: (parseFloat(p.unrealized_plpc||0)*100).toFixed(2)+'%',
        trailing_stop: trailingStops[p.symbol]||null,
      })),
      open_orders: orders.length, edgar_catalysts: signals.slice(0,5), earnings_this_week: earnings.slice(0,5),
    };
  } catch(e) { return { error: 'Could not load market data' }; }
}

app.post('/verify-pin', (req, res) => {
  req.body.pin === ACCESS_PIN ? res.json({ success: true }) : res.status(401).json({ success: false });
});

app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  const buyMatch  = message.match(/^buy\s+(\d+)?\s*([A-Z]{1,5})/i);
  const sellMatch = message.match(/^sell\s+([A-Z]{1,5})/i);
  const exitAll   = /exit all|close all|sell everything/i.test(message);
  const addWatch  = message.match(/add\s+([A-Z]{1,5})\s+to\s+watchlist/i);
  const remWatch  = message.match(/remove\s+([A-Z]{1,5})\s+from\s+watchlist/i);
  const showWatch = /show watchlist/i.test(message);

  if (exitAll) {
    const positions = await getPositions();
    for (const pos of positions) await closePosition(pos.symbol);
    return res.json({ reply: `Closed all ${positions.length} positions. We out. 💨` });
  }
  if (sellMatch) {
    const symbol = sellMatch[1].toUpperCase();
    await closePosition(symbol);
    return res.json({ reply: `Sold ${symbol}. Position closed. 💰` });
  }
  if (buyMatch) {
    const qty = parseInt(buyMatch[1]) || 1;
    const symbol = buyMatch[2].toUpperCase();
    try {
      const priceData = await getPrice(symbol);
      if (!priceData?.price) return res.json({ reply: `Can't get price for ${symbol} right now.` });
      await placeOrder({ symbol, qty, side: 'buy', stopLoss: priceData.price*(1-STOP_LOSS_PCT), takeProfit: priceData.price*(1+TARGET1_PCT) });
      await supabase.from('pulsetrader_positions').upsert({ symbol, entry_price: priceData.price, qty_total: qty, qty_remaining: qty, sold_50pct: false, sold_25pct: false, sold_75pct: false, trailing_stop: null }, { onConflict: 'symbol' });
      return res.json({ reply: `Bought ${qty} shares of ${symbol} at $${priceData.price}. Stop $${(priceData.price*0.9).toFixed(2)}, target $${(priceData.price*1.3).toFixed(2)}. Trap money working 💰` });
    } catch (e) { return res.json({ reply: `Order failed: ${e.message}` }); }
  }
  if (addWatch) {
    const symbol = addWatch[1].toUpperCase();
    await supabase.from('pulsetrader_watchlist').upsert({ symbol, reason: 'Manual add', score: 0 }, { onConflict: 'symbol' });
    return res.json({ reply: `${symbol} on the watchlist. Eyes open 👀` });
  }
  if (remWatch) {
    const symbol = remWatch[1].toUpperCase();
    await supabase.from('pulsetrader_watchlist').delete().eq('symbol', symbol);
    return res.json({ reply: `${symbol} removed from watchlist.` });
  }
  if (showWatch) {
    const { data } = await supabase.from('pulsetrader_watchlist').select('*').order('score', { ascending: false });
    if (!data?.length) return res.json({ reply: 'Watchlist empty. Add stocks with "add TICKER to watchlist"' });
    const list = data.map(w => `${w.symbol} (score: ${w.score}) — ${w.reason}`).join('\n');
    return res.json({ reply: `Watchlist:\n${list}` });
  }

  const [context, history] = await Promise.all([buildMarketContext(), loadChatHistory()]);

  const systemPrompt = `You are PulseTrader, an elite AI trading bot that talks like Jeezy — street smart, confident, direct, Atlanta energy, always focused on the money. You specialize in finding stocks BEFORE they spike like HCWB +164%, GCL +96%, SLXN +79%, MWC +154%, SLXN +134%.

Current Account:
${JSON.stringify(context, null, 2)}

Strategy: Hunt pre-market movers 20%+ with same-day EDGAR catalyst. Target biotech/pharma FDA approvals, M&A, earnings beats. Low float under 50M shares, small cap under $500M, foreign small caps, penny stocks under $5 — these squeeze 50-150%+. Volume spike 3x+ and insider Form 4 buying are strong signals. Gap up at open = momentum.

Exit: Sell 50% at +30%, 25% at +60%, hold 15% with trailing stop. If up 100%+ sell 75% immediately. Hard stop -10%. Exit before 2PM ET if weak. Never hold 3+ days. Max 3 positions. Pause if down 20% on day.

Commands: "what's moving"→movers, "daily pnl"→P&L, "earnings this week"→calendar, "score TICKER"→analysis, "what we holdin"→positions, "buying power"→balance, "scan now"→trigger scan, "pre-market movers"→gainers, "show watchlist"→watchlist, "buy QTY TICKER"→order, "sell TICKER"→close, "exit all"→close everything, "why did TICKER spike"→breakdown.

Keep it short, punchy, Jeezy style. Reference real numbers. Stay focused on the money.`;

  try {
    const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: message }],
      max_tokens: 400, temperature: 0.85,
    }, { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } });
    const reply = data.choices[0].message.content;
    await Promise.all([saveChatMessage('user', message), saveChatMessage('assistant', reply)]);
    res.json({ reply });
  } catch (e) {
    console.error('[CHAT ERROR]', e.response?.data || e.message);
    res.status(500).json({ error: 'Chat failed' });
  }
});

app.get('/history', async (req, res) => res.json(await loadChatHistory()));
app.get('/account', async (req, res) => { try { const d = await getAccount(); res.json({ buying_power: d.buying_power, equity: d.equity, status: d.status }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/positions', async (req, res) => { try { res.json(await getPositions()); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/pnl', async (req, res) => res.json(await getDailyPnL()));
app.get('/earnings', async (req, res) => res.json(await getEarningsCalendar()));
app.get('/scan', async (req, res) => { try { await runScan(); res.json({ message: 'Scan complete' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/movers', async (req, res) => res.json(await getTopMovers()));
app.get('/watchlist', async (req, res) => { const { data } = await supabase.from('pulsetrader_watchlist').select('*').order('score',{ascending:false}); res.json(data||[]); });
app.get('/price/:symbol', async (req, res) => { const d = await getPrice(req.params.symbol.toUpperCase()); d ? res.json(d) : res.status(404).json({ error: 'Not found' }); });
app.get('/score/:symbol', async (req, res) => {
  const [edgar, insider] = await Promise.all([scanEdgarFilings(), scanForm4Insider()]);
  const d = await scoreSignal(req.params.symbol.toUpperCase(), edgar, insider);
  d ? res.json(d) : res.status(404).json({ error: 'Could not score' });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PulseTrader</title>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { background:#0a0a0a; color:#fff; font-family:-apple-system,sans-serif; height:100vh; display:flex; flex-direction:column; }
#lock-screen { position:fixed; inset:0; background:#0a0a0a; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px; z-index:99; }
#lock-screen h1 { font-size:32px; color:#00ff88; font-weight:900; }
#lock-screen p { color:#666; font-size:14px; }
#pin-input { background:#1a1a1a; border:1px solid #333; border-radius:12px; padding:14px 20px; color:#fff; font-size:20px; text-align:center; width:240px; outline:none; letter-spacing:6px; }
#pin-btn { background:#00ff88; color:#000; border:none; border-radius:12px; padding:14px 40px; font-weight:900; font-size:16px; cursor:pointer; width:240px; }
#pin-error { color:#ff4444; font-size:13px; display:none; }
#app { display:none; flex-direction:column; height:100vh; }
#header { padding:12px 16px; background:#111; border-bottom:1px solid #222; display:flex; justify-content:space-between; align-items:center; }
#header h1 { font-size:18px; font-weight:900; color:#00ff88; }
.hbtn { background:#1a1a1a; border:1px solid #333; color:#aaa; border-radius:8px; padding:6px 10px; font-size:11px; cursor:pointer; }
.quick-btns { padding:8px 16px; display:flex; gap:6px; overflow-x:auto; background:#111; border-bottom:1px solid #222; }
.qbtn { background:#1a1a1a; border:1px solid #333; color:#aaa; border-radius:12px; padding:6px 12px; font-size:12px; cursor:pointer; white-space:nowrap; }
.qbtn:active { border-color:#00ff88; color:#00ff88; }
#messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
.msg { max-width:88%; padding:10px 14px; border-radius:16px; font-size:14px; line-height:1.5; }
.msg .time { font-size:10px; color:#555; margin-top:4px; }
.user { background:#1a1a2e; align-self:flex-end; border-bottom-right-radius:4px; }
.bot { background:#111; border:1px solid #222; align-self:flex-start; border-bottom-left-radius:4px; color:#00ff88; }
.bot-name { font-size:10px; color:#555; margin-bottom:4px; font-weight:700; letter-spacing:1px; }
#input-area { padding:12px 16px; background:#111; border-top:1px solid #222; display:flex; gap:8px; }
#input { flex:1; background:#1a1a1a; border:1px solid #333; border-radius:20px; padding:10px 16px; color:#fff; font-size:14px; outline:none; }
#send { background:#00ff88; color:#000; border:none; border-radius:20px; padding:10px 20px; font-weight:900; font-size:14px; cursor:pointer; }
</style>
</head>
<body>
<div id="lock-screen">
  <h1>⚡ PulseTrader</h1>
  <p>Enter your access PIN</p>
  <input id="pin-input" type="password" placeholder="••••••" />
  <button id="pin-btn">Unlock</button>
  <span id="pin-error">Wrong PIN. Try again.</span>
</div>
<div id="app">
  <div id="header">
    <h1>⚡ PulseTrader</h1>
    <div style="display:flex;gap:6px;">
      <button class="hbtn" onclick="quickAsk('daily pnl')">P&L</button>
      <button class="hbtn" onclick="quickAsk('what we holdin')">Holdings</button>
      <button class="hbtn" onclick="quickAsk('show movers')">Movers</button>
    </div>
  </div>
  <div class="quick-btns">
    <button class="qbtn" onclick="quickAsk('what is moving today')">🔥 Movers</button>
    <button class="qbtn" onclick="quickAsk('what EDGAR dropping today')">📋 EDGAR</button>
    <button class="qbtn" onclick="quickAsk('earnings this week')">📅 Earnings</button>
    <button class="qbtn" onclick="quickAsk('daily pnl')">💰 P&L</button>
    <button class="qbtn" onclick="quickAsk('show watchlist')">👀 Watchlist</button>
    <button class="qbtn" onclick="quickAsk('scan now')">🔍 Scan</button>
    <button class="qbtn" onclick="quickAsk('pre-market movers')">🌅 Pre-Mkt</button>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <input id="input" placeholder="buy TSLA, score NVDA, what's moving..." />
    <button id="send">Send</button>
  </div>
</div>
<script>
const lockScreen=document.getElementById('lock-screen');
const appDiv=document.getElementById('app');
const pinInput=document.getElementById('pin-input');
const pinBtn=document.getElementById('pin-btn');
const pinError=document.getElementById('pin-error');
const messages=document.getElementById('messages');
const input=document.getElementById('input');
const send=document.getElementById('send');

if(sessionStorage.getItem('unlocked')==='true'){lockScreen.style.display='none';appDiv.style.display='flex';loadHistory();}

async function unlock(){
  const pin=pinInput.value.trim();
  const res=await fetch('/verify-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
  const data=await res.json();
  if(data.success){sessionStorage.setItem('unlocked','true');lockScreen.style.display='none';appDiv.style.display='flex';loadHistory();}
  else{pinError.style.display='block';pinInput.value='';}
}

async function loadHistory(){
  const res=await fetch('/history');
  const data=await res.json();
  if(data.length===0){addMsg('Welcome back. Type "show movers" to see pre-spike candidates, "daily pnl" for account status, or ask me anything. Trap money don\\'t sleep 💰','bot');}
  else{data.forEach(m=>addMsg(m.content,m.role==='user'?'user':'bot'));}
}

pinBtn.addEventListener('click',unlock);
pinInput.addEventListener('keypress',e=>{if(e.key==='Enter')unlock();});

function addMsg(text,type){
  const div=document.createElement('div');
  div.className='msg '+type;
  const time=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(type==='bot'){div.innerHTML='<div class="bot-name">PULSETRADER</div>'+text+'<div class="time">'+time+'</div>';}
  else{div.innerHTML=text+'<div class="time">'+time+'</div>';}
  messages.appendChild(div);
  messages.scrollTop=messages.scrollHeight;
  return div;
}

function quickAsk(msg){input.value=msg;sendMessage();}

async function sendMessage(){
  const msg=input.value.trim();
  if(!msg)return;
  input.value='';
  addMsg(msg,'user');
  const typing=addMsg('thinking...','bot');
  try{
    const res=await fetch('/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
    const data=await res.json();
    typing.remove();
    addMsg(data.reply||data.error,'bot');
  }catch(e){typing.remove();addMsg('Connection error — try again','bot');}
}

send.addEventListener('click',sendMessage);
input.addEventListener('keypress',e=>{if(e.key==='Enter')sendMessage();});
</script>
</body>
</html>`);
});

cron.schedule('0 8 * * 1-5', () => runScan(true));
cron.schedule('32 13 * * 1-5', () => runScan(false));
cron.schedule('0 15 * * 1-5', () => runScan(false));
cron.schedule('*/5 13-20 * * 1-5', updateTrailingStops);
cron.schedule('*/5 13-20 * * 1-5', manageExits);
cron.schedule('*/30 13-20 * * 1-5', async () => {
  try {
    const { data: watchlist } = await supabase.from('pulsetrader_watchlist').select('symbol');
    if (!watchlist?.length) return;
    const [edgar, insider] = await Promise.all([scanEdgarFilings(), scanForm4Insider()]);
    for (const w of watchlist) {
      const result = await scoreSignal(w.symbol, edgar, insider);
      if (result && result.score >= MIN_SCORE) {
        await supabase.from('pulsetrader_watchlist').update({ score: result.score }).eq('symbol', w.symbol);
        console.log(`[WATCHLIST ALERT] ${w.symbol} score ${result.score} — ready!`);
      }
    }
  } catch(e) {}
});

console.log('[SCHEDULER] All cron jobs registered');
console.log('[BOT] Pre-market 4AM, Open 9:32AM, Mid 11AM, Trailing stops every 5min, Exit manager every 5min, Watchlist every 30min');

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 PulseTrader FINAL VERSION on port ${PORT}`);
  console.log('Features: Pre-market, Form4, Volume, Low float, Biotech filter, Partial exits, Trailing stops, Watchlist, Chat commands');
  try {
    const acct = await getAccount();
    console.log(`✅ Alpaca — equity: $${acct.equity}, buying power: $${acct.buying_power}`);
  } catch(e) { console.error('❌ Alpaca failed:', e.message); }
});
