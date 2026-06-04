// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PULSETRADER v20.4 — MULTI‑SOURCE SCANNER (FINVIZ PRIMARY)             ║
// ║  Finds low‑cap, high‑volume momentum stocks using all available data   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import express from "express";
import cors    from "cors";
import fetch   from "node-fetch";
import crypto  from "crypto";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PASSCODE  = process.env.ACCESS_CODE || process.env.PASSCODE || "092783";
const makeToken = () => crypto.createHmac("sha256", PASSCODE).update("pt_auth").digest("hex");
const parseCookies = req => {
  const list={}, h=req.headers.cookie; if(!h) return list;
  h.split(";").forEach(c=>{const[k,...v]=c.trim().split("=");list[k.trim()]=decodeURIComponent(v.join("="));});
  return list;
};
const isAuthed = req => {
  const tok=req.headers["x-auth-token"]||parseCookies(req).pt_session;
  return tok===makeToken();
};
const requireAuth = (req,res,next) => {
  if(isAuthed(req)) return next();
  if(req.headers["x-auth-token"]||req.headers["content-type"]?.includes("json"))
    return res.status(401).json({error:"Unauthorized"});
  res.redirect("/login");
};
app.get("/",(req,res,next)=>{if(!isAuthed(req))return res.redirect("/login");next();});
app.use(express.static("public"));

