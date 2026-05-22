// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PULSETRADER v11.0 — FINAL BUILD                                       ║
// ║  Kev's 6 Setups + Early Spike + Order Flow + Smart Sessions            ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import express from "express";
import cors    from "cors";
import fetch   from "node-fetch";
import crypto  from "crypto";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ── AUTH ─────────────────────────────────────────────────────────────────────
const sessions = new Map();
const createToken = () => crypto.randomBytes(32).toString("hex");
const isValidToken = (t) => {
  if (!t || !sessions.has(t)) return false;
  if (Date.now() > sessions.get(t)) { sessions.delete(t); return false; }
  return true;
};
const requireAuth = (req, res, next) => {
  const token = req.headers["x-auth-token"] || req.query._token;
  if (!isValidToken(token)) return res.status(401).json({ error: "Unauthorized" });
  next();
};
app.post("/api/auth", (req, res) => {
  const { passcode } = req.body;
  if (passcode !== (process.env.PASSCODE || "pulse2024")) return res.status(403).json({ error: "Wrong passcode." });
  const token = createToken(), expires = Date.now() + 24 * 60 * 60 * 1000;
  sessions.set(token, expires);
  for (const [t, exp] of sessions) { if (Date.now() > exp) sessions.delete(t); }
  res.json({ token, expires });
});
app.get("/api/ping", (_, res) => res.json({ ok: true }));
app.use("/api", requireAuth);

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  EARLY_POSITION_PCT:   0.10,
  FULL_POSITION_PCT:    0.20,
  MIN_POSITION_USD:     100,
  EARLY_VOL_MIN:        3,
  EARLY_VOL_MAX:        7,
  CONFIRMED_VOL_MIN:    7,
  EXTENDED_VOL:         15,
  EXTENDED_PCT:         40,
  EARLY_BUY_PCT:        60,
  CONFIRMED_BUY_PCT:    52,
  LOSER_BUY_PCT:        55,
  LOSER_DOWN_PCT:       20,
  FLOAT_ROTATION_MIN:   5,
  EARLY_CONVICTION:     9,
  CONFIRMED_CONVICTION: 7,
  LOSER_CONVICTION:     8,
  EARLY_OF_SCORE:       3,
  CONFIRMED_OF_SCORE:   2,
  FIRST_TARGET_PCT:     30,
  TRAIL_STOP_PCT:       10,
  HARD_STOP_PCT:        15,
  VOLUME_DRY_REDUCE:    0.50,
  FOOTPRINT_EXIT_HIGH:  65,
  FOOTPRINT_EXIT_LOW:   52,
  FOOTPRINT_HARD_EXIT:  40,
  DECLINING_VOL_CANDLES:3,
  L2_BID_ASK_RATIO:     1.2,
  TOP_GAINERS_COUNT:    100,
  MIN_SPIKE_PCT:        5,
  MIN_PRICE:            0.01,
  MAX_PRICE:            9999,
  PRE_ALERT_PCT:        15,
  AH_ALERT_PCT:         8,
};

// ── BRAIN + STATE ─────────────────────────────────────────────────────────────
const BRAIN = {
  totalTrades: 0, wins: 0, losses: 0, totalPnL: 0,
  bestSetups: {}, bestTickers: [], recentPerformance: [],
  adjustedFirstTarget: 30, adjustedStop: 15, adjustedConviction: 7,
  lessons: [], lastLearned: null,
};
const tradeLog      = [];
const openTrades    = {};
const chatAlerts    = [];
const buyPctHistory = {};
const volHistory    = {};
let autoTraderActive = false;
let scanInterval     = null;
let lastScanTime     = null;
let lastGainers      = [];
let lastAnalysis     = "";
let dynamicWatchlist = [];

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
const buildSystem = () => {
  const wr = BRAIN.totalTrades > 0 ? ((BRAIN.wins / BRAIN.totalTrades) * 100).toFixed(1) + "%" : "learning";
  const topSetups = Object.entries(BRAIN.bestSetups).sort((a,b)=>b[1].winRate-a[1].winRate).slice(0,3).map(([k,v])=>`${k}(${v.winRate.toFixed(0)}%)`).join(", ") || "none yet";
  const lessons = BRAIN.lessons.slice(0,5).map(l=>`- ${l}`).join("\n") || "none yet";
  return `You are PulseTrader v11 — elite momentum trader using Kev's (@trade.momentum) exact strategy + institutional order flow.
ONLY analyze real stocks from data. NEVER invent tickers or prices.
Win rate: ${wr} (${BRAIN.wins}W/${BRAIN.losses}L) | P&L: $${BRAIN.totalPnL.toFixed(2)} | Best: ${topSetups}
Target: +${BRAIN.adjustedFirstTarget}% first exit | Stop: -${BRAIN.adjustedStop}%
LESSONS:\n${lessons}

KEV'S 6 SETUPS:
1. S/D FLIP — price breaks ABOVE supply zone + higher lows forming. NO BREAK = NO TRADE.
2. ALL GAPPERS — any gap up, holds VWAP, higher lows in pre/AH. Enter at open reclaim.
3. DIP & RIP 9/20 EMA — pullback to EMA with vol drop, enter curl up with vol picking up.
4. VWAP RECLAIM — fades below VWAP, reclaims with volume. Trail stop below VWAP.
5. 200MA + DEMAND — price at BOTH 200MA and demand zone = highest conviction.
6. LOSER BOUNCE — stock down 20%+, volume picking up, VWAP reclaim or demand zone bounce.

ENTRY TIERS:
EARLY (3-7x vol): Need 3/3 order flow + conviction 9+ → 10% position size
CONFIRMED (7-15x vol): Need 2/3 order flow + conviction 7+ → 20% position size
SKIP: Stock already 40%+ AND 15x+ vol (spike done, don't chase)
EXCEPTION TO SKIP: If pulled back to EMA = Dip & Rip re-entry

ORDER FLOW (all required for entry):
- Footprint: buy vol >52% (early: >60%) = buyers aggressive
- Liquidity map: bid wall below + thin ask above = easy breakout
- Vol profile: price above VPOC = in value, bullish

NEWS/SEC: Read internally as BONUS signal only (not a gate):
- Has catalyst → +2 conviction bonus
- Has SEC filing → +1 conviction bonus
- Negative news → -2 conviction penalty

EXIT — MAX PROFIT:
- Sell 50% at +${BRAIN.adjustedFirstTarget}%
- Trail stop -10% from peak on remainder
- SELL ALL if: buy% was 65%+ drops to 52% (footprint exhaustion)
- SELL ALL if: 3 consecutive candles with declining volume
- SELL ALL if: bid wall breaks below entry
- Hard stop: -${BRAIN.adjustedStop}%

FORMAT: BUY: TICKER | CONVICTION: X | SETUP: name | TIER: early/confirmed | REASON: one line
Setups: sd_flip, all_gapper, dip_rip_ema, vwap_reclaim, ma200_confluence, loser_bounce`;
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const groq = async (prompt, maxTokens=1200) => {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST", headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
      body: JSON.stringify({model:"llama-3.3-70b-versatile",max_tokens:maxTokens,messages:[{role:"system",content:buildSystem()},{role:"user",content:prompt}]}),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.choices?.[0]?.message?.content || "No response.";
  } catch(e) { console.error("Groq:",e.message); return `Error: ${e.message}`; }
};

const groqChat = async (messages, maxTokens=1200) => {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST", headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
      body: JSON.stringify({model:"llama-3.3-70b-versatile",max_tokens:maxTokens,messages:[{role:"system",content:buildSystem()},...messages]}),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.choices?.[0]?.message?.content || "No response.";
  } catch(e) { return `Error: ${e.message}`; }
};

const supabase = async (path, opts={}) => {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers:{apikey:process.env.SUPABASE_KEY,Authorization:`Bearer ${process.env.SUPABASE_KEY}`,"Content-Type":"application/json",Prefer:"return=representation"},...opts,
  });
  const t = await r.text();
  return t ? JSON.parse(t) : [];
};

const alpaca = async (path, opts={}) => {
  const r = await fetch(`https://paper-api.alpaca.markets${path}`, {
    headers:{"APCA-API-KEY-ID":process.env.ALPACA_KEY,"APCA-API-SECRET-KEY":process.env.ALPACA_SECRET,"Content-Type":"application/json"},...opts,
  });
  return r.json();
};

const alpacaData = async (path) => {
  const r = await fetch(`https://data.alpaca.markets${path}`, {
    headers:{"APCA-API-KEY-ID":process.env.ALPACA_KEY,"APCA-API-SECRET-KEY":process.env.ALPACA_SECRET},
  });
  return r.json();
};

