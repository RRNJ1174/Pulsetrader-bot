// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PULSETRADER v15.9 — MOMENTUM SCANNER STRATEGY                        ║
// ║  24/7 Operation | 4AM-7:45PM Trading | Study Mode Overnight           ║
// ║  Scanner: Alpaca(1000 tickers) + Finnhub + AlphaVantage               ║
// ║  AI: Gemini (catalyst) + Groq (scoring)                               ║
// ║  Risk: 10 max positions | Float-adjusted sizing | Smart rate limits    ║
// ║  Targets: +50% sell 50% | +100% sell 25% | Trail -15% rest            ║
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
@import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@500;700&family=Exo+2:wght@300;400;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:#020508;color:#c8d8e8;font-family:'Exo 2',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100dvh;padding:24px;gap:28px}
.bolt{font-size:52px;text-align:center;filter:drop-shadow(0 0 20px #00ff88);animation:glow 2s ease-in-out infinite}
.title{font-family:'Rajdhani',sans-serif;font-size:34px;font-weight:700;letter-spacing:4px;color:#00ff88;text-shadow:0 0 30px rgba(0,255,136,.5);text-align:center;margin-top:6px}
.sub{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:3px;color:#5a7a9a;text-align:center;margin-top:4px}
.box{background:#0a1520;border:1px solid #162840;border-radius:12px;padding:28px 22px;width:100%;max-width:340px}
label{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:2px;color:#5a7a9a;display:block;margin-bottom:10px}
input[type=password]{width:100%;background:#060d14;border:1px solid #162840;border-radius:8px;color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:22px;letter-spacing:8px;padding:14px;text-align:center;outline:none;margin-bottom:14px;-webkit-appearance:none;transition:.2s}
input[type=password]:focus{border-color:#00ff88;box-shadow:0 0 15px rgba(0,255,136,.15)}
button{width:100%;background:#00ff88;color:#020508;border:none;border-radius:8px;font-family:'Rajdhani',sans-serif;font-size:16px;font-weight:700;letter-spacing:3px;padding:14px;cursor:pointer;-webkit-appearance:none;transition:.2s}
button:active{opacity:.8;transform:scale(.97)}
.err{color:#ff3355;font-family:'Share Tech Mono',monospace;font-size:11px;text-align:center;margin-top:10px;min-height:16px;letter-spacing:1px}
@keyframes glow{0%,100%{opacity:1}50%{opacity:.6}}
</style></head><body>
<div><div class="bolt">⚡</div><div class="title">PULSETRADER</div><div class="sub">MOMENTUM SCANNER · TRADEZERO · 24/7</div></div>
<div class="box"><form method="POST" action="/login">
<label>ENTER PASSCODE</label>
<input type="password" name="passcode" maxlength="20" placeholder="••••••••" autocomplete="off" autofocus>
<button type="submit">AUTHENTICATE</button>
<div class="err">${err}</div>
</form></div></body></html>`);
});
app.post("/login",(req,res)=>{
  const{passcode}=req.body;
  if(passcode!==PASSCODE) return res.redirect("/login?error=1");
  res.setHeader("Set-Cookie",`pt_session=${makeToken()}; Path=/; HttpOnly; Max-Age=2592000`);
  res.redirect("/");
});
app.post("/api/auth",(req,res)=>{
  const{passcode}=req.body;
  if(passcode!==PASSCODE) return res.status(403).json({error:"Wrong passcode."});
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
  MAX_POSITIONS:       10,
  CASH_FLOOR_PCT:      0.15,
  MIN_SCORE:           60,
  PRE_MIN_SCORE:       65,
  MIN_GAIN_PCT:        20,
  MIN_PRICE:           0.10,
  MAX_PRICE:           50,
  MAX_MKT_CAP_B:       2,
  MAX_FLOAT_M:         50,
  MIN_DOLLAR_VOL:      500000,
  MIN_REL_VOL:         10,
  MIN_FLOAT_ROTATION:  0.5,
  HARD_STOP_PCT:       15,
  FIRST_TARGET_PCT:    50,
  SECOND_TARGET_PCT:   100,
  TRAIL_STOP_PCT:      15,
  GAP_FILL_TRAIL_PCT:  10,
  SCALE_IN_PCT:        25,
  EOD_SELL_HOUR:       19,
  EOD_SELL_MIN:        50,
  NO_ENTRY_HOUR:       19,
  NO_ENTRY_MIN:        45,
  TZ_ROUTE:            process.env.TZ_ROUTE || "SMART",
  // Rate limits
  ALPACA_MAX_PER_MIN:  180,
  FINNHUB_MAX_PER_MIN: 54,
  AV_MAX_PER_DAY:      24,
};

// ════════════════════════════════════════════════════════════════════════════
// RATE LIMITER
// ════════════════════════════════════════════════════════════════════════════
const RATE = {
  alpaca:   { calls:0, resetAt: Date.now()+60000 },
  finnhub:  { calls:0, resetAt: Date.now()+60000 },
  av:       { calls:0, dayStamp:"" },
};
const checkRate = (api) => {
  const now=Date.now();
  if(api==="av"){
    const today=new Date().toISOString().split("T")[0];
    if(RATE.av.dayStamp!==today){RATE.av.dayStamp=today;RATE.av.calls=0;}
    return RATE.av.calls < CONFIG.AV_MAX_PER_DAY;
  }
  const r=RATE[api];
  if(now>r.resetAt){r.calls=0;r.resetAt=now+60000;}
  const limit=api==="alpaca"?CONFIG.ALPACA_MAX_PER_MIN:CONFIG.FINNHUB_MAX_PER_MIN;
  return r.calls < limit;
};
const trackRate = (api) => {
  if(api==="av") RATE.av.calls++;
  else RATE[api].calls++;
};

// ════════════════════════════════════════════════════════════════════════════
// BRAIN / STATE
// ════════════════════════════════════════════════════════════════════════════
const BRAIN = {
  totalTrades:0, wins:0, losses:0, totalPnL:0,
  bestTickers:[], recentPerformance:[],
  // Scoring factor weights (auto-adjusted by win rate)
  weights: { float:25, floatRot:20, relVol:20, gainPct:8, news:15, shortInt:10, priceAction:12, orderFlow:10, multiDay:15, timeOfDay:5, historical:5 },
  // Feature stats for auto-weight adjustment
  featureStats: { float:{}, floatRot:{}, relVol:{}, gainPct:{}, news:{yes:{t:0,w:0},no:{t:0,w:0}}, hour:{}, sector:{}, stockType:{} },
  // Pattern libraries
  explosionPatterns: [],  // pre-explosion patterns (what preceded big winners)
  redFlagPatterns:   [],  // failed move patterns
  // Time-of-day win rates
  timeStats: {},
  // Sector momentum
  sectorMomentum: {},
  // Multi-day runners (ran 20%+ yesterday)
  multiDayRunners: [],
  // Overnight watchlist
  overnightWatchlist: [],
  // Score thresholds (auto-adjusted)
  minScore: 60,
  lessons: [],
  lastStudy: null,
};

const tradeLog    = [];
const openTrades  = {};   // symbol -> {entryPrice, qty, peakPrice, halfSold, quarterSold, score, stockType, sector, entryHour, ...}
const pendingOrders = {}; // symbol -> clientOrderId (cancel before new order)

let autoTraderActive = false;
let scanTimer        = null;
let lastScanTime     = null;
let lastGainers      = [];
let lastAnalysis     = "";
let yesterdayMovers  = [];
// Persistent chat memory — survives across conversations in same session
const chatMemory = []; // [{role,content,ts}] last 30 messages

// AV cache
const AV_CACHE = { gainers:[], ts:0 };

// ════════════════════════════════════════════════════════════════════════════
// API HELPERS
// ════════════════════════════════════════════════════════════════════════════
const supabase = async (path,opts={}) => {
  try {
    const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`,{headers:{apikey:process.env.SUPABASE_KEY,Authorization:`Bearer ${process.env.SUPABASE_KEY}`,"Content-Type":"application/json",Prefer:"return=representation"},...opts});
    const t=await r.text(); return t?JSON.parse(t):[];
  } catch(_){return [];}
};
const alpacaData = async (path) => {
  if(!checkRate("alpaca")) { console.log("⚠️ Alpaca rate limit — skipping"); return {}; }
  trackRate("alpaca");
  const r=await fetch(`https://data.alpaca.markets${path}`,{headers:{"APCA-API-KEY-ID":process.env.ALPACA_KEY,"APCA-API-SECRET-KEY":process.env.ALPACA_SECRET}});
  return r.json();
};
const finnhub = async (path) => {
  if(!checkRate("finnhub")) { console.log("⚠️ Finnhub rate limit — skipping"); return {}; }
  trackRate("finnhub");
  const sep=path.includes("?")?"&":"?";
  const r=await fetch(`https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`);
  return r.json();
};
const groq = async (promptOrMessages, maxTokens=800) => {
  try {
    // Accept either a plain string OR a messages array (for chat with memory)
    const isChat=Array.isArray(promptOrMessages);
    const model=isChat?"llama-3.3-70b-versatile":"llama-3.1-8b-instant";
    const messages=isChat?promptOrMessages:[{role:"system",content:"You are PulseTrader, an elite momentum trading AI. Analyze small-cap momentum stocks. Be concise and decisive."},{role:"user",content:promptOrMessages}];
    const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model,max_tokens:maxTokens,messages})});
    const d=await r.json(); if(d.error) throw new Error(d.error.message);
    return d.choices?.[0]?.message?.content||"";
  } catch(e){return "";}
};
const gemini = async (prompt, maxTokens=400) => {
  try {
    if(!process.env.GEMINI_KEY) return null;
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_KEY}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:maxTokens,temperature:0.3}})});
    const d=await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text||null;
  } catch(_){return null;}
};
const logError = async (ctx,err) => {
  try{await supabase("bot_errors",{method:"POST",body:JSON.stringify({context:ctx,error:String(err?.message||err),ts:new Date().toISOString()})});}catch(_){}
};

// ════════════════════════════════════════════════════════════════════════════
// TRADEZERO API
// ════════════════════════════════════════════════════════════════════════════
const TZ_BASE = () => (process.env.TZ_API_URL||"https://webapi.tradezero.com").replace(/\/$/,"");
const TZ_ACC  = () => process.env.TZ_ACCOUNT_ID||"";

const tzAPI = async (method,path,body=null) => {
  const opts={method,headers:{"TZ-API-KEY-ID":process.env.TZ_API_KEY,"TZ-API-SECRET-KEY":process.env.TZ_API_SECRET,"Content-Type":"application/json","Accept":"application/json"}};
  if(body) opts.body=JSON.stringify(body);
  const r=await fetch(`${TZ_BASE()}${path}`,opts);
  const t=await r.text();
  try{return t?JSON.parse(t):{};}catch(_){return {raw:t};}
};

const tzGetAccount = async () => {
  try {
    const d=await tzAPI("GET",`/v1/api/accounts/${TZ_ACC()}/pnl`);
    return {
      equity: parseFloat(d.accountValue||d.netLiquidation||d.equity||d.totalValue||0),
      cash:   parseFloat(d.availableCash||d.cashAvailable||d.cash||d.buyingPower||0),
      pnl:    parseFloat(d.dayPnl||d.dayPnL||d.dayRealized||0),
      raw:d,
    };
  } catch(e){return {equity:0,cash:0,pnl:0};}
};

let _tzRawDumped = false;
const tzGetPositions = async () => {
  try {
    const d=await tzAPI("GET",`/v1/api/accounts/${TZ_ACC()}/positions`);
    if(!_tzRawDumped){
      _tzRawDumped=true;
      const arr=Array.isArray(d)?d:(d.positions||d.data||[]);
      const s=arr[0]||null;
      if(s) console.log("🔍 TZ position sample:",JSON.stringify(s).slice(0,400));
    }
    const list=Array.isArray(d)?d:(d.positions||d.data||d||[]);
    if(!Array.isArray(list)||!list.length) return [];

    const rawPositions=list.map(p=>{
      const sym=(p.symbol||p.ticker||"").toString().trim().toUpperCase();
      const qty=Math.abs(parseFloat(p.shares??p.quantity??p.qty??0));
      // Use shares sign to determine direction (TZ paper side field is unreliable)
      // Negative shares = actual short position, positive = long
      const rawShares=parseFloat(p.shares??p.quantity??p.qty??0);
      const isLong=rawShares>=0; // positive or zero shares = long
      const tzEntry=parseFloat(p.priceAvg??p.averagePrice??p.avgPrice??p.entryPrice??p.costBasis??0);
      const tzClose=parseFloat(p.priceClose??p.closePrice??0);
      const tzOpen=parseFloat(p.priceOpen??p.openPrice??0);
      return {sym,qty,isLong,tzEntry,tzClose,tzOpen};
    }).filter(p=>p.sym&&p.qty>0);

    if(!rawPositions.length) return [];

    // Fetch live prices from Finnhub
    const quotes=await Promise.all(
      rawPositions.map(p=>
        finnhub(`/quote?symbol=${p.sym}`)
          .then(q=>({sym:p.sym,price:parseFloat(q.c||0),prev:parseFloat(q.pc||0)}))
          .catch(()=>({sym:p.sym,price:0,prev:0}))
      )
    );
    const priceMap=Object.fromEntries(quotes.map(q=>[q.sym,q]));

    return rawPositions
    // Return ALL positions (longs + shorts) so UI matches TZ exactly
    // Management logic only applies to longs (openTrades only tracks longs)
    .map(({sym,qty,isLong,tzEntry,tzClose,tzOpen})=>{
      const liveQ=priceMap[sym]||{price:0,prev:0};
      const currentPrice=liveQ.price>0?liveQ.price:tzClose>0?tzClose:tzOpen>0?tzOpen:liveQ.prev>0?liveQ.prev:0;
      const entry=tzEntry>0?tzEntry:(openTrades[sym]?.entryPrice>0?openTrades[sym].entryPrice:(liveQ.prev>0?liveQ.prev:0));
      const unrlPl=entry>0&&currentPrice>0?(currentPrice-entry)*qty:0;
      return {
        symbol:sym, qty:String(qty), side:isLong?"long":"short",
        avg_entry_price:String(entry.toFixed(4)),
        current_price:String(currentPrice.toFixed(4)),
        market_value:String((qty*currentPrice).toFixed(2)),
        unrealized_pl:String(unrlPl.toFixed(2)),
        unrealized_plpc:String((entry>0&&qty>0&&isFinite(unrlPl/(qty*entry)))?((unrlPl/(qty*entry))*100).toFixed(2):0),
      };
    });
  } catch(e){console.log("TZ positions:",e.message);return [];}
};

// Cancel pending orders for a ticker before placing new
const tzCancelPending = async (symbol) => {
  try {
    // Cancel via stored pending order ID (fast — no extra API call)
    if(pendingOrders[symbol]){
      await tzAPI("DELETE",`/v1/api/accounts/${TZ_ACC()}/order/${pendingOrders[symbol]}`).catch(()=>{});
      console.log(`🗑️ Cancelled pending order for ${symbol}`);
      delete pendingOrders[symbol];
    }
  } catch(_){}
};