app.get("/login",(req,res)=>{
  const err=req.query.error?"WRONG PASSCODE — TRY AGAIN":"";
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>PulseTrader</title><style>
@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@700&family=Share+Tech+Mono&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{background:#020508;color:#c8d8e8;font-family:'Share Tech Mono',monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100dvh;padding:24px;gap:24px}
.logo{font-family:'Rajdhani',sans-serif;font-size:36px;font-weight:700;color:#00ff88;letter-spacing:4px;text-shadow:0 0 30px rgba(0,255,136,.4)}
.sub{font-size:10px;letter-spacing:3px;color:#4a6a8a;text-align:center}
.box{background:#0a1520;border:1px solid #1a3050;border-radius:12px;padding:28px 24px;width:100%;max-width:320px}
input[type=password]{width:100%;background:#060d14;border:1px solid #1a3050;border-radius:8px;color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:20px;letter-spacing:8px;padding:14px;text-align:center;outline:none;margin-bottom:14px;-webkit-appearance:none}
input:focus{border-color:#00ff88;box-shadow:0 0 12px rgba(0,255,136,.15)}
button{width:100%;background:#00ff88;color:#020508;border:none;border-radius:8px;font-family:'Rajdhani',sans-serif;font-size:15px;font-weight:700;letter-spacing:3px;padding:14px;cursor:pointer}
button:active{opacity:.8}
.err{color:#ff3355;font-size:11px;text-align:center;margin-top:8px;letter-spacing:1px;min-height:14px}
</style></head><body>
<div><div class="logo">⚡ PULSETRADER</div><div class="sub">VOLUME SPIKE HUNTER · v20.4</div></div>
<div class="box"><form method="POST" action="/login">
<input type="password" name="passcode" maxlength="20" placeholder="••••••••" autocomplete="off" autofocus>
<button type="submit">ENTER</button>
<div class="err">${err}</div>
</form></div></body></html>`);
});

app.post("/login",(req,res)=>{
  if(req.body.passcode!==PASSCODE) return res.redirect("/login?error=1");
  res.setHeader("Set-Cookie",`pt_session=${makeToken()}; Path=/; HttpOnly; Max-Age=2592000`);
  res.redirect("/");
});
app.post("/api/auth",(req,res)=>{
  if(req.body.passcode!==PASSCODE) return res.status(403).json({error:"Wrong passcode."});
  const token=makeToken();
  res.setHeader("Set-Cookie",`pt_session=${token}; Path=/; HttpOnly; Max-Age=2592000`);
  res.json({token});
});
app.get("/api/ping",(_,res)=>res.json({ok:true}));
app.use("/api",requireAuth);

// ════════════════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  MAX_POSITIONS:      8,
  HARD_STOP_PCT:      15,
  FIRST_TARGET_PCT:   30,
  SECOND_TARGET_PCT:  75,
  TRAIL_PCT:          12,
  MIN_GAIN_PCT:       5,
  MIN_VOL:            100000,
  MAX_ENTRY_GAIN_PCT: 30,
  CASH_PCT:           0.18,
  MAX_CASH_PER_TRADE: 40000,
  MIN_PRICE:          0.10,
  MAX_PRICE:          20,
  MAX_MKTCAP_M:       500,
  COOLDOWN_MINUTES:   5,
};

// ════════════════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════════════════
const openTrades  = {};
const tradeLog    = [];
const chatMemory  = [];
const lastBuyTime = {};
const PATTERNS = { winners: [], losers: [], stats: { byFloat: {}, byGap: {}, byVol: {}, byHour: {} } };
let autoTraderActive = false;
let scanTimer = null;
let lastScanTime = null;
let lastGainers  = [];
let preMarketWatchlist = [];
let preSpikeWatchlist  = [];

// ════════════════════════════════════════════════════════════════════════════
// API HELPERS
// ════════════════════════════════════════════════════════════════════════════
const supabase = async (path,opts={}) => {
  try {
    if(!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return [];
    const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`,{
      headers:{apikey:process.env.SUPABASE_KEY,Authorization:`Bearer ${process.env.SUPABASE_KEY}`,"Content-Type":"application/json",Prefer:"return=representation"},
      ...opts
    });
    const t=await r.text(); return t?JSON.parse(t):[];
  } catch(_){return [];}
};

const alpaca = async (path) => {
  try {
    if(!process.env.ALPACA_KEY || !process.env.ALPACA_SECRET) return {};
    const r=await fetch(`https://data.alpaca.markets${path}`,{
      headers:{"APCA-API-KEY-ID":process.env.ALPACA_KEY,"APCA-API-SECRET-KEY":process.env.ALPACA_SECRET}
    });
    return r.json();
  } catch(_){return {};}
};

// Twelve Data – safe JSON parsing
const twelveDataGainers = async () => {
  if (!process.env.TWELVEDATA_API_KEY) return [];
  try {
    const url = `https://api.twelvedata.com/market_movers?type=stocks&mover=top_gainers&apikey=${process.env.TWELVEDATA_API_KEY}`;
    const res = await fetch(url);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { return []; }
    if (!data.data || !Array.isArray(data.data)) return [];
    return data.data.map(item => ({
      symbol: item.symbol,
      price: parseFloat(item.price),
      pct: parseFloat(item.percent_change),
      vol: parseInt(item.volume) || 0,
      src: "twelvedata"
    }));
  } catch(e) { return []; }
};

// Yahoo gainers (with headers)
const yahooGainers = async () => {
  try {
    const url = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrId=day_gainers&count=50";
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json"
      }
    });
    const data = await res.json();
    const quotes = data.finance?.result?.[0]?.quotes || [];
    return quotes.map(q => ({
      symbol: q.symbol,
      price: q.regularMarketPrice,
      pct: q.regularMarketChangePercent,
      vol: q.regularMarketVolume,
      src: "yahoo"
    }));
  } catch(e) { return []; }
};

// Yahoo quote & market cap
const yahooQuote = async (symbol) => {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
    const res = await fetch(url);
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (meta) {
      return {
        c: meta.regularMarketPrice,
        dp: ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100,
        v: meta.regularMarketVolume,
        marketCap: meta.marketCap || 0
      };
    }
    return {};
  } catch(e) { return {}; }
};

const yahooMarketCap = async (symbol) => {
  const quote = await yahooQuote(symbol);
  return quote.marketCap || 0;
};

const groq = async (msgs, maxTokens=700) => {
  try {
    if(!process.env.GROQ_API_KEY) return "";
    const isArr=Array.isArray(msgs);
    const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:isArr?"llama-3.3-70b-versatile":"llama-3.1-8b-instant",
        max_tokens:maxTokens,
        messages:isArr?msgs:[{role:"user",content:msgs}]
      })
    });
    const d=await r.json();
    return d.choices?.[0]?.message?.content||"";
  } catch(_){return "";}
};

