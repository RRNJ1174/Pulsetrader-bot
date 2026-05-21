// ╔══════════════════════════════════════════════════════════════════════════╗
// ║   PULSETRADER v7.1 — FULL MARKET SCANNER + SELF-LEARNING AUTO TRADER   ║
// ║   Fixes: Real gainers only — no hallucinated tickers                    ║
// ║   Alpaca screener → Finnhub backup → AI analysis → Auto trade           ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import express from "express";
import cors    from "cors";
import fetch   from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ════════════════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  MAX_POSITIONS:      5,
  POSITION_SIZE:      1000,
  MIN_SPIKE_PCT:      5,
  MAX_PRICE:          20,
  MIN_PRICE:          0.30,
  MIN_VOLUME:         30000,
  PROFIT_TARGET:      25,
  STOP_LOSS:          10,
  SCAN_INTERVAL:      5 * 60 * 1000,
  MIN_CONVICTION:     7,
  TOP_GAINERS_COUNT:  50,
};

const BRAIN = {
  totalTrades:0, wins:0, losses:0, totalPnL:0,
  bestSetups:{}, bestHours:{}, worstTickers:[], bestTickers:[],
  recentPerformance:[], adjustedTarget:25, adjustedStop:10,
  lessons:[], lastLearned:null,
};

const tradeLog   = [];
const openTrades = {};
let autoTraderActive = false;
let scanInterval     = null;
let lastScanTime     = null;
let lastGainers      = [];
let lastAnalysis     = "";

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════════════════════════════

const buildSystem = () => {
  const wr = BRAIN.totalTrades > 0
    ? ((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%" : "learning";
  const topSetups = Object.entries(BRAIN.bestSetups)
    .sort((a,b)=>b[1].winRate-a[1].winRate).slice(0,3)
    .map(([k,v])=>`${k}(${v.winRate.toFixed(0)}%win)`).join(", ") || "collecting data";
  const recentLessons = BRAIN.lessons.slice(0,5).map(l=>`- ${l}`).join("\n") || "none yet";

  return `You are PulseTrader — elite self-learning AI momentum trader.
You ONLY analyze real stocks with real data provided to you. NEVER invent tickers or prices.
If no data is provided, say "No real gainers found right now."

YOUR LIVE PERFORMANCE:
- Win rate: ${wr} (${BRAIN.wins}W/${BRAIN.losses}L)
- Total P&L: $${BRAIN.totalPnL.toFixed(2)}
- Best setups: ${topSetups}
- Avoid: ${BRAIN.worstTickers.slice(0,8).join(",")||"none"}
- Proven winners: ${BRAIN.bestTickers.slice(0,8).join(",")||"none"}
- Target: +${BRAIN.adjustedTarget}% | Stop: -${BRAIN.adjustedStop}%

LESSONS LEARNED:
${recentLessons}

STRATEGY — finding stocks like WHLR +110%, PCLA +94%, EDHL +80%:
1. CATALYST — FDA, earnings beat, contract, merger, short squeeze news
2. LOW FLOAT — under 15M shares = explosive moves
3. VOLUME — 3x+ above average confirms the move
4. PRICE — $0.30-$20 sweet spot
5. TIMING — first 30-60 min after catalyst

FORMAT: 📊 TICKER | Price | % Move | Float | Catalyst | Setup | Conviction/10 | Entry | Target | Stop`;
};

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

const groq = async (prompt, maxTokens=1200) => {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"llama-3.3-70b-versatile", max_tokens:maxTokens,
        messages:[{role:"system",content:buildSystem()},{role:"user",content:prompt}],
      }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    return d.choices?.[0]?.message?.content || "No response.";
  } catch(e) { console.error("Groq:",e.message); return `Error: ${e.message}`; }
};

const groqChat = async (messages, maxTokens=1200) => {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"llama-3.3-70b-versatile", max_tokens:maxTokens,
        messages:[{role:"system",content:buildSystem()},...messages],
      }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    return d.choices?.[0]?.message?.content || "No response.";
  } catch(e) { return `Error: ${e.message}`; }
};

const supabase = async (path, opts={}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`,{
    headers:{
      apikey:process.env.SUPABASE_KEY,
      Authorization:`Bearer ${process.env.SUPABASE_KEY}`,
      "Content-Type":"application/json",
      Prefer:"return=representation",
    },...opts,
  });
  const t = await res.text();
  return t ? JSON.parse(t) : [];
};

const alpaca = async (path, opts={}) => {
  const res = await fetch(`https://paper-api.alpaca.markets${path}`,{
    headers:{
      "APCA-API-KEY-ID":process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY":process.env.ALPACA_SECRET,
      "Content-Type":"application/json",
    },...opts,
  });
  return res.json();
};

const alpacaData = async (path) => {
  const res = await fetch(`https://data.alpaca.markets${path}`,{
    headers:{
      "APCA-API-KEY-ID":process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY":process.env.ALPACA_SECRET,
    },
  });
  return res.json();
};