const tzPlaceOrder = async (symbol,action,qty,price=null) => {
  // Always cancel pending first
  await tzCancelPending(symbol);

  const clientOrderId=`PT-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
  const{sess}=getSession();
  const isExt=sess==="PRE"||sess==="AH";

  // Marketable limit orders: buys at ask, sells at bid
  // Always limit — no market orders except hard stop retries
  let limitPrice=null;
  if(price&&price>0){
    if(action==="Buy")  limitPrice=parseFloat((price*1.001).toFixed(4)); // at ask (tiny buffer)
    else                limitPrice=parseFloat((price*0.999).toFixed(4)); // at bid (tiny buffer)
  }

  const body={
    clientOrderId,
    symbol:symbol.toUpperCase(),
    securityType:"Stock",
    side:action,
    orderType:"Limit",
    limitPrice:limitPrice||price,
    price:limitPrice||price,
    traderAction:action,
    quantity:parseInt(qty),
    orderQuantity:parseInt(qty),
    timeInForce:isExt?"Day_Plus":"Day",
    route:CONFIG.TZ_ROUTE,
  };
  try {
    const d=await tzAPI("POST",`/v1/api/accounts/${TZ_ACC()}/order`,body);
    console.log(`TZ ${action} ${symbol} x${qty} @$${limitPrice||price}:`,JSON.stringify(d).slice(0,150));
    const rejected=["Rejected","Canceled","Expired"].includes(d.orderStatus);
    if(!rejected&&d.orderStatus) pendingOrders[symbol]=d.clientOrderId||clientOrderId;
    return {success:!rejected&&!!d.orderStatus,clientOrderId,orderStatus:d.orderStatus,data:d};
  } catch(e){return {success:false,error:e.message};}
};

const tzSellAll = async () => {
  try {
    const positions=await tzGetPositions();
    if(!positions.length) return 0;
    await Promise.all(positions.map(p=>tzPlaceOrder(p.symbol,"Sell",p.qty,parseFloat(p.current_price))));
    return positions.length;
  } catch(e){return 0;}
};

// ════════════════════════════════════════════════════════════════════════════
// SESSION / TIME
// ════════════════════════════════════════════════════════════════════════════
const getETTime = () => {
  const now=new Date();
  const dstStart=(()=>{const d=new Date(Date.UTC(now.getUTCFullYear(),2,1));d.setUTCDate(8-(d.getUTCDay()||7));return d;})();
  const dstEnd  =(()=>{const d=new Date(Date.UTC(now.getUTCFullYear(),10,1));d.setUTCDate(1+(7-d.getUTCDay())%7);return d;})();
  const offset=(now>=dstStart&&now<dstEnd)?-4:-5;
  return new Date(now.getTime()+offset*3600000);
};

const getSession = () => {
  const et=getETTime();
  const day=et.getUTCDay(),h=et.getUTCHours(),m=et.getUTCMinutes(),t=h*100+m;
  const isWeekend=day===0||day===6;
  const isPre=!isWeekend&&t>=400&&t<930;
  const isOpen=!isWeekend&&t>=930&&t<1600;
  const isAH=!isWeekend&&t>=1600&&t<2000;
  const isStudy=isWeekend||(t>=2000||t<400);
  const sess=isOpen?"REGULAR":isPre?"PRE":isAH?"AH":isWeekend?"WEEKEND":"OVERNIGHT";
  // No new entries after 7:45 PM
  const noNewEntries=t>=1945||isStudy;
  // Opening window (scan but wait 2 candles)
  const isOpeningWindow=!isWeekend&&t>=930&&t<935;
  return {isPre,isOpen,isAH,isStudy,isWeekend,sess,t,h,m,noNewEntries,isOpeningWindow};
};

// Scan interval based on time of day
const getScanInterval = () => {
  const{t,isStudy,isWeekend}=getSession();
  if(isWeekend) return 2*60*60*1000; // 2hr on weekends
  if(isStudy)   return 2*60*60*1000; // 2hr study mode
  if(t>=935&&t<1000)  return 15*1000;  // 15sec: open sprint
  if(t>=400&&t<930)   return 2*60*1000; // 2min: pre-market
  if(t>=930&&t<935)   return 30*1000;  // 30sec: opening window
  if(t>=1000&&t<1530) return 60*1000;  // 60sec: regular
  if(t>=1530&&t<1600) return 30*1000;  // 30sec: EOD surge
  if(t>=1600&&t<1945) return 2*60*1000; // 2min: AH (new entries ok)
  return 2*60*60*1000; // 2hr otherwise
};

// ════════════════════════════════════════════════════════════════════════════
// 1000 TICKER UNIVERSE WITH SECTORS
// ════════════════════════════════════════════════════════════════════════════
const SECTOR_UNIVERSE = {
  biotech:   ["SAVA","OCGN","NVAX","ADMA","BNGO","SRNE","TGTX","EDSA","FBRX","HTBX","NKGN","IMVT","CYRX","AXSM","ALDX","ALRS","ALTO","AMAM","PHGE","CODX","NNVC","NCPL","IPWR","AIMD","ARTL","OTLK","HTT","BRAI","NCRA","ATXI","TRIL","RVNC","JSPR","CLFD","IMVT","ACMR","MNMD","HIMS","ADMA","EDSA","FBRX","ALDX","AXSM","HCWB","RDWU","LUNL","SNGX","PHGE","SEGG","LFVN"],
  crypto:    ["MARA","RIOT","CIFR","BTBT","HUT","WULF","CLSK","BTBT","IREN","CORZ","BTDR","SATO","ARBK","BITF","HIVE","MIGI","BSRT","BTCM","BTCS","BKKT","COIN","HOOD","SOFI"],
  ai:        ["SOUN","MLGO","KULR","BBCP","AIIO","AUUD","GMEX","STEM","QUBT","KPLT","MULN","PLTR","HOOD","ACMR","GBOX","BKSY","CLFD"],
  cannabis:  ["VCIG","TLRY","CGC","CURLF","GTBIF","AYRWF","CRLBF","TCNNF","SNDL","ACB","OGI","GRWG","IIPR","MAPS","MSOS","YOLO"],
  energy:    ["AMMO","ORBS","BTM","TE","PETZ","SLXN","GCL","IPWR","LUNL","WULF","CLSK","HUT","CIFR"],
  space:     ["MNTS","MNTSW","ASTC","RDWU","LUNL","BKSY","RKLB","ASTR","SPCE","VORB","ASTS","SATL"],
  ev:        ["MULN","AYRO","SOLO","GOEV","RIDE","WKHS","NKLA","HYZN","FFIE","BLNK","CHPT","EVGO","PTRA"],
  fintech:   ["HOOD","SOFI","COIN","KPLT","Dave","MOXC","ATRK","CURO","NRDS","UPST","LC","TREE"],
  defense:   ["AMMO","KTOS","AVAV","RCON","VVOS","LONN","DRS","CODA"],
  smallcap:  ["ASTC","AMSS","SNGX","NHICW","FGL","UZX","LGHL","RDWU","PLU","CPSH","SEGG","YMAT","QTEX","PRTS","ARTL","HTT","PCLA","EDHL","ATPC","LIMN","ILLR","VIDA","DGNX","JUNS","WHLR","SLXN","GCL","PETZ","BTM","STFS","GMEX","BBCP","GBOX","LMND","JDZG","SNAL","POET","UCAR","HCWB","AUUD","AIIO","RDWU","CPSH","LGHL","NNVC","NCPL","FGL","AMSS","MNTSW","NHICW","LUNL","IPWR","SEGG","PLU","VCIG","QTEX","QTEXW","UZX","PHGE","NCRA","BRAI","CODX","ARTL","OTLK","WHLR","BKSY","ATPC","RDWU"],
};

// Flat universe of all unique tickers
// Expanded with top OTC/smallcap momentum runners from Finviz screener
const EXTRA_UNIVERSE = [
  // Top volume small caps / OTC runners (updated pool)
  "HUBC","DEVS","AACPW","STG","REPL","HCWC","PRFX","DLLL","OKTG","OLOX","NAMM","VCIG","VS",
  "CGTL","SPRC","AEAC","ABOS","ABUS","ACCD","ACET","ACHC","ACLS","ACNB","ACRS","ACST","ACTG",
  "ADAP","ADCT","ADIL","ADMA","ADMP","ADMS","ADPT","ADRA","ADSE","AEYE","AFMD","AFRI","AGBA",
  "AGFY","AGIL","AGIO","AGMH","AGRI","AGRO","AGYS","AHCO","AHPI","AIOT","AIRG","AIRO","AIXI",
  "AKBA","AKTS","AKTX","ALBT","ALCO","ALEC","ALGS","ALIM","ALLK","ALLT","ALNY","ALOT","ALPA",
  "ALPN","ALRS","ALSA","ALSP","ALTI","ALTO","ALUR","ALVO","ALXO","ALZN","AMAG","AMAO","AMBC",
  "AMBI","AMBO","AMBP","AMCX","AMED","AMEH","AMES","AMGN","AMHC","AMID","AMIX","AMMO","AMNB",
  "AMOT","AMOV","AMPE","AMPH","AMPIO","AMPX","AMRN","AMRS","AMSE","AMSF","AMTB","AMTI","AMTX",
  "AMWD","AMWL","AMZN","ANAB","ANAC","ANAT","ANCN","ANDE","ANGI","ANGL","ANGT","ANIK","ANIP",
  "ANIX","ANNX","ANPC","ANSS","ANTE","ANTX","ANVS","ANZU","AOGO","AOMR","AORT","AOUT","APCA",
  "APDN","APEI","APEN","APGN","APLD","APLE","APLS","APLT","APM","APMI","APMO","APOG","APOP",
  "APRE","APRT","APSI","APVO","APWC","APXI","APYX","AQMS","AQNA","AQNB","AQST","ARAV","ARBB",
  "ARBE","ARCE","ARCO","ARCT","AREC","ARGX","ARHS","ARIS","ARIZ","ARKG","ARKW","ARMP","AROC",
  "ARON","ARQT","ARQQ","ARTE","ARTL","ARTNA","ARTS","ARTV","ARWR","ARYA","ARYC","ASBP","ASCA",
  "ASDN","ASEP","ASLE","ASLN","ASMB","ASND","ASNS","ASPC","ASPI","ASPS","ASRV","ASST","ASTE",
  "ASUR","ASVN","ASXC","ASYS","ATAI","ATAQ","ATCX","ATEC","ATEX","ATHA","ATHE","ATHX","ATLC",
  "ATLO","ATMC","ATMV","ATNI","ATNM","ATNY","ATOB","ATRC","ATRE","ATRI","ATRX","ATSG","ATTO",
  "ATVI","ATXG","ATXI","ATXS","AUBN","AUDC","AUID","AUMN","AUPH","AURC","AURE","AUROW","AUTL",
  "AUUD","AUVI","AVAH","AVAV","AVCO","AVDL","AVDX","AVEO","AVER","AVGE","AVGO","AVGR","AVHI",
  "AVID","AVIR","AVNW","AVPT","AVRO","AVTA","AVTE","AVTR","AVXL","AWRE","AXDX","AXGN","AXIL",
  "AXNX","AXON","AXSM","AXTI","AXTX","AYRO","AYTU","AZEK","AZTA","AZUL","AZYO","BAFN","BAFR",
  "BANA","BANC","BAND","BANR","BANX","BAOS","BARK","BASE","BASI","BATRA","BCAN","BCDA","BCFL",
  "BCLI","BCML","BCNX","BCOM","BCRX","BCSA","BCSG","BCST","BCTX","BCYC","BDMD","BDRY","BDSX",
  "BDTX","BEAT","BEEM","BENF","BETR","BFAC","BFAM","BFIN","BFLY","BFRI","BGCP","BGIO","BGNE",
  "BGRY","BGSX","BHAT","BHIL","BHLB","BHTG","BIMI","BIOA","BIOC","BIOL","BIOR","BIOS","BIOX",
  "BIRK","BITE","BIVI","BJDX","BKFC","BKGI","BKKT","BKNG","BKSY","BKTI","BKUV","BLDE","BLDP",
  "BLFS","BLFY","BLIN","BLKB","BLMN","BLND","BLNK","BLPH","BLRX","BLSA","BLTE","BLTS","BLUE",
  "BLZE","BMBL","BMEA","BMGN","BMRA","BMRC","BMRN","BNAI","BNIX","BNKL","BNMV","BNOX","BNRG",
  "BNTC","BNTX","BNXG","BOLT","BOMN","BOOM","BORE","BOXL","BPMC","BPOP","BPRN","BPTH","BPTS",
  "BPVN","BPYP","BRAC","BRAG","BRBR","BREA","BRFS","BRKH","BRKL","BRLT","BRMK","BRNS","BRRR",
  "BRTX","BRUN","BRVS","BRWC","BRWS","BSAQ","BSBK","BSET","BSGM","BSIG","BSKL","BSRR","BSST",
  "BSVN","BTAI","BTBT","BTCM","BTCS","BTDR","BTMD","BTOQ","BTRE","BTTX","BTWA","BTWN","BULD",
  "BUSE","BVFL","BVNK","BWAY","BWMG","BXRX","BYDE","BYFC","BYND","BYRN","BYSI","BZFD","BZUN",
  // More active small caps
  "CACO","CADL","CAKE","CALC","CALT","CALX","CAMG","CAMP","CAMT","CANN","CAPR","CARA","CARB",
  "CARE","CARG","CARM","CARS","CASA","CASH","CASI","CASS","CATO","CBAN","CBAT","CBFV","CBIO",
  "CBKM","CBMB","CBPO","CBRN","CBSH","CBST","CBTX","CBYI","CCAI","CCAP","CCCC","CCEC","CCEL",
  "CCEP","CCIX","CCLP","CCNC","CCOB","CCOI","CCRD","CCRN","CCSI","CCTS","CCXI","CDAK","CDLX",
  "CDMO","CDNA","CDNS","CDRO","CDTG","CDTX","CDXC","CDXS","CEBI","CECO","CEDA","CELU","CENN",
  "CENT","CEPU","CERE","CERS","CETX","CEVA","CFFE","CFFI","CFFN","CFIV","CFLT","CFMS","CFNB",
  "CFRA","CFRX","CGABL","CGBS","CGEN","CGIX","CGNX","CGON","CGRA","CGRN","CGRO","CHCI","CHCO",
  "CHDN","CHEA","CHEF","CHEK","CHEM","CHGG","CHMG","CHNG","CHNR","CHPM","CHPT","CHRB","CHRD",
  "CHRO","CHRS","CHRY","CHSN","CHUC","CHWY","CIFR","CLBK","CLBS","CLCN","CLDX","CLEU","CLFD",
  "CLGN","CLIR","CLMB","CLMT","CLNE","CLNN","CLOA","CLPT","CLRB","CLRC","CLRD","CLRO","CLSD",
  "CLSH","CLSK","CLSN","CLST","CLTM","CLVR","CLVS","CLWT","CLXT","CMCL","CMCO","CMCT","CMEG",
  "CMER","CMLS","CMMB","CMND","CMPO","CMPR","CMPS","CMRA","CMRE","CMRX","CMTG","CNBS","CNCE",
  "CNCR","CNET","CNFN","CNGL","CNHI","CNMD","CNOB","CNSP","CNTB","CNTG","CNTIN","CNTQ","CNTY",
  "CNXA","CNXC","CNXN","CODA","CODX","COFS","COGT","COHN","COIN","COLS","COMS","COMT","CONG",
  "CONN","CONX","COPE","COPH","COPI","COPX","CORT","CORZ","COSM","COSS","COST","COVA","COVS",
  "CPBI","CPHI","CPIX","CPKI","CPOP","CPRT","CPSH","CPTK","CPTN","CPUH","CRAB","CRAI","CRCM",
  "CRDF","CRDL","CRDO","CREV","CREX","CRGE","CRGO","CRGX","CRGY","CRIS","CRKN","CRLBF","CRMD",
  "CRNC","CRNT","CRNX","CROX","CRSP","CRSR","CRTD","CRUS","CRVL","CRVS","CRWD","CRXT","CSAI",
  "CSBB","CSBR","CSCO","CSGS","CSGP","CSII","CSIQ","CSKI","CSLM","CSLT","CSOD","CSSE","CSTL",
  "CSTR","CSWC","CTAQ","CTBI","CTDD","CTHR","CTLP","CTLT","CTMX","CTNM","CTOS","CTRI","CTRL",
  "CTSO","CTTB","CTXR","CTXS","CUBE","CUBI","CULD","CULP","CURE","CUTR","CVAC","CVBF","CVCO",
  "CVGI","CVGW","CVII","CVKD","CVLG","CVLT","CVLY","CVNA","CVNX","CVRS","CVRX","CVTI","CWCO",
  "CWGL","CWIN","CWNP","CWST","CXAI","CXDO","CXSE","CYAN","CYCC","CYCN","CYDX","CYDY","CYME",
  "CYRN","CYTO","CZFS","CZNI","DADA","DAIS","DALI","DALN","DALS","DAMO","DANA","DANN","DAOO",
];
const MASTER_UNIVERSE = [...new Set([...Object.values(SECTOR_UNIVERSE).flat(),...EXTRA_UNIVERSE])].filter(t=>t&&t.length<=6).slice(0,1000);

// Get sector for a ticker
const getSector = (ticker) => {
  for(const[sector,tickers] of Object.entries(SECTOR_UNIVERSE)){
    if(tickers.includes(ticker)) return sector;
  }
  return "other";
};

// ════════════════════════════════════════════════════════════════════════════
// TECHNICALS
// ════════════════════════════════════════════════════════════════════════════
const calcVWAP = bars => {
  if(!bars?.length) return 0;
  let pv=0,vol=0;
  for(const b of bars){const tp=(b.h+b.l+b.c)/3;pv+=tp*(b.v||0);vol+=(b.v||0);}
  return vol>0?pv/vol:0;
};

const calcEMA = (data,period) => {
  if(!data||data.length<period) return null;
  const k=2/(period+1);
  let ema=data.slice(0,period).reduce((s,v)=>s+v,0)/period;
  for(let i=period;i<data.length;i++) ema=data[i]*k+ema*(1-k);
  return ema;
};

// Check higher highs and higher lows on last N bars
const hasHigherHighsLows = (bars,n=6) => {
  if(!bars||bars.length<n) return false;
  const r=bars.slice(-n);
  const highs=r.map(b=>b.h), lows=r.map(b=>b.l);
  return highs[highs.length-1]>highs[0] && lows[lows.length-1]>lows[0];
};

// Check last 3 candles are green and each higher
const lastCandlesGreenRising = (bars,n=3) => {
  if(!bars||bars.length<n) return false;
  const r=bars.slice(-n);
  return r.every((b,i)=>b.c>b.o) && r.every((b,i)=>i===0||b.c>r[i-1].c);
};

// Detect consolidation (tight range) before explosion
const detectConsolidation = (bars) => {
  if(!bars||bars.length<5) return false;
  const recent=bars.slice(-5,-1); // last 4 candles before latest
  const highs=recent.map(b=>b.h), lows=recent.map(b=>b.l);
  const range=(Math.max(...highs)-Math.min(...lows))/Math.min(...lows)*100;
  const latest=bars[bars.length-1];
  const explosion=latest.v > recent.reduce((s,b)=>s+(b.v||0),0)/recent.length * 2;
  return range<3 && explosion; // tight range then volume explosion
};

// Volume Profile: find POC (point of control = price with most volume)
const calcVolumeProfile = (bars) => {
  if(!bars?.length) return null;
  const buckets={};
  for(const b of bars){
    const price=parseFloat(b.c.toFixed(2));
    buckets[price]=(buckets[price]||0)+(b.v||0);
  }
  const poc=Object.entries(buckets).sort((a,b)=>b[1]-a[1])[0];
  return poc?{poc:parseFloat(poc[0]),pocVol:poc[1]}:null;
};

const get1MinBars = async (ticker) => {
  try {
    const etStart=new Date(getETTime());
    etStart.setUTCHours(etStart.getUTCHours()-etStart.getUTCHours()%24);
    etStart.setUTCHours(8); // ~4am ET
    const d=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=1Min&start=${etStart.toISOString()}&feed=iex&limit=480`);
    return d.bars||[];
  } catch(_){return [];}
};