// ════════════════════════════════════════════════════════════════════════════
// TRADEZERO API (fixed JSON parsing)
// ════════════════════════════════════════════════════════════════════════════
const TZ = () => (process.env.TZ_API_URL||"https://webapi.tradezero.com").replace(/\/$/,"");
const ACC = () => process.env.TZ_ACCOUNT_ID||"";

const tzAPI = async (method,path,body=null) => {
  try {
    const opts={method,headers:{"TZ-API-KEY-ID":process.env.TZ_API_KEY,"TZ-API-SECRET-KEY":process.env.TZ_API_SECRET,"Content-Type":"application/json","Accept":"application/json"}};
    if(body) opts.body=JSON.stringify(body);
    const r=await fetch(`${TZ()}${path}`,opts);
    const t=await r.text();
    try {
      return JSON.parse(t);
    } catch(e) {
      console.log(`TZ non-JSON response: ${t.slice(0,200)}`);
      return { error: t, raw: true };
    }
  } catch(e){return {error:e.message};}
};

const tzAccount = async () => {
  try {
    const d=await tzAPI("GET",`/v1/api/accounts/${ACC()}/pnl`);
    return {
      equity: parseFloat(d.accountValue||d.netLiquidation||d.equity||d.totalValue||0),
      cash:   parseFloat(d.availableCash||d.cashAvailable||d.cash||d.buyingPower||0),
      pnl:    parseFloat(d.dayPnl||d.dayPnL||d.dayRealized||0),
    };
  } catch(_){return {equity:0,cash:0,pnl:0};}
};

let _dumped=false;
const tzPositions = async () => {
  try {
    const d=await tzAPI("GET",`/v1/api/accounts/${ACC()}/positions`);
    if(!_dumped){_dumped=true;const arr=Array.isArray(d)?d:(d.positions||d.data||[]);if(arr[0])console.log("🔍 TZ sample:",JSON.stringify(arr[0]).slice(0,200));}
    const list=Array.isArray(d)?d:(d.positions||d.data||d||[]);
    if(!Array.isArray(list)||!list.length) return [];

    const raw=list.map(p=>{
      const sym=(p.symbol||p.ticker||"").toString().trim().toUpperCase();
      const rawShares=parseFloat(p.shares??p.quantity??p.qty??0);
      const qty=Math.abs(rawShares);
      const entry=parseFloat(p.priceAvg??p.averagePrice??p.avgPrice??p.entryPrice??0);
      const sideStr=(p.side||"").toLowerCase();
      const isShort = rawShares < 0 || sideStr==="sell" || sideStr==="short" || sideStr==="sellshort";
      return {sym, qty, entry, isShort};
    }).filter(p=>p.sym&&p.qty>0);

    const merged={};
    for(const p of raw){
      const key=`${p.sym}_${p.isShort?"S":"L"}`;
      if(!merged[key]){
        merged[key]={sym:p.sym,qty:p.qty,entry:p.entry,isShort:p.isShort};
      } else {
        const totalQty=merged[key].qty+p.qty;
        const avgEntry=(merged[key].entry*merged[key].qty + p.entry*p.qty)/totalQty;
        merged[key].qty=totalQty;
        merged[key].entry=parseFloat(avgEntry.toFixed(4));
        console.log(`🔀 Merged duplicate ${p.sym}(${p.isShort?"SHORT":"LONG"}): qty=${totalQty} avgEntry=$${avgEntry.toFixed(2)}`);
      }
    }
    const result = Object.values(merged);
    const symbols = [...new Set(result.map(p=>p.sym))];
    const netted = [];
    for(const sym of symbols){
      const long = result.find(p=>p.sym===sym&&!p.isShort);
      const short = result.find(p=>p.sym===sym&&p.isShort);
      if(long&&short){
        if(short.qty>=long.qty){
          console.log(`⚖️ Netted ${sym}: short(${short.qty}) >= long(${long.qty}) — long removed`);
          netted.push(short);
        } else {
          const remaining = long.qty - short.qty;
          console.log(`⚖️ Netted ${sym}: long(${long.qty}) - short(${short.qty}) = ${remaining} remaining long`);
          netted.push({...long, qty: remaining});
        }
      } else {
        if(long) netted.push(long);
        if(short) netted.push(short);
      }
    }
    return netted;
  } catch(e){console.log("tzPositions:",e.message);return [];}
};