const finnhub = async (path) => {
  const sep = path.includes("?")?"&":"?";
  const r = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`);
  return r.json();
};

// ── ERROR LOGGING ─────────────────────────────────────────────────────────────
const logError = async (context, err) => {
  try { await supabase("bot_errors",{method:"POST",body:JSON.stringify({context,error:String(err?.message||err),ts:new Date().toISOString()})}); } catch(_) {}
};

// ── SESSION LOGIC ─────────────────────────────────────────────────────────────
const getET = () => new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
const getSessionType = () => {
  const et=getET(), d=et.getDay();
  if (d===0||d===6) return "OVERNIGHT";
  const t=et.getHours()*100+et.getMinutes();
  if (t>=400&&t<930)  return "PRE";
  if (t>=930&&t<1600) return "REGULAR";
  if (t>=1600&&t<2000) return "AFTERHOURS";
  return "OVERNIGHT";
};
const getScanInterval = () => ({PRE:5*60000,REGULAR:3*60000,AFTERHOURS:10*60000,OVERNIGHT:30*60000}[getSessionType()]||30*60000);
const isOpen = () => getSessionType()==="REGULAR";
const isPre  = () => getSessionType()==="PRE";
const isAH   = () => getSessionType()==="AFTERHOURS";

// ── ENTRY TIER ────────────────────────────────────────────────────────────────
const getEntryTier = (volRatio, pctChange) => {
  if (volRatio>=CONFIG.EXTENDED_VOL && pctChange>=CONFIG.EXTENDED_PCT) return "SKIP";
  if (volRatio>=CONFIG.EARLY_VOL_MIN && volRatio<CONFIG.EARLY_VOL_MAX) return "EARLY";
  if (volRatio>=CONFIG.CONFIRMED_VOL_MIN) return "CONFIRMED";
  return null;
};

// ── TECHNICALS ────────────────────────────────────────────────────────────────
const calcEMA = (data, period) => {
  if (!data||data.length<period) return null;
  const k=2/(period+1);
  let ema=data.slice(0,period).reduce((s,v)=>s+v,0)/period;
  for(let i=period;i<data.length;i++) ema=data[i]*k+ema*(1-k);
  return ema;
};
const calcVWAP = (bars) => {
  if (!bars?.length) return 0;
  let pv=0,vol=0;
  for(const b of bars){const tp=(b.h+b.l+b.c)/3;pv+=tp*(b.v||0);vol+=(b.v||0);}
  return vol>0?pv/vol:0;
};
const calcAvgVolume = (bars,periods=20) => {
  if(!bars?.length) return 0;
  const r=bars.slice(-Math.min(periods,bars.length));
  return r.reduce((s,b)=>s+(b.v||0),0)/r.length;
};
const detectSDFlip = (bars, price) => {
  if(!bars||bars.length<5) return {detected:false};
  const recent=bars.slice(-20);
  const prevHigh=Math.max(...recent.slice(0,-3).map(b=>b.h));
  const brokeAbove=price>prevHigh;
  const lc=recent.slice(-3).map(b=>b.c);
  const higherLows=lc.length>=3&&lc[1]>lc[0]&&lc[2]>lc[1];
  return {detected:brokeAbove&&higherLows,prevHigh:prevHigh.toFixed(4),brokeAbove,higherLows};
};
const detectDipRip = (bars, price) => {
  if(!bars||bars.length<20) return {detected:false};
  const closes=bars.map(b=>b.c);
  const ema9=calcEMA(closes,9),ema20=calcEMA(closes,20);
  if(!ema9||!ema20) return {detected:false};
  const nearEMA9=Math.abs(price-ema9)/ema9<0.03;
  const nearEMA20=Math.abs(price-ema20)/ema20<0.05;
  const aboveEMA9=price>=ema9;
  const vols=bars.slice(-5).map(b=>b.v||0);
  const volDecline=vols[0]>vols[2]&&vols[2]<=vols[4];
  return {detected:(nearEMA9||nearEMA20)&&aboveEMA9&&volDecline,ema9:ema9?.toFixed(4),ema20:ema20?.toFixed(4)};
};
const detectGapper = (bars, price) => {
  if(!bars||bars.length<2) return {detected:false};
  const first=bars[0],second=bars[1]||bars[0];
  const gap=second.o>first.c;
  const vwap=calcVWAP(bars);
  const aboveVWAP=price>=vwap;
  const higherLow=bars.slice(-3).every((b,i,a)=>i===0||b.l>=a[i-1].l);
  return {detected:gap&&aboveVWAP&&higherLow,gap,aboveVWAP,higherLow};
};
const getFullTechnicals = async (ticker, price) => {
  try {
    const now=new Date(),start=new Date(now);
    start.setHours(4,0,0,0);
    const bd=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=5Min&start=${start.toISOString()}&limit=78&feed=iex`);
    const bars=bd.bars||[];
    if(bars.length<5) return null;
    const closes=bars.map(b=>b.c);
    const vwap=calcVWAP(bars),ema9=calcEMA(closes,9),ema20=calcEMA(closes,20),ema200=calcEMA(closes,Math.min(200,closes.length));
    const avgVol=calcAvgVolume(bars),lastVol=bars[bars.length-1]?.v||0;
    const volRatio=avgVol>0?lastVol/avgVol:0;
    const sdFlip=detectSDFlip(bars,price),dipRip=detectDipRip(bars,price),gapper=detectGapper(bars,price);
    const vwapReclaim=price>=vwap&&bars.slice(-3).some(b=>b.l<vwap);
    const ma200Conf=ema200&&Math.abs(price-ema200)/ema200<0.05;
    const aboveVWAP=price>=vwap;
    const recentVols=bars.slice(-6).map(b=>b.v||0);
    const volDryUp=recentVols.length>=4&&recentVols.slice(-2).every(v=>v<recentVols.slice(0,-2).reduce((s,x)=>s+x,0)/recentVols.slice(0,-2).length*0.5);
    // Detect declining volume candles
    let decliningVolCandles=0;
    for(let i=bars.length-1;i>0&&decliningVolCandles<CONFIG.DECLINING_VOL_CANDLES;i--){
      if((bars[i].v||0)<(bars[i-1].v||0)) decliningVolCandles++;
      else break;
    }
    return {vwap:vwap.toFixed(4),ema9:ema9?.toFixed(4),ema20:ema20?.toFixed(4),ema200:ema200?.toFixed(4),aboveVWAP,volRatio:volRatio.toFixed(1),avgVol:Math.round(avgVol),sdFlip,dipRip,gapper,vwapReclaim,ma200Conf,volDryUp,decliningVolCandles,bars:bars.length};
  } catch(e){console.log(`Tech ${ticker}:`,e.message);return null;}
};

// ── LEVEL 2 ───────────────────────────────────────────────────────────────────
const getLevel2 = async (ticker) => {
  try {
    const d=await alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`);
    const q=d.quote; if(!q) return null;
    const bidSize=q.bs||0,askSize=q.as||0,bid=q.bp||0,ask=q.ap||0;
    const spread=ask>0?((ask-bid)/ask*100):999;
    const bidAskRatio=askSize>0?bidSize/askSize:0;
    const strongBids=bidAskRatio>=CONFIG.L2_BID_ASK_RATIO,tightSpread=spread<3;
    return {bid,ask,spread:spread.toFixed(2),bidSize,askSize,bidAskRatio:bidAskRatio.toFixed(2),strongBids,tightSpread,goodL2:strongBids&&tightSpread,signal:strongBids&&tightSpread?"STRONG BIDS":strongBids?"Moderate bids":"Weak bids"};
  } catch(_){return null;}
};

// ── FOOTPRINT ─────────────────────────────────────────────────────────────────
const getFootprint = async (ticker) => {
  try {
    const [td,qd]=await Promise.all([alpacaData(`/v2/stocks/${ticker}/trades?limit=500&feed=iex`),alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`)]);
    const trades=td.trades||[]; if(!trades.length) return null;
    const q=qd.quote,mid=q?(parseFloat(q.bp||0)+parseFloat(q.ap||0))/2:0;
    let totalBuy=0,totalSell=0;
    for(const t of trades){
      const rp=parseFloat(t.p||0),sz=parseInt(t.s||0);
      if(rp>=mid&&mid>0) totalBuy+=sz; else totalSell+=sz;
    }
    const totalVol=totalBuy+totalSell;
    const buyPct=totalVol>0?(totalBuy/totalVol)*100:50;
    const delta=totalBuy-totalSell;
    const imbalance=buyPct>65?"STRONG_BUY":buyPct>52?"BUY":buyPct<35?"STRONG_SELL":buyPct<48?"SELL":"NEUTRAL";
    return {totalBuy,totalSell,totalVol,buyPct:buyPct.toFixed(1),delta,imbalance,signal:imbalance==="STRONG_BUY"?"🟢🟢 Strong buyers":imbalance==="BUY"?"🟢 Buy dominant":imbalance==="STRONG_SELL"?"🔴🔴 Strong sellers":imbalance==="SELL"?"🔴 Sell dominant":"⚪ Balanced",entryOk:buyPct>=CONFIG.CONFIRMED_BUY_PCT,earlyEntryOk:buyPct>=CONFIG.EARLY_BUY_PCT,exitNow:buyPct<=CONFIG.FOOTPRINT_HARD_EXIT};
  } catch(_){return null;}
};