const get5MinBars = async (ticker) => {
  try {
    const now=new Date(),start=new Date(now);
    start.setUTCHours(start.getUTCHours()-7);
    const d=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=5Min&start=${start.toISOString()}&limit=78&feed=iex`);
    return d.bars||[];
  } catch(_){return [];}
};

// Full chart analysis for a ticker
const getChartData = async (ticker,price) => {
  try {
    const [bars1,bars5]=await Promise.all([get1MinBars(ticker),get5MinBars(ticker)]);
    if(!bars1.length&&!bars5.length) return null;
    const bars=bars1.length?bars1:bars5;
    const closes=bars.map(b=>b.c);
    const vwap=calcVWAP(bars);
    const ema9=calcEMA(closes,9);
    const vp=calcVolumeProfile(bars);
    const aboveVWAP=price>=vwap&&vwap>0;
    const abovePOC=vp&&price>=vp.poc;
    const hhhl1=hasHigherHighsLows(bars1.length?bars1:[],6);
    const hhhl5=hasHigherHighsLows(bars5.length?bars5:[],6);
    const greenRising=lastCandlesGreenRising(bars,3);
    const consolidation=detectConsolidation(bars);
    // Volume trend: is volume increasing last 3 bars?
    const recentVols=bars.slice(-3).map(b=>b.v||0);
    const volIncreasing=recentVols.length>=2&&recentVols[recentVols.length-1]>=recentVols[0];
    // 20-day avg volume from daily bars
    const totalVol=bars.reduce((s,b)=>s+(b.v||0),0);
    return {vwap,ema9,vp,aboveVWAP,abovePOC,hhhl1,hhhl5,greenRising,consolidation,volIncreasing,totalVol,bars1len:bars1.length,bars5len:bars5.length};
  } catch(_){return null;}
};

// ════════════════════════════════════════════════════════════════════════════
// ORDER FLOW
// ════════════════════════════════════════════════════════════════════════════
const getOrderFlow = async (ticker) => {
  try {
    const[td,qd]=await Promise.all([
      alpacaData(`/v2/stocks/${ticker}/trades?limit=500&feed=iex`),
      alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`)
    ]);
    const trades=td.trades||[];
    const q=qd.quote;
    if(!trades.length||!q) return null;
    const bid=parseFloat(q.bp||0),ask=parseFloat(q.ap||0);
    const mid=(bid+ask)/2;
    const spread=ask>0?((ask-bid)/ask*100):999;
    let buyVol=0,sellVol=0,buyCount=0,sellCount=0;
    const tapeSpeed=trades.length>0?trades.length/60:0; // trades per minute approx
    for(const t of trades){
      const p=parseFloat(t.p||0),s=parseInt(t.s||0);
      if(p>=ask){buyVol+=s;buyCount++;}
      else if(p<=bid){sellVol+=s;sellCount++;}
      else if(p>mid){buyVol+=s*0.6;sellVol+=s*0.4;}
      else{buyVol+=s*0.4;sellVol+=s*0.6;}
    }
    const totalVol=buyVol+sellVol;
    const buyPct=totalVol>0?(buyVol/totalVol)*100:50;
    const delta=buyVol-sellVol;
    // Bid stack depth
    const bidSize=parseInt(q.bs||0),askSize=parseInt(q.as||0);
    const bidAskRatio=askSize>0?bidSize/askSize:1;
    return {
      buyPct:buyPct.toFixed(1),delta:Math.round(delta),
      buyVol:Math.round(buyVol),sellVol:Math.round(sellVol),
      tapeSpeed:tapeSpeed.toFixed(1),
      bid,ask,spread:spread.toFixed(2),
      bidSize,askSize,bidAskRatio:bidAskRatio.toFixed(2),
      deltaPositive:delta>0,
      strongBuy:buyPct>=60,
      buyDominating:buyPct>=52,
      printingAtAsk:buyCount>sellCount,
    };
  } catch(_){return null;}
};

// ════════════════════════════════════════════════════════════════════════════
// SCORING SYSTEM
// ════════════════════════════════════════════════════════════════════════════
const scoreStock = (data) => {
  const {ticker,price,pct,float,mktCapB,relVol,dollarVol,news,shortInt,chart,of,isPreMarket,hour,sector} = data;
  let score=0;
  const details=[];

  // ── Float Size (+25 max) ──
  const floatM=parseFloat(float)||999;
  if(floatM<5){score+=25;details.push("float<5M:+25");}
  else if(floatM<20){score+=15;details.push("float5-20M:+15");}
  else if(floatM<50){score+=8;details.push("float20-50M:+8");}

  // ── Float Rotation — VOLUME IS #1 (+20 max) ──
  const floatRot=floatM>0&&floatM<999?((data.todayVol||0)/1e6/floatM):0;
  if(floatRot>2){score+=20;details.push("floatRot>2x:+20");}
  else if(floatRot>1){score+=12;details.push("floatRot1-2x:+12");}
  else if(floatRot>0.5){score+=6;details.push("floatRot0.5-1x:+6");}

  // ── Relative Volume vs own 20-day avg (+20 max) ──
  const rv=parseFloat(relVol)||0;
  if(rv>50){score+=20;details.push("relVol>50x:+20");}
  else if(rv>20){score+=14;details.push("relVol20-50x:+14");}
  else if(rv>10){score+=8;details.push("relVol10-20x:+8");}

  // ── % Gain (+20 max) ──
  if(pct>100){score+=20;details.push("gain>100%:+20");}
  else if(pct>50){score+=14;details.push("gain50-100%:+14");}
  else if(pct>20){score+=8;details.push("gain20-50%:+8");}

  // ── News Catalyst (+20 max) ──
  if(news?.hasSECFiling){score+=20;details.push("SEC8K:+20");}
  else if(news?.ageHours<2){score+=15;details.push("news<2h:+15");}
  else if(news?.ageHours<8){score+=8;details.push("news<8h:+8");}

  // ── Short Interest (+15 max) ──
  const si=parseFloat(shortInt)||0;
  if(si>30){score+=15;details.push("SI>30%:+15");}
  else if(si>20){score+=10;details.push("SI>20%:+10");}
  else if(si>10){score+=5;details.push("SI>10%:+5");}

  // ── Price Action / Chart (+12 max) ──
  if(chart?.hhhl1&&chart?.hhhl5){score+=12;details.push("HH+HL_both:+12");}
  else if(chart?.hhhl1||chart?.hhhl5){score+=6;details.push("HH+HL_one:+6");}
  if(chart?.greenRising){score+=10;details.push("3greenRising:+10");}
  if(chart?.aboveVWAP){score+=5;details.push("aboveVWAP:+5");}
  if(chart?.consolidation){score+=10;details.push("consolidation:+10");}
  // Breakout levels
  const levels=[0.50,1,2,5,10];
  if(levels.some(l=>Math.abs(price-l)/l<0.03)){score+=7;details.push("breakoutLevel:+7");}
  // Matches explosion pattern from library
  if(BRAIN.explosionPatterns.length>0&&matchesPattern(data,BRAIN.explosionPatterns)){score+=10;details.push("explosionPattern:+10");}

  // ── Order Flow (+10 max) ──
  if(of?.deltaPositive){score+=10;details.push("deltaPos:+10");}
  if(of?.tapeSpeed>5){score+=8;details.push("tapeFast:+8");}
  if(of?.bidAskRatio>1.5){score+=8;details.push("bidWall:+8");}
  if(of?.printingAtAsk){score+=5;details.push("printAtAsk:+5");}

  // ── Multi-Day Runner (+15) ──
  if(BRAIN.multiDayRunners.includes(ticker)){score+=15;details.push("multiDay:+15");}
  if(BRAIN.overnightWatchlist.find(w=>w.ticker===ticker)){score+=10;details.push("overnight20:+10");}
  if(data.steadyPreVol){score+=8;details.push("steadyPreVol:+8");}

  // ── Sector Momentum (+8) ──
  if(BRAIN.sectorMomentum[sector]>=3){score+=8;details.push("sector3+:+8");}
  else if(BRAIN.sectorMomentum[sector]>=2){score+=5;details.push("sector2+:+5");}

  // ── Time of Day bonus (+5 max, auto-weighted) ──
  const todWr=BRAIN.timeStats[`${hour}h`]?.wr||0.5;
  const todBonus=Math.round(todWr*10-5); // -5 to +5 based on historical win rate
  if(hour>=9&&hour<10){score+=5+todBonus;details.push(`openWindow:+${5+todBonus}`);}
  else if(hour>=15&&hour<16){score+=3+Math.max(0,todBonus);details.push(`EODsurge:+${3+Math.max(0,todBonus)}`);}
  else if(isPreMarket&&news?.hasCatalyst){score+=5;details.push("preWithNews:+5");}

  // ── Historical (+5) ──
  if(BRAIN.bestTickers.includes(ticker)){score+=5;details.push("pastWinner:+5");}

  // ── Penalties ──
  if(!chart?.volIncreasing){score-=10;details.push("volDecline:-10");}
  if(!news?.hasCatalyst&&rv<20){score-=8;details.push("noNewsLowVol:-8");}
  if(parseFloat(of?.spread||0)>3&&price<2){score-=10;details.push("wideSpread:-10");}
  else if(parseFloat(of?.spread||0)>1.5&&price>=2){score-=10;details.push("wideSpread:-10");}
  if(of&&!of.deltaPositive){score-=8;details.push("deltaNeg:-8");}
  if(of&&parseFloat(of.tapeSpeed)<1){score-=5;details.push("tapeSlow:-5");}
  // Red flag pattern
  if(BRAIN.redFlagPatterns.length>0&&matchesPattern(data,BRAIN.redFlagPatterns)){
    data._redFlag=true;details.push("redFlagFlagged");
  }

  return {score:Math.max(0,score),details:details.join("|")};
};

// Simple pattern matching
const matchesPattern = (data,patterns) => {
  if(!patterns.length) return false;
  return patterns.some(p=>{
    const floatMatch=!p.floatM||Math.abs((parseFloat(data.float)||0)-p.floatM)/Math.max(p.floatM,1)<0.5;
    const volMatch=!p.relVol||Math.abs((data.relVol||0)-p.relVol)/Math.max(p.relVol,1)<0.5;
    const pctMatch=!p.pct||Math.abs(data.pct-p.pct)/Math.max(p.pct,1)<0.5;
    return floatMatch&&volMatch&&pctMatch;
  });
};

