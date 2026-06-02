// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PULSETRADER v18.0 — VOLUME SPIKE HUNTER                              ║
// ║  Catches: JZ +325% | HKIT +350% | ABTS +115% | HUBC +97% type moves  ║
// ║  Scans every 60s | Learns chart patterns | Max 5 positions            ║
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
<div><div class="logo">⚡ PULSETRADER</div><div class="sub">VOLUME SPIKE HUNTER · v18.0</div></div>
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
  MAX_POSITIONS:      5,      // hard max — never exceed
  HARD_STOP_PCT:      15,     // stop loss -15%
  FIRST_TARGET_PCT:   30,     // sell 50% at +30%
  SECOND_TARGET_PCT:  75,     // sell 25% more at +75%
  TRAIL_PCT:          12,     // trail remaining -12% from peak
  MIN_GAIN_PCT:       15,     // min % gain to consider
  MIN_VOL:            500000, // min 500k volume
  CASH_PCT:           0.18,   // 18% cash per trade
  MAX_CASH_PER_TRADE: 40000,  // max $40k per trade
  MIN_PRICE:          0.10,
  MAX_PRICE:          500,
};

// ════════════════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════════════════
const openTrades  = {}; // sym -> {entry,qty,peak,halfSold,quarterSold,time,pattern}
const tradeLog    = [];
const chatMemory  = [];

// Pattern memory — learns what setups work
const PATTERNS = {
  winners: [],   // setups that returned 30%+
  losers:  [],   // setups that stopped out
  stats: {
    byFloat:  {},  // win rates by float bucket
    byGap:    {},  // win rates by gap size
    byVol:    {},  // win rates by volume bucket
    byHour:   {},  // win rates by hour
  },
};

let autoTraderActive = false;
let scanTimer = null;
let lastScanTime = null;
let lastGainers  = [];
let preMarketWatchlist = []; // stocks to watch from previous day

// ════════════════════════════════════════════════════════════════════════════
// API HELPERS
// ════════════════════════════════════════════════════════════════════════════
const supabase = async (path,opts={}) => {
  try {
    const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`,{
      headers:{apikey:process.env.SUPABASE_KEY,Authorization:`Bearer ${process.env.SUPABASE_KEY}`,"Content-Type":"application/json",Prefer:"return=representation"},
      ...opts
    });
    const t=await r.text(); return t?JSON.parse(t):[];
  } catch(_){return [];}
};

const alpaca = async (path) => {
  try {
    const r=await fetch(`https://data.alpaca.markets${path}`,{
      headers:{"APCA-API-KEY-ID":process.env.ALPACA_KEY,"APCA-API-SECRET-KEY":process.env.ALPACA_SECRET}
    });
    return r.json();
  } catch(_){return {};}
};

const finnhub = async (path) => {
  try {
    const sep=path.includes("?")?"&":"?";
    const r=await fetch(`https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`);
    return r.json();
  } catch(_){return {};}
};