// ── LIQUIDITY MAP ─────────────────────────────────────────────────────────────
const getLiquidityMap = async (ticker) => {
  try {
    let bids=[],asks=[];
    try{const od=await alpacaData(`/v2/stocks/${ticker}/orderbook/latest?feed=iex`);const ob=od.orderbook;if(ob?.b?.length){bids=ob.b.slice(0,10).map(b=>({price:parseFloat(b.p),size:parseInt(b.s)}));asks=ob.a.slice(0,10).map(a=>({price:parseFloat(a.p),size:parseInt(a.s)}));}}catch(_){}
    if(!bids.length){const qd=await alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`);const q=qd.quote;if(q){bids=[{price:parseFloat(q.bp||0),size:parseInt(q.bs||0)}];asks=[{price:parseFloat(q.ap||0),size:parseInt(q.as||0)}];}}
    if(!bids.length) return null;
    const totalBid=bids.reduce((s,b)=>s+b.size,0),totalAsk=asks.reduce((s,a)=>s+a.size,0);
    const liqRatio=totalAsk>0?totalBid/totalAsk:1;
    const bigBid=bids.reduce((b,x)=>(!b||x.size>b.size)?x:b,null);
    const bigAsk=asks.reduce((b,x)=>(!b||x.size>b.size)?x:b,null);
    const askWallThin=!bigAsk||bigAsk.size<totalAsk*0.3;
    const signal=liqRatio>2?"🟢🟢 MASSIVE bid wall":liqRatio>1.5?"🟢 Strong bid support":liqRatio>1.1?"🟡 Slight bid favor":liqRatio<0.5?"🔴🔴 Ask wall dominant":liqRatio<0.8?"🔴 Sellers stacking":"⚪ Balanced";
    return {bids:bids.slice(0,5),asks:asks.slice(0,5),totalBid,totalAsk,liqRatio:liqRatio.toFixed(2),bigBid,bigAsk,askWallThin,signal,entryFavorable:liqRatio>=1.1&&askWallThin,exitSignal:liqRatio<0.8||(bigAsk&&bigAsk.size>totalAsk*0.6)};
  } catch(_){return null;}
};

// ── VOLUME PROFILE ────────────────────────────────────────────────────────────
const getVolumeProfile = async (ticker) => {
  try {
    const d=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=1Min&limit=390&feed=iex`);
    const bars=d.bars||[]; if(bars.length<5) return null;
    const profile={};let totalVol=0;
    for(const b of bars){const tp=parseFloat(((b.h+b.l+b.c)/3).toFixed(2));profile[tp]=(profile[tp]||0)+(b.v||0);totalVol+=(b.v||0);}
    if(totalVol===0) return null;
    const levels=Object.entries(profile).map(([p,v])=>({price:parseFloat(p),vol:v})).sort((a,b)=>b.vol-a.vol);
    const vpoc=levels[0];
    let vaAccum=0;const vaLevels=[];
    for(const l of levels){vaAccum+=l.vol;vaLevels.push(l.price);if(vaAccum>=totalVol*0.70) break;}
    const vah=Math.max(...vaLevels),val=Math.min(...vaLevels);
    const cur=parseFloat(bars[bars.length-1].c);
    const aboveVPOC=cur>=vpoc.price,inVA=cur>=val&&cur<=vah,aboveVAH=cur>vah;
    return {vpoc:vpoc.price,vah:parseFloat(vah.toFixed(2)),val:parseFloat(val.toFixed(2)),totalVol,currentPrice:cur,aboveVPOC,inValueArea:inVA,aboveVAH,topLevels:levels.slice(0,5),signal:aboveVAH?"⚠️ Above value — extended":aboveVPOC?"🟢 Above VPOC — bullish":inVA?"🟡 In value area":"🔴 Below value — selling",entryOk:aboveVPOC&&!aboveVAH,exitSignal:!aboveVPOC&&!inVA};
  } catch(_){return null;}
};

// ── COMBINED ORDER FLOW ───────────────────────────────────────────────────────
const getOrderFlow = async (ticker, price) => {
  try {
    const [fp,lm,vp]=await Promise.all([getFootprint(ticker).catch(()=>null),getLiquidityMap(ticker).catch(()=>null),getVolumeProfile(ticker).catch(()=>null)]);
    let entryScore=0,exitSignals=0;
    if(fp?.entryOk) entryScore++;
    if(lm?.entryFavorable) entryScore++;
    if(vp?.entryOk) entryScore++;
    if(fp?.exitNow) exitSignals++;
    if(lm?.exitSignal) exitSignals++;
    if(vp?.exitSignal) exitSignals++;
    const earlyOk=fp?.earlyEntryOk&&lm?.entryFavorable&&vp?.entryOk;
    const grade=entryScore===3?"A+ all aligned":entryScore===2?"B  2/3 OK":entryScore===1?"C  weak":"D  avoid";
    return {footprint:fp,liqMap:lm,volProfile:vp,entryScore,grade,exitSignals,earlyOk,shouldEnter:entryScore>=CONFIG.CONFIRMED_OF_SCORE,shouldExit:exitSignals>=2};
  } catch(_){return null;}
};

// ── DYNAMIC WATCHLIST ─────────────────────────────────────────────────────────
const loadDynamicWatchlist = async () => {
  try {
    const wl=await supabase("bot_watchlist?order=last_seen.desc&limit=150");
    if(Array.isArray(wl)&&wl.length) {
      dynamicWatchlist=wl.map(w=>w.ticker).filter(Boolean);
      console.log(`📋 Watchlist: ${dynamicWatchlist.length} tickers`);
    }
  } catch(_) {}
};

const addToWatchlist = async (ticker, pct, price, session) => {
  try {
    await supabase("bot_watchlist", {
      method:"POST",
      headers:{Prefer:"resolution=merge-duplicates"},
      body:JSON.stringify({ticker:ticker.toUpperCase(),last_seen:new Date().toISOString(),last_pct:pct,last_price:price,session}),
    });
    if(!dynamicWatchlist.includes(ticker.toUpperCase())) dynamicWatchlist.push(ticker.toUpperCase());
  } catch(_) {}
};

// ── 3-LAYER SCANNER ───────────────────────────────────────────────────────────
const getTopGainers = async (includeExtended=false) => {
  const gainers=[];

  // Layer 1: Alpaca screener
  try {
    const urls=[`/v1beta1/screener/stocks/movers?by=percent_change&top=${CONFIG.TOP_GAINERS_COUNT}&market_type=sip`,`/v1beta1/screener/stocks/movers?by=percent_change&top=${CONFIG.TOP_GAINERS_COUNT}`];
    for(const url of urls){
      try{
        const d=await alpacaData(url);
        if(d.gainers?.length){
          for(const g of d.gainers){
            if(g.price>=CONFIG.MIN_PRICE&&g.price<=CONFIG.MAX_PRICE&&g.percent_change>=CONFIG.MIN_SPIKE_PCT){
              gainers.push({ticker:g.symbol,c:g.price,dp:g.percent_change,v:g.volume||0,source:"alpaca"});
            }
          }
          console.log(`📡 Alpaca screener: ${gainers.length} gainers`);
          break;
        }
      }catch(_){continue;}
    }
  } catch(e){console.log("Screener err:",e.message);}

  // Layer 2: Alpaca batch snapshots for extended hours + watchlist
  if(includeExtended||gainers.length<5) {
    try {
      const tickers=[...new Set([...dynamicWatchlist.slice(0,80)])].join(",");
      if(tickers) {
        const sd=await alpacaData(`/v2/stocks/snapshots?symbols=${tickers}&feed=iex`);
        for(const [sym,snap] of Object.entries(sd)) {
          if(!snap) continue;
          const prevClose=snap.prevDailyBar?.c||snap.dailyBar?.o||0;
          const curPrice=snap.latestTrade?.p||snap.latestQuote?.ap||0;
          const pct=prevClose>0?((curPrice-prevClose)/prevClose)*100:0;
          if(curPrice>=CONFIG.MIN_PRICE&&pct>=CONFIG.MIN_SPIKE_PCT&&!gainers.find(g=>g.ticker===sym)){
            gainers.push({ticker:sym,c:curPrice,dp:pct,v:snap.dailyBar?.v||0,source:"snapshot"});
          }
        }
        console.log(`📸 Snapshots added, total: ${gainers.length}`);
      }
    } catch(e){console.log("Snapshot err:",e.message);}
  }

  // Layer 3: Finnhub fallback using dynamic watchlist
  if(gainers.length<5&&dynamicWatchlist.length>0){
    const batch=dynamicWatchlist.slice(0,60);
    const batchSize=15;
    for(let i=0;i<batch.length;i+=batchSize){
      const b=batch.slice(i,i+batchSize);
      const quotes=await Promise.all(b.map(t=>finnhub(`/quote?symbol=${t}`).then(q=>({ticker:t,...q})).catch(()=>null)));
      for(const q of quotes.filter(Boolean)){
        if(q.c>=CONFIG.MIN_PRICE&&q.c<=CONFIG.MAX_PRICE&&q.dp>=CONFIG.MIN_SPIKE_PCT&&q.v>10000&&!gainers.find(g=>g.ticker===q.ticker)){
          gainers.push({ticker:q.ticker,c:q.c,dp:q.dp,v:q.v,source:"finnhub"});
        }
      }
      if(i+batchSize<batch.length) await new Promise(r=>setTimeout(r,250));
    }
  }

  // Save all found tickers to watchlist
  const session=getSessionType();
  for(const g of gainers.slice(0,30)){
    await addToWatchlist(g.ticker,g.dp,g.c,session);
  }

  return gainers.sort((a,b)=>b.dp-a.dp);
};

const getTopLosers = async () => {
  try {
    const losers=[];
    const d=await alpacaData(`/v1beta1/screener/stocks/movers?by=percent_change&top=${CONFIG.TOP_GAINERS_COUNT}`);
    if(d.losers?.length){
      for(const l of d.losers){
        if(l.price>=CONFIG.MIN_PRICE&&Math.abs(l.percent_change)>=CONFIG.LOSER_DOWN_PCT){
          losers.push({ticker:l.symbol,c:l.price,dp:l.percent_change,v:l.volume||0,source:"alpaca"});
        }
      }
    }
    return losers.sort((a,b)=>a.dp-b.dp);
  } catch(_){return [];}
};

const getMostActive = async () => {
  try {
    const d=await alpacaData(`/v1beta1/screener/stocks/movers?by=volume&top=50`);
    return (d.most_actives||d.gainers||[]).slice(0,20).map(s=>({ticker:s.symbol,c:s.price,dp:s.percent_change||0,v:s.volume||0,source:"alpaca"}));
  } catch(_){return [];}
};