// ════════════════════════════════════════════════════════════════════════════
// POSITION SIZING
// ════════════════════════════════════════════════════════════════════════════
const calcPositionSize = (cash,price,floatM,mktCapB,gainPct=0) => {
  const fm=parseFloat(floatM)||30;
  // Float-adjusted position pct
  let posPct=0.10;
  if(fm<5)       posPct=0.08;
  else if(fm<20) posPct=0.10;
  else           posPct=0.12;

  let dollars=cash*posPct;

  // Hard caps by price
  let maxVal=50000, maxShares=Infinity;
  if(price<1)        {maxVal=15000; maxShares=50000;}
  else if(price<2)   {maxVal=20000; maxShares=20000;}
  else if(price<10)  {maxVal=30000; maxShares=10000;}
  // Halt risk cap: stocks up >100% get max $10k position
  const isHaltRisk=(fm<5&&gainPct>100)||(gainPct>150);
  if(isHaltRisk) maxVal=Math.min(maxVal,10000);

  // Halt risk cap
  dollars=Math.min(dollars,maxVal);
  let qty=Math.floor(dollars/price);
  qty=Math.min(qty,maxShares);
  if(qty<1) return 0;
  return qty;
};

// ════════════════════════════════════════════════════════════════════════════
// STOCK TYPE DETECTION
// ════════════════════════════════════════════════════════════════════════════
const detectStockType = (price,floatM,sector,pct) => {
  if(price<1)              return "sub1";
  if(sector==="biotech")   return "biotech";
  if(sector==="crypto")    return "crypto";
  if(parseFloat(floatM)<5) return "lowfloat";
  if(BRAIN.multiDayRunners.length&&BRAIN.multiDayRunners.includes("_check")) return "multiday";
  return "standard";
};

// ════════════════════════════════════════════════════════════════════════════
// SCANNER — MAIN UNIVERSE SCAN
// ════════════════════════════════════════════════════════════════════════════
const scanUniverse = async () => {
  const{isPre,isOpen,isAH}=getSession();
  const gainers=[];

  // SOURCE 1: AlphaVantage top gainers (cached 30 min, 24 calls/day)
  try {
    const ageMin=(Date.now()-AV_CACHE.ts)/60000;
    if(ageMin>30&&checkRate("av")){
      const r=await fetch(`https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${process.env.ALPHAVANTAGE_KEY}`);
      trackRate("av");
      const d=await r.json();
      const list=d.top_gainers||[];
      list.forEach(g=>{
        const c=parseFloat(g.price||0),dp=parseFloat((g.change_percentage||"0").replace("%",""));
        if(c>=CONFIG.MIN_PRICE&&c<=CONFIG.MAX_PRICE&&dp>=CONFIG.MIN_GAIN_PCT)
          gainers.push({ticker:g.ticker,price:c,pct:dp,vol:parseInt(g.volume||0),source:"av"});
      });
      AV_CACHE.gainers=gainers.slice(); AV_CACHE.ts=Date.now();
      console.log(`📡 AV: ${gainers.length} gainers`);
    } else if(AV_CACHE.gainers.length){
      gainers.push(...AV_CACHE.gainers);
    }
  }catch(_){}

  // SOURCE 2: Alpaca screener
  try {
    const urls=[
      `/v1beta1/screener/stocks/movers?by=percent_change&top=100&market_type=sip`,
      `/v1beta1/screener/stocks/movers?by=percent_change&top=100`,
    ];
    for(const url of urls){
      try{
        const data=await alpacaData(url);
        const list=data.gainers||[];
        if(list.length){
          list.forEach(g=>{
            if(g.price>=CONFIG.MIN_PRICE&&g.price<=CONFIG.MAX_PRICE&&g.percent_change>=CONFIG.MIN_GAIN_PCT&&!gainers.find(x=>x.ticker===g.symbol))
              gainers.push({ticker:g.symbol,price:g.price,pct:g.percent_change,vol:g.volume||0,source:"alpaca"});
          });
          console.log(`📡 Alpaca screener: ${list.length}`);
          break;
        }
      }catch(_){continue;}
    }
  }catch(_){}

  // SOURCE 3: Batch snapshot of entire 1000-ticker universe
  // Chunk into batches of 100
  const minVol=isPre?500:10000;
  const tickers=[...new Set([
    ...gainers.map(g=>g.ticker),
    ...yesterdayMovers,
    ...BRAIN.overnightWatchlist.map(w=>w.ticker),
    ...MASTER_UNIVERSE,
  ])].filter(t=>t&&t.length<=6).slice(0,1000);

  for(let i=0;i<tickers.length;i+=100){
    const batch=tickers.slice(i,i+100);
    try {
      const snap=await alpacaData(`/v2/stocks/snapshots?symbols=${batch.join(",")}&feed=iex`);
      for(const[sym,s] of Object.entries(snap||{})){
        const price=s?.minuteBar?.c||s?.dailyBar?.c||s?.latestTrade?.p||0;
        const prev=s?.prevDailyBar?.c||0;
        if(price<=0||prev<=0) continue;
        const pct=((price-prev)/prev)*100;
        const vol=s?.dailyBar?.v||s?.minuteBar?.v||0;
        if(pct>=CONFIG.MIN_GAIN_PCT&&price>=CONFIG.MIN_PRICE&&price<=CONFIG.MAX_PRICE&&vol>=minVol&&!gainers.find(g=>g.ticker===sym))
          gainers.push({ticker:sym,price,pct:parseFloat(pct.toFixed(2)),vol,source:"snapshot"});
      }
    }catch(_){}
    if(i+100<tickers.length) await new Promise(r=>setTimeout(r,100));
  }

  // Sort by % gain, dedupe
  const seen=new Set();
  return gainers.filter(g=>{
    if(seen.has(g.ticker)) return false;
    seen.add(g.ticker);
    return true;
  }).sort((a,b)=>b.pct-a.pct);
};

// Full analysis for a single stock
const analyzeCandidate = async (ticker,price,pct,vol) => {
  try {
    const week=new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const today=new Date().toISOString().split("T")[0];
    const[profile,news,chart,of]=await Promise.all([
      finnhub(`/stock/profile2?symbol=${ticker}`),
      finnhub(`/company-news?symbol=${ticker}&from=${week}&to=${today}`),
      getChartData(ticker,price),
      getOrderFlow(ticker),
    ]);

    const floatM=profile?.shareOutstanding||null;
    const mktCapB=profile?.marketCapitalization?profile.marketCapitalization/1000:null; // Finnhub gives in M
    const sector=getSector(ticker)||(profile?.finnhubIndustry||"other");

    // News analysis
    const newsItems=Array.isArray(news)?news:[];
    const latestNews=newsItems[0];
    const ageHours=latestNews?((Date.now()-latestNews.datetime*1000)/3600000):999;
    const hasSECFiling=newsItems.some(n=>(n.headline||"").match(/8-K|S-1|SEC|filing/i));
    const newsData={hasCatalyst:newsItems.length>0,ageHours,hasSECFiling,topHeadline:latestNews?.headline||null};

    // Get 20-day avg volume from daily bars
    let relVol=0,todayVol=vol;
    try{
      const daily=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=1Day&limit=21&feed=iex`);
      const bars=daily.bars||[];
      if(bars.length>=2){
        const avgVol=bars.slice(0,-1).reduce((s,b)=>s+(b.v||0),0)/Math.max(bars.length-1,1);
        relVol=avgVol>0?vol/avgVol:0;
        todayVol=bars[bars.length-1]?.v||vol;
      }
    }catch(_){}

    // Short interest from Finnhub
    let shortInt=0;
    try{
      const si=await finnhub(`/stock/short-interest?symbol=${ticker}`);
      if(si?.data?.length){
        const latest=si.data[0];
        if(latest&&floatM) shortInt=(latest.shortInterest/floatM)*100;
      }
    }catch(_){}

    const{isOpeningWindow,isPreMarket,h:hour}=getSession();
    const scoreData={
      ticker,price,pct,float:floatM,mktCapB,relVol,dollarVol:price*vol,
      todayVol,news:newsData,shortInt,chart,of,
      isPreMarket:getSession().isPre,hour:getSession().h,sector,
      steadyPreVol:BRAIN.overnightWatchlist.find(w=>w.ticker===ticker)?.steadyVol||false,
    };
    const{score,details}=scoreStock(scoreData);
    const stockType=detectStockType(price,floatM,sector,pct);

    return {ticker,price,pct,vol,relVol,todayVol,float:floatM,mktCapB,sector,stockType,news:newsData,chart,of,score,details,scoreData,shortInt};
  }catch(e){return null;}
};

// ════════════════════════════════════════════════════════════════════════════
// BRAIN — LEARNING
// ════════════════════════════════════════════════════════════════════════════
const learnFromTrade = async (trade) => {
  const won=trade.pnl>0;
  const big=(trade.pnlPct||0)>=50;
  BRAIN.totalTrades=(BRAIN.totalTrades||0)+1;
  if(won) BRAIN.wins=(BRAIN.wins||0)+1;
  else BRAIN.losses=(BRAIN.losses||0)+1;
  BRAIN.totalPnL=(BRAIN.totalPnL||0)+(trade.pnl||0);

  if(won&&!BRAIN.bestTickers.includes(trade.symbol)){
    BRAIN.bestTickers.unshift(trade.symbol);
    BRAIN.bestTickers=BRAIN.bestTickers.slice(0,30);
  }

  // Time-of-day stats
  const hk=`${trade.entryHour||0}h`;
  if(!BRAIN.timeStats[hk]) BRAIN.timeStats[hk]={t:0,w:0,wr:0.5};
  BRAIN.timeStats[hk].t++;
  if(won) BRAIN.timeStats[hk].w++;
  BRAIN.timeStats[hk].wr=BRAIN.timeStats[hk].w/BRAIN.timeStats[hk].t;

  // Learn pattern
  if(big&&trade.scoreData){
    BRAIN.explosionPatterns.unshift({floatM:parseFloat(trade.scoreData.float)||0,relVol:trade.scoreData.relVol||0,pct:trade.pnlPct||0,sector:trade.sector,ts:Date.now()});
    BRAIN.explosionPatterns=BRAIN.explosionPatterns.slice(0,50);
  }
  if(!won&&trade.scoreData){
    BRAIN.redFlagPatterns.unshift({floatM:parseFloat(trade.scoreData.float)||0,relVol:trade.scoreData.relVol||0,pct:trade.pnlPct||0,sector:trade.sector,ts:Date.now()});
    BRAIN.redFlagPatterns=BRAIN.redFlagPatterns.slice(0,50);
  }

  // Recent performance
  BRAIN.recentPerformance.unshift({...trade,won});
  BRAIN.recentPerformance=BRAIN.recentPerformance.slice(0,30);

  // Auto-adjust score threshold
  const recent=BRAIN.recentPerformance;
  if(recent.length>=10){
    const wr=recent.filter(t=>t.won).length/recent.length;
    if(wr>0.65) BRAIN.minScore=Math.max(50,BRAIN.minScore-2);
    else if(wr<0.35) BRAIN.minScore=Math.min(75,BRAIN.minScore+2);
  }

  // Get lesson from Groq
  try{
    const lesson=await groq(`Trade: ${trade.symbol} ${won?"WIN":"LOSS"} ${trade.pnlPct?.toFixed(1)}% | Type:${trade.stockType} | Score:${trade.score} | Exit:${trade.exitReason}\nOne key lesson for finding stocks like this earlier:`,100);
    if(lesson){BRAIN.lessons.unshift(lesson.trim());BRAIN.lessons=BRAIN.lessons.slice(0,15);}
  }catch(_){}

  // Persist
  await supabase("bot_trade_memory",{method:"POST",body:JSON.stringify({
    symbol:trade.symbol,pnl:trade.pnl,pnl_pct:trade.pnlPct,
    entry_price:trade.entryPrice,exit_price:trade.exitPrice,
    exit_reason:trade.exitReason,won,score:trade.score,
    stock_type:trade.stockType,sector:trade.sector,
    entry_hour:trade.entryHour,float_val:trade.float,
    rel_vol:trade.relVol,has_catalyst:trade.news?.hasCatalyst,
  })}).catch(()=>{});
  await saveBrainState().catch(()=>{});
};

const saveBrainState = async () => {
  try {
    const snap={
      totalTrades:BRAIN.totalTrades,wins:BRAIN.wins,losses:BRAIN.losses,totalPnL:BRAIN.totalPnL,
      bestTickers:BRAIN.bestTickers,timeStats:BRAIN.timeStats,featureStats:BRAIN.featureStats,
      explosionPatterns:BRAIN.explosionPatterns.slice(0,30),redFlagPatterns:BRAIN.redFlagPatterns.slice(0,30),
      minScore:BRAIN.minScore,lessons:BRAIN.lessons,sectorMomentum:BRAIN.sectorMomentum,
      multiDayRunners:BRAIN.multiDayRunners,overnightWatchlist:BRAIN.overnightWatchlist,
    };
    await supabase("bot_watchlist",{method:"POST",body:JSON.stringify({label:"brain_v15",tickers:JSON.stringify(snap).slice(0,90000),ts:new Date().toISOString()})});
  }catch(_){}
};

const loadBrain = async () => {
  try {
    const d=await supabase("bot_watchlist?label=eq.brain_v15&order=created_at.desc&limit=1");
    if(Array.isArray(d)&&d[0]?.tickers){
      const s=JSON.parse(d[0].tickers);
      Object.assign(BRAIN,{
        totalTrades:s.totalTrades||0,wins:s.wins||0,losses:s.losses||0,totalPnL:s.totalPnL||0,
        bestTickers:s.bestTickers||[],timeStats:s.timeStats||{},featureStats:s.featureStats||BRAIN.featureStats,
        explosionPatterns:s.explosionPatterns||[],redFlagPatterns:s.redFlagPatterns||[],
        minScore:s.minScore||60,lessons:s.lessons||[],sectorMomentum:s.sectorMomentum||{},
        multiDayRunners:s.multiDayRunners||[],overnightWatchlist:s.overnightWatchlist||[],
      });
      console.log(`🧠 Brain loaded: ${BRAIN.totalTrades} trades | ${BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0):0}% WR | minScore:${BRAIN.minScore}`);
    }
  }catch(e){console.log("Brain load:",e.message);}

  // Load yesterday's movers
  try {
    const d=await supabase("bot_watchlist?label=eq.yesterday_movers_v15&order=created_at.desc&limit=1");
    if(Array.isArray(d)&&d[0]?.tickers){
      yesterdayMovers=d[0].tickers.split(",").filter(Boolean);
      // Multi-day runners: stocks that were yesterday's movers
      BRAIN.multiDayRunners=yesterdayMovers;
      console.log(`📋 Yesterday movers: ${yesterdayMovers.join(", ")}`);
    }
  }catch(_){}

  // Restore positions from TZ
  try {
    const positions=await tzGetPositions();
    // Restore ALL TZ positions — MAX_POSITIONS only gates new entries, not restoration
    // Without this, positions 11-14 get no stop-loss management
    const toRestore=positions; // restore everything TZ has
    for(const p of toRestore){
      if(!openTrades[p.symbol]){
        const entryPrice=parseFloat(p.avg_entry_price);
        if(entryPrice<=0) continue;
        openTrades[p.symbol]={
          entryPrice,qty:parseFloat(p.qty),peakPrice:parseFloat(p.current_price)||entryPrice,
          halfSold:false,quarterSold:false,scaled:false,score:60,
          stockType:"standard",sector:getSector(p.symbol),entryHour:new Date().getHours(),
          time:new Date(Date.now()-300000).toISOString(), // 5min ago so decay doesn't immediately fire
          reason:"Restored on startup",restored:true,
        };
        console.log(`📍 Restored: ${p.symbol} x${p.qty} @$${entryPrice} live:$${p.current_price}`);
      }
    }
    if(positions.length>CONFIG.MAX_POSITIONS)
      console.log(`⚠️ TZ has ${positions.length} positions (>${CONFIG.MAX_POSITIONS} max). All restored for stop management. No new entries until below ${CONFIG.MAX_POSITIONS}.`);
    if(Object.keys(openTrades).length>0)
      console.log(`🛡️ ${Object.keys(openTrades).length} positions under management`);
  }catch(e){console.log("Restore:",e.message);}
};

// ════════════════════════════════════════════════════════════════════════════
// OVERNIGHT STUDY MODE
// ════════════════════════════════════════════════════════════════════════════
const runOvernightStudy = async () => {
  // Only run once per calendar day ET — guard against 2hr timer firing multiple times
  const studyDate=getETTime().toISOString().split("T")[0];
  if(BRAIN.lastStudy&&BRAIN.lastStudy.startsWith(studyDate)){
    console.log(`🌙 Study already ran today (${studyDate}) — skipping`);return;
  }
  // Skip if no movers to study (e.g. weekend before market opens)
  if(!lastGainers.length){
    console.log("🌙 No movers to study yet — skipping (will run after first trading day)");
    return;
  }
  console.log("🌙 Starting overnight study...");
  try {
    // Study today's big movers (30 days back)
    const today=new Date().toISOString().split("T")[0];
    const month=new Date(Date.now()-30*86400000).toISOString().split("T")[0];

    // Get all stocks that ran 20%+ today from last gainers
    const todayMovers=lastGainers.filter(g=>g.pct>=20).map(g=>g.ticker);
    yesterdayMovers=todayMovers.slice(0,30);
    BRAIN.multiDayRunners=yesterdayMovers;

    // Save for tomorrow
    await supabase("bot_watchlist",{method:"POST",body:JSON.stringify({label:"yesterday_movers_v15",tickers:yesterdayMovers.join(","),ts:new Date().toISOString()})}).catch(()=>{});

    // Build overnight watchlist (top 20 candidates for tomorrow)
    const watchlist=[];
    for(const ticker of todayMovers.slice(0,30)){
      try {
        const[q,prof,news]=await Promise.all([
          finnhub(`/quote?symbol=${ticker}`),
          finnhub(`/stock/profile2?symbol=${ticker}`),
          finnhub(`/company-news?symbol=${ticker}&from=${today}&to=${today}`),
        ]);
        // Check for steady pre-market volume build (not a single spike)
        const snapshot=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=1Min&start=${new Date(Date.now()-4*3600000).toISOString()}&limit=240&feed=iex`).catch(()=>({bars:[]}));
        const bars=snapshot.bars||[];
        const vols=bars.map(b=>b.v||0);
        const steadyVol=vols.length>10&&vols.slice(-5).every((v,i)=>i===0||v>=vols[vols.length-6+i]*0.8);
        watchlist.push({
          ticker,price:q.c,pct:q.dp,float:prof?.shareOutstanding,
          hasCatalyst:(news||[]).length>0,steadyVol,sector:getSector(ticker),
        });
      }catch(_){}
      await new Promise(r=>setTimeout(r,200));
    }

    // Score and rank watchlist
    BRAIN.overnightWatchlist=watchlist.sort((a,b)=>{
      const scoreA=(a.steadyVol?2:0)+(a.hasCatalyst?2:0)+(parseFloat(a.float||99)<10?2:0);
      const scoreB=(b.steadyVol?2:0)+(b.hasCatalyst?2:0)+(parseFloat(b.float||99)<10?2:0);
      return scoreB-scoreA;
    }).slice(0,20);

    // Study daily charts for pattern learning
    console.log(`📚 Studying ${todayMovers.length} movers from today...`);
    for(const ticker of todayMovers.slice(0,15)){
      try {
        const daily=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=1Day&limit=30&feed=iex`);
        const bars=daily.bars||[];
        if(bars.length<5) continue;
        // Day before the big move — what did volume look like?
        const dayBefore=bars.slice(0,-1);
        const bigDay=bars[bars.length-1];
        const avgVolBefore=dayBefore.reduce((s,b)=>s+(b.v||0),0)/dayBefore.length;
        const volRatioOnDay=bigDay.v>0?bigDay.v/avgVolBefore:0;
        const prevConsol=dayBefore.slice(-3).every(b=>Math.abs(b.c-b.o)/b.o<0.03); // tight consolidation day before
        if(volRatioOnDay>5){
          BRAIN.explosionPatterns.push({
            floatM:parseFloat(await finnhub(`/stock/profile2?symbol=${ticker}`).then(p=>p.shareOutstanding||0).catch(()=>0)),
            relVol:volRatioOnDay,pct:((bigDay.c-bigDay.o)/bigDay.o)*100,
            sector:getSector(ticker),prevConsol,ts:Date.now(),
          });
        }
        // Study where most volume traded (POC analysis)
        const vp=calcVolumeProfile([...dayBefore.slice(-5),bigDay]);
        if(vp) console.log(`📊 ${ticker}: POC=$${vp.poc} bigDayVol=${(bigDay.v/1e6).toFixed(1)}M avgBefore=${(avgVolBefore/1e6).toFixed(1)}M ratio=${volRatioOnDay.toFixed(1)}x`);
      }catch(_){}
      await new Promise(r=>setTimeout(r,300));
    }

    BRAIN.explosionPatterns=BRAIN.explosionPatterns.slice(0,50);

    // Update sector momentum tracking
    BRAIN.sectorMomentum={};
    for(const ticker of todayMovers){
      const s=getSector(ticker);
      BRAIN.sectorMomentum[s]=(BRAIN.sectorMomentum[s]||0)+1;
    }

    // AI study summary
    if(BRAIN.overnightWatchlist.length>0){
      const prompt=`Study these stocks that ran big today and find common patterns:\n${todayMovers.slice(0,10).join(", ")}\n\nTop watchlist for tomorrow:\n${BRAIN.overnightWatchlist.slice(0,5).map(w=>`${w.ticker} float:${w.float}M catalyst:${w.hasCatalyst}`).join("\n")}\n\nWhat patterns predict tomorrow's big movers? Focus on volume and float.`;
      const study=await groq(prompt,300);
      if(study){BRAIN.lessons.unshift(`STUDY: ${study.slice(0,200)}`);BRAIN.lessons=BRAIN.lessons.slice(0,15);}
    }

    await saveBrainState();
    BRAIN.lastStudy=new Date().toISOString();
    console.log(`🌙 Study complete. Watchlist: ${BRAIN.overnightWatchlist.map(w=>w.ticker).join(", ")}`);
  }catch(e){console.log("Overnight study error:",e.message);}
};