const finnhub = async (path) => {
  const sep = path.includes("?")?"&":"?";
  const res = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`);
  return res.json();
};

// ════════════════════════════════════════════════════════════════════════════
// TOP GAINERS — real data only, no hallucination
// ════════════════════════════════════════════════════════════════════════════

const getTopGainers = async () => {
  const gainers = [];

  // Method 1: Alpaca full market screener
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
            if (
              g.price      >= CONFIG.MIN_PRICE  &&
              g.price      <= CONFIG.MAX_PRICE  &&
              g.percent_change >= CONFIG.MIN_SPIKE_PCT &&
              !BRAIN.worstTickers.includes(g.symbol)
            ) {
              gainers.push({
                ticker: g.symbol,
                c:      g.price,
                dp:     g.percent_change,
                v:      g.volume || 0,
                h:      g.price,
                l:      g.price,
                source: "alpaca_screener",
              });
            }
          }
          console.log(`📡 Alpaca screener: ${gainers.length} qualifying gainers`);
          break;
        }
      } catch(e) { console.log("Alpaca URL attempt failed:", e.message); }
    }
  } catch(e) { console.log("Alpaca screener error:", e.message); }

  // Method 2: Finnhub broad scan as backup
  const BROAD_SCAN = [
    "WHLR","PCLA","EDHL","ATPC","LIMN","ILLR","NCPL","VIDA","DGNX","JUNS",
    "HCWB","SLXN","PHGE","GCL","MLGO","SOUN","MARA","RIOT","CIFR","BTBT",
    "HUT","WULF","CLSK","SPCE","NKLA","CLOV","WISH","IDEX","NAKD","SNDL",
    "OCGN","NVAX","ADMA","BNGO","SRNE","TGTX","EDSA","FBRX","HTBX","SAVA",
    "TE","PETZ","BTM","ORBS","AMMO","STFS","JDZG","CAPS","CTEV","SLQT",
    "COIN","PLTR","SOFI","HOOD","FUTU","TIGR","LMND","HIMS","OPEN","SMAR",
    "ATXI","NKGN","IMVT","AGEN","CYRX","TRIL","IRNC","RRGB","GIPR","CDT",
    "GMEX","KULR","MULN","STEM","VERB","XCUR","INPX","RVNC","QUBT","KPLT",
    "BBCP","CLFD","JSPR","TDUP","ACMR","IRNT","FBRT","GBOX","MNMD","ALTTF",
    "LAUR","TRCH","WNW","MSGY","EGHT","UWMC","MNMD","ALRS","ALBO","ALNA",
  ];

  try {
    const batchSize = 15;
    for (let i=0; i<BROAD_SCAN.length; i+=batchSize) {
      const batch  = BROAD_SCAN.slice(i,i+batchSize);
      const quotes = await Promise.all(
        batch.map(t=>finnhub(`/quote?symbol=${t}`).then(q=>({ticker:t,...q})).catch(()=>null))
      );
      for (const q of quotes.filter(Boolean)) {
        if (
          q.c  >= CONFIG.MIN_PRICE  &&
          q.c  <= CONFIG.MAX_PRICE  &&
          q.dp >= CONFIG.MIN_SPIKE_PCT &&
          q.v  >= CONFIG.MIN_VOLUME &&
          !BRAIN.worstTickers.includes(q.ticker) &&
          !gainers.find(g=>g.ticker===q.ticker)
        ) {
          gainers.push({ticker:q.ticker,c:q.c,dp:q.dp,v:q.v,h:q.h,l:q.l,source:"finnhub"});
        }
      }
      if (i+batchSize < BROAD_SCAN.length) await new Promise(r=>setTimeout(r,250));
    }
    console.log(`🔍 Finnhub scan added ${gainers.filter(g=>g.source==="finnhub").length} more gainers`);
  } catch(e) { console.log("Finnhub scan error:", e.message); }

  return gainers.sort((a,b)=>b.dp-a.dp);
};

// ════════════════════════════════════════════════════════════════════════════
// DEEP ANALYSIS — WHY is this stock moving?
// ════════════════════════════════════════════════════════════════════════════

const analyzeGainer = async (ticker, price, pct) => {
  try {
    const week  = new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [profile, news] = await Promise.all([
      finnhub(`/stock/profile2?symbol=${ticker}`),
      finnhub(`/company-news?symbol=${ticker}&from=${week}&to=${today}`),
    ]);
    return {
      ticker, price, pct,
      float:    profile.shareOutstanding || "unknown",
      industry: profile.finnhubIndustry  || "unknown",
      headlines: Array.isArray(news) ? news.slice(0,4).map(n=>`- ${n.headline}`).join("\n") : "No news",
    };
  } catch(e) {
    return {ticker, price, pct, float:"?", industry:"?", headlines:"No data"};
  }
};

// ════════════════════════════════════════════════════════════════════════════
// SELF-LEARNING ENGINE
// ════════════════════════════════════════════════════════════════════════════

const learnFromTrade = async (trade) => {
  const won = trade.pnl > 0;
  BRAIN.totalTrades++;
  won ? BRAIN.wins++ : BRAIN.losses++;
  BRAIN.totalPnL += trade.pnl || 0;

  if (trade.setup) {
    if (!BRAIN.bestSetups[trade.setup]) BRAIN.bestSetups[trade.setup]={trades:0,wins:0,winRate:0};
    BRAIN.bestSetups[trade.setup].trades++;
    if (won) BRAIN.bestSetups[trade.setup].wins++;
    BRAIN.bestSetups[trade.setup].winRate =
      (BRAIN.bestSetups[trade.setup].wins/BRAIN.bestSetups[trade.setup].trades)*100;
  }

  if (won) {
    if (!BRAIN.bestTickers.includes(trade.symbol)) BRAIN.bestTickers.unshift(trade.symbol);
    BRAIN.worstTickers = BRAIN.worstTickers.filter(t=>t!==trade.symbol);
  } else {
    if (!BRAIN.worstTickers.includes(trade.symbol)) BRAIN.worstTickers.unshift(trade.symbol);
  }

  BRAIN.recentPerformance.unshift({...trade,won});
  BRAIN.recentPerformance = BRAIN.recentPerformance.slice(0,20);

  const rw = BRAIN.recentPerformance.filter(t=>t.won).length;
  const rt = BRAIN.recentPerformance.length;
  if (rt >= 5) {
    const rate = rw/rt;
    if (rate > 0.65) {
      BRAIN.adjustedTarget = Math.min(40, BRAIN.adjustedTarget+2);
      CONFIG.MIN_CONVICTION = Math.max(6, CONFIG.MIN_CONVICTION-1);
      CONFIG.PROFIT_TARGET  = BRAIN.adjustedTarget;
      console.log("📈 Winning streak — more aggressive");
    } else if (rate < 0.35) {
      BRAIN.adjustedTarget = Math.max(15, BRAIN.adjustedTarget-2);
      BRAIN.adjustedStop   = Math.max(5,  BRAIN.adjustedStop-1);
      CONFIG.MIN_CONVICTION = Math.min(9, CONFIG.MIN_CONVICTION+1);
      CONFIG.PROFIT_TARGET  = BRAIN.adjustedTarget;
      CONFIG.STOP_LOSS      = BRAIN.adjustedStop;
      console.log("📉 Losing streak — more conservative");
    }
  }

  try {
    const lesson = await groq(
      `Trade: ${trade.symbol} | ${won?"WIN ✅":"LOSS ❌"} | P&L: $${trade.pnl?.toFixed(2)}\n` +
      `Entry $${trade.entryPrice} → Exit $${trade.exitPrice} | Setup: ${trade.setup}\n\n` +
      `ONE sentence lesson for future trades:`,100
    );
    BRAIN.lessons.unshift(lesson.trim());
    BRAIN.lessons = BRAIN.lessons.slice(0,10);
    BRAIN.lastLearned = new Date().toISOString();
    console.log(`🧠 Lesson: ${lesson}`);
  } catch(e) {}

  await supabase("bot_trade_memory",{method:"POST",body:JSON.stringify({
    symbol:trade.symbol,side:"LONG",
    entry_price:trade.entryPrice,exit_price:trade.exitPrice,
    pnl:trade.pnl,pnl_pct:trade.pnlPct,
    entry_reason:trade.reason,exit_reason:trade.exitReason,
    setup_type:trade.setup,won,
    entry_hour:new Date().getHours(),day_of_week:new Date().getDay(),
  })}).catch(()=>{});
};

const loadMemory = async () => {
  try {
    const mem = await supabase("bot_trade_memory?order=created_at.desc&limit=200");
    if (!Array.isArray(mem)||!mem.length) { console.log("🧠 Fresh start"); return; }
    BRAIN.totalTrades = mem.length;
    BRAIN.wins        = mem.filter(m=>m.won).length;
    BRAIN.losses      = mem.filter(m=>!m.won).length;
    BRAIN.totalPnL    = mem.reduce((s,m)=>s+parseFloat(m.pnl||0),0);
    mem.forEach(m=>{
      if (m.setup_type){
        if (!BRAIN.bestSetups[m.setup_type]) BRAIN.bestSetups[m.setup_type]={trades:0,wins:0,winRate:0};
        BRAIN.bestSetups[m.setup_type].trades++;
        if (m.won) BRAIN.bestSetups[m.setup_type].wins++;
        BRAIN.bestSetups[m.setup_type].winRate=
          (BRAIN.bestSetups[m.setup_type].wins/BRAIN.bestSetups[m.setup_type].trades)*100;
      }
      if (m.won  && !BRAIN.bestTickers.includes(m.symbol))  BRAIN.bestTickers.push(m.symbol);
      if (!m.won && !BRAIN.worstTickers.includes(m.symbol)) BRAIN.worstTickers.push(m.symbol);
    });
    BRAIN.bestTickers  = BRAIN.bestTickers.slice(0,15);
    BRAIN.worstTickers = BRAIN.worstTickers.slice(0,20);
    const lessons = await supabase("bot_lessons?order=created_at.desc&limit=20");
    if (Array.isArray(lessons)) BRAIN.lessons = lessons.map(l=>l.lesson).filter(Boolean);
    console.log(`🧠 Memory: ${mem.length} trades | ${((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0)}% WR | $${BRAIN.totalPnL.toFixed(0)} P&L`);
  } catch(e) { console.log("Memory load failed:", e.message); }
};

// ════════════════════════════════════════════════════════════════════════════
// MARKET HOURS
// ════════════════════════════════════════════════════════════════════════════

const getET = () => new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
const isMarketOpen = () => {
  const et=getET(),d=et.getDay();
  if(d===0||d===6) return false;
  const t=et.getHours()*100+et.getMinutes();
  return t>=930&&t<1600;
};
const isPreMarket = () => {
  const et=getET(),d=et.getDay();
  if(d===0||d===6) return false;
  const t=et.getHours()*100+et.getMinutes();
  return t>=400&&t<930;
};

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER ENGINE
// ════════════════════════════════════════════════════════════════════════════

const autoTrade = async () => {
  if (!isMarketOpen()&&!isPreMarket()) { console.log("⏸️ Market closed"); return; }
  lastScanTime = new Date().toISOString();
  console.log("🔍 Scanning entire market for top gainers...");

  try {
    const gainers = await getTopGainers();
    lastGainers   = gainers.slice(0,20);
    console.log(`📊 ${gainers.length} real gainers | Top: ${gainers.slice(0,5).map(g=>`${g.ticker}+${g.dp?.toFixed(0)}%`).join(", ")}`);

    // Manage existing positions
    const [positions,account] = await Promise.all([
      alpaca("/v2/positions").catch(()=>[]),
      alpaca("/v2/account").catch(()=>null),
    ]);

    if (Array.isArray(positions)) {
      for (const pos of positions) {
        const pct   = parseFloat(pos.unrealized_plpc)*100;
        const sym   = pos.symbol;
        const entry = openTrades[sym];
        if (pct >= CONFIG.PROFIT_TARGET) {
          console.log(`🎯 PROFIT HIT: ${sym} +${pct.toFixed(1)}%`);
          await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
          const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct:pct,entryPrice:pos.avg_entry_price,exitPrice:pos.current_price,reason:entry?.reason||"",setup:entry?.setup||"unknown",exitReason:"PROFIT TARGET",type:"SELL",price:pos.current_price,ts:new Date().toISOString()};
          tradeLog.unshift(t); await learnFromTrade(t); delete openTrades[sym];
        } else if (pct <= -CONFIG.STOP_LOSS) {
          console.log(`🛑 STOP HIT: ${sym} ${pct.toFixed(1)}%`);
          await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
          const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct:pct,entryPrice:pos.avg_entry_price,exitPrice:pos.current_price,reason:entry?.reason||"",setup:entry?.setup||"unknown",exitReason:"STOP LOSS",type:"STOP",price:pos.current_price,ts:new Date().toISOString()};
          tradeLog.unshift(t); await learnFromTrade(t); delete openTrades[sym];
        }
      }
    }

    // Find new entries
    const openCount = Array.isArray(positions)?positions.length:0;
    if (openCount>=CONFIG.MAX_POSITIONS) { console.log("⚠️ Max positions reached"); return; }
    const cash = account?parseFloat(account.cash):0;
    if (cash<CONFIG.POSITION_SIZE) { console.log("⚠️ Insufficient cash"); return; }
    if (!gainers.length) { console.log("⏭️ No qualifying gainers this cycle"); return; }

    // Deep analyze top 8
    const top8     = gainers.slice(0,8);
    const analyses = await Promise.all(top8.map(g=>analyzeGainer(g.ticker,g.c,g.dp)));
    const candStr  = analyses.map(a=>
      `${a.ticker}: $${a.price} +${a.pct?.toFixed(1)}% | Float:${a.float}M | ${a.industry}\nNews: ${a.headlines.split("\n")[0]||"no news"}`
    ).join("\n\n");
    lastAnalysis = candStr;

    const verdict = await groq(
      `REAL top gainers right now (ONLY use these tickers):\n\n${candStr}\n\n` +
      `Pick TOP 2 to buy. Conviction ${CONFIG.MIN_CONVICTION}+. Skip: ${BRAIN.worstTickers.slice(0,5).join(",")||"none"}\n\n` +
      `Reply ONLY in this format:\nBUY: TICKER | CONVICTION: X | SETUP: type | REASON: one line\n` +
      `Setup types: gap_and_go, short_squeeze, catalyst_play, breakout, low_float_spike`,
      400
    );
    console.log("🤖 AI verdict:", verdict);

    const buyLines = verdict.split("\n").filter(l=>l.startsWith("BUY:"));
    const owned    = Array.isArray(positions)?positions.map(p=>p.symbol):[];
    let buys = 0;

    for (const line of buyLines) {
      if (buys >= CONFIG.MAX_POSITIONS-openCount) break;
      const m = line.match(/BUY:\s*([A-Z]+)\s*\|\s*CONVICTION:\s*([\d.]+)/i);
      if (!m) continue;
      const ticker     = m[1].toUpperCase();
      const conviction = parseFloat(m[2]);
      if (conviction < CONFIG.MIN_CONVICTION) continue;
      if (owned.includes(ticker)) continue;
      if (BRAIN.worstTickers.includes(ticker)) { console.log(`🚫 Skip ${ticker}`); continue; }

      // IMPORTANT: only buy if ticker actually came from our real scan
      const gainer = gainers.find(g=>g.ticker===ticker);
      if (!gainer||gainer.c<=0) { console.log(`🚫 ${ticker} not in real gainers list — skipping`); continue; }

      const qty    = Math.floor(CONFIG.POSITION_SIZE/gainer.c);
      if (qty<1) continue;
      const setup  = line.match(/SETUP:\s*([a-z_]+)/i)?.[1]||"unknown";
      const reason = line.match(/REASON:\s*(.+)/i)?.[1]||"top gainer signal";

      console.log(`🚀 BUY ${ticker} x${qty} @ $${gainer.c} | ${setup} | c${conviction}`);
      const order = await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:ticker,qty:String(qty),side:"buy",type:"market",time_in_force:"day"})});

      if (order.id) {
        openTrades[ticker]={reason,setup,time:new Date().toISOString(),conviction};
        tradeLog.unshift({type:"BUY",symbol:ticker,qty,price:gainer.c,conviction,reason,setup,target:(gainer.c*(1+CONFIG.PROFIT_TARGET/100)).toFixed(2),stop:(gainer.c*(1-CONFIG.STOP_LOSS/100)).toFixed(2),ts:new Date().toISOString()});
        await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({symbol:ticker,side:"LONG",qty,entry_price:gainer.c,reason:`AUTO[${setup}|c${conviction}]: ${reason}`})}).catch(()=>{});
        buys++;
        console.log(`✅ Order placed: ${ticker}`);
      } else {
        console.log(`❌ Order failed ${ticker}:`, order.message||"unknown error");
      }
    }
    if (buys===0) console.log("⏭️ No qualifying buys this cycle");

  } catch(e) { console.error("Auto-trade error:", e.message); }
};

// ════════════════════════════════════════════════════════════════════════════
// CONTROLS
// ════════════════════════════════════════════════════════════════════════════

const startAutoTrader = () => {
  if (autoTraderActive) return;
  autoTraderActive = true;
  console.log("🤖 Auto-trader STARTED — scanning entire market");
  autoTrade();
  scanInterval = setInterval(autoTrade, CONFIG.SCAN_INTERVAL);
};

const stopAutoTrader = () => {
  if (scanInterval) clearInterval(scanInterval);
  autoTraderActive=false; scanInterval=null;
  console.log("⏹️ Auto-trader STOPPED");
};

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — AUTO TRADER
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/autotrader/start", (_,res) => { startAutoTrader(); res.json({status:"started",config:CONFIG}); });
app.get( "/api/autotrader/start", (_,res) => { startAutoTrader(); res.json({status:"started"}); });
app.post("/api/autotrader/stop",  (_,res) => { stopAutoTrader();  res.json({status:"stopped"}); });

app.get("/api/autotrader/status", async (req,res) => {
  const [positions,account] = await Promise.all([
    alpaca("/v2/positions").catch(()=>[]),
    alpaca("/v2/account").catch(()=>null),
  ]);
  const todayPnL = account?parseFloat(account.equity)-parseFloat(account.last_equity):0;
  res.json({
    active:autoTraderActive, last_scan:lastScanTime,
    open_positions:Array.isArray(positions)?positions.length:0,
    max_positions:CONFIG.MAX_POSITIONS, position_size:CONFIG.POSITION_SIZE,
    profit_target:CONFIG.PROFIT_TARGET+"%", stop_loss:CONFIG.STOP_LOSS+"%",
    min_conviction:CONFIG.MIN_CONVICTION,
    market_open:isMarketOpen(), pre_market:isPreMarket(),
    equity:account?parseFloat(account.equity).toFixed(2):"—",
    cash:account?parseFloat(account.cash).toFixed(2):"—",
    today_pnl:todayPnL.toFixed(2),
    today_pnl_pct:account?((todayPnL/parseFloat(account.last_equity))*100).toFixed(2)+"%":"—",
    recent_trades:tradeLog.slice(0,20),
    last_gainers:lastGainers,
    last_analysis:lastAnalysis,
    brain:{
      total_trades:BRAIN.totalTrades, wins:BRAIN.wins, losses:BRAIN.losses,
      win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"0%",
      total_pnl:BRAIN.totalPnL.toFixed(2),
      best_setups:BRAIN.bestSetups, best_tickers:BRAIN.bestTickers,
      avoid_tickers:BRAIN.worstTickers, lessons:BRAIN.lessons,
      adjusted_target:BRAIN.adjustedTarget+"%", adjusted_stop:BRAIN.adjustedStop+"%",
    },
  });
});

app.post("/api/autotrader/scan",    async (req,res) => { res.json({message:"Scan triggered",ts:new Date().toISOString()}); autoTrade(); });
app.get( "/api/autotrader/brain",   (_,res) => res.json(BRAIN));
app.get( "/api/autotrader/gainers", (_,res) => res.json({gainers:lastGainers,analysis:lastAnalysis,ts:lastScanTime}));

app.post("/api/autotrader/sellall", async (req,res) => {
  try {
    const p = await alpaca("/v2/positions");
    if (!Array.isArray(p)||!p.length) return res.json({message:"No positions to sell"});
    await Promise.all(p.map(x=>alpaca("/v2/orders",{method:"POST",
      body:JSON.stringify({symbol:x.symbol,qty:x.qty,side:"sell",type:"market",time_in_force:"day"})})));
    res.json({message:`Sold ${p.length} positions`});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Teach the bot
app.post("/api/teach", async (req,res) => {
  const {tickers,context,instruction}=req.body;
  if (!tickers?.length) return res.status(400).json({error:"tickers required"});
  const list=Array.isArray(tickers)?tickers:[tickers];
  const lessons=[];
  for (const ticker of list) {
    try {
      const week=new Date(Date.now()-7*86400000).toISOString().split("T")[0];
      const today=new Date().toISOString().split("T")[0];
      const [quote,profile,news]=await Promise.all([
        finnhub(`/quote?symbol=${ticker.toUpperCase()}`),
        finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
        finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),
      ]);
      const headlines=Array.isArray(news)?news.slice(0,6).map(n=>`- ${n.headline}`).join("\n"):"No news.";
      const analysis=await groq(
        `${instruction||"Analyze for trading"}\n\n` +
        `${ticker.toUpperCase()}: $${quote.c} | +${quote.dp?.toFixed(2)}% | Float:${profile.shareOutstanding}M\n` +
        `${context?"Context: "+context+"\n":""}\nNews:\n${headlines}\n\n` +
        `1. WHY moving? 2. HOW to trade for max profit? 3. Pattern to find similar stocks? 4. Key lesson?`,1000
      );
      const lesson=analysis.slice(-150);
      BRAIN.lessons.unshift(lesson);
      BRAIN.lessons=BRAIN.lessons.slice(0,10);
      if (!BRAIN.bestTickers.includes(ticker.toUpperCase())) BRAIN.bestTickers.unshift(ticker.toUpperCase());
      BRAIN.worstTickers=BRAIN.worstTickers.filter(t=>t!==ticker.toUpperCase());
      await supabase("bot_lessons",{method:"POST",body:JSON.stringify({ticker:ticker.toUpperCase(),lesson,pattern:instruction||"user taught",catalyst:headlines.slice(0,200),taught_by:"user"})}).catch(()=>{});
      lessons.push({ticker:ticker.toUpperCase(),analysis,lesson});
      console.log(`🎓 Taught: ${ticker}`);
    } catch(e) { lessons.push({ticker,error:e.message}); }
  }
  res.json({message:`Studied ${lessons.length} stocks`,lessons});
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — CHAT
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/chat", async (req,res) => {
  const {messages}=req.body;
  if (!messages?.length) return res.status(400).json({error:"No messages"});
  try {
    const [spy,account]=await Promise.all([
      finnhub("/quote?symbol=SPY").catch(()=>null),
      alpaca("/v2/account").catch(()=>null),
    ]);
    const gainersStr=lastGainers.slice(0,5).map(g=>`${g.ticker}+${g.dp?.toFixed(0)}%`).join(",")||"scanning";
    const ctx=[
      spy?.c?`[SPY $${spy.c} (${spy.dp>0?"+":""}${spy.dp?.toFixed(2)}%)]`:"",
      account?`[Portfolio: $${parseFloat(account.equity).toFixed(0)} | Cash: $${parseFloat(account.cash).toFixed(0)}]`:"",
      autoTraderActive?`[Bot: RUNNING | Full market scan | Top gainers: ${gainersStr}]`:"[Bot: PAUSED]",
      BRAIN.totalTrades>0?`[Brain: ${BRAIN.totalTrades} trades | ${((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0)}% wins | $${BRAIN.totalPnL.toFixed(0)} P&L]`:"",
    ].filter(Boolean).join(" ");
    const last=messages[messages.length-1];
    const enriched=[...messages.slice(0,-1),{...last,content:last.content+"\n"+ctx}];
    res.json({reply:await groqChat(enriched)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — MARKET DATA
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/movers", async (req,res) => {
  try {
    const gainers = await getTopGainers();
    lastGainers   = gainers.slice(0,20);

    if (!gainers.length) {
      return res.json({
        data:"No real gainers found right now. Market may be closed or pre-market activity is low. Check back at 9:30 AM ET.",
        raw:[],scanned:0,ts:new Date().toISOString(),
      });
    }

    const analyses = await Promise.all(gainers.slice(0,10).map(g=>analyzeGainer(g.ticker,g.c,g.dp)));
    const dataStr  = analyses.map(a=>
      `${a.ticker}: $${a.price} +${a.pct?.toFixed(1)}% | Float:${a.float}M | ${a.industry}\nCatalyst: ${a.headlines.split("\n")[0]||"unknown"}`
    ).join("\n\n");

    const ai = await groq(
      `REAL market gainers (ONLY analyze these — do not invent tickers):\n\n${dataStr}\n\n` +
      `For each: WHY is it moving? HOW to trade for max profit? Conviction 1-10.\n` +
      `End with your #1 highest conviction trade with exact entry/target/stop.`,1500
    );
    res.json({data:ai,raw:gainers.slice(0,20),scanned:gainers.length,ts:new Date().toISOString()});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/spikes", async (req,res) => {
  try {
    const gainers=await getTopGainers();
    if (!gainers.length) return res.json({data:"No pre-spike candidates right now.",candidates:[],ts:new Date().toISOString()});
    const early=gainers.filter(g=>g.dp>3&&g.dp<30&&g.c<10).slice(0,8);
    if (!early.length) return res.json({data:"No early-stage movers found. All gainers are already extended.",candidates:[],ts:new Date().toISOString()});
    const str=early.map(g=>`${g.ticker} +${g.dp?.toFixed(1)}% $${g.c} (REAL DATA)`).join("\n");
    const ai=await groq(`Real early-stage movers:\n${str}\n\nBest 3 to buy before bigger move? Entry, target, stop, conviction.`,800);
    res.json({data:ai,candidates:early,ts:new Date().toISOString()});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/quote", async (req,res) => {
  const {ticker="SPY"}=req.query;
  try {
    const [q,p]=await Promise.all([finnhub(`/quote?symbol=${ticker.toUpperCase()}`),finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`)]);
    res.json({ticker,price:q.c,change:q.d,pct:q.dp,high:q.h,low:q.l,open:q.o,prev:q.pc,name:p.name,industry:p.finnhubIndustry,market_cap:p.marketCapitalization,float:p.shareOutstanding});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/edgar", async (req,res) => {
  const {ticker="NVDA"}=req.query;
  try {
    const week=new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const today=new Date().toISOString().split("T")[0];
    const [p,n]=await Promise.all([finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`)]);
    const headlines=Array.isArray(n)?n.slice(0,8).map(x=>`- ${x.headline}`).join("\n"):"No news.";
    const ai=await groq(`${ticker.toUpperCase()} | Float:${p.shareOutstanding}M | Cap:$${p.marketCapitalization}B\nReal news:\n${headlines}\n\nCatalyst quality? Entry, target, stop, conviction.`);
    res.json({ticker:ticker.toUpperCase(),data:ai,ts:new Date().toISOString()});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/earnings", async (req,res) => {
  try {
    const today=new Date().toISOString().split("T")[0];
    const next7=new Date(Date.now()+7*86400000).toISOString().split("T")[0];
    const cal=await finnhub(`/calendar/earnings?from=${today}&to=${next7}`);
    const top=cal?.earningsCalendar?.slice(0,20)||[];
    const list=top.map(e=>`${e.symbol}|${e.date}|EPS:${e.epsEstimate??'N/A'}`).join("\n");
    const ai=await groq(`Real earnings this week:\n${list||"No data"}\n\nTop 5 small cap spike plays? Entry, target, stop.`);
    res.json({calendar:top,ai_summary:ai,ts:new Date().toISOString()});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/news", async (req,res) => {
  const {ticker}=req.query;
  try {
    const today=new Date().toISOString().split("T")[0];
    const week=new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const news=ticker?await finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`):await finnhub("/news?category=general");
    res.json((Array.isArray(news)?news:[]).slice(0,15));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — ALPACA
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/account", async (req,res) => {
  try {
    const d=await alpaca("/v2/account");
    const pnl=parseFloat(d.equity)-parseFloat(d.last_equity);
    res.json({equity:parseFloat(d.equity).toFixed(2),cash:parseFloat(d.cash).toFixed(2),buying_power:parseFloat(d.buying_power).toFixed(2),portfolio_value:parseFloat(d.portfolio_value).toFixed(2),pnl_today:pnl.toFixed(2),pnl_today_pct:((pnl/parseFloat(d.last_equity))*100).toFixed(2)+"%",day_trade_count:d.daytrade_count,status:d.status,paper:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/holdings", async (req,res) => {
  try {
    const positions=await alpaca("/v2/positions");
    if (!Array.isArray(positions)||!positions.length) return res.json({holdings:[],total_value:"0.00",total_pnl:"0.00",total_pnl_today:"0.00",count:0});
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
      target_price:(parseFloat(p.avg_entry_price)*(1+CONFIG.PROFIT_TARGET/100)).toFixed(2),
      stop_price:(parseFloat(p.avg_entry_price)*(1-CONFIG.STOP_LOSS/100)).toFixed(2),
    }));
    res.json({holdings,total_value:holdings.reduce((s,h)=>s+parseFloat(h.market_value),0).toFixed(2),total_pnl:holdings.reduce((s,h)=>s+parseFloat(h.unrealized_pnl),0).toFixed(2),total_pnl_today:holdings.reduce((s,h)=>s+parseFloat(h.today_pnl),0).toFixed(2),count:holdings.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/orders", async (req,res) => {
  try {
    const o=await alpaca("/v2/orders?status=all&limit=25&direction=desc");
    if (!Array.isArray(o)) return res.json([]);
    res.json(o.map(x=>({id:x.id,symbol:x.symbol,side:x.side,type:x.type,qty:x.qty,filled_qty:x.filled_qty,price:x.filled_avg_price||x.limit_price||null,status:x.status,submitted:x.submitted_at,filled:x.filled_at})));
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/order", async (req,res) => {
  const {symbol,side,qty,type="market",limit_price,time_in_force="day"}=req.body;
  if (!symbol||!side||!qty) return res.status(400).json({error:"symbol,side,qty required"});
  try {
    const body={symbol:symbol.toUpperCase(),side,qty:String(qty),type,time_in_force};
    if (type==="limit"&&limit_price) body.limit_price=String(limit_price);
    res.json({success:true,order:await alpaca("/v2/orders",{method:"POST",body:JSON.stringify(body)})});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/bars", async (req,res) => {
  const {ticker="SPY",timeframe="1Day",limit=30}=req.query;
  try {
    const d=await alpacaData(`/v2/stocks/${ticker.toUpperCase()}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`);
    res.json({ticker:ticker.toUpperCase(),bars:d.bars||[]});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES — SUPABASE
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/pnl", async (req,res) => {
  try {
    const trades=await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    if (!Array.isArray(trades)) return res.status(500).json({error:"DB error"});
    const closed=trades.filter(t=>t.pnl!=null),open=trades.filter(t=>t.pnl==null);
    const total=closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0);
    const winners=closed.filter(t=>parseFloat(t.pnl)>0).length;
    const best=closed.reduce((b,t)=>(!b||parseFloat(t.pnl)>parseFloat(b.pnl)?t:b),null);
    const worst=closed.reduce((b,t)=>(!b||parseFloat(t.pnl)<parseFloat(b.pnl)?t:b),null);
    res.json({summary:{total_pnl:total.toFixed(2),avg_pnl:closed.length?(total/closed.length).toFixed(2):"0.00",win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",total_trades:trades.length,closed:closed.length,open:open.length,winners,losers:closed.length-winners,best_trade:best?{symbol:best.symbol,pnl:best.pnl}:null,worst_trade:worst?{symbol:worst.symbol,pnl:worst.pnl}:null},recent:trades.slice(0,15),open_positions:open});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/trades", async (req,res) => {
  try { res.json(await supabase("pulsetrader_trades?order=created_at.desc&limit=500").then(d=>Array.isArray(d)?d:[])); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/trade", async (req,res) => {
  const {symbol,side,qty,entry_price,exit_price,reason}=req.body;
  if (!symbol||!side||!qty||!entry_price) return res.status(400).json({error:"required fields missing"});
  let pnl=null,pnl_pct=null;
  if (exit_price){const dir=side.toUpperCase()==="SHORT"?-1:1;pnl=((+exit_price-+entry_price)*+qty*dir).toFixed(2);pnl_pct=(((+exit_price-+entry_price)/+entry_price)*100*dir).toFixed(2);}
  try {
    const r=await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({symbol:symbol.toUpperCase(),side:side.toUpperCase(),qty:+qty,entry_price:+entry_price,exit_price:exit_price?+exit_price:null,pnl:pnl?+pnl:null,pnl_pct:pnl_pct?+pnl_pct:null,reason:reason||null})});
    res.json({success:true,trade:Array.isArray(r)?r[0]:r});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete("/api/trade/:id", async (req,res) => {
  try { await supabase(`pulsetrader_trades?id=eq.${req.params.id}`,{method:"DELETE"}); res.json({success:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// HEALTH + DASHBOARD
// ════════════════════════════════════════════════════════════════════════════

app.get("/health", (_,res) => res.json({
  status:"ok",version:"7.1.0",ai:"groq-llama-3.3-70b",mode:"paper",
  auto_trader:autoTraderActive,scanner:"Alpaca full market + Finnhub (real data only)",
  brain_trades:BRAIN.totalTrades,
  win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"learning",
  market_open:isMarketOpen(),ts:new Date().toISOString(),
}));

app.get("/api/dashboard", async (req,res) => {
  try {
    const [account,positions,trades]=await Promise.all([alpaca("/v2/account").catch(()=>null),alpaca("/v2/positions").catch(()=>[]),supabase("pulsetrader_trades?order=created_at.desc&limit=500").catch(()=>[])]);
    const t=Array.isArray(trades)?trades:[],closed=t.filter(x=>x.pnl!=null),total=closed.reduce((s,x)=>s+parseFloat(x.pnl||0),0),winners=closed.filter(x=>parseFloat(x.pnl)>0).length,todayPnL=account?parseFloat(account.equity)-parseFloat(account.last_equity):0;
    res.json({account:account?{equity:parseFloat(account.equity).toFixed(2),cash:parseFloat(account.cash).toFixed(2),buying_power:parseFloat(account.buying_power).toFixed(2),pnl_today:todayPnL.toFixed(2),pnl_today_pct:((todayPnL/parseFloat(account.last_equity))*100).toFixed(2)+"%"}:null,auto_trader:{active:autoTraderActive,last_scan:lastScanTime,recent_trades:tradeLog.slice(0,5)},brain:{win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"0%",total_trades:BRAIN.totalTrades,total_pnl:BRAIN.totalPnL.toFixed(2),lessons:BRAIN.lessons.slice(0,3)},holdings:Array.isArray(positions)?positions.map(p=>({symbol:p.symbol,qty:parseFloat(p.qty),side:p.side,avg_entry:parseFloat(p.avg_entry_price).toFixed(2),current_price:parseFloat(p.current_price).toFixed(2),market_value:parseFloat(p.market_value).toFixed(2),unrealized_pnl:parseFloat(p.unrealized_pl).toFixed(2),unrealized_pnl_pct:(parseFloat(p.unrealized_plpc)*100).toFixed(2)+"%",today_pnl:parseFloat(p.unrealized_intraday_pl).toFixed(2),today_pnl_pct:(parseFloat(p.unrealized_intraday_plpc)*100).toFixed(2)+"%"})):[],trade_summary:{total_pnl:total.toFixed(2),win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",total_trades:t.length,open:t.filter(x=>x.pnl==null).length,closed:closed.length},recent_trades:t.slice(0,5)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════════════════════════
// START — auto-boots on every deploy
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`⚡ PulseTrader v7.1 FULL MARKET SCANNER on port ${PORT}`);
  console.log(`   Scanner : Alpaca full market screener + Finnhub fallback`);
  console.log(`   Fix     : Real data only — no hallucinated tickers`);
  console.log(`   Target  : +${CONFIG.PROFIT_TARGET}% | Stop: -${CONFIG.STOP_LOSS}%`);
  console.log(`   Mode    : PAPER TRADING`);
  await loadMemory();
  console.log("🤖 Auto-starting trader...");
  startAutoTrader();
});