// ── ANALYZE STOCK (news as bonus) ─────────────────────────────────────────────
const analyzeStock = async (ticker, price, pct) => {
  try {
    const week=new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const today=new Date().toISOString().split("T")[0];
    const [profile,news]=await Promise.all([finnhub(`/stock/profile2?symbol=${ticker}`),finnhub(`/company-news?symbol=${ticker}&from=${week}&to=${today}`)]);
    const newsItems=Array.isArray(news)?news.slice(0,4):[];
    const headlines=newsItems.map(n=>`- ${n.headline}`).join("\n")||"No news";
    const hasCatalyst=newsItems.length>0;
    const floatShares=parseFloat(profile.shareOutstanding||0)*1_000_000;
    return {ticker,price,pct,float:profile.shareOutstanding||null,mktCap:profile.marketCapitalization||"?",industry:profile.finnhubIndustry||"?",headlines,name:profile.name||ticker,hasCatalyst,topHeadline:newsItems[0]?.headline||null,floatShares,convictionBonus:hasCatalyst?2:0};
  } catch(_){return {ticker,price,pct,float:null,mktCap:"?",industry:"?",headlines:"No data",name:ticker,hasCatalyst:false,topHeadline:null,floatShares:0,convictionBonus:0};}
};

// ── SELF-LEARNING ─────────────────────────────────────────────────────────────
const saveBrainState = async () => {
  try {
    await supabase("bot_lessons",{method:"POST",body:JSON.stringify({ticker:"__BRAIN__",lesson:JSON.stringify({adjustedFirstTarget:BRAIN.adjustedFirstTarget,adjustedStop:BRAIN.adjustedStop,adjustedConviction:BRAIN.adjustedConviction}),pattern:"brain_state",taught_by:"system"})});
  } catch(_) {}
};

const learnFromTrade = async (trade) => {
  const won=trade.pnl>0;
  BRAIN.totalTrades++;won?BRAIN.wins++:BRAIN.losses++;BRAIN.totalPnL+=trade.pnl||0;
  if(trade.setup){
    if(!BRAIN.bestSetups[trade.setup]) BRAIN.bestSetups[trade.setup]={trades:0,wins:0,winRate:0};
    BRAIN.bestSetups[trade.setup].trades++;
    if(won) BRAIN.bestSetups[trade.setup].wins++;
    BRAIN.bestSetups[trade.setup].winRate=(BRAIN.bestSetups[trade.setup].wins/BRAIN.bestSetups[trade.setup].trades)*100;
  }
  if(won&&!BRAIN.bestTickers.includes(trade.symbol)){BRAIN.bestTickers.unshift(trade.symbol);BRAIN.bestTickers=BRAIN.bestTickers.slice(0,20);}
  BRAIN.recentPerformance.unshift({...trade,won});BRAIN.recentPerformance=BRAIN.recentPerformance.slice(0,20);
  const rw=BRAIN.recentPerformance.filter(t=>t.won).length,rt=BRAIN.recentPerformance.length;
  if(rt>=5){
    const rate=rw/rt;
    if(rate>0.65){BRAIN.adjustedFirstTarget=Math.min(40,BRAIN.adjustedFirstTarget+2);BRAIN.adjustedConviction=Math.max(6,BRAIN.adjustedConviction-1);}
    else if(rate<0.35){BRAIN.adjustedFirstTarget=Math.max(20,BRAIN.adjustedFirstTarget-2);BRAIN.adjustedStop=Math.max(8,BRAIN.adjustedStop-1);BRAIN.adjustedConviction=Math.min(9,BRAIN.adjustedConviction+1);}
    CONFIG.FIRST_TARGET_PCT=BRAIN.adjustedFirstTarget;CONFIG.HARD_STOP_PCT=BRAIN.adjustedStop;CONFIG.CONFIRMED_CONVICTION=BRAIN.adjustedConviction;
  }
  try {
    const lesson=await groq(`Trade: ${trade.symbol} | ${won?"WIN ✅":"LOSS ❌"}\nP&L: $${trade.pnl?.toFixed(2)} (${trade.pnlPct?.toFixed(1)}%)\nEntry: $${trade.entryPrice} → $${trade.exitPrice}\nSetup: ${trade.setup} | Tier: ${trade.tier||"?"} | Exit: ${trade.exitReason}\nOrderFlow at exit: ${trade.orderFlowAtExit||"?"}\n\nONE lesson for Kev's strategy + early spike detection:`,100);
    BRAIN.lessons.unshift(lesson.trim());BRAIN.lessons=BRAIN.lessons.slice(0,10);BRAIN.lastLearned=new Date().toISOString();
    await supabase("bot_lessons",{method:"POST",body:JSON.stringify({ticker:trade.symbol,lesson:lesson.trim(),pattern:trade.setup,taught_by:"auto"})}).catch(()=>{});
  } catch(_) {}
  await supabase("bot_trade_memory",{method:"POST",body:JSON.stringify({symbol:trade.symbol,side:"LONG",entry_price:trade.entryPrice,exit_price:trade.exitPrice,pnl:trade.pnl,pnl_pct:trade.pnlPct,entry_reason:trade.reason,exit_reason:trade.exitReason,setup_type:trade.setup,won,entry_hour:new Date().getHours(),day_of_week:new Date().getDay()})}).catch(()=>{});
  await saveBrainState();
};

// ── LOAD MEMORY + RESTORE ─────────────────────────────────────────────────────
const loadMemory = async () => {
  try {
    const mem=await supabase("bot_trade_memory?order=created_at.desc&limit=200");
    if(Array.isArray(mem)&&mem.length){
      BRAIN.totalTrades=mem.length;BRAIN.wins=mem.filter(m=>m.won).length;BRAIN.losses=mem.filter(m=>!m.won).length;
      BRAIN.totalPnL=mem.reduce((s,m)=>s+parseFloat(m.pnl||0),0);
      mem.forEach(m=>{
        if(m.setup_type){if(!BRAIN.bestSetups[m.setup_type])BRAIN.bestSetups[m.setup_type]={trades:0,wins:0,winRate:0};BRAIN.bestSetups[m.setup_type].trades++;if(m.won)BRAIN.bestSetups[m.setup_type].wins++;BRAIN.bestSetups[m.setup_type].winRate=(BRAIN.bestSetups[m.setup_type].wins/BRAIN.bestSetups[m.setup_type].trades)*100;}
        if(m.won&&!BRAIN.bestTickers.includes(m.symbol))BRAIN.bestTickers.push(m.symbol);
      });
      BRAIN.bestTickers=BRAIN.bestTickers.slice(0,20);
      console.log(`🧠 Brain: ${mem.length} trades | ${((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0)}% WR | $${BRAIN.totalPnL.toFixed(0)} P&L`);
    }
    try {
      const bs=await supabase("bot_lessons?ticker=eq.__BRAIN__&order=created_at.desc&limit=1");
      if(Array.isArray(bs)&&bs.length){
        const s=JSON.parse(bs[0].lesson||"{}");
        if(s.adjustedFirstTarget){BRAIN.adjustedFirstTarget=s.adjustedFirstTarget;CONFIG.FIRST_TARGET_PCT=s.adjustedFirstTarget;}
        if(s.adjustedStop){BRAIN.adjustedStop=s.adjustedStop;CONFIG.HARD_STOP_PCT=s.adjustedStop;}
        if(s.adjustedConviction){BRAIN.adjustedConviction=s.adjustedConviction;CONFIG.CONFIRMED_CONVICTION=s.adjustedConviction;}
        console.log(`🧠 Restored: target ${BRAIN.adjustedFirstTarget}% | stop ${BRAIN.adjustedStop}%`);
      }
    } catch(_){}
    const lessons=await supabase("bot_lessons?taught_by=neq.system&order=created_at.desc&limit=20");
    if(Array.isArray(lessons)) BRAIN.lessons=lessons.filter(l=>l.ticker!=="__BRAIN__").map(l=>l.lesson).filter(Boolean);
  } catch(e){console.log("Memory load:",e.message);}

  // Restore open positions from Alpaca
  try {
    const positions=await alpaca("/v2/positions");
    if(Array.isArray(positions)&&positions.length){
      for(const p of positions){
        if(!openTrades[p.symbol]){
          openTrades[p.symbol]={reason:"Restored on startup",setup:"unknown",tier:"restored",conviction:7,entryPrice:parseFloat(p.avg_entry_price),qty:parseFloat(p.qty),halfSold:false,peakPrice:parseFloat(p.current_price),volumeReduced:false,time:new Date().toISOString()};
          buyPctHistory[p.symbol]=[];
          console.log(`📍 Restored: ${p.symbol} x${p.qty} @ $${p.avg_entry_price}`);
        }
      }
    }
  } catch(e){console.log("Position restore:",e.message);}

  await loadDynamicWatchlist();
};