const groq = async (msgs, maxTokens=700) => {
  try {
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
// TRADEZERO
// ════════════════════════════════════════════════════════════════════════════
const TZ  = () => (process.env.TZ_API_URL||"https://webapi.tradezero.com").replace(/\/$/,"");
const ACC = () => process.env.TZ_ACCOUNT_ID||"";

const tzAPI = async (method,path,body=null) => {
  const opts={method,headers:{"TZ-API-KEY-ID":process.env.TZ_API_KEY,"TZ-API-SECRET-KEY":process.env.TZ_API_SECRET,"Content-Type":"application/json","Accept":"application/json"}};
  if(body) opts.body=JSON.stringify(body);
  const r=await fetch(`${TZ()}${path}`,opts);
  const t=await r.text();
  try{return t?JSON.parse(t):{};}catch(_){return {raw:t};}
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

    // Parse ALL positions — detect long vs short from raw shares sign or side field
    const raw=list.map(p=>{
      const sym=(p.symbol||p.ticker||"").toString().trim().toUpperCase();
      const rawShares=parseFloat(p.shares??p.quantity??p.qty??0);
      const qty=Math.abs(rawShares);
      const entry=parseFloat(p.priceAvg??p.averagePrice??p.avgPrice??p.entryPrice??0);
      const sideStr=(p.side||"").toLowerCase();
      // TZ paper: negative shares = short position, positive = long
      // side field: "Buy" or "Long" = long, "Sell" or "Short" or "SellShort" = short
      const isShort = rawShares < 0 || sideStr==="sell" || sideStr==="short" || sideStr==="sellshort";
      return {sym, qty, entry, isShort};
    }).filter(p=>p.sym&&p.qty>0);

    // MERGE duplicate symbols — TZ paper sometimes shows same symbol twice
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
    return Object.values(merged);
  } catch(e){console.log("tzPositions:",e.message);return [];}
};

const tzOrder = async (symbol,side,qty,price) => {
  if(!qty||qty<1||!price||price<=0) return {success:false,error:"invalid"};
  // TZ paper order sides:
  // "Buy"       = open long position
  // "Sell"      = close long position  
  // "SellShort" = open short position
  // "BuyCover"  = close short position
  // We ONLY use Buy and Sell — no shorting
  const tzSide = side==="Buy" ? "Buy" : "Sell";
  const lp=tzSide==="Buy"?parseFloat((price*1.002).toFixed(4)):parseFloat((price*0.998).toFixed(4));
  const body={
    clientOrderId:`PT-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,
    symbol:symbol.toUpperCase(),securityType:"Stock",
    side:tzSide,orderType:"Limit",
    limitPrice:lp,price:lp,traderAction:tzSide,
    quantity:Math.floor(qty),orderQuantity:Math.floor(qty),
    timeInForce:"Day",route:process.env.TZ_ROUTE||"SMART",
  };
  try {
    const d=await tzAPI("POST",`/v1/api/accounts/${ACC()}/order`,body);
    console.log(`TZ ${side} ${symbol} x${qty} @${lp}:`,JSON.stringify(d).slice(0,120));
    const ok=!["Rejected","Canceled","Expired"].includes(d.orderStatus)&&!!d.orderStatus;
    return {success:ok,status:d.orderStatus,data:d};
  } catch(e){return {success:false,error:e.message};}
};

// ════════════════════════════════════════════════════════════════════════════
// CHART PATTERN RECOGNITION
// Learns to recognize pre-spike patterns like JZ, HKIT, ABTS, HUBC
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

    // ── Relative Volume (today vs 20-day avg) ──
    let relVol=0,avgDailyVol=0;
    if(bd.length>=2){
      const past=bd.slice(0,-1);
      avgDailyVol=past.reduce((s,b)=>s+(b.v||0),0)/past.length;
      const todayVol=b1.reduce((s,b)=>s+(b.v||0),0)||b5.reduce((s,b)=>s+(b.v||0),0);
      relVol=avgDailyVol>0?todayVol/avgDailyVol:0;
    }

    // ── VWAP ──
    const bars=b1.length>=5?b1:b5;
    let pv=0,tv=0;
    for(const b of bars){const tp=(b.h+b.l+b.c)/3;pv+=tp*(b.v||0);tv+=(b.v||0);}
    const vwap=tv>0?pv/tv:0;

    // ── Trend: Higher Highs + Higher Lows (momentum) ──
    const last6=bars.slice(-6);
    const hhhl = last6.length>=4 &&
      last6[last6.length-1].h > last6[0].h &&
      last6[last6.length-1].l > last6[0].l;

    // ── Volume acceleration: last candle >> average ──
    const recentBars=bars.slice(-10);
    const avgRecentVol=recentBars.slice(0,-1).reduce((s,b)=>s+(b.v||0),0)/Math.max(recentBars.length-1,1);
    const lastVol=recentBars[recentBars.length-1]?.v||0;
    const volAccel=avgRecentVol>0?lastVol/avgRecentVol:0;

    // ── Green candles: last 3 all green and rising ──
    const last3=bars.slice(-3);
    const greenRising = last3.length===3 &&
      last3.every(b=>b.c>b.o) &&
      last3[2].c>last3[1].c && last3[1].c>last3[0].c;

    // ── Pattern score (0-100) — what early HKIT/JZ/ABTS looked like ──
    let patternScore=0;
    if(relVol>50)  patternScore+=35; // 50x+ relative volume = #1 signal
    else if(relVol>20) patternScore+=25;
    else if(relVol>10) patternScore+=15;
    else if(relVol>5)  patternScore+=8;

    if(volAccel>3)  patternScore+=20; // volume exploding right now
    else if(volAccel>2) patternScore+=12;
    else if(volAccel>1.5) patternScore+=6;

    if(hhhl)        patternScore+=15; // higher highs = uptrend confirmed
    if(greenRising) patternScore+=15; // 3 green rising candles
    if(vwap>0&&bars.length>0&&bars[bars.length-1].c>=vwap) patternScore+=15; // above VWAP

    // Check pattern memory — does this match past winners?
    const matchBonus = getPatternBonus(relVol, volAccel);
    patternScore += matchBonus;

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

// ════════════════════════════════════════════════════════════════════════════
// PATTERN MEMORY — learns from wins/losses over time
// ════════════════════════════════════════════════════════════════════════════
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

  // Update stats
  const floatBucket = pattern.float<5?"micro":pattern.float<20?"small":pattern.float<50?"mid":"large";
  const volBucket   = pattern.relVol>50?"x50":pattern.relVol>20?"x20":pattern.relVol>10?"x10":"low";
  const hourKey     = `h${pattern.hour}`;

  for(const[bucket,key] of [[PATTERNS.stats.byFloat,floatBucket],[PATTERNS.stats.byVol,volBucket],[PATTERNS.stats.byHour,hourKey]]){
    if(!bucket[key]) bucket[key]={t:0,w:0};
    bucket[key].t++;
    if(won) bucket[key].w++;
  }

  // Log what's working
  const bestVol=Object.entries(PATTERNS.stats.byVol).filter(([,v])=>v.t>=3).sort(([,a],[,b])=>(b.w/b.t)-(a.w/a.t));
  if(bestVol.length) console.log(`🧠 Best setups: ${bestVol.slice(0,3).map(([k,v])=>`${k}:${((v.w/v.t)*100).toFixed(0)}%WR(${v.t})`).join(" | ")}`);
};

const getPatternBonus = (relVol, volAccel) => {
  if(!PATTERNS.winners.length) return 0;
  // How many winners had similar relVol and volAccel?
  const similar=PATTERNS.winners.filter(p=>
    Math.abs(p.relVol - relVol)/Math.max(relVol,1) < 0.5 &&
    Math.abs(p.volAccel - volAccel)/Math.max(volAccel,1) < 0.5
  );
  if(similar.length>=5) return 15; // strong pattern match
  if(similar.length>=2) return 8;
  return 0;
};

// Save/load patterns to Supabase
const savePatterns = async () => {
  try {
    await supabase("bot_watchlist",{method:"POST",body:JSON.stringify({
      label:"patterns_v18",
      tickers:JSON.stringify({winners:PATTERNS.winners.slice(0,50),losers:PATTERNS.losers.slice(0,50),stats:PATTERNS.stats}).slice(0,90000),
      ts:new Date().toISOString()
    })});
  } catch(_){}
};

const loadPatterns = async () => {
  try {
    const d=await supabase("bot_watchlist?label=eq.patterns_v18&order=created_at.desc&limit=1");
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
// SCANNER — Find volume spikes like JZ, HKIT, ABTS, HUBC
// ════════════════════════════════════════════════════════════════════════════
const scanForSpikes = async () => {
  const gainers = [];
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const t=et.getHours()*100+et.getMinutes();
  const isPreMarket = t>=400 && t<930;

  // Source 1: Alpaca screener — real-time movers
  try {
    const urls=[
      "/v1beta1/screener/stocks/movers?by=percent_change&top=100&market_type=sip",
      "/v1beta1/screener/stocks/movers?by=percent_change&top=100",
    ];
    for(const url of urls){
      try{
        const d=await alpaca(url);
        const list=d.gainers||[];
        if(list.length){
          for(const g of list){
            if(g.price>=CONFIG.MIN_PRICE&&g.price<=CONFIG.MAX_PRICE&&
               g.percent_change>=CONFIG.MIN_GAIN_PCT&&(g.volume||0)>=CONFIG.MIN_VOL){
              gainers.push({symbol:g.symbol,price:g.price,pct:g.percent_change,vol:g.volume||0,src:"screener"});
            }
          }
          console.log(`📡 Alpaca: ${gainers.length} spikes found`);
          break;
        }
      }catch(_){}
    }
  }catch(_){}

  // Source 2: AlphaVantage top gainers
  try{
    if(process.env.ALPHAVANTAGE_KEY){
      const r=await fetch(`https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${process.env.ALPHAVANTAGE_KEY}`);
      const d=await r.json();
      for(const g of (d.top_gainers||[])){
        const price=parseFloat(g.price||0);
        const pct=parseFloat((g.change_percentage||"0").replace("%",""));
        const vol=parseInt(g.volume||0);
        if(price>=CONFIG.MIN_PRICE&&price<=CONFIG.MAX_PRICE&&pct>=CONFIG.MIN_GAIN_PCT&&vol>=CONFIG.MIN_VOL&&!gainers.find(x=>x.symbol===g.ticker))
          gainers.push({symbol:g.ticker,price,pct,vol,src:"av"});
      }
    }
  }catch(_){}

  // Source 3: Pre-market watchlist — yesterday's runners
  for(const w of preMarketWatchlist){
    try{
      const q=await finnhub(`/quote?symbol=${w}`);
      const price=parseFloat(q.c||0),pct=parseFloat(q.dp||0),vol=parseInt(q.v||0);
      if(price>0&&pct>=5&&!gainers.find(x=>x.symbol===w))
        gainers.push({symbol:w,price,pct,vol,src:"watchlist"});
    }catch(_){}
  }

  // Sort by volume first (highest volume = most conviction)
  return gainers.sort((a,b)=>b.vol-a.vol);
};

// ════════════════════════════════════════════════════════════════════════════
// POSITION MANAGER
// ════════════════════════════════════════════════════════════════════════════
const managePositions = async (tzPos) => {
  for(const pos of tzPos){
    const {sym,qty,entry,isShort}=pos;
    // NEVER manage short positions — skip them entirely
    if(isShort){
      console.log(`⏭️ Skipping ${sym} — short position (not managed by bot)`);
      continue;
    }
    const state=openTrades[sym];
    if(!state||entry<=0||qty<=0) continue;

    // Get live price
    const q=await finnhub(`/quote?symbol=${sym}`).catch(()=>null);
    const cur=parseFloat(q?.c||0);
    if(!cur||cur<=0) continue;

    if(cur>state.peak) state.peak=cur;
    const pnlPct=((cur-entry)/entry)*100;
    const fromPeak=((cur-state.peak)/state.peak)*100;

    console.log(`💰 ${sym}: $${cur.toFixed(2)} | ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}% | peak:$${state.peak.toFixed(2)}`);

    // ── HARD STOP -15% ──
    if(pnlPct<=-CONFIG.HARD_STOP_PCT){
      // Only fire stop if market is open — prevent duplicate orders overnight
      const etNow=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
      const tNow=etNow.getHours()*100+etNow.getMinutes();
      const isWeekday=etNow.getDay()>=1&&etNow.getDay()<=5;
      const mktOpen=isWeekday&&tNow>=400&&tNow<=1945; // 4am-7:45pm only
      if(!mktOpen){
        console.log(`⏸️ STOP queued for ${sym} (${pnlPct.toFixed(1)}%) — market closed, will fire at open`);
        state._stopQueued=true;
        continue;
      }
      // Don't re-send if already queued
      if(state._stopSent){
        console.log(`⏸️ STOP already sent for ${sym} — waiting for fill`);
        continue;
      }
      console.log(`🛑 STOP ${sym} ${pnlPct.toFixed(1)}%`);
      const r=await tzOrder(sym,"Sell",qty,cur);
      if(r.success){
        state._stopSent=true; // mark as sent — don't re-send
        recordPattern(state, pnlPct);
        tradeLog.unshift({type:"STOP",symbol:sym,qty,price:cur,pnlPct:pnlPct.toFixed(1),ts:new Date().toISOString()});
        await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({symbol:sym,side:"SELL",qty,entry_price:entry,exit_price:cur,pnl:(cur-entry)*qty,reason:"HARD_STOP"})}).catch(()=>{});
        await savePatterns();
        delete openTrades[sym];
      }
      continue;
    }

    // ── FIRST TARGET +30% — sell 50% ──
    if(!state.halfSold && pnlPct>=CONFIG.FIRST_TARGET_PCT){
      const sellQty=Math.floor(qty/2);
      if(sellQty>=1){
        const r=await tzOrder(sym,"Sell",sellQty,cur);
        if(r.success){
          state.halfSold=true;
          console.log(`🎯 ${sym} +${pnlPct.toFixed(0)}% — sold 50%`);
          tradeLog.unshift({type:"TARGET1",symbol:sym,qty:sellQty,price:cur,pnlPct:pnlPct.toFixed(1),ts:new Date().toISOString()});
        }
      }
    }

    // ── SECOND TARGET +75% — sell 25% more ──
    if(state.halfSold && !state.quarterSold && pnlPct>=CONFIG.SECOND_TARGET_PCT){
      const sellQty=Math.floor(qty/4);
      if(sellQty>=1){
        const r=await tzOrder(sym,"Sell",sellQty,cur);
        if(r.success){
          state.quarterSold=true;
          console.log(`🎯 ${sym} +${pnlPct.toFixed(0)}% — sold 25% more`);
          tradeLog.unshift({type:"TARGET2",symbol:sym,qty:sellQty,price:cur,pnlPct:pnlPct.toFixed(1),ts:new Date().toISOString()});
        }
      }
    }

    // ── TRAIL STOP -12% from peak (after first target hit) ──
    if(state.halfSold && fromPeak<=-CONFIG.TRAIL_PCT){
      const etNow2=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
      const tNow2=etNow2.getHours()*100+etNow2.getMinutes();
      const isWeekday2=etNow2.getDay()>=1&&etNow2.getDay()<=5;
      const mktOpen2=isWeekday2&&tNow2>=400&&tNow2<=1945;
      if(!mktOpen2){console.log(`⏸️ Trail queued for ${sym} — market closed`);continue;}
      if(state._trailSent){console.log(`⏸️ Trail already sent for ${sym}`);continue;}
      console.log(`📉 TRAIL ${sym} ${fromPeak.toFixed(1)}% from peak`);
      const r=await tzOrder(sym,"Sell",qty,cur);
      if(r.success){
        state._trailSent=true;
        recordPattern(state, pnlPct);
        tradeLog.unshift({type:"TRAIL",symbol:sym,qty,price:cur,pnlPct:pnlPct.toFixed(1),ts:new Date().toISOString()});
        await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({symbol:sym,side:"SELL",qty,entry_price:entry,exit_price:cur,pnl:(cur-entry)*qty,reason:"TRAIL_STOP"})}).catch(()=>{});
        await savePatterns();
        delete openTrades[sym];
      }
    }
  }
};

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER
// ════════════════════════════════════════════════════════════════════════════
const autoTrade = async () => {
  lastScanTime=new Date().toISOString();
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=et.getHours(),m=et.getMinutes(),t=h*100+m;
  const isWeekend=et.getDay()===0||et.getDay()===6;
  console.log(`\n🔍 ${h}:${String(m).padStart(2,"0")} ET — scanning`);

  try {
    // 1. Manage existing positions first
    const tzPos=await tzPositions();

    // Sync openTrades with actual TZ (remove ghosts)
    for(const sym of Object.keys(openTrades)){
      if(!tzPos.find(p=>p.sym===sym)){
        console.log(`🗑️ ${sym} closed in TZ — removing`);
        delete openTrades[sym];
      }
    }

    if(tzPos.length) await managePositions(tzPos);

    // 2. EOD sweep — sell everything at 3:55pm ET (before close)
    const isEOD=!isWeekend&&t>=1955&&t<=2000;
    if(isEOD&&tzPos.length){
      console.log(`🌙 EOD SWEEP — selling ${tzPos.length} positions before close`);
      for(const p of tzPos){
        const q=await finnhub(`/quote?symbol=${p.sym}`).catch(()=>null);
        const price=parseFloat(q?.c||0)||p.entry;
        if(price>0){
          const r=await tzOrder(p.sym,"Sell",p.qty,price);
          if(r.success){
            const pnl=((price-p.entry)/p.entry*100).toFixed(1);
            console.log(`🌙 SOLD ${p.sym} x${p.qty} @$${price.toFixed(2)} | ${pnl}%`);
            if(openTrades[p.sym]) recordPattern(openTrades[p.sym],parseFloat(pnl));
            delete openTrades[p.sym];
          }
        }
      }
      return;
    }

    // Trading hours only: 4am-7:45pm ET, weekdays
    if(isWeekend||t<400||t>1945){
      // Overnight: save pre-market watchlist from today's top movers
      if(lastGainers.length&&!isWeekend){
        preMarketWatchlist=lastGainers.slice(0,10).map(g=>g.symbol);
        console.log(`📋 Pre-market watchlist: ${preMarketWatchlist.join(", ")}`);
      }
      console.log(`⏸️ Outside trading hours`);
      return;
    }

    // 3. Check max positions — only count bot-managed positions
    // Don't count stale/legacy TZ positions the bot didn't enter this session
    const longPos=tzPos.filter(p=>!p.isShort);
    const botManaged=longPos.filter(p=>openTrades[p.sym]).length;
    if(botManaged>=CONFIG.MAX_POSITIONS){
      console.log(`🛑 Max ${CONFIG.MAX_POSITIONS} bot positions (${botManaged} managed, ${longPos.length} longs in TZ)`);
      return;
    }
    // Also block if TZ has too many total long positions (risk control)
    if(longPos.length>=15){
      console.log(`⚠️ TZ has ${longPos.length} long positions — not adding more until cleaned up`);
      return;
    }

    // 4. Get account
    const acc=await tzAccount();
    console.log(`💵 Equity:$${acc.equity?.toFixed(0)} Cash:$${acc.cash?.toFixed(0)} PnL:$${acc.pnl?.toFixed(0)}`);
    if(acc.cash<2000){console.log("💵 Low cash");return;}

    // 5. Scan for spikes
    const movers=await scanForSpikes();
    if(!movers.length){console.log("📭 No spikes found");return;}
    lastGainers=movers.slice(0,20);
    console.log(`🔥 Top spikes: ${movers.slice(0,5).map(g=>`${g.symbol}+${g.pct?.toFixed(0)}% ${(g.vol/1e6).toFixed(1)}Mvol`).join(" | ")}`);

    // 6. Filter owned
    const owned=tzPos.map(p=>p.sym);
    const candidates=movers.filter(g=>!owned.includes(g.symbol)).slice(0,8);
    if(!candidates.length){console.log("⏭️ All spikes already owned");return;}

    // 7. Analyze and score each candidate
    const slotsLeft=CONFIG.MAX_POSITIONS-tzPos.length;
    const scored=[];

    for(const stock of candidates.slice(0,6)){
      // Get float info
      const prof=await finnhub(`/stock/profile2?symbol=${stock.symbol}`).catch(()=>null);
      const floatM=parseFloat(prof?.shareOutstanding||999);
      const mktCapM=parseFloat(prof?.marketCapitalization||0);

      // Chart pattern analysis
      const chart=await analyzeChart(stock.symbol);

      // Only proceed if pattern score is decent
      if(chart.patternScore<20&&chart.relVol<5) continue;

      console.log(`  📊 ${stock.symbol}: +${stock.pct?.toFixed(0)}% | vol:${(stock.vol/1e6).toFixed(1)}M | relVol:${chart.relVol}x | score:${chart.patternScore} | float:${floatM<999?floatM.toFixed(1)+"M":"?"}`);

      scored.push({
        ...stock,
        float: floatM,
        mktCapM,
        chart,
        finalScore: chart.patternScore,
      });

      await new Promise(r=>setTimeout(r,200)); // rate limit buffer
    }

    if(!scored.length){console.log("⏭️ No stocks passed pattern filter");return;}

    // Sort by pattern score
    scored.sort((a,b)=>b.finalScore-a.finalScore);

    // 8. Buy top candidates
    for(const stock of scored.slice(0,slotsLeft)){
      if(stock.finalScore<15){console.log(`🚫 ${stock.symbol}: score too low (${stock.finalScore})`);continue;}

      // Fresh price
      const q=await finnhub(`/quote?symbol=${stock.symbol}`).catch(()=>null);
      const price=parseFloat(q?.c||stock.price||0);
      if(!price||price<=0||price<CONFIG.MIN_PRICE||price>CONFIG.MAX_PRICE) continue;

      // Position size
      const maxDollars=Math.min(acc.cash*CONFIG.CASH_PCT, CONFIG.MAX_CASH_PER_TRADE);
      const qty=Math.floor(maxDollars/price);
      if(qty<1){console.log(`🚫 ${stock.symbol}: qty<1`);continue;}

      console.log(`🚀 BUY ${stock.symbol} x${qty} @$${price} | +${stock.pct?.toFixed(0)}% | ${(stock.vol/1e6).toFixed(1)}Mvol | relVol:${stock.chart.relVol}x | score:${stock.finalScore}`);
      const order=await tzOrder(stock.symbol,"Buy",qty,price);

      if(order.success){
        openTrades[stock.symbol]={
          entry:price, qty, peak:price,
          halfSold:false, quarterSold:false,
          time:Date.now(), hour:h,
          relVol:stock.chart.relVol,
          volAccel:stock.chart.volAccel,
          entryGainPct:stock.pct,
          float:stock.float,
          patternScore:stock.finalScore,
        };
        tradeLog.unshift({type:"BUY",symbol:stock.symbol,qty,price,pct:stock.pct,vol:stock.vol,relVol:stock.chart.relVol,score:stock.finalScore,ts:new Date().toISOString()});
        await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({symbol:stock.symbol,side:"BUY",qty,entry_price:price,reason:`v18 score:${stock.finalScore} relVol:${stock.chart.relVol}x pct:+${stock.pct?.toFixed(1)}%`})}).catch(()=>{});
        console.log(`✅ ${stock.symbol} bought`);
      } else {
        console.log(`❌ ${stock.symbol} failed: ${order.status||order.error}`);
      }
    }

  } catch(e){console.error("autoTrade:",e.message);}
};

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULER
// ════════════════════════════════════════════════════════════════════════════
const getInterval = () => {
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const t=et.getHours()*100+et.getMinutes();
  if(t>=930&&t<1000) return 15000;    // 15s at open — critical window
  if(t>=400&&t<930)  return 90000;    // 90s pre-market
  if(t>=1000&&t<1530) return 60000;   // 60s regular hours
  if(t>=1530&&t<1600) return 30000;   // 30s EOD
  if(t>=1600&&t<1945) return 120000;  // 2min AH
  return 3600000;                      // 1hr overnight
};

const startAutoTrader = () => {
  if(autoTraderActive) return;
  autoTraderActive=true;
  console.log("🤖 PulseTrader v18.0 STARTED — Volume Spike Hunter");
  const run=async()=>{
    await autoTrade();
    if(autoTraderActive) scanTimer=setTimeout(run,getInterval());
  };
  run();
};

const stopAutoTrader = () => {
  if(scanTimer) clearTimeout(scanTimer);
  autoTraderActive=false; scanTimer=null;
  console.log("⏹️ Stopped");
};

// ════════════════════════════════════════════════════════════════════════════
// STARTUP SYNC
// ════════════════════════════════════════════════════════════════════════════
const startup = async () => {
  console.log("🔄 Syncing with TZ...");
  await loadPatterns();
  try {
    const positions=await tzPositions();
    const longs=positions.filter(p=>!p.isShort);
    const shorts=positions.filter(p=>p.isShort);
    if(shorts.length) console.log(`⚠️ Found ${shorts.length} SHORT positions in TZ: ${shorts.map(p=>p.sym).join(",")} — bot will NOT manage these`);
    for(const p of longs){
      if(!openTrades[p.sym]&&p.entry>0){
        openTrades[p.sym]={entry:p.entry,qty:p.qty,peak:p.entry,halfSold:false,quarterSold:false,time:Date.now(),hour:new Date().getHours()};
        console.log(`📍 Restored LONG: ${p.sym} x${p.qty} @$${p.entry}`);
      }
    }
    if(longs.length>CONFIG.MAX_POSITIONS)
      console.log(`⚠️ TZ has ${longs.length} long positions (>${CONFIG.MAX_POSITIONS} max). All restored for management.`);
    console.log(`🛡️ ${Object.keys(openTrades).length} long positions under management`);
  } catch(e){console.log("Startup:",e.message);}
};

// ════════════════════════════════════════════════════════════════════════════
// CHAT
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/chat",async(req,res)=>{
  const{messages}=req.body;
  if(!messages?.length) return res.status(400).json({error:"No messages"});
  try{
    const userMsg=messages[messages.length-1]?.content||"";
    chatMemory.push({role:"user",content:userMsg,ts:Date.now()});
    if(chatMemory.length>40) chatMemory.splice(0,2);

    const[acc,pos]=await Promise.all([tzAccount().catch(()=>null),tzPositions().catch(()=>[])]);

    // Build live position strings with P&L
    const posData=await Promise.all(pos.map(async p=>{
      const q=await finnhub(`/quote?symbol=${p.sym}`).catch(()=>null);
      const cur=parseFloat(q?.c||0);
      const pnlPct=cur>0&&p.entry>0?((cur-p.entry)/p.entry*100):0;
      return `${p.sym}:${p.qty}sh@$${p.entry.toFixed(2)}→$${cur.toFixed(2)}(${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}%)`;
    }));

    const ctx=`Bot:${autoTraderActive?"RUNNING":"PAUSED"} | Equity:$${acc?.equity?.toFixed(0)||"?"} | Cash:$${acc?.cash?.toFixed(0)||"?"} | PnL:$${acc?.pnl?.toFixed(0)||"?"} | Pos(${pos.length}/${CONFIG.MAX_POSITIONS}):[${posData.join(", ")||"none"}] | Movers:${lastGainers.slice(0,4).map(g=>`${g.symbol}+${(g.pct||0).toFixed(0)}%`).join(",")||"none"} | Patterns:${PATTERNS.winners.length}W/${PATTERNS.losers.length}L`;

    const recentMem=chatMemory.slice(-16).map(m=>({role:m.role,content:m.content}));

    const sys=`You are PulseTrader v18.0 — elite momentum trading assistant.

LIVE ACCOUNT DATA: ${ctx}

CRITICAL RULES — NEVER VIOLATE:
- NEVER invent, fabricate, or hallucinate positions, trades, cash balances, or P&L
- NEVER show fake Pos() lists — only use real data from LIVE ACCOUNT DATA above
- NEVER say a sell executed unless you used EXECUTE_SELL command and it returned success
- NEVER invent new buy trades — the bot scanner handles all buys automatically
- If asked about positions, use EXECUTE_POSITIONS to fetch real data
- Only report what is in LIVE ACCOUNT DATA — nothing else

TO EXECUTE REAL ORDERS (add as LAST LINE only):
EXECUTE_SELL:SYMBOL — sells real TZ position
EXECUTE_SELLALL — sells all real TZ positions  
EXECUTE_POSITIONS — shows real positions from TZ
EXECUTE_MOVERS — shows real top movers
EXECUTE_ANALYZE:SYMBOL — analyzes a stock
EXECUTE_STATUS — shows real bot status
EXECUTE_STOP | EXECUTE_START
EXECUTE_COVER_ALL — covers ALL short positions in TZ using BuyCover orders

Be direct. Trader language. No fake data ever.`;

    const groqMsgs=[{role:"system",content:sys},...recentMem.slice(0,-1),{role:"user",content:userMsg}];
    const reply=await groq(groqMsgs,800);
    if(!reply) return res.json({reply:"AI unavailable."});

    const lines=reply.split("\n");
    const execLine=lines.find(l=>l.trim().startsWith("EXECUTE_"));
    let display=lines.filter(l=>!l.trim().startsWith("EXECUTE_")).join("\n").trim();
    let action="";

    if(execLine){
      const cmd=execLine.trim();

      if(cmd.startsWith("EXECUTE_SELL:")){
        const sym=cmd.split(":")[1]?.trim().toUpperCase();
        const p=pos.find(x=>x.sym===sym);
        const state=openTrades[sym];
        const qty=p?.qty||state?.qty;
        if(sym&&qty){
          const q=await finnhub(`/quote?symbol=${sym}`).catch(()=>null);
          const price=parseFloat(q?.c||0)||p?.entry||0;
          if(price){
            const r=await tzOrder(sym,"Sell",qty,price);
            if(r.success){
              const entry=p?.entry||state?.entry||price;
              const pnlPct=((price-entry)/entry*100).toFixed(1);
              if(state) recordPattern(state,parseFloat(pnlPct));
              delete openTrades[sym];
              action=`\n\n✅ Sold ${sym} x${qty} @$${price.toFixed(2)} | P&L: ${pnlPct}%`;
            } else action=`\n\n❌ Order failed: ${r.status||r.error}`;
          } else action=`\n\n❌ Can't get price for ${sym}`;
        } else action=`\n\n❌ No position in ${sym||"?"}`;
      }

      else if(cmd.startsWith("EXECUTE_SELLALL")){
        const positions=await tzPositions();
        let sold=0;
        for(const p of positions){
          const q=await finnhub(`/quote?symbol=${p.sym}`).catch(()=>null);
          const price=parseFloat(q?.c||0)||p.entry;
          if(price){const r=await tzOrder(p.sym,"Sell",p.qty,price);if(r.success){sold++;delete openTrades[p.sym];}}
        }
        action=`\n\n🔴 Sold ${sold}/${positions.length} positions.`;
      }

      else if(cmd.startsWith("EXECUTE_BUY:")){
        const parts=cmd.split(":");
        const sym=(parts[1]||"").trim().toUpperCase();
        const reqQty=parseInt(parts[2]||0);
        if(sym){
          const q=await finnhub(`/quote?symbol=${sym}`).catch(()=>null);
          const price=parseFloat(q?.c||0);
          if(price>0){
            const acc2=await tzAccount();
            const qty=reqQty>0?reqQty:Math.floor(Math.min(acc2.cash*CONFIG.CASH_PCT,CONFIG.MAX_CASH_PER_TRADE)/price);
            if(qty>=1){
              const r=await tzOrder(sym,"Buy",qty,price);
              if(r.success){
                openTrades[sym]={entry:price,qty,peak:price,halfSold:false,quarterSold:false,time:Date.now(),hour:new Date().getHours()};
                action=`\n\n✅ Bought ${sym} x${qty} @$${price.toFixed(2)}`;
              } else action=`\n\n❌ Failed: ${r.status||r.error}`;
            } else action=`\n\n❌ Not enough cash`;
          } else action=`\n\n❌ Can't get price for ${sym}`;
        }
      }

      else if(cmd.startsWith("EXECUTE_ANALYZE:")){
        const sym=cmd.split(":")[1]?.trim().toUpperCase();
        if(sym){
          const[q,prof,chart]=await Promise.all([
            finnhub(`/quote?symbol=${sym}`),
            finnhub(`/stock/profile2?symbol=${sym}`),
            analyzeChart(sym),
          ]);
          const price=q.c||0,pct=q.dp||0;
          const float=prof?.shareOutstanding;
          const myPos=pos.find(p=>p.sym===sym);
          let a=`\n\n📊 ${sym}: $${price.toFixed(2)} (${pct>=0?"+":""}${pct.toFixed(1)}%)\n`;
          a+=`Float: ${float?float.toFixed(1)+"M":"?"} | Vol: ${((q.v||0)/1e6).toFixed(2)}M\n`;
          a+=`RelVol: ${chart.relVol}x | VolAccel: ${chart.volAccel}x | Score: ${chart.patternScore}/100\n`;
          a+=`VWAP: $${chart.vwap?.toFixed(2)} ${chart.aboveVWAP?"✅above":"❌below"} | HH+HL: ${chart.hhhl?"✅":"❌"}\n`;
          if(myPos){const pnlPct=((price-myPos.entry)/myPos.entry*100);a+=`Position: ${myPos.qty}sh @$${myPos.entry.toFixed(2)} | ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}% | Stop: $${(myPos.entry*0.85).toFixed(2)}`;}
          action=a;
        }
      }

      else if(cmd.startsWith("EXECUTE_POSITIONS")){
        if(!pos.length) action="\n\n📊 Flat — no positions.";
        else{
          const lines2=await Promise.all(pos.map(async p=>{
            const q=await finnhub(`/quote?symbol=${p.sym}`).catch(()=>null);
            const cur=parseFloat(q?.c||0);
            const pnlPct=cur>0?((cur-p.entry)/p.entry*100):0;
            const flag=pnlPct<=-14?"🚨":pnlPct<=-8?"⚠️":pnlPct>=50?"🎯":pnlPct>=25?"✅":"";
            const stop=(p.entry*(1-CONFIG.HARD_STOP_PCT/100)).toFixed(2);
            return `${flag}${p.sym}: ${p.qty}sh @$${p.entry.toFixed(2)}→$${cur.toFixed(2)} ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}% | stop:$${stop}`;
          }));
          action=`\n\n📊 POSITIONS (${pos.length}/${CONFIG.MAX_POSITIONS}):\n${lines2.join("\n")}`;
        }
      }

      else if(cmd.startsWith("EXECUTE_MOVERS")){
        const top=lastGainers.slice(0,8);
        action=top.length?`\n\n🔥 TOP SPIKES:\n${top.map((g,i)=>`${i+1}. ${g.symbol} +${(g.pct||0).toFixed(1)}% @$${g.price} | ${(g.vol/1e6).toFixed(1)}M vol`).join("\n")}`:"\n\n🔍 No spikes yet.";
      }

      else if(cmd.startsWith("EXECUTE_STATUS")){
        const wins=PATTERNS.winners.length,losses=PATTERNS.losers.length;
        const wr=wins+losses>0?((wins/(wins+losses))*100).toFixed(0):0;
        action=`\n\n${autoTraderActive?"🟢 RUNNING":"🔴 PAUSED"} | v18.0\nEquity:$${acc?.equity?.toFixed(2)} | Cash:$${acc?.cash?.toFixed(2)}\nP&L:$${acc?.pnl?.toFixed(2)} | Pos:${pos.length}/${CONFIG.MAX_POSITIONS}\nPatterns: ${wins}W/${losses}L (${wr}%WR)`;
      }

      else if(cmd.startsWith("EXECUTE_STOP")){stopAutoTrader();action="\n\n⏹️ Bot stopped.";}
      else if(cmd.startsWith("EXECUTE_START")){startAutoTrader();action="\n\n🟢 Bot started.";}

      else if(cmd.startsWith("EXECUTE_COVER_ALL")){
        const allPos=await tzPositions();
        const shorts=allPos.filter(p=>p.isShort);
        if(!shorts.length){action="\n\n✅ No short positions — already clean.";}
        else{
          let covered=0,failed=0;
          const results=[];
          for(const p of shorts){
            const q=await finnhub(`/quote?symbol=${p.sym}`).catch(()=>null);
            const price=parseFloat(q?.c||0)||p.entry;
            if(!price){results.push(`❌ ${p.sym}: no price`);failed++;continue;}
            const lp=parseFloat((price*1.002).toFixed(4));
            const body={
              clientOrderId:`PT-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,
              symbol:p.sym,securityType:"Stock",
              side:"BuyCover",orderType:"Market",
              limitPrice:lp,price:lp,traderAction:"BuyCover",
              quantity:Math.floor(p.qty),orderQuantity:Math.floor(p.qty),
              timeInForce:"Day",route:process.env.TZ_ROUTE||"SMART",
            };
            try{
              const d=await tzAPI("POST",`/v1/api/accounts/${ACC()}/order`,body);
              console.log(`TZ BuyCover ${p.sym} x${p.qty} @${lp}:`,JSON.stringify(d).slice(0,120));
              const ok=!["Rejected","Canceled","Expired"].includes(d.orderStatus)&&!!d.orderStatus;
              if(ok){covered++;results.push(`✅ Covered ${p.sym} x${p.qty} @$${price.toFixed(2)}`);}
              else{failed++;results.push(`❌ ${p.sym}: ${d.orderStatus||"rejected"}`);}
            }catch(e){failed++;results.push(`❌ ${p.sym}: ${e.message}`);}
            await new Promise(r=>setTimeout(r,300));
          }
          action=`\n\n🔄 COVER ALL:\n${results.join("\n")}\n\nCovered: ${covered} | Failed: ${failed}`;
        }
      }
    }

    const finalReply=(display+action).trim();
    chatMemory.push({role:"assistant",content:finalReply,ts:Date.now()});
    res.json({reply:finalReply});
  }catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/autotrader/start",(_,res)=>{startAutoTrader();res.json({status:"started"});});
app.get( "/api/autotrader/start",(_,res)=>{startAutoTrader();res.json({status:"started"});});
app.post("/api/autotrader/stop", (_,res)=>{stopAutoTrader();res.json({status:"stopped"});});
app.post("/api/autotrader/scan", async(_,res)=>{res.json({ok:true});autoTrade();});
app.get("/api/alerts",(_,res)=>res.json({alerts:[]}));

app.post("/api/autotrader/sellall",async(_,res)=>{
  const positions=await tzPositions();
  let sold=0;
  for(const p of positions){
    const q=await finnhub(`/quote?symbol=${p.sym}`).catch(()=>null);
    const price=parseFloat(q?.c||0)||p.entry;
    if(price){const r=await tzOrder(p.sym,"Sell",p.qty,price);if(r.success){sold++;delete openTrades[p.sym];}}
  }
  res.json({sold});
});

app.get("/api/autotrader/status",async(_,res)=>{
  const[acc,pos]=await Promise.all([tzAccount().catch(()=>null),tzPositions().catch(()=>[])]);
  res.json({
    active:autoTraderActive,last_scan:lastScanTime,version:"18.0.0",
    equity:acc?.equity?.toFixed(2),cash:acc?.cash?.toFixed(2),pnl:acc?.pnl?.toFixed(2),
    positions:pos.length,max_positions:CONFIG.MAX_POSITIONS,
    open_trades:Object.keys(openTrades),
    patterns:{winners:PATTERNS.winners.length,losers:PATTERNS.losers.length,stats:PATTERNS.stats},
    recent_trades:tradeLog.slice(0,20),
    top_movers:lastGainers.slice(0,10),
    config:CONFIG,
  });
});

app.get("/api/holdings",async(_,res)=>{
  try{
    // Read DIRECTLY from TZ — no internal state overlay
    // This ensures UI always matches exactly what TZ has
    const raw=await tzAPI("GET",`/v1/api/accounts/${ACC()}/positions`);
    const list=Array.isArray(raw)?raw:(raw.positions||raw.data||raw||[]);
    if(!Array.isArray(list)||!list.length){
      const acc2=await tzAccount().catch(()=>null);
      return res.json({holdings:[],count:0,total_pnl:"0.00",today_pnl:acc2?.pnl?.toFixed(2)||"0"});
    }

    // Get all unique symbols for batch price fetch
    const syms=[...new Set(list.map(p=>(p.symbol||p.ticker||"").toUpperCase()).filter(Boolean))];
    const priceMap={};
    await Promise.all(syms.map(async sym=>{
      const q=await finnhub(`/quote?symbol=${sym}`).catch(()=>null);
      priceMap[sym]=parseFloat(q?.c||0);
    }));

    // Parse and MERGE duplicate symbols (TZ paper quirk)
    const rawMap={};
    for(const p of list){
      const sym=(p.symbol||p.ticker||"").toString().trim().toUpperCase();
      if(!sym) continue;
      const qty=Math.abs(parseFloat(p.shares??p.quantity??p.qty??0));
      const entry=parseFloat(p.priceAvg??p.averagePrice??p.avgPrice??p.entryPrice??0);
      const side=(p.side||"").toLowerCase();
      if(side==="sell"||qty<=0) continue;
      if(!rawMap[sym]){
        rawMap[sym]={sym,qty,entry};
      } else {
        const totalQty=rawMap[sym].qty+qty;
        rawMap[sym].entry=(rawMap[sym].entry*rawMap[sym].qty+entry*qty)/totalQty;
        rawMap[sym].qty=totalQty;
      }
    }
    const holdings=Object.values(rawMap).map(p=>{
      const sym=p.sym;
      const qty=p.qty;
      const entry=p.entry;
      const cur=priceMap[sym]||entry;
      const pnl=entry>0&&cur>0?(cur-entry)*qty:0;
      const pct=entry>0&&cur>0?((cur-entry)/entry*100):0;
      return {
        symbol:sym,
        qty,
        side:"long",
        avg_entry:entry.toFixed(4),
        current_price:cur.toFixed(4),
        unrealized_pnl:pnl.toFixed(2),
        unrealized_pnl_pct:pct.toFixed(2)+"%",
        hard_stop:(entry*(1-CONFIG.HARD_STOP_PCT/100)).toFixed(4),
        first_target:(entry*(1+CONFIG.FIRST_TARGET_PCT/100)).toFixed(4),
      };
    }).filter(p=>p.symbol&&p.qty>0);

    const acc=await tzAccount().catch(()=>null);
    const totalPnl=holdings.reduce((s,h)=>s+parseFloat(h.unrealized_pnl),0);
    res.json({
      holdings,
      count:holdings.length,
      total_pnl:totalPnl.toFixed(2),
      today_pnl:acc?.pnl?.toFixed(2)||"0",
      equity:acc?.equity?.toFixed(2)||"0",
      cash:acc?.cash?.toFixed(2)||"0",
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/account",async(_,res)=>{
  try{const acc=await tzAccount();res.json({equity:acc.equity.toFixed(2),cash:acc.cash.toFixed(2),pnl_today:acc.pnl.toFixed(2)});}
  catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/movers",async(_,res)=>{
  try{
    const movers=await scanForSpikes();
    lastGainers=movers.slice(0,20);
    res.json({movers:movers.slice(0,20),count:movers.length,ts:new Date().toISOString()});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/quote",async(req,res)=>{
  const{ticker="SPY"}=req.query;
  try{const q=await finnhub(`/quote?symbol=${ticker.toUpperCase()}`);res.json({ticker,price:q.c,pct:q.dp,vol:q.v});}
  catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/trades",async(_,res)=>{
  try{res.json(await supabase("pulsetrader_trades?order=created_at.desc&limit=100").then(d=>Array.isArray(d)?d:[]));}
  catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/order",async(req,res)=>{
  const{symbol,side,qty,price}=req.body;
  if(!symbol||!side||!qty||!price) return res.status(400).json({error:"symbol,side,qty,price required"});
  try{const r=await tzOrder(symbol.toUpperCase(),side==="buy"?"Buy":"Sell",parseInt(qty),parseFloat(price));res.json(r);}
  catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/debug/positions",async(_,res)=>{
  try{const raw=await tzAPI("GET",`/v1/api/accounts/${ACC()}/positions`);const list=Array.isArray(raw)?raw:(raw.positions||raw.data||[]);res.json({count:list.length,first:list[0]||null});}
  catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/news",async(req,res)=>{
  const{ticker}=req.query;
  try{
    const today=new Date().toISOString().split("T")[0];
    const week=new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const news=ticker?await finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`):await finnhub("/news?category=general");
    res.json((Array.isArray(news)?news:[]).slice(0,20));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/health",(_,res)=>res.json({
  status:"ok",version:"18.0.0",
  active:autoTraderActive,
  positions:Object.keys(openTrades).length,
  patterns:{winners:PATTERNS.winners.length,losers:PATTERNS.losers.length},
  ts:new Date().toISOString()
}));

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════
const PORT=process.env.PORT||3001;
app.listen(PORT,async()=>{
  console.log(`⚡ PulseTrader v18.0 — Volume Spike Hunter`);
  console.log(`   Targets: JZ +325% | HKIT +350% | ABTS +115% | HUBC +97%`);
  console.log(`   Max positions: ${CONFIG.MAX_POSITIONS} | Stop: -${CONFIG.HARD_STOP_PCT}%`);
  console.log(`   Target1: +${CONFIG.FIRST_TARGET_PCT}% (sell 50%) | Target2: +${CONFIG.SECOND_TARGET_PCT}% (sell 25%)`);
  console.log(`   Trail: -${CONFIG.TRAIL_PCT}% from peak`);
  await startup();
  startAutoTrader();
});