// ════════════════════════════════════════════════════════════════════════════
// POSITION MANAGER
// ════════════════════════════════════════════════════════════════════════════
const managePositions = async (positions) => {
  if(!Array.isArray(positions)||!positions.length) return;

  for(const pos of positions){
    const sym=pos.symbol;

    const cur=parseFloat(pos.current_price);
    const state=openTrades[sym];
    if(!state) continue;
    if(!cur||cur<=0) continue;
    const entryPrice=state.entryPrice;
    if(!entryPrice||entryPrice<=0) continue;

    const qty=parseFloat(pos.qty);
    const pnlPct=((cur-entryPrice)/entryPrice)*100;
    if(cur>state.peakPrice) state.peakPrice=cur;
    const fromPeak=state.peakPrice>0?((cur-state.peakPrice)/state.peakPrice)*100:0;
    const pnlDollars=(cur-entryPrice)*qty;

    // Get fresh order flow for exit decisions
    const of=await getOrderFlow(sym).catch(()=>null);
    const chart=await getChartData(sym,cur).catch(()=>null);

    // Lightweight rescore (chart + OF only — saves ~4 API calls vs full analyzeCandidate)
    // Full rescore only every 5th cycle to stay within rate limits
    state._rescoreCount=(state._rescoreCount||0)+1;
    let currentScore=state.score||60;
    if(chart&&of){
      // Quick delta-based score adjustment (no full API fetch)
      let adj=0;
      if(chart.aboveVWAP&&of.deltaPositive) adj+=5;
      if(!chart.aboveVWAP&&!of.deltaPositive) adj-=10;
      if(chart.volIncreasing&&of.strongBuy) adj+=5;
      if(!chart.volIncreasing&&!of.deltaPositive) adj-=8;
      if(chart.hhhl1||chart.hhhl5) adj+=3; else adj-=5;
      currentScore=Math.max(0,Math.min(100,(state.score||60)+adj));
      state.score=currentScore;
    }

    // ── Score decay sells ──
    // Score decay: sell proportional amount based on score drop
    // Minimum 5 min hold before decay can fire (prevents instant exit on noisy rescore)
    const heldMinutes=state.time?(Date.now()-new Date(state.time).getTime())/60000:999;
    const needsDecay=currentScore<50&&heldMinutes>5;
    if(needsDecay){
      let sellPct=0;
      if(currentScore<25)      sellPct=1.0;
      else if(currentScore<35) sellPct=0.75;
      else if(currentScore<45) sellPct=0.50;
      else                     sellPct=0.25; // 45-49
      const sellQty=Math.floor(qty*sellPct);
      if(sellQty>=1){
        const r=await tzPlaceOrder(sym,"Sell",sellQty,cur);
        if(r.success){
          tradeLog.unshift({type:"SCORE_DECAY",symbol:sym,qty:sellQty,price:cur,score:currentScore,pct:pnlPct.toFixed(1),ts:new Date().toISOString()});
          console.log(`📉 ${sym} score decay ${currentScore} → sold ${(sellPct*100).toFixed(0)}%`);
          if(sellPct>=1){
            const t={symbol:sym,pnl:pnlDollars,pnlPct,entryPrice,exitPrice:cur,exitReason:"SCORE_DECAY",score:currentScore,stockType:state.stockType,sector:state.sector,entryHour:state.entryHour,float:state.float,relVol:state.relVol,news:state.news,scoreData:state.scoreData};
            await learnFromTrade(t); delete openTrades[sym]; continue;
          }
          continue; // partial decay sold — skip remaining exit checks this cycle
        }
      }
    }

    // ── Hard stop -15% ──
    if(pnlPct<=-CONFIG.HARD_STOP_PCT){
      // Fire and move on — don't block event loop with 30s sleeps
      // If first attempt fails, the next scan cycle will retry
      const r=await tzPlaceOrder(sym,"Sell",pos.qty,cur);
      const success=r.success;
      if(success){
        const t={symbol:sym,pnl:pnlDollars,pnlPct,entryPrice,exitPrice:cur,exitReason:"HARD_STOP",score:currentScore,stockType:state.stockType,sector:state.sector,entryHour:state.entryHour,float:state.float,relVol:state.relVol,news:state.news,scoreData:state.scoreData};
        tradeLog.unshift({...t,type:"STOP",ts:new Date().toISOString()});
        await learnFromTrade(t); delete openTrades[sym]; continue;
      }
    }

    // ── First target: +50% → sell 50% ──
    if(!state.halfSold&&pnlPct>=CONFIG.FIRST_TARGET_PCT){
      const hq=Math.floor(qty/2);
      if(hq>=1){
        const r=await tzPlaceOrder(sym,"Sell",hq,cur);
        if(r.success){
          state.halfSold=true;
          tradeLog.unshift({type:"PARTIAL_50",symbol:sym,qty:hq,price:cur,pnlPct:pnlPct.toFixed(1),ts:new Date().toISOString()});
          console.log(`🎯 ${sym} +${pnlPct.toFixed(0)}% — sold 50%`);
        }
      }
    }

    // ── Second target: +100% → sell 50% of remaining (25% of original) ──
    if(state.halfSold&&!state.quarterSold&&pnlPct>=CONFIG.SECOND_TARGET_PCT){
      const rq=Math.floor(qty/2);
      if(rq>=1){
        const r=await tzPlaceOrder(sym,"Sell",rq,cur);
        if(r.success){
          state.quarterSold=true;
          tradeLog.unshift({type:"PARTIAL_100",symbol:sym,qty:rq,price:cur,pnlPct:pnlPct.toFixed(1),ts:new Date().toISOString()});
          console.log(`🎯 ${sym} +${pnlPct.toFixed(0)}% — sold another 25%`);
        }
      }
    }

    // ── Trail stop: -15% from peak (after first target) ──
    if(state.halfSold&&fromPeak<=-CONFIG.TRAIL_STOP_PCT){
      const r=await tzPlaceOrder(sym,"Sell",pos.qty,cur);
      if(r.success){
        const t={symbol:sym,pnl:pnlDollars,pnlPct,entryPrice,exitPrice:cur,exitReason:"TRAIL_STOP",score:currentScore,stockType:state.stockType,sector:state.sector,entryHour:state.entryHour,float:state.float,relVol:state.relVol,news:state.news,scoreData:state.scoreData};
        tradeLog.unshift({...t,type:"TRAIL",ts:new Date().toISOString()});
        await learnFromTrade(t); delete openTrades[sym]; continue;
      }
    }

    // ── Gap fill tighten: -10% trail if at previous day high ──
    if(state.halfSold&&state.prevDayHigh&&cur>=state.prevDayHigh&&fromPeak<=-CONFIG.GAP_FILL_TRAIL_PCT){
      const r=await tzPlaceOrder(sym,"Sell",pos.qty,cur);
      if(r.success){
        const t={symbol:sym,pnl:pnlDollars,pnlPct,entryPrice,exitPrice:cur,exitReason:"GAP_FILL_TRAIL",score:currentScore,stockType:state.stockType,sector:state.sector,entryHour:state.entryHour};
        tradeLog.unshift({...t,type:"SELL",ts:new Date().toISOString()});
        await learnFromTrade(t); delete openTrades[sym]; continue;
      }
    }

    // ── Scale in at +25% if still strong ──
    if(!state.scaled&&pnlPct>=CONFIG.SCALE_IN_PCT&&currentScore>=70&&chart?.volIncreasing){
      try{
        const acc=await tzGetAccount();
        const cash=acc.cash||0;
        const addQty=Math.floor((cash*0.05)/cur);
        if(addQty>=1){
          const r=await tzPlaceOrder(sym,"Buy",addQty,cur);
          if(r.success){
            state.scaled=true;
            tradeLog.unshift({type:"SCALE_IN",symbol:sym,qty:addQty,price:cur,pnlPct:pnlPct.toFixed(1),ts:new Date().toISOString()});
            console.log(`📈 ${sym} +${pnlPct.toFixed(0)}% — scaled in ${addQty} shares`);
          }
        }
      }catch(_){}
    }

    // ── Momentum exits (after first target) ──
    if(state.halfSold){
      const volDead=!chart?.volIncreasing;
      const deltaFlipped=of&&!of.deltaPositive;
      const redCandles=chart&&!chart.greenRising;
      const tapeDead=of&&parseFloat(of.tapeSpeed)<0.5;
      if((volDead&&deltaFlipped)||(redCandles&&deltaFlipped)||tapeDead){
        const r=await tzPlaceOrder(sym,"Sell",pos.qty,cur);
        if(r.success){
          const t={symbol:sym,pnl:pnlDollars,pnlPct,entryPrice,exitPrice:cur,exitReason:"MOMENTUM_EXIT",score:currentScore,stockType:state.stockType,sector:state.sector,entryHour:state.entryHour};
          tradeLog.unshift({...t,type:"SELL",ts:new Date().toISOString()});
          await learnFromTrade(t); delete openTrades[sym]; continue;
        }
      }
    }

    console.log(`💰 ${sym}: $${cur.toFixed(4)} | ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}% | peak:$${state.peakPrice.toFixed(4)} | score:${currentScore}`);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// EOD SELL SWEEP (7:50 PM ET)
// ════════════════════════════════════════════════════════════════════════════
let eodDoneStamp="";
const runEODSweep = async (positions) => {
  const today=getETTime().toISOString().split("T")[0];
  if(eodDoneStamp===today) return;
  eodDoneStamp=today;
  console.log(`🌙 EOD SWEEP — ${positions.length} positions`);

  for(const pos of positions){
    const sym=pos.symbol,cur=parseFloat(pos.current_price),qty=parseFloat(pos.qty);
    const state=openTrades[sym];
    const entryPrice=state?.entryPrice||parseFloat(pos.avg_entry_price);
    const pnlPct=entryPrice>0?((cur-entryPrice)/entryPrice)*100:0;
    if(!cur||cur<=0){console.log(`🌙 ${sym}: no price — holding`);continue;}

    const chart=await getChartData(sym,cur).catch(()=>null);
    const score=state?.score||60;
    // Overnight hold: score≥70, aboveVWAP, volIncreasing, float<10M, within 10% of high
    const floatM=parseFloat(state?.float||99);
    const keepOvernight=score>=70&&chart?.aboveVWAP&&chart?.volIncreasing&&floatM<10&&pnlPct>0;

    if(keepOvernight){
      const hq=Math.floor(qty/2);
      if(hq>=1){
        const r=await tzPlaceOrder(sym,"Sell",hq,cur);
        if(r.success){
          if(state) state.overnightHold=true;
          tradeLog.unshift({type:"EOD_KEEP50",symbol:sym,qty:hq,price:cur,pnlPct:pnlPct.toFixed(1),ts:new Date().toISOString()});
          console.log(`🌙 KEEP ${sym}: score:${score} → sold 50%, riding overnight`);
        }
      }
    } else {
      const r=await tzPlaceOrder(sym,"Sell",pos.qty,cur);
      if(r.success){
        const t={symbol:sym,pnl:(cur-entryPrice)*qty,pnlPct,entryPrice,exitPrice:cur,exitReason:"EOD_SWEEP",score,stockType:state?.stockType,sector:state?.sector,entryHour:state?.entryHour};
        tradeLog.unshift({...t,type:"SELL",ts:new Date().toISOString()});
        await learnFromTrade(t); delete openTrades[sym];
        console.log(`🌙 SOLD ${sym}: ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}%`);
      }
    }
  }

  // Save today's movers for tomorrow and run study
  lastGainers=lastGainers.slice(0,30);
  await runOvernightStudy();
};

// ════════════════════════════════════════════════════════════════════════════
// MAIN AUTO TRADER
// ════════════════════════════════════════════════════════════════════════════
const autoTrade = async () => {
  lastScanTime=new Date().toISOString();
  const{isPre,isOpen,isAH,isStudy,noNewEntries,isOpeningWindow,sess,h,m,t}=getSession();

  try {
    // ── ALWAYS: manage held positions first — even during study/overnight ──
    const[positions,account]=await Promise.all([
      tzGetPositions().catch(()=>[]),
      tzGetAccount().catch(()=>null),
    ]);
    if(positions.length) await managePositions(positions);

    // Study mode: run overnight study, then return (no new entries)
    if(isStudy){
      console.log(`📚 Study mode [${sess}] — running overnight analysis`);
      await runOvernightStudy().catch(e=>console.log("Study err:",e.message));
      return;
    }

    // ── EOD sweep at 7:50 PM ──
    if(t>=CONFIG.EOD_SELL_HOUR*100+CONFIG.EOD_SELL_MIN&&t<2000&&positions.length){
      await runEODSweep(positions); return;
    }

    // ── No new entries after 7:45 PM ──
    if(noNewEntries){console.log(`⏸️ No new entries [${sess} ${h}:${String(m).padStart(2,"0")}]`);return;}

    // ── Opening window 9:30-9:35: scan only, wait for 2 candles ──
    if(isOpeningWindow){console.log("⏳ Opening window — scanning but waiting for 2 confirmed candles");
      // Still scan to build picture, don't enter yet
    }

    // ── Check cash floor ──
    const cash=account?.cash||0,equity=account?.equity||0;
    if(cash<Math.max(100,equity*CONFIG.CASH_FLOOR_PCT)){
      console.log(`💵 Cash floor — no new entries`);return;
    }

    // ── Scan universe ──
    const rawGainers=await scanUniverse();
    if(!rawGainers.length){console.log("⏭️ No movers found");return;}
    lastGainers=rawGainers.filter(g=>g.pct>=CONFIG.MIN_GAIN_PCT).slice(0,30);
    console.log(`📊 ${rawGainers.length} movers | Top: ${rawGainers.slice(0,5).map(g=>`${g.ticker}+${g.pct?.toFixed(0)}%`).join(", ")}`);

    // Update sector momentum
    BRAIN.sectorMomentum={};
    for(const g of rawGainers){
      const s=getSector(g.ticker);
      BRAIN.sectorMomentum[s]=(BRAIN.sectorMomentum[s]||0)+1;
    }

    // ── Score and filter candidates ──
    const owned=positions.map(p=>p.symbol);
    const candidates=rawGainers.filter(g=>!owned.includes(g.ticker)).slice(0,20);
    const analyzed=await Promise.all(
      candidates.map(g=>analyzeCandidate(g.ticker,g.price,g.pct,g.vol).catch(()=>null))
    );

    let qualified=analyzed.filter(s=>{
      if(!s) return false;
      // Must pass ALL entry filters
      if(s.price<CONFIG.MIN_PRICE||s.price>CONFIG.MAX_PRICE) return false;
      if(s.mktCapB&&s.mktCapB>CONFIG.MAX_MKT_CAP_B) return false;
      if(s.float&&parseFloat(s.float)>CONFIG.MAX_FLOAT_M) return false;
      if(isOpen&&s.price*s.vol<CONFIG.MIN_DOLLAR_VOL) return false; // dollar vol only regular hours
      if(s.pct<CONFIG.MIN_GAIN_PCT) return false;
      if(!s.chart?.hhhl1&&!s.chart?.hhhl5) return false; // must have HH+HL on at least one timeframe
      if(!s.chart?.aboveVWAP) return false;
      if(!s.of?.deltaPositive) return false; // must have positive delta
      // Spread check
      const spread=parseFloat(s.of?.spread||0);
      if(s.price<2&&spread>3) return false;
      if(s.price>=2&&spread>1.5) return false;
      return true;
    });

    if(!qualified.length){console.log("⏭️ No qualified candidates");return;}

    // Score sort
    qualified=qualified.sort((a,b)=>b.score-a.score);
    console.log(`🎯 Qualified: ${qualified.map(s=>`${s.ticker}=${s.score}`).slice(0,8).join(" ")}`);
    lastAnalysis=qualified.slice(0,5).map(s=>`${s.ticker}=$${s.price} +${s.pct?.toFixed(0)}% score:${s.score} [${s.details?.slice(0,50)||""}]`).join(" | ");

    // ── Opening window: need 2 green rising candles ──
    if(isOpeningWindow){
      qualified=qualified.filter(s=>s.chart?.greenRising);
      if(!qualified.length){console.log("⏳ Opening window: no stocks with 2 confirmed candles yet");return;}
    }

    // ── AI catalyst check on top 3 (Gemini) ──
    let geminiBoosts={};
    try {
      const top3=qualified.slice(0,3);
      const gPrompt=`Momentum trading analysis. For each stock, rate catalyst strength (STRONG/OK/WEAK):\n\n${top3.map(s=>`${s.ticker} +${s.pct?.toFixed(0)}% $${s.price} float:${s.float}M news:"${s.news?.topHeadline||"none"}"`).join("\n")}\n\nReply format: TICKER:STRONG or TICKER:OK or TICKER:WEAK`;
      const gOut=await gemini(gPrompt,200);
      if(gOut){
        for(const line of gOut.split("\n")){
          const m=line.match(/([A-Z]+):(STRONG|OK|WEAK)/);
          if(m) geminiBoosts[m[1]]={STRONG:10,OK:0,WEAK:-5}[m[2]]||0;
        }
      }
    }catch(_){}

    // Apply Gemini boosts
    qualified=qualified.map(s=>({...s,score:s.score+(geminiBoosts[s.ticker]||0)})).sort((a,b)=>b.score-a.score);

    // ── Determine entry threshold ──
    const threshold=isPre?CONFIG.PRE_MIN_SCORE:Math.max(CONFIG.MIN_SCORE,BRAIN.minScore);
    qualified=qualified.filter(s=>s.score>=threshold);
    if(!qualified.length){console.log(`⏭️ No stocks above threshold ${threshold}`);return;}

    // ── Position management: sell lowest if new stock is better ──
    if(positions.length>=CONFIG.MAX_POSITIONS){
      const lowestPos=positions.reduce((low,p)=>{
        const score=openTrades[p.symbol]?.score||0;
        return !low||(openTrades[p.symbol]?.score||0)<(openTrades[low.symbol]?.score||0)?p:low;
      },null);
      const topNew=qualified[0];
      if(lowestPos&&topNew&&topNew.score>=(openTrades[lowestPos.symbol]?.score||0)+10){
        console.log(`🔄 Replacing ${lowestPos.symbol}(score:${openTrades[lowestPos.symbol]?.score}) with ${topNew.ticker}(score:${topNew.score})`);
        const r=await tzPlaceOrder(lowestPos.symbol,"Sell",lowestPos.qty,parseFloat(lowestPos.current_price));
        if(r.success){
          const ep=parseFloat(lowestPos.avg_entry_price),cp=parseFloat(lowestPos.current_price);
          const pct=ep>0?((cp-ep)/ep)*100:0;
          const t={symbol:lowestPos.symbol,pnl:(cp-ep)*parseFloat(lowestPos.qty),pnlPct:pct,entryPrice:ep,exitPrice:cp,exitReason:"REPLACED",score:openTrades[lowestPos.symbol]?.score,stockType:openTrades[lowestPos.symbol]?.stockType,sector:openTrades[lowestPos.symbol]?.sector,entryHour:openTrades[lowestPos.symbol]?.entryHour};
          await learnFromTrade(t); delete openTrades[lowestPos.symbol];
          await new Promise(res=>setTimeout(res,1000));
        } else return; // if sell failed, don't buy
      } else {
        console.log(`🛑 Max positions — new candidates don't score 10+ above lowest`);
        return;
      }
    }

    // ── Buy top candidates ──
    const refreshedPositions=await tzGetPositions().catch(()=>positions);
    const refreshedOwned=refreshedPositions.map(p=>p.symbol);
    const slotsLeft=CONFIG.MAX_POSITIONS-refreshedPositions.length;

    for(const stock of qualified.slice(0,slotsLeft)){
      if(refreshedOwned.includes(stock.ticker)) continue;
      if(stock.score<threshold) continue;

      // Final 14-point pre-buy checklist
      if(!stock.chart?.hhhl1&&!stock.chart?.hhhl5){console.log(`🚫 ${stock.ticker}: no HH+HL`);continue;}
      if(!stock.chart?.aboveVWAP){console.log(`🚫 ${stock.ticker}: below VWAP`);continue;}
      if(!stock.of?.deltaPositive){console.log(`🚫 ${stock.ticker}: delta negative`);continue;}
      if(!stock.chart?.volIncreasing){console.log(`🚫 ${stock.ticker}: volume declining`);continue;}

      const qty=calcPositionSize(cash,stock.price,stock.float,stock.mktCapB,stock.pct||0);
      if(qty<1){console.log(`🚫 ${stock.ticker}: qty too small`);continue;}
      if(qty*stock.price>cash-equity*CONFIG.CASH_FLOOR_PCT){console.log(`🚫 ${stock.ticker}: would breach cash floor`);continue;}

      console.log(`🚀 BUY ${stock.ticker} x${qty} @$${stock.price} | score:${stock.score} | ${sess} | type:${stock.stockType}`);
      const order=await tzPlaceOrder(stock.ticker,"Buy",qty,stock.price);
      if(order.success){
        openTrades[stock.ticker]={
          entryPrice:stock.price,qty,peakPrice:stock.price,halfSold:false,quarterSold:false,scaled:false,
          score:stock.score,stockType:stock.stockType,sector:stock.sector,entryHour:h,
          float:stock.float,relVol:stock.relVol,news:stock.news,scoreData:stock.scoreData,
          prevDayHigh:null, // will be set from daily bars if available
          time:new Date().toISOString(), // for minimum hold time check
          reason:`score:${stock.score} ${stock.details?.slice(0,80)}`,
        };
        // Try to get prev day high for gap fill tracking
        try{
          const daily=await alpacaData(`/v2/stocks/${stock.ticker}/bars?timeframe=1Day&limit=2&feed=iex`);
          if(daily.bars?.length>=2) openTrades[stock.ticker].prevDayHigh=daily.bars[daily.bars.length-2].h;
        }catch(_){}

        tradeLog.unshift({type:"BUY",symbol:stock.ticker,qty,price:stock.price,score:stock.score,sector:stock.sector,stockType:stock.stockType,sess,ts:new Date().toISOString()});
        await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({symbol:stock.ticker,side:"LONG",qty,entry_price:stock.price,reason:`v15[score:${stock.score}|${stock.stockType}|${sess}]: ${stock.details?.slice(0,100)}`})}).catch(()=>{});
        console.log(`✅ Bought ${stock.ticker} | score:${stock.score} | ${stock.details?.slice(0,60)}`);
        refreshedOwned.push(stock.ticker);
      } else {
        console.log(`❌ Order failed ${stock.ticker}: ${order.orderStatus||order.error}`);
        await logError("order",`${stock.ticker}: ${JSON.stringify(order)}`);
      }
    }
  }catch(e){console.error("AutoTrade:",e.message);await logError("autoTrade",e);}
};