// ── POSITION MANAGER ──────────────────────────────────────────────────────────
const managePositions = async (positions) => {
  if(!Array.isArray(positions)) return;
  for(const pos of positions){
    const sym=pos.symbol,pnlPct=parseFloat(pos.unrealized_plpc)*100,cur=parseFloat(pos.current_price);
    const entry=openTrades[sym]; if(!entry) continue;
    if(!entry.peakPrice||cur>entry.peakPrice) entry.peakPrice=cur;
    const fromPeak=entry.peakPrice>0?((cur-entry.peakPrice)/entry.peakPrice)*100:0;

    // Get order flow + technicals for intelligent exits
    const [tech,of]=await Promise.all([getFullTechnicals(sym,cur).catch(()=>null),getOrderFlow(sym,cur).catch(()=>null)]);

    // Track buy% history for exhaustion detection
    if(of?.footprint) {
      if(!buyPctHistory[sym]) buyPctHistory[sym]=[];
      buyPctHistory[sym].push(parseFloat(of.footprint.buyPct));
      buyPctHistory[sym]=buyPctHistory[sym].slice(-10);
    }
    const bph=buyPctHistory[sym]||[];
    const footprintExhausted=bph.length>=3&&bph.some(b=>b>=CONFIG.FOOTPRINT_EXIT_HIGH)&&bph[bph.length-1]<=CONFIG.FOOTPRINT_EXIT_LOW;

    // 1. Sell 50% at first target
    if(!entry.halfSold&&pnlPct>=CONFIG.FIRST_TARGET_PCT){
      const halfQty=Math.floor(parseFloat(pos.qty)/2);
      if(halfQty>=1){
        await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:String(halfQty),side:"sell",type:"market",time_in_force:"day"})});
        entry.halfSold=true;
        tradeLog.unshift({type:"PARTIAL_SELL",symbol:sym,qty:halfQty,price:cur,pnlPct:pnlPct.toFixed(1),reason:`First target +${CONFIG.FIRST_TARGET_PCT}%`,ts:new Date().toISOString()});
        console.log(`🎯 FIRST TARGET: ${sym} +${pnlPct.toFixed(1)}%`);
      }
    }

    // 2. Footprint exhaustion exit
    if(footprintExhausted&&entry.halfSold){
      console.log(`🔴 FOOTPRINT EXHAUSTED: ${sym} — buy% dropped from ${CONFIG.FOOTPRINT_EXIT_HIGH}% to ${bph[bph.length-1]}%`);
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,tier:entry.tier,exitReason:"FOOTPRINT EXHAUSTION",orderFlowAtExit:"buy% dropped",type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];delete buyPctHistory[sym];continue;
    }

    // 3. 3 declining volume candles exit
    if(tech?.decliningVolCandles>=CONFIG.DECLINING_VOL_CANDLES&&entry.halfSold){
      console.log(`📉 VOL DECLINING: ${sym} — ${tech.decliningVolCandles} candles`);
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,tier:entry.tier,exitReason:"VOLUME DECLINE",type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];continue;
    }

    // 4. Order flow exit (all signals red)
    if(of?.shouldExit&&entry.halfSold){
      console.log(`🔴 ORDER FLOW EXIT: ${sym}`);
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,tier:entry.tier,exitReason:"ORDER FLOW EXIT",orderFlowAtExit:of?.footprint?.signal,type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];delete buyPctHistory[sym];continue;
    }

    // 5. Bid wall breaks
    if(of?.liqMap?.exitSignal&&entry.halfSold){
      console.log(`🔴 BID WALL BROKEN: ${sym}`);
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,tier:entry.tier,exitReason:"BID WALL BROKEN",type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];continue;
    }

    // 6. Trail stop
    if(entry.halfSold&&fromPeak<=-CONFIG.TRAIL_STOP_PCT){
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,tier:entry.tier,exitReason:"TRAIL STOP",type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];continue;
    }

    // 7. Hard stop
    if(pnlPct<=-CONFIG.HARD_STOP_PCT){
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,tier:entry.tier,exitReason:"HARD STOP",type:"STOP",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];continue;
    }

    // 8. Volume dry-up
    if(tech?.volDryUp&&!entry.volumeReduced){
      const rQty=Math.floor(parseFloat(pos.qty)*CONFIG.VOLUME_DRY_REDUCE);
      if(rQty>=1){
        await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:String(rQty),side:"sell",type:"market",time_in_force:"day"})});
        entry.volumeReduced=true;
        tradeLog.unshift({type:"REDUCE",symbol:sym,qty:rQty,price:cur,reason:"Volume dry-up",ts:new Date().toISOString()});
      }
    }

    // 9. Below 9 EMA after half sold
    if(tech?.ema9&&cur<parseFloat(tech.ema9)&&entry.halfSold){
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,tier:entry.tier,exitReason:"BELOW 9 EMA",type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];
    }
  }
};

// ── AUTO TRADER ───────────────────────────────────────────────────────────────
const autoTrade = async () => {
  lastScanTime=new Date().toISOString();
  const session=getSessionType();
  console.log(`🔍 Scanning [${session}]...`);
  try {
    const [positions,account]=await Promise.all([alpaca("/v2/positions").catch(()=>[]),alpaca("/v2/account").catch(()=>null)]);
    if(session==="REGULAR") await managePositions(positions);

    const cash=account?parseFloat(account.cash):0;
    const gainers=await getTopGainers(session!=="REGULAR");
    lastGainers=gainers.slice(0,20);
    console.log(`📊 ${gainers.length} gainers | Top: ${gainers.slice(0,5).map(g=>`${g.ticker}+${g.dp?.toFixed(0)}%`).join(", ")}`);

    // PRE-MARKET: monitor + alert, no trades
    if(session==="PRE"){
      for(const g of gainers){
        if(g.dp>=CONFIG.PRE_ALERT_PCT){
          const alert=`🌅 PRE-MARKET: ${g.ticker} +${g.dp.toFixed(1)}% @ $${g.c} — watching for open`;
          chatAlerts.unshift({msg:alert,ts:new Date().toISOString(),type:"pre_alert",ticker:g.ticker});
          chatAlerts.splice(20);
          console.log(alert);
          await addToWatchlist(g.ticker,g.dp,g.c,"PRE");
        }
      }
      return;
    }

    // AFTER-HOURS: monitor + alert, no trades
    if(session==="AFTERHOURS"){
      for(const g of gainers){
        if(g.dp>=CONFIG.AH_ALERT_PCT){
          const alert=`🌆 AFTER-HOURS: ${g.ticker} +${g.dp.toFixed(1)}% @ $${g.c} — gapper candidate`;
          chatAlerts.unshift({msg:alert,ts:new Date().toISOString(),type:"ah_alert",ticker:g.ticker});
          chatAlerts.splice(20);
          console.log(alert);
          await addToWatchlist(g.ticker,g.dp,g.c,"AH");
        }
      }
      return;
    }

    // OVERNIGHT: just scan, no trades
    if(session==="OVERNIGHT") return;

    // REGULAR HOURS: full trading
    if(cash<CONFIG.MIN_POSITION_USD){console.log("⚠️ Low cash");return;}
    const owned=Array.isArray(positions)?positions.map(p=>p.symbol):[];
    const candidates=gainers.filter(g=>!owned.includes(g.ticker)).slice(0,12);
    if(!candidates.length) return;

    const results=await Promise.all(candidates.map(async g=>{
      const tier=getEntryTier(parseFloat(g.dp>0?g.v/1000:0),g.dp);
      if(tier==="SKIP"){console.log(`⏭️ ${g.ticker} SKIP — already extended`);return null;}
      const [info,tech,l2,of]=await Promise.all([analyzeStock(g.ticker,g.c,g.dp),getFullTechnicals(g.ticker,g.c),getLevel2(g.ticker),getOrderFlow(g.ticker,g.c)]);
      const volRatio=parseFloat(tech?.volRatio||0);
      const actualTier=getEntryTier(volRatio,g.dp);
      if(actualTier==="SKIP"){console.log(`⏭️ ${g.ticker} SKIP — vol/pct extended`);return null;}
      const floatShares=(parseFloat(info?.float||0))*1_000_000;
      const floatRot=floatShares>0?g.v/floatShares:0;
      return {...g,tier:actualTier,info,tech,l2,of,volRatio,floatRot};
    }));

    const qualified=results.filter(s=>{
      if(!s) return false;
      const minVol=s.tier==="EARLY"?CONFIG.EARLY_VOL_MIN:CONFIG.CONFIRMED_VOL_MIN;
      const volOk=s.volRatio>=minVol||s.dp>=20;
      const ofOk=s.tier==="EARLY"?s.of?.earlyOk:s.of?.entryScore>=CONFIG.CONFIRMED_OF_SCORE;
      return volOk&&(ofOk||!s.of);
    });

    if(!qualified.length){console.log("⏭️ No qualified stocks");return;}

    const candStr=qualified.slice(0,6).map(s=>{
      const t=s.tech,of=s.of;
      return `${s.ticker}: $${s.c} +${s.dp?.toFixed(1)}% | Tier:${s.tier||"?"} | Float:${s.info?.float||"?"}M | FloatRot:${s.floatRot.toFixed(1)}x\nTech: VWAP ${t?.aboveVWAP?"↑":"↓"} | EMA9:$${t?.ema9} | Vol:${t?.volRatio}x\nSetups: SDFlip:${t?.sdFlip?.detected?"✅":"no"} | DipRip:${t?.dipRip?.detected?"✅":"no"} | Gapper:${t?.gapper?.detected?"✅":"no"} | VWAP:${t?.vwapReclaim?"✅":"no"}\nL2: ${s.l2?.signal||"?"} | OF Grade: ${of?.grade||"?"} | Score: ${of?.entryScore||0}/3\nNews: ${s.info?.hasCatalyst?"✅ HAS CATALYST":"❌ none"} — ${s.info?.topHeadline?.slice(0,50)||""}`;
    }).join("\n\n");
    lastAnalysis=candStr;

    const verdict=await groq(`REAL stocks — Kev's 6 setups + order flow:\n\n${candStr}\n\nRules:\n1. Kev setup match? 2. Entry tier (early 3-7x OR confirmed 7-15x)? 3. Order flow confirms? 4. Float rotation 5x+? 5. News = +2 conviction bonus\n\nPick ALL qualifying. ONLY output:\nBUY: TICKER | CONVICTION: X | SETUP: name | TIER: early/confirmed | REASON: one line`,600);

    console.log("🤖 AI:",verdict);
    const buyLines=verdict.split("\n").filter(l=>l.startsWith("BUY:"));
    let buys=0;

    for(const line of buyLines){
      const m=line.match(/BUY:\s*([A-Z]+)\s*\|\s*CONVICTION:\s*([\d.]+)/i);
      if(!m) continue;
      const ticker=m[1].toUpperCase(),conviction=parseFloat(m[2]);
      const tierMatch=line.match(/TIER:\s*(early|confirmed)/i);
      const tier=tierMatch?tierMatch[1].toLowerCase():"confirmed";
      const minConv=tier==="early"?CONFIG.EARLY_CONVICTION:CONFIG.CONFIRMED_CONVICTION;
      if(conviction<minConv||owned.includes(ticker)) continue;

      const stock=qualified.find(s=>s.ticker===ticker);
      if(!stock||stock.c<=0){console.log(`🚫 ${ticker} not in qualified`);continue;}

      // Float rotation gate
      if(stock.floatRot>0&&stock.floatRot<CONFIG.FLOAT_ROTATION_MIN&&stock.dp<20){console.log(`⚠️ ${ticker} float rot ${stock.floatRot.toFixed(1)}x too low`);continue;}

      // Order flow gate by tier
      if(tier==="early"&&!stock.of?.earlyOk&&conviction<9.5){console.log(`🚫 ${ticker} early entry needs 3/3 OF`);continue;}
      if(tier==="confirmed"&&stock.of&&stock.of.entryScore===0&&conviction<9){console.log(`🚫 ${ticker} all OF red`);continue;}
      if(stock.l2&&parseFloat(stock.l2.bidAskRatio)<0.5){console.log(`🚫 ${ticker} big L2 seller`);continue;}

      const posSize=tier==="early"?CONFIG.EARLY_POSITION_PCT:CONFIG.FULL_POSITION_PCT;
      const qty=Math.floor((cash*posSize)/stock.c);
      if(qty<1) continue;

      const setup=line.match(/SETUP:\s*([a-z_]+)/i)?.[1]||"momentum";
      const reason=line.match(/REASON:\s*(.+)/i)?.[1]||"Kev + OrderFlow signal";
      const finalConviction=conviction+(stock.info?.convictionBonus||0);

      console.log(`🚀 BUY ${ticker} x${qty} @ $${stock.c} | ${setup} | ${tier} | c${finalConviction} | OF:${stock.of?.grade}`);
      const order=await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:ticker,qty:String(qty),side:"buy",type:"market",time_in_force:"day"})});
      if(order.id){
        openTrades[ticker]={reason,setup,tier,conviction:finalConviction,entryPrice:stock.c,qty,halfSold:false,peakPrice:stock.c,volumeReduced:false,time:new Date().toISOString(),orderFlowAtEntry:stock.of?.grade,floatRot:stock.floatRot.toFixed(1),hasCatalyst:stock.info?.hasCatalyst};
        buyPctHistory[ticker]=[];
        tradeLog.unshift({type:"BUY",symbol:ticker,qty,price:stock.c,conviction:finalConviction,reason,setup,tier,target:(stock.c*(1+CONFIG.FIRST_TARGET_PCT/100)).toFixed(2),stop:(stock.c*(1-CONFIG.HARD_STOP_PCT/100)).toFixed(2),orderFlow:stock.of?.grade,catalyst:stock.info?.topHeadline||"none",ts:new Date().toISOString()});
        await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({symbol:ticker,side:"LONG",qty,entry_price:stock.c,reason:`AUTO[${setup}|${tier}|c${finalConviction}|OF:${stock.of?.entryScore}/3]: ${reason}`})}).catch(()=>{});
        await addToWatchlist(ticker,stock.dp,stock.c,"REGULAR");
        buys++;console.log(`✅ Bought ${ticker}`);
      } else {
        await logError("order_failed",`${ticker}: ${JSON.stringify(order)}`);
      }
    }
    if(buys===0) console.log("⏭️ No qualifying entries");
  } catch(e){console.error("AutoTrade:",e.message);await logError("autoTrade",e);}
};