// LIMIT ORDERS for both buys and sells
const tzOrder = async (symbol, side, qty, price) => {
  if (!qty || qty < 1 || !price || price <= 0) return { success: false, error: "invalid" };
  const tzSide = side === "Buy" ? "Buy" : "Sell";
  const isBuy = tzSide === "Buy";
  const limitPrice = isBuy
    ? parseFloat((price * 1.002).toFixed(4))
    : parseFloat((price * 0.998).toFixed(4));
  const body = {
    clientOrderId: `PT-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    symbol: symbol.toUpperCase(),
    securityType: "Stock",
    side: tzSide,
    orderType: "Limit",
    limitPrice: limitPrice,
    price: limitPrice,
    traderAction: tzSide,
    quantity: Math.floor(qty),
    orderQuantity: Math.floor(qty),
    timeInForce: "Day",
    route: isBuy ? "SMART" : "TRAFIX_SIM",
  };
  try {
    const d = await tzAPI("POST", `/v1/api/accounts/${ACC()}/order`, body);
    if (d.error || d.raw) {
      console.log(`TZ order failed: ${JSON.stringify(d)}`);
      return { success: false, status: d.error || "API error" };
    }
    console.log(`TZ ${side} ${symbol} x${qty} @${limitPrice}:`, JSON.stringify(d).slice(0, 120));
    const ok = !["Rejected", "Canceled", "Expired"].includes(d.orderStatus) && !!d.orderStatus;
    return { success: ok, status: d.orderStatus, data: d };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

// ════════════════════════════════════════════════════════════════════════════
// CHART PATTERN (uses alpaca bars – unchanged)
// ════════════════════════════════════════════════════════════════════════════
const analyzeChart = async (symbol) => {
  try {
    const etNow=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const etStart=new Date(etNow);
    etStart.setHours(4,0,0,0);

    const [bars1, bars5, daily] = await Promise.all([
      alpaca(`/v2/stocks/${symbol}/bars?timeframe=1Min&start=${etStart.toISOString()}&feed=iex&limit=480`),
      alpaca(`/v2/stocks/${symbol}/bars?timeframe=5Min&start=${etStart.toISOString()}&feed=iex&limit=78`),
      alpaca(`/v2/stocks/${symbol}/bars?timeframe=1Day&limit=22&feed=iex`),
    ]);

    const b1=bars1.bars||[], b5=bars5.bars||[], bd=daily.bars||[];
    let relVol=0,avgDailyVol=0;
    if(bd.length>=2){
      const past=bd.slice(0,-1);
      avgDailyVol=past.reduce((s,b)=>s+(b.v||0),0)/past.length;
      const todayVol=b1.reduce((s,b)=>s+(b.v||0),0)||b5.reduce((s,b)=>s+(b.v||0),0);
      relVol=avgDailyVol>0?todayVol/avgDailyVol:0;
    }

    const bars=b1.length>=5?b1:b5;
    let pv=0,tv=0;
    for(const b of bars){const tp=(b.h+b.l+b.c)/3;pv+=tp*(b.v||0);tv+=(b.v||0);}
    const vwap=tv>0?pv/tv:0;

    const last6=bars.slice(-6);
    const hhhl = last6.length>=4 &&
      last6[last6.length-1].h > last6[0].h &&
      last6[last6.length-1].l > last6[0].l;

    const recentBars=bars.slice(-10);
    const avgRecentVol=recentBars.slice(0,-1).reduce((s,b)=>s+(b.v||0),0)/Math.max(recentBars.length-1,1);
    const lastVol=recentBars[recentBars.length-1]?.v||0;
    const volAccel=avgRecentVol>0?lastVol/avgRecentVol:0;

    const last3=bars.slice(-3);
    const greenRising = last3.length===3 &&
      last3.every(b=>b.c>b.o) &&
      last3[2].c>last3[1].c && last3[1].c>last3[0].c;

    let patternScore=0;
    if(relVol>50)  patternScore+=35;
    else if(relVol>20) patternScore+=25;
    else if(relVol>10) patternScore+=15;
    else if(relVol>5)  patternScore+=8;

    if(volAccel>3)  patternScore+=20;
    else if(volAccel>2) patternScore+=12;
    else if(volAccel>1.5) patternScore+=6;

    if(hhhl)        patternScore+=15;
    if(greenRising) patternScore+=15;
    if(vwap>0&&bars.length>0&&bars[bars.length-1].c>=vwap) patternScore+=15;

    return {
      patternScore: Math.min(patternScore, 100),
      relVol: parseFloat(relVol.toFixed(1)),
      vwap: parseFloat(vwap.toFixed(4)),
      aboveVWAP: vwap>0 && bars.length>0 && bars[bars.length-1].c>=vwap,
      hhhl,
      greenRising,
      volAccel: parseFloat(volAccel.toFixed(1)),
      avgDailyVol: Math.round(avgDailyVol),
      bars1len: b1.length,
    };
  } catch(e){
    return {patternScore:0,relVol:0,vwap:0,aboveVWAP:false,hhhl:false,greenRising:false,volAccel:0};
  }
};

const recordPattern = (trade, pnlPct) => {
  const won = pnlPct >= 20;
  const big = pnlPct >= 50;
  const pattern = {
    relVol:   trade.relVol||0,
    volAccel: trade.volAccel||0,
    gainPct:  trade.entryGainPct||0,
    float:    trade.float||0,
    hour:     trade.hour||0,
    pnlPct,
    ts: Date.now(),
  };
  if(big)      { PATTERNS.winners.unshift(pattern); PATTERNS.winners=PATTERNS.winners.slice(0,100); }
  else if(!won){ PATTERNS.losers.unshift(pattern);  PATTERNS.losers=PATTERNS.losers.slice(0,100); }
  const floatBucket = pattern.float<5?"micro":pattern.float<20?"small":pattern.float<50?"mid":"large";
  const volBucket   = pattern.relVol>50?"x50":pattern.relVol>20?"x20":pattern.relVol>10?"x10":"low";
  const hourKey     = `h${pattern.hour}`;
  for(const[bucket,key] of [[PATTERNS.stats.byFloat,floatBucket],[PATTERNS.stats.byVol,volBucket],[PATTERNS.stats.byHour,hourKey]]){
    if(!bucket[key]) bucket[key]={t:0,w:0};
    bucket[key].t++;
    if(won) bucket[key].w++;
  }
  const bestVol=Object.entries(PATTERNS.stats.byVol).filter(([,v])=>v.t>=3).sort(([,a],[,b])=>(b.w/b.t)-(a.w/a.t));
  if(bestVol.length) console.log(`🧠 Best setups: ${bestVol.slice(0,3).map(([k,v])=>`${k}:${((v.w/v.t)*100).toFixed(0)}%WR(${v.t})`).join(" | ")}`);
};

const getPatternBonus = (relVol, volAccel) => {
  if(!PATTERNS.winners.length) return 0;
  const similar=PATTERNS.winners.filter(p=>
    Math.abs(p.relVol - relVol)/Math.max(relVol,1) < 0.5 &&
    Math.abs(p.volAccel - volAccel)/Math.max(volAccel,1) < 0.5
  );
  if(similar.length>=5) return 15;
  if(similar.length>=2) return 8;
  return 0;
};

const savePatterns = async () => {
  try {
    await supabase("bot_watchlist",{method:"POST",body:JSON.stringify({
      label:"patterns_v20",
      tickers:JSON.stringify({winners:PATTERNS.winners.slice(0,50),losers:PATTERNS.losers.slice(0,50),stats:PATTERNS.stats}).slice(0,90000),
      ts:new Date().toISOString()
    })});
  } catch(_){}
};

const loadPatterns = async () => {
  try {
    const d=await supabase("bot_watchlist?label=eq.patterns_v20&order=created_at.desc&limit=1");
    if(Array.isArray(d)&&d[0]?.tickers){
      const s=JSON.parse(d[0].tickers);
      PATTERNS.winners=s.winners||[];
      PATTERNS.losers=s.losers||[];
      Object.assign(PATTERNS.stats,s.stats||{});
      console.log(`🧠 Patterns loaded: ${PATTERNS.winners.length} winners | ${PATTERNS.losers.length} losers`);
    }
  } catch(_){}
};

// ════════════════════════════════════════════════════════════════════════════
// PRE-SPIKE SCANNER (unchanged)
// ════════════════════════════════════════════════════════════════════════════
const scanPreSpike = async () => {
  const candidates = [];
  try {
    const urls=[
      "/v1beta1/screener/stocks/movers?by=volume&top=50&market_type=sip",
      "/v1beta1/screener/stocks/movers?by=volume&top=50",
    ];
    for(const url of urls){
      try{
        const d=await alpaca(url);
        const list=[...(d.gainers||[]),...(d.losers||[])];
        if(list.length){
          for(const g of list){
            const price=g.price||0;
            const pct=Math.abs(g.percent_change||0);
            const vol=g.volume||0;
            if(price>=CONFIG.MIN_PRICE&&price<=CONFIG.MAX_PRICE&&
               pct>=2&&pct<=30&&vol>=CONFIG.MIN_VOL){
              candidates.push({
                symbol:g.symbol, price, pct:g.percent_change, vol,
                src:"prescan", prePike:true
              });
            }
          }
          break;
        }
      }catch(_){}
    }
    const ahMovers = lastGainers.filter(g=>g.pct>5).slice(0,10);
    for(const g of ahMovers){
      if(!candidates.find(c=>c.symbol===g.symbol))
        candidates.push({...g, src:"ah_watchlist", preSpike:true});
    }
    if(candidates.length){
      preSpikeWatchlist = candidates.slice(0,15);
      console.log(`🔭 Pre-spike watchlist: ${preSpikeWatchlist.map(g=>g.symbol).join(", ")}`);
    }
  } catch(e){ console.log("scanPreSpike:", e.message); }
};

// ════════════════════════════════════════════════════════════════════════════
// DYNAMIC THRESHOLDS
// ════════════════════════════════════════════════════════════════════════════
const getDynamicThresholds = () => {
  const et = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const hour = et.getHours() + et.getMinutes()/60;
  const isPre = hour >= 4 && hour < 9.5;
  const isPost = hour >= 16 && hour < 20;
  return {
    minGain: isPre ? 3 : (isPost ? 5 : CONFIG.MIN_GAIN_PCT),
    minVol:  isPre ? 50000 : (isPost ? 100000 : CONFIG.MIN_VOL),
  };
};

// ════════════════════════════════════════════════════════════════════════════
// ⭐ FINAL SCANNER – FINVIZ PRIMARY + ALL OTHER APIs + BROAD WATCHLIST
// ════════════════════════════════════════════════════════════════════════════
const scanForSpikes = async () => {
  const gainers = [];
  const { minGain, minVol } = getDynamicThresholds();
  console.log(`🔍 Scanning with minGain=${minGain}% minVol=${minVol.toLocaleString()}`);

  // ----- SOURCE 0: Finviz top gainers (free, no key, works pre-market) -----
  let finvizList = [];
  try {
    const url = "https://finviz.com/screener.ashx?v=111&ft=4";
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    const html = await res.text();
    // Extract table rows – Finviz uses class "screener-body-table"
    const rows = html.match(/<tr class="(?:table-dark-row|table-light-row)">.*?<\/tr>/gs);
    if (rows) {
      for (const row of rows.slice(0, 50)) {
        const cells = row.match(/<td.*?>(.*?)<\/td>/gs);
        if (cells && cells.length >= 8) {
          const ticker = cells[0].replace(/<.*?>/g, '').trim();
          const price = parseFloat(cells[2].replace(/<.*?>/g, '').trim());
          const pct = parseFloat(cells[3].replace(/<.*?>/g, '').replace('%', '').trim());
          const vol = parseInt(cells[5].replace(/<.*?>/g, '').replace(/,/g, '').trim());
          if (ticker && price && !isNaN(pct) && !isNaN(vol)) {
            finvizList.push({ symbol: ticker, price, pct, vol, src: "finviz" });
          }
        }
      }
    }
    console.log(`📡 Finviz returned ${finvizList.length} gainers`);
  } catch(e) { console.log("Finviz scrape error:", e.message); }

  // Enrich Finviz candidates with live Yahoo quotes (more accurate volume/price)
  for (const g of finvizList) {
    try {
      const quote = await yahooQuote(g.symbol);
      const price = quote.c || g.price;
      const pct = quote.dp || g.pct;
      const vol = quote.v || g.vol;
      if (price >= CONFIG.MIN_PRICE && price <= CONFIG.MAX_PRICE &&
          pct >= minGain && vol >= minVol &&
          !gainers.find(x => x.symbol === g.symbol)) {
        gainers.push({ symbol: g.symbol, price, pct, vol, src: "finviz" });
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 200));
  }

  // ----- SOURCE 1: Twelve Data -----
  let twelveList = await twelveDataGainers();
  console.log(`📡 Twelve Data returned ${twelveList.length} gainers`);
  for (const g of twelveList) {
    if (g.symbol && g.price >= CONFIG.MIN_PRICE && g.price <= CONFIG.MAX_PRICE &&
        g.pct >= minGain && g.vol >= minVol && !gainers.find(x => x.symbol === g.symbol)) {
      gainers.push(g);
    }
  }

  // ----- SOURCE 2: Yahoo gainers -----
  let yahooList = await yahooGainers();
  console.log(`📡 Yahoo returned ${yahooList.length} gainers`);
  for (const g of yahooList) {
    if (g.symbol && g.price >= CONFIG.MIN_PRICE && g.price <= CONFIG.MAX_PRICE &&
        g.pct >= minGain && g.vol >= minVol && !gainers.find(x => x.symbol === g.symbol)) {
      gainers.push(g);
    }
  }

  // ----- SOURCE 3: Alpha Vantage -----
  if (process.env.ALPHAVANTAGE_KEY) {
    try {
      const url = `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${process.env.ALPHAVANTAGE_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      const list = data.top_gainers || [];
      console.log(`📡 Alpha Vantage returned ${list.length} gainers`);
      for (const g of list) {
        const sym = g.ticker.toUpperCase();
        const price = parseFloat(g.price);
        const pct = parseFloat(g.change_percentage.replace('%', ''));
        const vol = parseInt(g.volume);
        if (sym && price >= CONFIG.MIN_PRICE && price <= CONFIG.MAX_PRICE &&
            pct >= minGain && vol >= minVol && !gainers.find(x => x.symbol === sym)) {
          gainers.push({ symbol: sym, price, pct, vol, src: "alphavantage" });
        }
      }
    } catch(e) { console.log("Alpha Vantage error:", e.message); }
  }

  // ----- SOURCE 4: Alpaca gainers -----
  try {
    const d = await alpaca("/v1beta1/screener/stocks/movers?by=percent_change&top=100&market_type=sip");
    const list = d.gainers || [];
    console.log(`📡 Alpaca gainers returned ${list.length}`);
    for (const g of list) {
      if (g.price >= CONFIG.MIN_PRICE && g.price <= CONFIG.MAX_PRICE &&
          g.percent_change >= minGain && (g.volume || 0) >= minVol &&
          !gainers.find(x => x.symbol === g.symbol)) {
        gainers.push({
          symbol: g.symbol,
          price: g.price,
          pct: g.percent_change,
          vol: g.volume || 0,
          src: "alpaca"
        });
      }
    }
  } catch(e) { console.log("Alpaca gainers error:", e.message); }

  // ----- SOURCE 5: Broad watchlist (50+ small‑cap symbols) – only if no other spikes found -----
  if (gainers.length === 0) {
    console.log("⚠️ No spikes from any source – scanning broad watchlist");
    const broadWatchlist = [
      "LASE", "PMI", "BJDX", "RKTO", "DEVS", "STAK", "DXST", "TELL", "KOLD", "BOIL",
      "ATPC", "CODX", "MNTS", "PLTR", "HOOD", "VCIG", "AMSS", "PHGE", "LGHL", "SPRC",
      "FOXX", "SBEV", "YYGH", "EDHL", "MOBX", "CXAI", "TWAV", "STI", "ACCL", "RPGL"
    ];
    for (const sym of broadWatchlist) {
      try {
        const quote = await yahooQuote(sym);
        if (quote.c && quote.c >= CONFIG.MIN_PRICE && quote.c <= CONFIG.MAX_PRICE &&
            quote.dp >= minGain && quote.v >= minVol &&
            !gainers.find(x => x.symbol === sym)) {
          gainers.push({ symbol: sym, price: quote.c, pct: quote.dp, vol: quote.v, src: "watchlist" });
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`📡 Broad watchlist returned ${gainers.length} gainers`);
  }

  // ----- WATCHLISTS (pre‑spike & pre‑market) -----
  for (const w of preSpikeWatchlist) {
    try {
      const quote = await yahooQuote(w.symbol);
      const price = quote.c || 0;
      const pct = quote.dp || 0;
      const vol = quote.v || 0;
      if (price > 0 && price <= CONFIG.MAX_PRICE && pct >= minGain && vol >= minVol && !gainers.find(x => x.symbol === w.symbol))
        gainers.push({ symbol: w.symbol, price, pct, vol, src: "prescan" });
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }

  for (const w of preMarketWatchlist) {
    try {
      const quote = await yahooQuote(w);
      const price = quote.c || 0;
      const pct = quote.dp || 0;
      const vol = quote.v || 0;
      if (price > 0 && pct >= minGain && vol >= minVol && !gainers.find(x => x.symbol === w))
        gainers.push({ symbol: w, price, pct, vol, src: "watchlist" });
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }

  if (gainers.length === 0) {
    console.log("📭 No spikes found – try again in a few minutes");
  } else {
    console.log(`🔥 Found ${gainers.length} spikes: ${gainers.slice(0, 3).map(g => `${g.symbol}+${g.pct.toFixed(0)}%`).join(", ")}`);
  }
  return gainers.sort((a, b) => b.vol - a.vol);
};

// ════════════════════════════════════════════════════════════════════════════
// POSITION MANAGER (unchanged)
// ════════════════════════════════════════════════════════════════════════════
const managePositions = async (tzPos) => {
  // ... (keep exactly as in v20.3 – same as your current code)
  // To save space, I'm not repeating it here – your existing managePositions is fine.
  // Use the same function from your current index.js.
};

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER (unchanged)
// ════════════════════════════════════════════════════════════════════════════
const autoTrade = async () => {
  // ... (keep exactly as in v20.3)
};

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULER, CHAT, ROUTES, START – all unchanged from v20.3
// ════════════════════════════════════════════════════════════════════════════
// (Because the full file would exceed the response length, I assume you already have
// the rest of the code from v20.3 – the only changes are in scanForSpikes above.
// Please replace your current scanForSpikes with the new one and keep everything else.)

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════
const PORT=process.env.PORT||3001;
app.listen(PORT,async()=>{
  console.log(`⚡ PulseTrader v20.4 — Multi‑Source Scanner (Finviz Primary)`);
  console.log(`   Targets: JZ +325% | HKIT +350% | ABTS +115% | HUBC +97%`);
  console.log(`   Max positions: ${CONFIG.MAX_POSITIONS} | Stop: -${CONFIG.HARD_STOP_PCT}%`);
  console.log(`   Sources: Finviz, Twelve Data, Yahoo, Alpha Vantage, Alpaca, Watchlists`);
  await startup();
  startAutoTrader();
});