// ════════════════════════════════════════════════════════════════════════════
// SMART SCHEDULER
// ════════════════════════════════════════════════════════════════════════════
const scheduleNextScan = () => {
  if(!autoTraderActive) return;
  if(scanTimer){clearTimeout(scanTimer);}
  const ms=getScanInterval();
  scanTimer=setTimeout(async()=>{await autoTrade();scheduleNextScan();},ms);
  const{sess,h,m}=getSession();
  console.log(`⏰ Next scan in ${(ms/1000).toFixed(0)}s [${sess} ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")} ET]`);
};
const startAutoTrader = () => {
  if(autoTraderActive) return;
  autoTraderActive=true;
  console.log("🤖 AutoTrader STARTED — Momentum Scanner v15.9");
  autoTrade().then(()=>scheduleNextScan());
};
const stopAutoTrader = () => {
  if(scanTimer) clearTimeout(scanTimer);
  autoTraderActive=false; scanTimer=null;
  console.log("⏹️ AutoTrader stopped");
};

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/autotrader/start",(_,res)=>{startAutoTrader();res.json({status:"started"});});
app.get( "/api/autotrader/start",(_,res)=>{startAutoTrader();res.json({status:"started"});});
app.post("/api/autotrader/stop", (_,res)=>{stopAutoTrader(); res.json({status:"stopped"});});
app.post("/api/autotrader/scan", async(_,res)=>{res.json({message:"Scan triggered"});autoTrade();});