// ── CONTROLS ──────────────────────────────────────────────────────────────────
let scanTimer=null;
const startAutoTrader = () => {
  if(autoTraderActive) return;
  autoTraderActive=true;
  console.log("🤖 AutoTrader STARTED");
  autoTrade();
  const scheduleNext=()=>{scanTimer=setTimeout(async()=>{await autoTrade();scheduleNext();},getScanInterval());};
  scheduleNext();
};
const stopAutoTrader = () => {
  if(scanTimer) clearTimeout(scanTimer);
  if(scanInterval) clearInterval(scanInterval);
  autoTraderActive=false;scanTimer=null;scanInterval=null;
  console.log("⏹️ Stopped");
};

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/autotrader/start",(_, res)=>{startAutoTrader();res.json({status:"started",session:getSessionType()});});
app.get( "/api/autotrader/start",(_, res)=>{startAutoTrader();res.json({status:"started"});});
app.post("/api/autotrader/stop", (_, res)=>{stopAutoTrader();res.json({status:"stopped"});});
app.post("/api/autotrader/scan", async(_, res)=>{res.json({message:"Scan triggered"});autoTrade();});

app.get("/api/autotrader/status", async(_, res)=>{
  const [positions,account]=await Promise.all([alpaca("/v2/positions").catch(()=>[]),alpaca("/v2/account").catch(()=>null)]);
  const todayPnL=account?parseFloat(account.equity)-parseFloat(account.last_equity):0;
  res.json({active:autoTraderActive,last_scan:lastScanTime,session:getSessionType(),open_positions:Array.isArray(positions)?positions.length:0,equity:account?parseFloat(account.equity).toFixed(2):"—",cash:account?parseFloat(account.cash).toFixed(2):"—",today_pnl:todayPnL.toFixed(2),today_pnl_pct:account?((todayPnL/parseFloat(account.last_equity))*100).toFixed(2)+"%":"—",config:{early_position:"10%",full_position:"20%",first_target:CONFIG.FIRST_TARGET_PCT+"%",trail_stop:CONFIG.TRAIL_STOP_PCT+"%",hard_stop:CONFIG.HARD_STOP_PCT+"%",min_conviction_early:CONFIG.EARLY_CONVICTION,min_conviction_confirmed:CONFIG.CONFIRMED_CONVICTION,scan_interval:getScanInterval()/60000+"min",order_flow:"footprint+heatmap+volprofile",news:"bonus signal only"},recent_trades:tradeLog.slice(0,20),last_gainers:lastGainers,last_analysis:lastAnalysis,brain:{total_trades:BRAIN.totalTrades,wins:BRAIN.wins,losses:BRAIN.losses,win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"0%",total_pnl:BRAIN.totalPnL.toFixed(2),best_setups:BRAIN.bestSetups,best_tickers:BRAIN.bestTickers,lessons:BRAIN.lessons,adjusted_target:BRAIN.adjustedFirstTarget+"%",adjusted_stop:BRAIN.adjustedStop+"%"},watchlist_size:dynamicWatchlist.length,pending_alerts:chatAlerts.length});
});

// Chat alerts for frontend polling
app.get("/api/alerts", (_, res)=>{
  const alerts=[...chatAlerts];
  chatAlerts.length=0;
  res.json({alerts});
});

// Chat with smart keywords
app.post("/api/chat", async(req, res)=>{
  const {messages}=req.body;
  if(!messages?.length) return res.status(400).json({error:"No messages"});
  try {
    const userMsg=messages[messages.length-1]?.content?.toLowerCase()||"";

    // MOVERS keyword
    if(userMsg.match(/\b(movers?|gainers?|top stocks?|what.?s moving|hot stocks?|spikes?)\b/)){
      const top=lastGainers.slice(0,8);
      if(top.length){
        const list=top.map(g=>`${g.ticker}+${(g.dp||0).toFixed(1)}%@$${g.c}`).join(" | ");
        return res.json({reply:`🔥 TOP MOVERS [${getSessionType()}]:\n\n${top.map((g,i)=>`${i+1}. ${g.ticker} +${(g.dp||0).toFixed(1)}% @ $${g.c} | Vol: ${g.v>=1e6?(g.v/1e6).toFixed(1)+"M":g.v>=1e3?(g.v/1e3).toFixed(0)+"K":g.v||"?"}`).join("\n")}\n\nLast scan: ${lastScanTime?new Date(lastScanTime).toLocaleTimeString():"pending"}\nCheck Movers tab for full order flow.`});
      }
      return res.json({reply:`🔍 Scanning now... Check back in a moment or tap Movers tab. Session: ${getSessionType()}`});
    }

    // STATUS keyword
    if(userMsg.match(/\b(status|how.?s bot|bot running|portfolio|equity|p&l)\b/)){
      const [acc,pos]=await Promise.all([alpaca("/v2/account").catch(()=>null),alpaca("/v2/positions").catch(()=>[])]);
      if(acc){
        const pnl=parseFloat(acc.equity)-parseFloat(acc.last_equity);
        return res.json({reply:`📊 BOT STATUS:\n• ${autoTraderActive?"🟢 RUNNING":"🔴 PAUSED"} | ${getSessionType()}\n• Equity: $${parseFloat(acc.equity).toFixed(2)}\n• Today: ${pnl>=0?"+":""}$${pnl.toFixed(2)} (${((pnl/parseFloat(acc.last_equity))*100).toFixed(2)}%)\n• Cash: $${parseFloat(acc.cash).toFixed(2)}\n• Open positions: ${Array.isArray(pos)?pos.length:0}\n• Brain: ${BRAIN.totalTrades} trades | ${BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0):0}% win rate | $${BRAIN.totalPnL.toFixed(2)} P&L\n• Watchlist: ${dynamicWatchlist.length} tickers\n• Last scan: ${lastScanTime?new Date(lastScanTime).toLocaleTimeString():"never"}`});
      }
    }

    // HOLDINGS keyword
    if(userMsg.match(/\b(holdings?|positions?|open trades?|what.?s open|my stocks?)\b/)){
      const pos=await alpaca("/v2/positions").catch(()=>[]);
      if(Array.isArray(pos)&&pos.length){
        const list=pos.map(p=>`${p.symbol}: ${p.qty} @ $${parseFloat(p.avg_entry_price).toFixed(2)} → $${parseFloat(p.current_price).toFixed(2)} | P&L ${parseFloat(p.unrealized_plpc)*100>=0?"+":""}${(parseFloat(p.unrealized_plpc)*100).toFixed(1)}% ($${parseFloat(p.unrealized_pl).toFixed(2)})`).join("\n");
        return res.json({reply:`📊 OPEN POSITIONS (${pos.length}):\n\n${list}`});
      }
      return res.json({reply:"📊 No open positions right now."});
    }

    // HOW'S [TICKER] keyword
    const tickerMatch=userMsg.match(/how.?s\s+([a-z]{1,5})\b/i)||userMsg.match(/\b([a-z]{2,5})\s+(analysis|setup|chart|looking|doing)\b/i);
    if(tickerMatch){
      const ticker=tickerMatch[1].toUpperCase();
      try {
        const [q,of,tech]=await Promise.all([finnhub(`/quote?symbol=${ticker}`),getOrderFlow(ticker,0),getFullTechnicals(ticker,0)]);
        if(q.c>0){
          const reply=await groq(`Quick analysis of ${ticker}:\nPrice: $${q.c} ${q.dp>=0?"+":""}${q.dp?.toFixed(2)}%\nVWAP: ${tech?.aboveVWAP?"above":"below"} ($${tech?.vwap})\nEMA9: $${tech?.ema9} | Vol ratio: ${tech?.volRatio}x\nSD Flip: ${tech?.sdFlip?.detected?"YES":"no"} | DipRip: ${tech?.dipRip?.detected?"YES":"no"}\nOrder Flow: ${of?.grade} | Score: ${of?.entryScore}/3\nFootprint: ${of?.footprint?.buyPct||"?"}% buys\n\nIs this Kev setup? Which one? Entry, target, stop? 3 sentences max.`,300);
          return res.json({reply:`📊 ${ticker} @ $${q.c} (${q.dp>=0?"+":""}${q.dp?.toFixed(2)}%)\n\n${reply}`});
        }
      } catch(_) {}
    }

    // General AI
    const [spy,account]=await Promise.all([finnhub("/quote?symbol=SPY").catch(()=>null),alpaca("/v2/account").catch(()=>null)]);
    const gs=lastGainers.slice(0,5).map(g=>`${g.ticker}+${(g.dp||0).toFixed(0)}%`).join(",")||"scanning";
    const ctx=[spy?.c?`[SPY $${spy.c} ${spy.dp>=0?"+":""}${spy.dp?.toFixed(2)}%]`:"",account?`[Equity:$${parseFloat(account.equity).toFixed(0)}|Cash:$${parseFloat(account.cash).toFixed(0)}]`:"",autoTraderActive?`[Bot:RUNNING|${getSessionType()}|Top:${gs}]`:"[Bot:PAUSED]",BRAIN.totalTrades>0?`[Brain:${BRAIN.totalTrades}T|${((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0)}%WR|$${BRAIN.totalPnL.toFixed(0)}P&L]`:""].filter(Boolean).join(" ");
    const last=messages[messages.length-1];
    const enriched=[...messages.slice(0,-1),{...last,content:last.content+"\n"+ctx}];
    res.json({reply:await groqChat(enriched)});
  } catch(e){res.status(500).json({error:e.message});}
});

// Movers
app.get("/api/movers", async(req, res)=>{
  try {
    const {type="gainers"}=req.query;
    let raw=[];
    if(type==="losers") raw=await getTopLosers();
    else if(type==="active") raw=await getMostActive();
    else raw=await getTopGainers(true);
    lastGainers=raw.slice(0,20);
    if(!raw.length) return res.json({gainers:[],analysis:"No movers right now.",scanned:0,ts:new Date().toISOString()});
    const top=raw.slice(0,15);
    const enriched=await Promise.all(top.map(async g=>{
      try {
        const ago3=new Date(Date.now()-3*86400000).toISOString().split("T")[0];
        const today=new Date().toISOString().split("T")[0];
        const [prof,news]=await Promise.all([finnhub(`/stock/profile2?symbol=${g.ticker}`),finnhub(`/company-news?symbol=${g.ticker}&from=${ago3}&to=${today}`)]);
        const topNews=Array.isArray(news)?news.slice(0,3).map(n=>({headline:n.headline,source:n.source,url:n.url,datetime:n.datetime})):[];
        const vf=g.v>=1e6?(g.v/1e6).toFixed(1)+"M":g.v>=1e3?(g.v/1e3).toFixed(0)+"K":String(g.v||0);
        const floatSh=parseFloat(prof?.shareOutstanding||0)*1e6;
        const fr=floatSh>0?(g.v/floatSh).toFixed(1):null;
        return {symbol:g.ticker,name:prof?.name||g.ticker,price:parseFloat(g.c||0).toFixed(2),change_pct:parseFloat(g.dp||0).toFixed(2),volume:g.v||0,volume_fmt:vf,float:prof?.shareOutstanding||null,float_rotation:fr,mkt_cap:prof?.marketCapitalization||null,industry:prof?.finnhubIndustry||null,news:topNews,catalyst:topNews[0]?.headline||null,source:g.source||"scan"};
      } catch(_){
        const vf=g.v>=1e6?(g.v/1e6).toFixed(1)+"M":g.v>=1e3?(g.v/1e3).toFixed(0)+"K":String(g.v||0);
        return {symbol:g.ticker,name:g.ticker,price:parseFloat(g.c||0).toFixed(2),change_pct:parseFloat(g.dp||0).toFixed(2),volume:g.v||0,volume_fmt:vf,float:null,float_rotation:null,mkt_cap:null,industry:null,news:[],catalyst:null,source:g.source||"scan"};
      }
    }));
    let analysis="";
    try {
      const t5=enriched.slice(0,5).map(g=>`${g.symbol}(${g.name}): $${g.price} ${g.change_pct>=0?"+":""}${g.change_pct}% | Vol:${g.volume_fmt} | FloatRot:${g.float_rotation||"?"}x | ${g.catalyst||"no catalyst"}`).join("\n");
      analysis=await groq(`${type==="losers"?"LOSERS — find bounce setups:":"TOP MOVERS — find early spikes:"}\n\n${t5}\n\nApply Kev's 6 setups. Identify entry tier (early/confirmed). News bonus +2. End: #1 PICK: [TICKER] — [reason]`,500);
    } catch(_){analysis="AI unavailable.";}
    res.json({gainers:enriched,analysis,scanned:raw.length,session:getSessionType(),ts:new Date().toISOString()});
  } catch(e){res.status(500).json({error:e.message});}
});