app.get("/api/autotrader/status", async(_,res)=>{
  const[positions,account]=await Promise.all([tzGetPositions().catch(()=>[]),tzGetAccount().catch(()=>null)]);
  const{sess}=getSession();
  const pnl=account?.pnl||0,eq=account?.equity||0;
  res.json({
    active:autoTraderActive,last_scan:lastScanTime,session:sess,broker:"TradeZero",version:"15.9.0",
    open_positions:positions.length,max_positions:CONFIG.MAX_POSITIONS,slots_left:Math.max(0,CONFIG.MAX_POSITIONS-positions.length),
    equity:account?account.equity.toFixed(2):"—",cash:account?account.cash.toFixed(2):"—",
    today_pnl:pnl.toFixed(2),today_pnl_pct:eq>0?((pnl/eq)*100).toFixed(2)+"%":"0.00%",
    config:{max_positions:CONFIG.MAX_POSITIONS,cash_floor:(CONFIG.CASH_FLOOR_PCT*100)+"%",first_target:CONFIG.FIRST_TARGET_PCT+"%",second_target:CONFIG.SECOND_TARGET_PCT+"%",trail_stop:CONFIG.TRAIL_STOP_PCT+"%",hard_stop:CONFIG.HARD_STOP_PCT+"%",min_score:BRAIN.minScore,no_entry_after:"7:45PM ET",eod_sweep:"7:50PM ET"},
    scanner:{universe_size:MASTER_UNIVERSE.length,sources:["Alpaca","Finnhub","AlphaVantage"],av_calls_today:RATE.av.calls,alpaca_calls_min:RATE.alpaca.calls,finnhub_calls_min:RATE.finnhub.calls},
    brain:{total_trades:BRAIN.totalTrades,wins:BRAIN.wins,losses:BRAIN.losses,win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"0%",total_pnl:(BRAIN.totalPnL||0).toFixed(2),min_score:BRAIN.minScore,lessons:BRAIN.lessons.slice(0,5),explosion_patterns:BRAIN.explosionPatterns.length,red_flag_patterns:BRAIN.redFlagPatterns.length,overnight_watchlist:BRAIN.overnightWatchlist.map(w=>w.ticker),multi_day_runners:BRAIN.multiDayRunners,sector_momentum:BRAIN.sectorMomentum,last_study:BRAIN.lastStudy},
    recent_trades:tradeLog.slice(0,20),last_gainers:lastGainers.slice(0,20),last_analysis:lastAnalysis,
    held_positions:Object.entries(openTrades).map(([sym,s])=>({symbol:sym,entry:s.entryPrice,peak:s.peakPrice,score:s.score,type:s.stockType,halfSold:s.halfSold})),
  });
});