// Spark charts batch endpoint
app.get("/api/sparks", async(req, res)=>{
  try {
    const {tickers=""}=req.query;
    const list=tickers.split(",").map(t=>t.trim().toUpperCase()).filter(Boolean).slice(0,20);
    if(!list.length) return res.json({});
    const now=new Date(),start=new Date(now);
    start.setHours(4,0,0,0);
    const results={};
    await Promise.all(list.map(async ticker=>{
      try {
        const d=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=1Min&start=${start.toISOString()}&feed=iex&limit=480`);
        const bars=d.bars||[];
        if(!bars.length){results[ticker]={closes:[],open:0,current:0,pctFromOpen:0,vols:[]};return;}
        const open=bars[0].o;
        const current=bars[bars.length-1].c;
        const pctFromOpen=open>0?((current-open)/open)*100:0;
        results[ticker]={closes:bars.map(b=>b.c),vols:bars.map(b=>b.v||0),open,current,pctFromOpen:parseFloat(pctFromOpen.toFixed(2)),ts:bars.map(b=>b.t)};
      } catch(_){results[ticker]={closes:[],open:0,current:0,pctFromOpen:0,vols:[]};}
    }));
    res.json(results);
  } catch(e){res.status(500).json({error:e.message});}
});

// Order flow routes
app.get("/api/orderflow/:ticker", async(req, res)=>{
  try {const ticker=req.params.ticker.toUpperCase();const q=await finnhub(`/quote?symbol=${ticker}`);const of=await getOrderFlow(ticker,q.c||0);res.json({ticker,price:q.c,pct:q.dp,orderFlow:of,ts:new Date().toISOString()});} catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/footprint/:ticker",     async(req,res)=>{try{res.json({ticker:req.params.ticker.toUpperCase(),footprint:await getFootprint(req.params.ticker.toUpperCase()),ts:new Date().toISOString()});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/heatmap/:ticker",       async(req,res)=>{try{res.json({ticker:req.params.ticker.toUpperCase(),heatmap:await getLiquidityMap(req.params.ticker.toUpperCase()),ts:new Date().toISOString()});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/volumeprofile/:ticker", async(req,res)=>{try{res.json({ticker:req.params.ticker.toUpperCase(),volumeProfile:await getVolumeProfile(req.params.ticker.toUpperCase()),ts:new Date().toISOString()});}catch(e){res.status(500).json({error:e.message});}});

// Holdings
app.get("/api/holdings", async(_,res)=>{
  try {
    const positions=await alpaca("/v2/positions");
    if(!Array.isArray(positions)||!positions.length) return res.json({holdings:[],total_value:"0.00",total_pnl:"0.00",total_pnl_today:"0.00",count:0});
    const holdings=positions.map(p=>({symbol:p.symbol,qty:parseFloat(p.qty),side:p.side,avg_entry:parseFloat(p.avg_entry_price).toFixed(2),current_price:parseFloat(p.current_price).toFixed(2),market_value:parseFloat(p.market_value).toFixed(2),unrealized_pnl:parseFloat(p.unrealized_pl).toFixed(2),unrealized_pnl_pct:(parseFloat(p.unrealized_plpc)*100).toFixed(2)+"%",today_pnl:parseFloat(p.unrealized_intraday_pl).toFixed(2),today_pnl_pct:(parseFloat(p.unrealized_intraday_plpc)*100).toFixed(2)+"%",first_target:(parseFloat(p.avg_entry_price)*(1+CONFIG.FIRST_TARGET_PCT/100)).toFixed(2),hard_stop:(parseFloat(p.avg_entry_price)*(1-CONFIG.HARD_STOP_PCT/100)).toFixed(2),half_sold:openTrades[p.symbol]?.halfSold||false,setup:openTrades[p.symbol]?.setup||"unknown",tier:openTrades[p.symbol]?.tier||"?",order_flow_entry:openTrades[p.symbol]?.orderFlowAtEntry||"—",float_rotation:openTrades[p.symbol]?.floatRot||"—",has_catalyst:openTrades[p.symbol]?.hasCatalyst||false}));
    res.json({holdings,total_value:holdings.reduce((s,h)=>s+parseFloat(h.market_value),0).toFixed(2),total_pnl:holdings.reduce((s,h)=>s+parseFloat(h.unrealized_pnl),0).toFixed(2),total_pnl_today:holdings.reduce((s,h)=>s+parseFloat(h.today_pnl),0).toFixed(2),count:holdings.length});
  } catch(e){res.status(500).json({error:e.message});}
});

// P&L
app.get("/api/pnl", async(_,res)=>{
  try {
    const trades=await supabase("pulsetrader_trades?order=created_at.desc&limit=500");
    if(!Array.isArray(trades)) return res.status(500).json({error:"DB error"});
    const closed=trades.filter(t=>t.pnl!=null),open=trades.filter(t=>t.pnl==null);
    const total=closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0);
    const winners=closed.filter(t=>parseFloat(t.pnl)>0).length;
    const best=closed.reduce((b,t)=>(!b||parseFloat(t.pnl)>parseFloat(b.pnl)?t:b),null);
    const worst=closed.reduce((b,t)=>(!b||parseFloat(t.pnl)<parseFloat(b.pnl)?t:b),null);
    res.json({summary:{total_pnl:total.toFixed(2),avg_pnl:closed.length?(total/closed.length).toFixed(2):"0.00",win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",total_trades:trades.length,closed:closed.length,open:open.length,winners,losers:closed.length-winners,best_trade:best?{symbol:best.symbol,pnl:best.pnl}:null,worst_trade:worst?{symbol:worst.symbol,pnl:worst.pnl}:null},recent:trades.slice(0,20),open_positions:open});
  } catch(e){res.status(500).json({error:e.message});}
});

// Account
app.get("/api/account", async(_,res)=>{
  try{const d=await alpaca("/v2/account");const pnl=parseFloat(d.equity)-parseFloat(d.last_equity);res.json({equity:parseFloat(d.equity).toFixed(2),cash:parseFloat(d.cash).toFixed(2),buying_power:parseFloat(d.buying_power).toFixed(2),pnl_today:pnl.toFixed(2),pnl_today_pct:((pnl/parseFloat(d.last_equity))*100).toFixed(2)+"%",day_trade_count:d.daytrade_count,status:d.status,paper:true});}catch(e){res.status(500).json({error:e.message});}
});

// Quote
app.get("/api/quote", async(req,res)=>{
  const{ticker="SPY"}=req.query;
  try{const[q,p]=await Promise.all([finnhub(`/quote?symbol=${ticker.toUpperCase()}`),finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`)]);res.json({ticker,price:q.c,change:q.d,pct:q.dp,high:q.h,low:q.l,open:q.o,prev:q.pc,name:p.name,industry:p.finnhubIndustry,market_cap:p.marketCapitalization,float:p.shareOutstanding});}catch(e){res.status(500).json({error:e.message});}
});

// Bars (for charts)
app.get("/api/bars", async(req,res)=>{
  const{ticker="SPY",timeframe="5Min",limit=78}=req.query;
  try{const d=await alpacaData(`/v2/stocks/${ticker.toUpperCase()}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`);res.json({ticker:ticker.toUpperCase(),bars:d.bars||[],ts:new Date().toISOString()});}catch(e){res.status(500).json({error:e.message});}
});

// Orders
app.get("/api/orders", async(_,res)=>{
  try{const o=await alpaca("/v2/orders?status=all&limit=25&direction=desc");if(!Array.isArray(o)) return res.json([]);res.json(o.map(x=>({id:x.id,symbol:x.symbol,side:x.side,qty:x.qty,filled_qty:x.filled_qty,price:x.filled_avg_price||null,status:x.status,submitted:x.submitted_at,filled:x.filled_at})));}catch(e){res.status(500).json({error:e.message});}
});

// Manual order
app.post("/api/order", async(req,res)=>{
  const{symbol,side,qty,type="market",limit_price,time_in_force="day"}=req.body;
  if(!symbol||!side||!qty) return res.status(400).json({error:"symbol,side,qty required"});
  try{const body={symbol:symbol.toUpperCase(),side,qty:String(qty),type,time_in_force};if(type==="limit"&&limit_price)body.limit_price=String(limit_price);res.json({success:true,order:await alpaca("/v2/orders",{method:"POST",body:JSON.stringify(body)})});}catch(e){res.status(500).json({error:e.message});}
});

// Sell all
app.post("/api/autotrader/sellall", async(_,res)=>{
  try{const p=await alpaca("/v2/positions");if(!Array.isArray(p)||!p.length) return res.json({message:"No positions"});await Promise.all(p.map(x=>alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:x.symbol,qty:x.qty,side:"sell",type:"market",time_in_force:"day"})})));res.json({message:`Sold ${p.length} positions`});}catch(e){res.status(500).json({error:e.message});}
});

// Trades DB
app.get("/api/trades", async(_,res)=>{try{res.json(await supabase("pulsetrader_trades?order=created_at.desc&limit=500").then(d=>Array.isArray(d)?d:[]));}catch(e){res.status(500).json({error:e.message});}});

// Teach
app.post("/api/teach", async(req,res)=>{
  const{tickers,context,instruction}=req.body;
  if(!tickers?.length) return res.status(400).json({error:"tickers required"});
  const list=Array.isArray(tickers)?tickers:[tickers];
  const lessons=[];
  for(const ticker of list){
    try{
      const week=new Date(Date.now()-7*86400000).toISOString().split("T")[0];
      const today=new Date().toISOString().split("T")[0];
      const[quote,profile,news,tech,l2,of]=await Promise.all([finnhub(`/quote?symbol=${ticker.toUpperCase()}`),finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),getFullTechnicals(ticker.toUpperCase(),0),getLevel2(ticker.toUpperCase()),getOrderFlow(ticker.toUpperCase(),0)]);
      const headlines=Array.isArray(news)?news.slice(0,6).map(n=>`- ${n.headline}`).join("\n"):"No news.";
      const analysis=await groq(`${instruction||"Analyze Kev's 6 setups + order flow"}\n\n${ticker.toUpperCase()}: $${quote.c} | ${quote.dp>=0?"+":""}${quote.dp?.toFixed(2)}%\nTech: SDFlip:${tech?.sdFlip?.detected} | DipRip:${tech?.dipRip?.detected} | Gapper:${tech?.gapper?.detected} | VWAP:${tech?.aboveVWAP?"above":"below"} | Vol:${tech?.volRatio}x\nL2: ${l2?.signal}\nOF: ${of?.grade} | ${of?.footprint?.buyPct||"?"}% buys\n${context?"Context:"+context+"\n":""}News:\n${headlines}`,1000);
      const lesson=analysis.slice(-150);
      BRAIN.lessons.unshift(lesson);BRAIN.lessons=BRAIN.lessons.slice(0,10);
      await supabase("bot_lessons",{method:"POST",body:JSON.stringify({ticker:ticker.toUpperCase(),lesson,pattern:instruction||"user taught",taught_by:"user"})}).catch(()=>{});
      await addToWatchlist(ticker.toUpperCase(),quote.dp,quote.c,"TEACH");
      lessons.push({ticker:ticker.toUpperCase(),analysis,lesson,tech,l2,orderFlow:of});
    }catch(e){lessons.push({ticker,error:e.message});}
  }
  res.json({message:`Studied ${lessons.length} stocks`,lessons});
});

// Brain
app.get("/api/autotrader/brain", (_,res)=>res.json({...BRAIN,watchlist:dynamicWatchlist.slice(0,50)}));

// Health
app.get("/health", (_,res)=>res.json({status:"ok",version:"11.0.0",strategy:"Kev 6 Setups + Early Spike + Order Flow + Smart Sessions",session:getSessionType(),scan_interval:getScanInterval()/60000+"min",auto_trader:autoTraderActive,brain_trades:BRAIN.totalTrades,win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"learning",watchlist_size:dynamicWatchlist.length,ts:new Date().toISOString()}));

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════
const PORT=process.env.PORT||3001;
app.listen(PORT, async()=>{
  console.log(`⚡ PulseTrader v11.0 on port ${PORT}`);
  console.log(`   Security : Passcode protected`);
  console.log(`   Strategy : Kev's 6 Setups + Early Spike Detection`);
  console.log(`   Scanner  : 3-layer (Alpaca + Snapshots + Dynamic Watchlist)`);
  console.log(`   Sessions : OVERNIGHT/PRE/REGULAR/AH — smart intervals`);
  console.log(`   OrderFlow: Footprint + LiqMap + VolProfile`);
  console.log(`   Entry    : Early(3-7x,3/3OF,9+) | Confirmed(7-15x,2/3OF,7+)`);
  console.log(`   Exit     : +30% half | Trail | Footprint exhaust | Vol decline`);
  console.log(`   Brain    : Persists via Supabase`);
  await loadMemory();
  console.log("🤖 Auto-starting...");
  startAutoTrader();
});