app.post("/api/autotrader/sellall",async(_,res)=>{try{const n=await tzSellAll();res.json({message:`Sold ${n} positions`});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/alerts",(_,res)=>res.json({alerts:[]}));

app.post("/api/chat", async(req,res)=>{
  const{messages}=req.body; if(!messages?.length) return res.status(400).json({error:"No messages"});
  try{
    const userMsg=messages[messages.length-1]?.content||"";

    // Store in memory
    chatMemory.push({role:"user",content:userMsg,ts:Date.now()});
    if(chatMemory.length>60) chatMemory.splice(0,2);

    // ── Get live context ──────────────────────────────────────────────────
    const[acc,pos]=await Promise.all([tzGetAccount().catch(()=>null),tzGetPositions().catch(()=>[])]);
    const posStr=pos.map(p=>{
      const entry=parseFloat(p.avg_entry_price),cur=parseFloat(p.current_price),qty=parseFloat(p.qty);
      const pnlPct=entry>0?((cur-entry)/entry*100).toFixed(1):"?";
      return `${p.symbol}:${qty}sh@$${entry.toFixed(2)}→$${cur.toFixed(2)}(${pnlPct}%)`;
    }).join(", ");
    const ctx=`Bot:${autoTraderActive?"RUNNING":"PAUSED"}|${getSession().sess}|Equity:$${acc?.equity?.toFixed(0)||"?"}|Cash:$${acc?.cash?.toFixed(0)||"?"}|PnL:$${acc?.pnl?.toFixed(0)||"?"}|${BRAIN.totalTrades}T|${BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0):0}%WR|minScore:${BRAIN.minScore}|Positions:[${posStr||"none"}]|TopMovers:${lastGainers.slice(0,5).map(g=>`${g.ticker}+${(g.pct||0).toFixed(0)}%@$${g.price}`).join(",")||"none"}|Lessons:${BRAIN.lessons.slice(0,2).join(" / ")||"none"}`;

    // ── Send to Groq to understand intent ─────────────────────────────────
    const recentMemory=chatMemory.slice(-20).map(m=>({role:m.role,content:m.content}));
    const systemPrompt=`You are PulseTrader — an elite momentum trading AI and the user's personal trading partner. You have live access to their TradeZero paper trading account and can execute real trades right now.

LIVE ACCOUNT CONTEXT (real-time):
${ctx}

YOUR PERSONALITY:
- Sharp prop trader at a desk — direct, decisive, zero fluff
- Use trader language: float, catalyst, rip, flush, gap, tape, HOD, VWAP, float rotation
- Remember this entire conversation and the user's trading style
- User style: low float momentum, fresh catalysts, scale out into strength, cut losers fast

YOUR CAPABILITIES (you can execute these right now):
- Sell or buy any stock in their TradeZero account
- Full ticker analysis: chart, order flow, score, news, P&L
- Show all positions with live P&L and risk flags
- Show top movers from last scan
- Start or stop the bot scanner
- Sell everything at once

TRADEZERO POSITION DATA:
- avg_entry_price = cost basis | current_price = live Finnhub price
- qty = shares held | side = long or short
- P&L for longs = (current - entry) * qty
- Hard stop = -15% from entry | First target = +50% from entry
- Positions shown as: SYMBOL:QTYsh@$ENTRY→$CURRENT(PNL%)

INTENT DETECTION — add EXECUTE_ command on its own line at the very end when user clearly wants action:
- Sell a stock: "get me out of X" / "sell X" / "close X" / "dump X" → EXECUTE_SELL:SYMBOL
- Buy a stock: "buy X" / "get into X" / "grab some X" → EXECUTE_BUY:SYMBOL:QTY(optional)
- Sell everything: "sell all" / "close everything" / "get flat" / "nuke it" → EXECUTE_SELLALL
- Analyze ticker: "analyze X" / "what's X doing" / "check X" / "dd X" → EXECUTE_ANALYZE:SYMBOL
- Show positions: "what do I have" / "my positions" / "show holdings" → EXECUTE_POSITIONS
- Show movers: "what's moving" / "top movers" / "what's hot" → EXECUTE_MOVERS
- Account status: "status" / "how's the bot" / "equity" / "how am I doing" → EXECUTE_STATUS
- Stop bot: "stop" / "pause the bot" / "stop trading" → EXECUTE_STOPBOT
- Start bot: "start" / "resume" / "kick it on" → EXECUTE_STARTBOT

RULES:
- Only add EXECUTE_ when action is clearly intended
- Conversation, strategy talk, market questions = respond naturally, NO EXECUTE_
- EXECUTE_ must be the very last line, nothing after it
- Never trigger trades on vague questions

You are watching the same screen as the user. Be their edge.\`;const groqMessages=[
      {role:"system",content:systemPrompt},
      ...recentMemory.slice(0,-1),
      {role:"user",content:userMsg}
    ];

    const aiReply=await groq(groqMessages,900);
    if(!aiReply) return res.json({reply:"Sorry, AI unavailable right now."});

    // ── Parse intent from Groq response ──────────────────────────────────
    const lines=aiReply.split("\n");
    const execLine=lines.find(l=>l.trim().startsWith("EXECUTE_"));
    const displayReply=lines.filter(l=>!l.trim().startsWith("EXECUTE_")).join("\n").trim();

    let actionResult="";

    if(execLine){
      const cmd=execLine.trim();

      // SELL specific stock
      if(cmd.startsWith("EXECUTE_SELL:")){
        const sym=cmd.split(":")[1]?.trim().toUpperCase();
        if(sym){
          const p=pos.find(x=>x.symbol===sym);
          if(p){
            const cur=parseFloat(p.current_price);
            const r=await tzPlaceOrder(sym,"Sell",p.qty,cur);
            if(r.success){
              const entry=openTrades[sym]?.entryPrice||parseFloat(p.avg_entry_price);
              const pnlPct=entry>0?((cur-entry)/entry*100).toFixed(1):"?";
              delete openTrades[sym];
              actionResult=`\n\n✅ Done — sold ${sym} x${p.qty} @$${cur.toFixed(2)} | P&L: ${pnlPct}%`;
            } else {
              actionResult=`\n\n❌ Order failed: ${r.orderStatus||r.error}`;
            }
          } else {
            actionResult=`\n\n❌ No position in ${sym}`;
          }
        }
      }

      // SELL ALL
      else if(cmd.startsWith("EXECUTE_SELLALL")){
        const n=await tzSellAll();
        Object.keys(openTrades).forEach(s=>delete openTrades[s]);
        actionResult=`\n\n🔴 Sold all ${n} positions.`;
      }

      // BUY
      else if(cmd.startsWith("EXECUTE_BUY:")){
        const parts=cmd.split(":");
        const sym=(parts[1]||"").trim().toUpperCase();
        const qty=parseInt(parts[2]||0);
        if(sym){
          const q=await finnhub(`/quote?symbol=${sym}`).catch(()=>null);
          const price=q?.c||0;
          if(price){
            const buyQty=qty>0?qty:calcPositionSize(acc?.cash||100000,price,30,1,0);
            const r=await tzPlaceOrder(sym,"Buy",buyQty,price);
            if(r.success){
              openTrades[sym]={entryPrice:price,qty:buyQty,peakPrice:price,halfSold:false,quarterSold:false,scaled:false,score:60,stockType:"manual",sector:getSector(sym),entryHour:getSession().h,time:new Date().toISOString(),reason:"Chat order"};
              actionResult=`\n\n✅ Bought ${sym} x${buyQty} @$${price.toFixed(2)}`;
            } else {
              actionResult=`\n\n❌ Order failed: ${r.orderStatus||r.error}`;
            }
          } else {
            actionResult=`\n\n❌ Can't get price for ${sym}`;
          }
        }
      }

      // ANALYZE
      else if(cmd.startsWith("EXECUTE_ANALYZE:")){
        const sym=cmd.split(":")[1]?.trim().toUpperCase();
        if(sym){
          try{
            const[q,prof,newsR,chart,of]=await Promise.all([
              finnhub(`/quote?symbol=${sym}`),
              finnhub(`/stock/profile2?symbol=${sym}`),
              finnhub(`/company-news?symbol=${sym}&from=${new Date(Date.now()-7*86400000).toISOString().split("T")[0]}&to=${new Date().toISOString().split("T")[0]}`),
              getChartData(sym,0).catch(()=>null),
              getOrderFlow(sym).catch(()=>null),
            ]);
            const price=q.c||0,pct=q.dp||0;
            const float=prof?.shareOutstanding;
            const newsItems=Array.isArray(newsR)?newsR:[];
            const topNews=newsItems[0]?.headline||"none";
            const ageH=newsItems[0]?((Date.now()-newsItems[0].datetime*1000)/3600000).toFixed(0):"?";
            const scoreResult=await analyzeCandidate(sym,price,pct,q.v||0).catch(()=>null);
            const myPos=pos.find(p=>p.symbol===sym);
            let analysis=`\n\n📊 ${sym} LIVE DATA:\n`;
            analysis+=`$${price.toFixed(2)} (${pct>=0?"+":""}${pct.toFixed(1)}%) | Float: ${float?float.toFixed(1)+"M":"?"} \n`;
            analysis+=`News: ${topNews.slice(0,80)} (${ageH}h ago)\n`;
            if(chart) analysis+=`VWAP: $${chart.vwap?.toFixed(2)} ${price>=chart.vwap?"✅above":"❌below"} | Vol: ${chart.volIncreasing?"📈":"📉"} | HH+HL: ${(chart.hhhl1||chart.hhhl5)?"✅":"❌"}\n`;
            if(of) analysis+=`Buy%: ${of.buyPct}% | Delta: ${of.delta>0?"+":""}${of.delta} | Spread: ${of.spread}%\n`;
            if(scoreResult) analysis+=`Bot Score: ${scoreResult.score}/100 ${scoreResult.score>=BRAIN.minScore?"✅ QUALIFIES":"❌ below threshold"}\n`;
            if(myPos){
              const entry=parseFloat(myPos.avg_entry_price),qty=parseFloat(myPos.qty);
              const pnlPct=entry>0?((price-entry)/entry*100):0;
              analysis+=`Your position: ${qty}sh @$${entry.toFixed(2)} | ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}% | Stop: $${(entry*0.85).toFixed(2)}`;
            }
            actionResult=analysis;
          }catch(e){actionResult=`\n\n❌ Analysis error: ${e.message}`;}
        }
      }

      // POSITIONS
      else if(cmd.startsWith("EXECUTE_POSITIONS")){
        if(!pos.length){actionResult="\n\n📊 No open positions.";}
        else{
          const lines=pos.map(p=>{
            const entry=parseFloat(p.avg_entry_price),cur=parseFloat(p.current_price),qty=parseFloat(p.qty);
            const pnlPct=entry>0?((cur-entry)/entry*100):0;
            const pnlDollar=(cur-entry)*qty;
            
            const flag=pnlPct<=-14?"🚨":pnlPct<=-10?"⚠️":pnlPct>=50?"🎯":pnlPct>=20?"✅":"";
            return `${flag}${p.symbol}: ${qty}sh @$${entry.toFixed(2)}→$${cur.toFixed(2)} ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}% ($${pnlDollar>=0?"+":""}${pnlDollar.toFixed(0)})`;
          });
          actionResult=`\n\n📊 POSITIONS (${pos.length}):\n${lines.join("\n")}`;
        }
      }

      // MOVERS
      else if(cmd.startsWith("EXECUTE_MOVERS")){
        const top=lastGainers.slice(0,8);
        if(top.length) actionResult=`\n\n🔥 TOP MOVERS:\n${top.map((g,i)=>`${i+1}. ${g.ticker} +${(g.pct||0).toFixed(1)}% @$${g.price}`).join("\n")}`;
        else actionResult="\n\n🔍 No movers scanned yet.";
      }

      // STATUS
      else if(cmd.startsWith("EXECUTE_STATUS")){
        if(acc) actionResult=`\n\n📊 ${autoTraderActive?"🟢 RUNNING":"🔴 PAUSED"} | ${getSession().sess}\nEquity: $${acc.equity.toFixed(2)} | Cash: $${acc.cash.toFixed(2)}\nP&L: ${acc.pnl>=0?"+":""}$${acc.pnl.toFixed(2)}\nPositions: ${pos.length}/${CONFIG.MAX_POSITIONS} | WR: ${BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0):0}%`;
      }

      // STOP BOT
      else if(cmd.startsWith("EXECUTE_STOPBOT")){
        stopAutoTrader();
        actionResult="\n\n⏹️ Bot paused.";
      }

      // START BOT
      else if(cmd.startsWith("EXECUTE_STARTBOT")){
        startAutoTrader();
        actionResult="\n\n🟢 Bot started.";
      }
    }

    const finalReply=(displayReply+actionResult).trim();
    chatMemory.push({role:"assistant",content:finalReply,ts:Date.now()});
    res.json({reply:finalReply});

  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/movers", async(req,res)=>{
  try{
    const raw=await scanUniverse();
    lastGainers=raw.slice(0,30);
    const top=raw.slice(0,15);
    const enriched=await Promise.all(top.map(async g=>{
      try{
        const[prof,news]=await Promise.all([finnhub(`/stock/profile2?symbol=${g.ticker}`),finnhub(`/company-news?symbol=${g.ticker}&from=${new Date(Date.now()-3*86400000).toISOString().split("T")[0]}&to=${new Date().toISOString().split("T")[0]}`)]);
        const topNews=Array.isArray(news)?news.slice(0,2).map(n=>({headline:n.headline,source:n.source})):[];
        const vf=g.vol>=1e6?(g.vol/1e6).toFixed(1)+"M":g.vol>=1e3?(g.vol/1e3).toFixed(0)+"K":String(g.vol||0);
        return{symbol:g.ticker,name:prof?.name||g.ticker,price:g.price?.toFixed(4),change_pct:g.pct?.toFixed(2),volume:g.vol,volume_fmt:vf,float:prof?.shareOutstanding,mkt_cap:prof?.marketCapitalization,sector:getSector(g.ticker),news:topNews,catalyst:topNews[0]?.headline||null};
      }catch(_){return{symbol:g.ticker,name:g.ticker,price:g.price?.toFixed(4),change_pct:g.pct?.toFixed(2),volume:g.vol,volume_fmt:String(g.vol||0),sector:getSector(g.ticker),news:[],catalyst:null};}
    }));
    let analysis="";
    try{const t5=enriched.slice(0,5).map(g=>`${g.symbol}(${g.name}) $${g.price} +${g.change_pct}% float:${g.float}M sector:${g.sector} | ${g.catalyst||"no catalyst"}`).join("\n");analysis=await groq(`Top momentum movers analysis:\n${t5}\n\nFor each: entry signal? float rotation? volume profile? Best pick and why:`,500);}catch(_){}
    res.json({gainers:enriched,analysis,scanned:raw.length,session:getSession().sess,brain_score_threshold:BRAIN.minScore,ts:new Date().toISOString()});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/holdings",async(_,res)=>{
  try{
    const positions=await tzGetPositions();
    if(!positions.length) return res.json({holdings:[],total_value:"0.00",total_pnl:"0.00",count:0});
    const holdings=positions.map(p=>{
      const cur=parseFloat(p.current_price),entry=parseFloat(p.avg_entry_price),qty=parseFloat(p.qty);
      const unrlPnl=entry>0?(cur-entry)*qty:0;
      const unrlPct=entry>0?((cur-entry)/entry)*100:0;
      const s=openTrades[p.symbol];
      const safeUnrlPct=isNaN(unrlPct)?0:unrlPct;
      return {symbol:p.symbol,qty,side:p.side,avg_entry:entry.toFixed(4),current_price:cur.toFixed(4),market_value:(qty*cur).toFixed(2),unrealized_pnl:unrlPnl.toFixed(2),unrealized_pnl_pct:safeUnrlPct.toFixed(2)+"%",score:s?.score||"?",stock_type:s?.stockType||"?",sector:s?.sector||"?",half_sold:s?.halfSold||false,quarter_sold:s?.quarterSold||false,scaled:s?.scaled||false,peak:s?.peakPrice?.toFixed(4)||"?",first_target:(entry*(1+CONFIG.FIRST_TARGET_PCT/100)).toFixed(4),hard_stop:(entry*(1-CONFIG.HARD_STOP_PCT/100)).toFixed(4)};
    });
    const acc=await tzGetAccount().catch(()=>null);
    res.json({holdings,total_value:holdings.reduce((s,h)=>s+parseFloat(h.market_value),0).toFixed(2),total_pnl:holdings.reduce((s,h)=>s+parseFloat(h.unrealized_pnl),0).toFixed(2),total_pnl_today:acc?(acc.pnl||0).toFixed(2):"0.00",count:holdings.length,broker:"TradeZero"});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/account",async(_,res)=>{
  try{const acc=await tzGetAccount();const pnl=acc.pnl||0,eq=acc.equity||0;res.json({equity:acc.equity.toFixed(2),cash:acc.cash.toFixed(2),pnl_today:pnl.toFixed(2),pnl_today_pct:eq>0?((pnl/eq)*100).toFixed(2)+"%":"0.00%",buying_power:acc.cash.toFixed(2),broker:"TradeZero",paper:true});}catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/quote",async(req,res)=>{
  const{ticker="SPY"}=req.query;
  try{const[q,p]=await Promise.all([finnhub(`/quote?symbol=${ticker.toUpperCase()}`),finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`)]);res.json({ticker,price:q.c,change:q.d,pct:q.dp,high:q.h,low:q.l,open:q.o,prev:q.pc,name:p.name,float:p.shareOutstanding,sector:getSector(ticker.toUpperCase())});}catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/bars",async(req,res)=>{
  const{ticker="SPY",timeframe="1Min",limit=100}=req.query;
  try{const d=await alpacaData(`/v2/stocks/${ticker.toUpperCase()}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`);res.json({ticker:ticker.toUpperCase(),bars:d.bars||[]});}catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/orderflow/:ticker",async(req,res)=>{
  try{const ticker=req.params.ticker.toUpperCase();const of=await getOrderFlow(ticker);const q=await finnhub(`/quote?symbol=${ticker}`);res.json({ticker,price:q.c,pct:q.dp,orderFlow:of,ts:new Date().toISOString()});}catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/pnl",async(_,res)=>{
  try{
    const trades=await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    if(!Array.isArray(trades)) return res.status(500).json({error:"DB error"});
    const closed=trades.filter(t=>t.pnl!=null),total=closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0),winners=closed.filter(t=>parseFloat(t.pnl)>0).length;
    res.json({summary:{total_pnl:total.toFixed(2),win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",total_trades:trades.length,closed:closed.length,open:trades.filter(t=>t.pnl==null).length,winners,losers:closed.length-winners},recent:trades.slice(0,20)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/trades",async(_,res)=>{try{res.json(await supabase("pulsetrader_trades?order=created_at.desc&limit=500").then(d=>Array.isArray(d)?d:[]));}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/order",async(req,res)=>{const{symbol,side,qty,price}=req.body;if(!symbol||!side||!qty)return res.status(400).json({error:"symbol,side,qty required"});try{const action=side.toLowerCase()==="buy"?"Buy":"Sell";const r=await tzPlaceOrder(symbol.toUpperCase(),action,parseInt(qty),price?parseFloat(price):null);res.json({success:r.success,order:r});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/trade",async(req,res)=>{const{symbol,side,qty,entry_price,exit_price,reason}=req.body;if(!symbol||!side||!qty||!entry_price)return res.status(400).json({error:"required"});let pnl=null,pnl_pct=null;if(exit_price){pnl=((+exit_price-+entry_price)*+qty).toFixed(2);pnl_pct=(((+exit_price-+entry_price)/+entry_price)*100).toFixed(2);}try{const r=await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({symbol:symbol.toUpperCase(),side,qty:+qty,entry_price:+entry_price,exit_price:exit_price?+exit_price:null,pnl:pnl?+pnl:null,pnl_pct:pnl_pct?+pnl_pct:null,reason:reason||null})});res.json({success:true,trade:Array.isArray(r)?r[0]:r});}catch(e){res.status(500).json({error:e.message});}});
app.delete("/api/trade/:id",async(req,res)=>{try{await supabase(`pulsetrader_trades?id=eq.${req.params.id}`,{method:"DELETE"});res.json({success:true});}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/news",async(req,res)=>{
  const{ticker}=req.query;
  try{const today=new Date().toISOString().split("T")[0],week=new Date(Date.now()-7*86400000).toISOString().split("T")[0];const news=ticker?await finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`):await finnhub("/news?category=general");res.json((Array.isArray(news)?news:[]).slice(0,20).map(n=>({headline:n.headline,source:n.source,url:n.url,datetime:n.datetime})));}catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/autotrader/brain",(_,res)=>res.json({...BRAIN,master_universe_size:MASTER_UNIVERSE.length}));
app.get("/api/autotrader/gainers",(_,res)=>res.json({gainers:lastGainers,ts:lastScanTime}));
app.get("/api/orders",async(req,res)=>{try{const d=await tzAPI("GET",`/v1/api/accounts/${TZ_ACC()}/orders`);res.json(Array.isArray(d.orders||d.data||d)?d.orders||d.data||d:[]);}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/dashboard",async(req,res)=>{
  try{
    const[account,positions,trades]=await Promise.all([tzGetAccount().catch(()=>null),tzGetPositions().catch(()=>[]),supabase("pulsetrader_trades?order=created_at.desc&limit=100").catch(()=>[])]);
    const t=Array.isArray(trades)?trades:[],closed=t.filter(x=>x.pnl!=null),total=closed.reduce((s,x)=>s+parseFloat(x.pnl||0),0),winners=closed.filter(x=>parseFloat(x.pnl)>0).length;
    res.json({account:account?{equity:account.equity.toFixed(2),cash:account.cash.toFixed(2),pnl_today:account.pnl.toFixed(2)}:null,auto_trader:{active:autoTraderActive,session:getSession().sess,last_scan:lastScanTime,brain_score:BRAIN.minScore},brain:{win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"0%",total_trades:BRAIN.totalTrades,total_pnl:(BRAIN.totalPnL||0).toFixed(2),lessons:BRAIN.lessons.slice(0,3),watchlist:BRAIN.overnightWatchlist.slice(0,5).map(w=>w.ticker)},holdings:positions.map(p=>({symbol:p.symbol,qty:parseFloat(p.qty),current_price:parseFloat(p.current_price).toFixed(4),unrealized_pnl:parseFloat(p.unrealized_pl).toFixed(2),score:openTrades[p.symbol]?.score||"?"})),trade_summary:{total_pnl:total.toFixed(2),win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",total_trades:t.length}});
  }catch(e){res.status(500).json({error:e.message});}
});

// Debug
app.get("/api/debug/positions",async(_,res)=>{try{const raw=await tzAPI("GET",`/v1/api/accounts/${TZ_ACC()}/positions`);const list=Array.isArray(raw)?raw:(raw.positions||raw.data||[]);res.json({raw_keys:Object.keys(raw||{}),count:list.length,first:list[0]||null,first_keys:list[0]?Object.keys(list[0]):[]});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/debug/account",async(_,res)=>{try{const raw=await tzAPI("GET",`/v1/api/accounts/${TZ_ACC()}/pnl`);res.json({raw,keys:Object.keys(raw||{})});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/debug/study",(_,res)=>res.json({lastStudy:BRAIN.lastStudy,watchlist:BRAIN.overnightWatchlist,multiDayRunners:BRAIN.multiDayRunners,explosionPatterns:BRAIN.explosionPatterns.length,redFlagPatterns:BRAIN.redFlagPatterns.length,sectorMomentum:BRAIN.sectorMomentum,lastGainersCount:lastGainers.length}));
app.get("/api/debug/score/:ticker",async(req,res)=>{
  try{
    const ticker=req.params.ticker.toUpperCase();
    const q=await finnhub(`/quote?symbol=${ticker}`);
    const result=await analyzeCandidate(ticker,q.c,q.dp,q.v);
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/sparks",async(req,res)=>{
  try{const{tickers=""}=req.query;const list=tickers.split(",").map(t=>t.trim().toUpperCase()).filter(Boolean).slice(0,20);if(!list.length)return res.json({});const etStart=new Date(getETTime());etStart.setUTCHours(8);const results={};await Promise.all(list.map(async t=>{try{const d=await alpacaData(`/v2/stocks/${t}/bars?timeframe=1Min&start=${etStart.toISOString()}&feed=iex&limit=480`);const bars=d.bars||[];if(!bars.length){results[t]={closes:[],vols:[],pctFromOpen:0};return;}const open=bars[0].o,cur=bars[bars.length-1].c;results[t]={closes:bars.map(b=>b.c),vols:bars.map(b=>b.v||0),open,current:cur,pctFromOpen:open>0?parseFloat(((cur-open)/open*100).toFixed(2)):0};}catch(_){results[t]={closes:[],vols:[],pctFromOpen:0};}}));res.json(results);}catch(e){res.status(500).json({error:e.message});}
});

app.get("/health",(_,res)=>res.json({status:"ok",version:"15.9.0",strategy:"Momentum Scanner — 1000 tickers | Float-adjusted | 24/7",broker:"TradeZero",auto_trader:autoTraderActive,brain_trades:BRAIN.totalTrades,min_score:BRAIN.minScore,universe:MASTER_UNIVERSE.length,session:getSession().sess,ts:new Date().toISOString()}));

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════
const PORT=process.env.PORT||3001;
app.listen(PORT, async()=>{
  console.log(`⚡ PulseTrader v15.9 on port ${PORT}`);
  console.log(`   Strategy  : Momentum Scanner — pure volume/float/score`);
  console.log(`   Universe  : ${MASTER_UNIVERSE.length} tickers | 10 sectors`);
  console.log(`   Trading   : 4:00 AM - 7:45 PM ET | No entries after 7:45`);
  console.log(`   EOD Sweep : 7:50 PM ET`);
  console.log(`   Study Mode: 7:50 PM - 3:59 AM ET (every 2hr)`);
  console.log(`   Targets   : +50% sell 50% | +100% sell 25% | Trail -15%`);
  console.log(`   Sizing    : Float-adjusted (8%/10%/12%) + hard caps`);
  console.log(`   Orders    : All marketable limit (buy@ask sell@bid)`);
  console.log(`   Rate Limits: Alpaca ${CONFIG.ALPACA_MAX_PER_MIN}/min | Finnhub ${CONFIG.FINNHUB_MAX_PER_MIN}/min | AV ${CONFIG.AV_MAX_PER_DAY}/day`);
  console.log(`   Keys      : AV:${!!process.env.ALPHAVANTAGE_KEY} Gemini:${!!process.env.GEMINI_KEY} Groq:${!!process.env.GROQ_API_KEY} TZ:${!!process.env.TZ_API_KEY}`);
  await loadBrain();
  console.log("🤖 Starting Momentum Scanner v15.9...");
  startAutoTrader();
});
