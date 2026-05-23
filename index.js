// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PULSETRADER v12.0 — JEEZY STRATEGY                                   ║
// ║  S/D Flip | AH Gapper | Dip & Rip | VWAP Reclaim | 200MA Confluence  ║
// ║  Order Flow + Heat Map — predict price action, not just volume        ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import express from "express";
import cors    from "cors";
import fetch   from "node-fetch";
import crypto  from "crypto";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ── AUTH ──────────────────────────────────────────────────────────────────
const PASSCODE   = process.env.PASSCODE || "092783";
const makeToken  = () => crypto.createHmac("sha256", PASSCODE).update("pt_auth").digest("hex");

const parseCookies = req => {
  const list = {}, h = req.headers.cookie;
  if (!h) return list;
  h.split(";").forEach(c => { const [k,...v]=c.trim().split("="); list[k.trim()]=decodeURIComponent(v.join("=")); });
  return list;
};

const isAuthed = req => {
  const tok = req.headers["x-auth-token"] || parseCookies(req).pt_session;
  return tok === makeToken();
};

const requireAuth = (req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.headers["x-auth-token"] || req.headers["content-type"]?.includes("json"))
    return res.status(401).json({ error: "Unauthorized" });
  res.redirect("/login");
};

// ── LOGIN PAGE ────────────────────────────────────────────────────────────
app.get("/login", (req, res) => {
  const err = req.query.error ? "WRONG PASSCODE — TRY AGAIN" : "";
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>PulseTrader</title>
<style>
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
<div><div class="bolt">⚡</div><div class="title">PULSETRADER</div><div class="sub">JEEZY STRATEGY · ORDER FLOW · PAPER TRADING</div></div>
<div class="box">
  <form method="POST" action="/login">
    <label>ENTER PASSCODE</label>
    <input type="password" name="passcode" maxlength="20" placeholder="••••••••" autocomplete="off" autofocus>
    <button type="submit">AUTHENTICATE</button>
    <div class="err">${err}</div>
  </form>
</div></body></html>`);
});

app.post("/login", (req, res) => {
  const { passcode } = req.body;
  console.log(`🔐 Login: ${passcode === PASSCODE ? "SUCCESS ✅" : "FAILED ❌"}`);
  if (passcode !== PASSCODE) return res.redirect("/login?error=1");
  res.setHeader("Set-Cookie", `pt_session=${makeToken()}; Path=/; HttpOnly; Max-Age=2592000`);
  res.redirect("/");
});

app.post("/api/auth", (req, res) => {
  const { passcode } = req.body;
  if (passcode !== PASSCODE) return res.status(403).json({ error: "Wrong passcode." });
  const token = makeToken();
  res.setHeader("Set-Cookie", `pt_session=${token}; Path=/; HttpOnly; Max-Age=2592000`);
  res.json({ token });
});

app.get("/api/ping", (_, res) => res.json({ ok: true }));
app.use("/api", requireAuth);

// ════════════════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  POSITION_PCT:        0.20,
  EARLY_POSITION_PCT:  0.10,
  MIN_POSITION_USD:    100,
  MIN_SPIKE_PCT:       5,
  MIN_VOLUME_RATIO:    10,
  MIN_FLOAT_ROTATION:  5,
  MIN_CONVICTION:      7,
  MAX_PRICE:           9999,
  MIN_PRICE:           0.01,
  FIRST_TARGET_PCT:    30,
  TRAIL_STOP_PCT:      10,
  HARD_STOP_PCT:       15,
  VOLUME_DRY_REDUCE:   0.50,
  SCAN_INTERVAL:       3 * 60 * 1000,
  TOP_GAINERS_COUNT:   100,
  L2_BID_ASK_RATIO:    1.2,
  OF_BUY_PCT_ENTRY:    52,
  OF_BUY_PCT_STRONG:   60,
  OF_BUY_PCT_EXIT:     48,
  OF_BUY_PCT_EXHAUST:  65,
};

// ════════════════════════════════════════════════════════════════════════════
// BRAIN
// ════════════════════════════════════════════════════════════════════════════
const BRAIN = {
  totalTrades:0, wins:0, losses:0, totalPnL:0,
  bestSetups:{}, bestTickers:[], recentPerformance:[],
  adjustedFirstTarget:30, adjustedStop:15, adjustedConviction:7,
  lessons:[], lastLearned:null,
};

const tradeLog       = [];
const openTrades     = {};
const buyPctHistory  = {};
let autoTraderActive = false;
let scanInterval     = null;
let lastScanTime     = null;
let lastGainers      = [];
let lastAnalysis     = "";

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — JEEZY STRATEGY
// ════════════════════════════════════════════════════════════════════════════
const buildSystem = () => {
  const wr = BRAIN.totalTrades > 0 ? ((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%" : "learning";
  const topSetups = Object.entries(BRAIN.bestSetups).sort((a,b)=>b[1].winRate-a[1].winRate).slice(0,3).map(([k,v])=>`${k}(${v.winRate.toFixed(0)}%)`).join(", ")||"none yet";
  const lessons = BRAIN.lessons.slice(0,5).map(l=>`- ${l}`).join("\n")||"none yet";
  return `You are PulseTrader — elite small cap momentum trader using the JEEZY STRATEGY.
ONLY analyze REAL stocks from data provided. NEVER invent tickers or prices.
Win rate: ${wr} | P&L: $${BRAIN.totalPnL.toFixed(2)} | Best setups: ${topSetups}
Target: +${BRAIN.adjustedFirstTarget}% first exit | Stop: -${BRAIN.adjustedStop}%
LESSONS:\n${lessons}

═══ THE JEEZY STRATEGY — 6 SETUPS ═══

SETUP 1 — S/D FLIP (Primary, highest win rate)
• Identify supply zone: previous resistance, closing range high, prior highs
• Wait for price to BREAK ABOVE the supply zone
• Confirm: HIGHER LOWS forming OVER the broken supply — this IS the confirmation
• NO BREAK = NO TRADE. Never buy anticipating. Only after break + higher lows confirmed.
• Target: daily gap fill or next supply zone above
• Entry: on confirmation of higher lows, not on the break itself

SETUP 2 — AFTER-HOURS GAPPER + S/D FLIP (Day 2 continuation)
• Stock gaps up after-hours or pre-market
• VWAP gets dragged up underneath AH supply = adds confluence
• Next session: watch for break OVER the AH supply zone
• Then higher lows must form OVER it = confirms the S/D flip
• NO BREAK = NO TRADE even on strong gappers
• Enter after confirmation, target AH highs then new highs

SETUP 3 — TWO-WAY WATCH (when setup is strong)
• Way 1: Straight S/D flip over highs — break + higher lows confirmation
• Way 2: Pullback to local demand/VWAP — higher lows form there — curl back up toward supply — enter on curl targeting break
• Watch both simultaneously, trade whichever triggers first

SETUP 4 — DIP AND RIP OFF 9/20 EMA
• After initial spike, pullback to 9 EMA or 20 EMA
• Volume drops on pullback = healthy, not panic
• Higher lows forming on the EMA
• Volume picks back up on the curl
• Enter on the curl, trail at 9 EMA

SETUP 5 — VWAP RECLAIM
• Price fades below VWAP then reclaims with volume
• Enter on the reclaim, trail stop below VWAP
• Target previous highs or supply zone above

SETUP 6 — 200MA + DEMAND CONFLUENCE (Highest conviction)
• Price at BOTH 200MA AND demand zone on daily simultaneously
• Highest conviction = larger position
• Same entry rules — wait for S/D flip confirmation or VWAP reclaim

═══ CHART CONFIRMATION (ALL setups) ═══
• Price in UPWARD TREND: higher highs, higher lows on 15m
• ABOVE VWAP: VWAP acting as dynamic support below
• OVER THE DAILY HIGH: confirms strength
• EMAs curling UP and stacked below price (9, 20 pointing up)
• MACD bullish: MACD above signal, histogram green and growing
• Being up 40%, 60%, 76%+ does NOT disqualify — trade the CHART not the % move

═══ VOLUME + ORDER FLOW ═══
• Minimum 10x relative volume, 5x+ float rotation
• Weak/light volume does NOT disqualify — check order flow and heat map instead
• Footprint buy% >52% = buyers in control, valid entry
• Footprint buy% >60% = strong buying, high confidence
• Bid wall below price = support, buyers defending, safe to hold
• Thin ask wall above = easy break incoming, add size
• Bid wall breaks = exit immediately
• Buy% 65%→52% drop = exhaustion, exit

═══ WHAT DISQUALIFIES A TRADE ═══
• No break of supply zone yet (NO BREAK = NO TRADE)
• Below VWAP with no reclaim in sight
• Overhead supply too close — not enough room to run
• Spread too wide — hard to fill cleanly

═══ EXIT RULES ═══
• Sell 50% at first target (+${BRAIN.adjustedFirstTarget}%)
• Trail remaining on 9 EMA — let winners run
• Reduce 50% on volume dry-up (check order flow first, not just volume)
• Full exit if drops below 9 EMA after half sold
• Full exit if buy% exhaustion (65%→52%)
• Full exit if bid wall breaks
• Hard stop -${BRAIN.adjustedStop}%

FORMAT: BUY: TICKER | CONVICTION: X | SETUP: name | REASON: one line
Setup names: sd_flip, ah_gapper, two_way, dip_rip_ema, vwap_reclaim, ma200_confluence`;
};

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════
const groq = async (prompt, maxTokens=1200) => {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({model:"llama-3.3-70b-versatile",max_tokens:maxTokens,messages:[{role:"system",content:buildSystem()},{role:"user",content:prompt}]}),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.choices?.[0]?.message?.content || "No response.";
  } catch(e){console.error("Groq:",e.message);return `Error: ${e.message}`;}
};

const groqChat = async (messages, maxTokens=1200) => {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({model:"llama-3.3-70b-versatile",max_tokens:maxTokens,messages:[{role:"system",content:buildSystem()},...messages]}),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.choices?.[0]?.message?.content || "No response.";
  } catch(e){return `Error: ${e.message}`;}
};

const supabase = async (path, opts={}) => {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`,{
    headers:{apikey:process.env.SUPABASE_KEY,Authorization:`Bearer ${process.env.SUPABASE_KEY}`,"Content-Type":"application/json",Prefer:"return=representation"},...opts,
  });
  const t = await r.text();
  return t ? JSON.parse(t) : [];
};

const alpaca = async (path, opts={}) => {
  const r = await fetch(`https://paper-api.alpaca.markets${path}`,{
    headers:{"APCA-API-KEY-ID":process.env.ALPACA_KEY,"APCA-API-SECRET-KEY":process.env.ALPACA_SECRET,"Content-Type":"application/json"},...opts,
  });
  return r.json();
};

const alpacaData = async path => {
  const r = await fetch(`https://data.alpaca.markets${path}`,{
    headers:{"APCA-API-KEY-ID":process.env.ALPACA_KEY,"APCA-API-SECRET-KEY":process.env.ALPACA_SECRET},
  });
  return r.json();
};

const finnhub = async path => {
  const sep = path.includes("?")?"&":"?";
  const r = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_KEY}`);
  return r.json();
};

const logError = async (ctx, err) => {
  try { await supabase("bot_errors",{method:"POST",body:JSON.stringify({context:ctx,error:String(err?.message||err),ts:new Date().toISOString()})}); } catch(_){}
};

// ════════════════════════════════════════════════════════════════════════════
// TECHNICALS
// ════════════════════════════════════════════════════════════════════════════
const calcEMA = (data, period) => {
  if (!data||data.length<period) return null;
  const k=2/(period+1);
  let ema=data.slice(0,period).reduce((s,v)=>s+v,0)/period;
  for(let i=period;i<data.length;i++) ema=data[i]*k+ema*(1-k);
  return ema;
};

const calcMACD = (closes) => {
  const ema12=calcEMA(closes,12), ema26=calcEMA(closes,26);
  if(!ema12||!ema26) return null;
  const macd=ema12-ema26;
  // signal approximation
  const macdLine=closes.slice(-26).map((_,i)=>{
    const e12=calcEMA(closes.slice(0,closes.length-25+i+1),12);
    const e26=calcEMA(closes.slice(0,closes.length-25+i+1),26);
    return e12&&e26?e12-e26:null;
  }).filter(Boolean);
  const signal=calcEMA(macdLine,9)||macd;
  const histogram=macd-signal;
  return {macd:parseFloat(macd.toFixed(4)),signal:parseFloat(signal.toFixed(4)),histogram:parseFloat(histogram.toFixed(4)),bullish:macd>signal&&histogram>0};
};

const calcVWAP = bars => {
  if(!bars?.length) return 0;
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
  const last3=recent.slice(-3).map(b=>b.c);
  const higherLows=last3.length>=3&&last3[1]>last3[0]&&last3[2]>last3[1];
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
  return {detected:(nearEMA9||nearEMA20)&&aboveEMA9&&volDecline,ema9:ema9?.toFixed(4),ema20:ema20?.toFixed(4),nearEMA9,nearEMA20,aboveEMA9,volDecline};
};

const isUptrend = bars => {
  if(!bars||bars.length<6) return false;
  const recent=bars.slice(-6);
  const highs=recent.map(b=>b.h);
  const lows=recent.map(b=>b.l);
  const higherHighs=highs[highs.length-1]>highs[0];
  const higherLows=lows[lows.length-1]>lows[0];
  return higherHighs&&higherLows;
};

const emasStacked = (ema9, ema20, price) => {
  if(!ema9||!ema20) return false;
  return price>parseFloat(ema9)&&parseFloat(ema9)>parseFloat(ema20);
};

const getFullTechnicals = async (ticker, currentPrice) => {
  try {
    const now=new Date(), start=new Date(now);
    start.setHours(4,0,0,0);
    const bd=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=5Min&start=${start.toISOString()}&limit=78&feed=iex`);
    const bars=bd.bars||[];
    if(bars.length<5) return null;
    const closes=bars.map(b=>b.c);
    const vwap=calcVWAP(bars);
    const ema9=calcEMA(closes,9),ema20=calcEMA(closes,20),ema200=calcEMA(closes,Math.min(200,closes.length));
    const avgVol=calcAvgVolume(bars);
    const lastVol=bars[bars.length-1]?.v||0;
    const volRatio=avgVol>0?lastVol/avgVol:0;
    const totalDayVol=bars.reduce((s,b)=>s+(b.v||0),0);
    const sdFlip=detectSDFlip(bars,currentPrice);
    const dipRip=detectDipRip(bars,currentPrice);
    const macd=calcMACD(closes);
    const uptrend=isUptrend(bars);
    const emasUp=emasStacked(ema9?.toFixed(4),ema20?.toFixed(4),currentPrice);
    const aboveVWAP=currentPrice>=vwap;
    const overDayHigh=currentPrice>=Math.max(...bars.map(b=>b.h));
    const vwapReclaim=currentPrice>=vwap&&bars.slice(-3).some(b=>b.l<vwap);
    const ma200Conf=ema200&&Math.abs(currentPrice-ema200)/ema200<0.05;
    const recentVols=bars.slice(-6).map(b=>b.v||0);
    const volDryUp=recentVols.length>=4&&recentVols.slice(-2).every(v=>v<recentVols.slice(0,-2).reduce((s,x)=>s+x,0)/recentVols.slice(0,-2).length*0.5);
    let decliningVolCandles=0;
    for(let i=bars.length-1;i>0&&decliningVolCandles<3;i--){if((bars[i].v||0)<(bars[i-1].v||0))decliningVolCandles++;else break;}
    return {
      vwap:vwap.toFixed(4),ema9:ema9?.toFixed(4),ema20:ema20?.toFixed(4),ema200:ema200?.toFixed(4),
      aboveVWAP,overDayHigh,uptrend,emasUp,volRatio:volRatio.toFixed(1),
      totalDayVol,avgVol:Math.round(avgVol),
      sdFlip,dipRip,vwapReclaim,ma200Conf,
      macd,volDryUp,decliningVolCandles,bars:bars.length,
    };
  } catch(e){console.log(`Tech ${ticker}:`,e.message);return null;}
};

// ════════════════════════════════════════════════════════════════════════════
// ORDER FLOW + HEAT MAP
// ════════════════════════════════════════════════════════════════════════════
const getLevel2 = async ticker => {
  try {
    const d=await alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`);
    const q=d.quote; if(!q) return null;
    const bidSize=q.bs||0,askSize=q.as||0,bid=q.bp||0,ask=q.ap||0;
    const spread=ask>0?((ask-bid)/ask*100):999;
    const bidAskRatio=askSize>0?bidSize/askSize:0;
    const strongBids=bidAskRatio>=CONFIG.L2_BID_ASK_RATIO;
    return {
      bid,ask,spread:spread.toFixed(2),bidSize,askSize,
      bidAskRatio:bidAskRatio.toFixed(2),strongBids,
      signal:strongBids?"STRONG BIDS — buyers in control":"Weak bids",
    };
  } catch(_){return null;}
};

const getFootprint = async ticker => {
  try {
    const [td,qd]=await Promise.all([
      alpacaData(`/v2/stocks/${ticker}/trades?limit=500&feed=iex`),
      alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`),
    ]);
    const trades=td.trades||[]; if(!trades.length) return null;
    const q=qd.quote,mid=q?(parseFloat(q.bp||0)+parseFloat(q.ap||0))/2:0;
    let totalBuy=0,totalSell=0;
    for(const t of trades){const rp=parseFloat(t.p||0),sz=parseInt(t.s||0);if(rp>=mid&&mid>0)totalBuy+=sz;else totalSell+=sz;}
    const totalVol=totalBuy+totalSell;
    const buyPct=totalVol>0?(totalBuy/totalVol)*100:50;
    const imbalance=buyPct>65?"STRONG_BUY":buyPct>52?"BUY":buyPct<35?"STRONG_SELL":buyPct<48?"SELL":"NEUTRAL";
    return {
      totalBuy,totalSell,totalVol,buyPct:buyPct.toFixed(1),
      delta:totalBuy-totalSell,imbalance,
      entryOk:buyPct>=CONFIG.OF_BUY_PCT_ENTRY,
      strongEntry:buyPct>=CONFIG.OF_BUY_PCT_STRONG,
      exitNow:buyPct<=CONFIG.OF_BUY_PCT_EXIT,
      exhaustion:buyPct<=CONFIG.OF_BUY_PCT_EXIT,
    };
  } catch(_){return null;}
};

const getLiquidityMap = async ticker => {
  try {
    let bids=[],asks=[];
    try{
      const od=await alpacaData(`/v2/stocks/${ticker}/orderbook/latest?feed=iex`);
      const ob=od.orderbook;
      if(ob?.b?.length){
        bids=ob.b.slice(0,10).map(b=>({price:parseFloat(b.p),size:parseInt(b.s)}));
        asks=ob.a.slice(0,10).map(a=>({price:parseFloat(a.p),size:parseInt(a.s)}));
      }
    }catch(_){}
    if(!bids.length){
      const qd=await alpacaData(`/v2/stocks/${ticker}/quotes/latest?feed=iex`);
      const q=qd.quote;
      if(q){bids=[{price:parseFloat(q.bp||0),size:parseInt(q.bs||0)}];asks=[{price:parseFloat(q.ap||0),size:parseInt(q.as||0)}];}
    }
    if(!bids.length) return null;
    const totalBid=bids.reduce((s,b)=>s+b.size,0);
    const totalAsk=asks.reduce((s,a)=>s+a.size,0);
    const liqRatio=totalAsk>0?totalBid/totalAsk:1;
    const bigAsk=asks.reduce((b,x)=>(!b||x.size>b.size)?x:b,null);
    const bidWallBelow=bids[0]&&bids[0].size>totalBid*0.3;
    const thinAskAbove=!bigAsk||bigAsk.size<totalAsk*0.3;
    const bidWallBroken=liqRatio<0.8;
    return {
      bids:bids.slice(0,5),asks:asks.slice(0,5),totalBid,totalAsk,
      liqRatio:liqRatio.toFixed(2),
      bidWallBelow,thinAskAbove,bidWallBroken,
      entryFavorable:liqRatio>=1.1&&thinAskAbove,
      exitSignal:bidWallBroken||(bigAsk&&bigAsk.size>totalAsk*0.6),
      signal:liqRatio>1.5?"🟢🟢 Strong bids":liqRatio>1.1?"🟢 Bid favor":liqRatio<0.8?"🔴 Sellers":"⚪ Balanced",
    };
  } catch(_){return null;}
};

const getOrderFlow = async (ticker, price) => {
  try {
    const [fp,lm]=await Promise.all([getFootprint(ticker).catch(()=>null),getLiquidityMap(ticker).catch(()=>null)]);
    let entryScore=0,exitSignals=0;
    if(fp?.entryOk) entryScore++;
    if(fp?.strongEntry) entryScore++;
    if(lm?.entryFavorable) entryScore++;
    if(fp?.exitNow||fp?.exhaustion) exitSignals++;
    if(lm?.bidWallBroken||lm?.exitSignal) exitSignals++;
    const grade=entryScore>=3?"A+ perfect":entryScore===2?"B  good":entryScore===1?"C  weak":"D  avoid";
    return {footprint:fp,liqMap:lm,entryScore,grade,exitSignals,
      shouldEnter:entryScore>=2||(fp?.entryOk&&!lm?.exitSignal),
      shouldExit:exitSignals>=2};
  } catch(_){return null;}
};

// ════════════════════════════════════════════════════════════════════════════
// SCANNER
// ════════════════════════════════════════════════════════════════════════════
const getTopGainers = async () => {
  const gainers=[];
  try {
    const urls=[
      `/v1beta1/screener/stocks/movers?by=percent_change&top=${CONFIG.TOP_GAINERS_COUNT}&market_type=sip`,
      `/v1beta1/screener/stocks/movers?by=percent_change&top=${CONFIG.TOP_GAINERS_COUNT}`,
    ];
    for(const url of urls){
      try{
        const data=await alpacaData(url);
        if(data.gainers?.length){
          for(const g of data.gainers){
            if(g.price>=CONFIG.MIN_PRICE&&g.price<=CONFIG.MAX_PRICE&&g.percent_change>=CONFIG.MIN_SPIKE_PCT)
              gainers.push({ticker:g.symbol,c:g.price,dp:g.percent_change,v:g.volume||0,source:"alpaca"});
          }
          console.log(`📡 Alpaca: ${gainers.length} gainers`);
          break;
        }
      }catch(_){continue;}
    }
  }catch(e){console.log("Screener:",e.message);}

  if(gainers.length<5){
    const SCAN=[
      "WHLR","PCLA","EDHL","ATPC","LIMN","ILLR","NCPL","VIDA","DGNX","JUNS",
      "HCWB","SLXN","PHGE","GCL","MLGO","SOUN","MARA","RIOT","CIFR","BTBT",
      "HUT","WULF","CLSK","OCGN","NVAX","ADMA","BNGO","SRNE","TGTX","EDSA",
      "FBRX","HTBX","SAVA","TE","PETZ","BTM","ORBS","AMMO","STFS","JDZG",
      "ATXI","NKGN","IMVT","CYRX","TRIL","IRNC","LAUR","TRCH","ALTTF","SNAL",
      "AIIO","AUUD","MTVA","NXXT","QUCY","AMST","SACH","POET","UCAR","CODX",
      "GMEX","KULR","MULN","STEM","RVNC","QUBT","KPLT","BBCP","CLFD","JSPR",
      "COIN","PLTR","SOFI","HOOD","LMND","HIMS","MNMD","SMAR","ACMR","GBOX",
    ];
    for(let i=0;i<SCAN.length;i+=15){
      const batch=SCAN.slice(i,i+15);
      const quotes=await Promise.all(batch.map(t=>finnhub(`/quote?symbol=${t}`).then(q=>({ticker:t,...q})).catch(()=>null)));
      for(const q of quotes.filter(Boolean)){
        if(q.c>=CONFIG.MIN_PRICE&&q.dp>=CONFIG.MIN_SPIKE_PCT&&q.v>10000&&!gainers.find(g=>g.ticker===q.ticker))
          gainers.push({ticker:q.ticker,c:q.c,dp:q.dp,v:q.v,source:"finnhub"});
      }
      if(i+15<SCAN.length) await new Promise(r=>setTimeout(r,250));
    }
  }
  return gainers.sort((a,b)=>b.dp-a.dp);
};

const analyzeStock = async (ticker, price, pct) => {
  try {
    const week=new Date(Date.now()-7*86400000).toISOString().split("T")[0];
    const today=new Date().toISOString().split("T")[0];
    const [profile,news]=await Promise.all([finnhub(`/stock/profile2?symbol=${ticker}`),finnhub(`/company-news?symbol=${ticker}&from=${week}&to=${today}`)]);
    const newsItems=Array.isArray(news)?news.slice(0,4):[];
    return {
      ticker,price,pct,
      float:profile.shareOutstanding||"?",mktCap:profile.marketCapitalization||"?",
      industry:profile.finnhubIndustry||"?",
      headlines:newsItems.map(n=>`- ${n.headline}`).join("\n")||"No news",
      hasCatalyst:newsItems.length>0,
      topHeadline:newsItems[0]?.headline||null,
      name:profile.name||ticker,
      convictionBonus:newsItems.length>0?2:0,
    };
  } catch(_){return {ticker,price,pct,float:"?",mktCap:"?",industry:"?",headlines:"No data",hasCatalyst:false,topHeadline:null,name:ticker,convictionBonus:0};}
};

// ════════════════════════════════════════════════════════════════════════════
// BRAIN / MEMORY
// ════════════════════════════════════════════════════════════════════════════
const learnFromTrade = async trade => {
  const won=trade.pnl>0;
  BRAIN.totalTrades++;won?BRAIN.wins++:BRAIN.losses++;BRAIN.totalPnL+=trade.pnl||0;
  if(trade.setup){
    if(!BRAIN.bestSetups[trade.setup])BRAIN.bestSetups[trade.setup]={trades:0,wins:0,winRate:0};
    BRAIN.bestSetups[trade.setup].trades++;
    if(won)BRAIN.bestSetups[trade.setup].wins++;
    BRAIN.bestSetups[trade.setup].winRate=(BRAIN.bestSetups[trade.setup].wins/BRAIN.bestSetups[trade.setup].trades)*100;
  }
  if(won&&!BRAIN.bestTickers.includes(trade.symbol)){BRAIN.bestTickers.unshift(trade.symbol);BRAIN.bestTickers=BRAIN.bestTickers.slice(0,20);}
  BRAIN.recentPerformance.unshift({...trade,won});BRAIN.recentPerformance=BRAIN.recentPerformance.slice(0,20);
  const rw=BRAIN.recentPerformance.filter(t=>t.won).length,rt=BRAIN.recentPerformance.length;
  if(rt>=5){
    const rate=rw/rt;
    if(rate>0.65){BRAIN.adjustedFirstTarget=Math.min(40,BRAIN.adjustedFirstTarget+2);BRAIN.adjustedConviction=Math.max(6,BRAIN.adjustedConviction-1);}
    else if(rate<0.35){BRAIN.adjustedFirstTarget=Math.max(20,BRAIN.adjustedFirstTarget-2);BRAIN.adjustedStop=Math.max(8,BRAIN.adjustedStop-1);BRAIN.adjustedConviction=Math.min(9,BRAIN.adjustedConviction+1);}
    CONFIG.FIRST_TARGET_PCT=BRAIN.adjustedFirstTarget;CONFIG.HARD_STOP_PCT=BRAIN.adjustedStop;CONFIG.MIN_CONVICTION=BRAIN.adjustedConviction;
  }
  try{
    const lesson=await groq(`Trade: ${trade.symbol} | ${won?"WIN ✅":"LOSS ❌"}\nP&L: $${trade.pnl?.toFixed(2)} | Setup: ${trade.setup} | Exit: ${trade.exitReason}\nONE lesson for Jeezy strategy:`,80);
    BRAIN.lessons.unshift(lesson.trim());BRAIN.lessons=BRAIN.lessons.slice(0,10);BRAIN.lastLearned=new Date().toISOString();
  }catch(_){}
  await supabase("bot_trade_memory",{method:"POST",body:JSON.stringify({symbol:trade.symbol,side:"LONG",entry_price:trade.entryPrice,exit_price:trade.exitPrice,pnl:trade.pnl,pnl_pct:trade.pnlPct,entry_reason:trade.reason,exit_reason:trade.exitReason,setup_type:trade.setup,won,entry_hour:new Date().getHours(),day_of_week:new Date().getDay()})}).catch(()=>{});
};

const loadMemory = async () => {
  try {
    const mem=await supabase("bot_trade_memory?order=created_at.desc&limit=200");
    if(!Array.isArray(mem)||!mem.length){console.log("🧠 Fresh start");return;}
    BRAIN.totalTrades=mem.length;BRAIN.wins=mem.filter(m=>m.won).length;BRAIN.losses=mem.filter(m=>!m.won).length;
    BRAIN.totalPnL=mem.reduce((s,m)=>s+parseFloat(m.pnl||0),0);
    mem.forEach(m=>{
      if(m.setup_type){
        if(!BRAIN.bestSetups[m.setup_type])BRAIN.bestSetups[m.setup_type]={trades:0,wins:0,winRate:0};
        BRAIN.bestSetups[m.setup_type].trades++;
        if(m.won)BRAIN.bestSetups[m.setup_type].wins++;
        BRAIN.bestSetups[m.setup_type].winRate=(BRAIN.bestSetups[m.setup_type].wins/BRAIN.bestSetups[m.setup_type].trades)*100;
      }
      if(m.won&&!BRAIN.bestTickers.includes(m.symbol))BRAIN.bestTickers.push(m.symbol);
    });
    BRAIN.bestTickers=BRAIN.bestTickers.slice(0,20);
    const lessons=await supabase("bot_lessons?order=created_at.desc&limit=20");
    if(Array.isArray(lessons))BRAIN.lessons=lessons.map(l=>l.lesson).filter(Boolean);
    console.log(`🧠 Brain: ${mem.length} trades | ${((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0)}% WR | $${BRAIN.totalPnL.toFixed(0)} P&L`);
  }catch(e){console.log("Memory:",e.message);}
  try {
    const positions=await alpaca("/v2/positions");
    if(Array.isArray(positions)&&positions.length){
      for(const p of positions){
        if(!openTrades[p.symbol]){
          openTrades[p.symbol]={reason:"Restored",setup:"unknown",entryPrice:parseFloat(p.avg_entry_price),qty:parseFloat(p.qty),halfSold:false,peakPrice:parseFloat(p.current_price),volumeReduced:false,time:new Date().toISOString()};
          console.log(`📍 Restored: ${p.symbol} x${p.qty} @ $${p.avg_entry_price}`);
        }
      }
    }
  }catch(e){console.log("Restore:",e.message);}
};

// ════════════════════════════════════════════════════════════════════════════
// POSITION MANAGER
// ════════════════════════════════════════════════════════════════════════════
const managePositions = async positions => {
  if(!Array.isArray(positions)) return;
  for(const pos of positions){
    const sym=pos.symbol,pnlPct=parseFloat(pos.unrealized_plpc)*100,cur=parseFloat(pos.current_price);
    const entry=openTrades[sym]; if(!entry) continue;
    if(!entry.peakPrice||cur>entry.peakPrice) entry.peakPrice=cur;
    const fromPeak=entry.peakPrice>0?((cur-entry.peakPrice)/entry.peakPrice)*100:0;

    // Get order flow to predict price action (not just volume)
    const[tech,of]=await Promise.all([getFullTechnicals(sym,cur).catch(()=>null),getOrderFlow(sym,cur).catch(()=>null)]);

    // Track buy% history for exhaustion detection
    if(of?.footprint){
      if(!buyPctHistory[sym])buyPctHistory[sym]=[];
      buyPctHistory[sym].push(parseFloat(of.footprint.buyPct));
      buyPctHistory[sym]=buyPctHistory[sym].slice(-10);
    }
    const bph=buyPctHistory[sym]||[];
    const footprintExhaustion=bph.length>=3&&bph.some(b=>b>=CONFIG.OF_BUY_PCT_EXHAUST)&&bph[bph.length-1]<=52;

    // 1. Sell 50% at first target
    if(!entry.halfSold&&pnlPct>=CONFIG.FIRST_TARGET_PCT){
      const hq=Math.floor(parseFloat(pos.qty)/2);
      if(hq>=1){
        await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:String(hq),side:"sell",type:"market",time_in_force:"day"})});
        entry.halfSold=true;
        tradeLog.unshift({type:"PARTIAL_SELL",symbol:sym,qty:hq,price:cur,pnlPct:pnlPct.toFixed(1),reason:`First target +${CONFIG.FIRST_TARGET_PCT}%`,ts:new Date().toISOString()});
      }
    }

    // 2. Trailing stop
    if(entry.halfSold&&fromPeak<=-CONFIG.TRAIL_STOP_PCT){
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,exitReason:"TRAIL STOP",type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];delete buyPctHistory[sym];continue;
    }

    // 3. Hard stop
    if(pnlPct<=-CONFIG.HARD_STOP_PCT){
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,exitReason:"HARD STOP",type:"STOP",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];continue;
    }

    // 4. Order flow exhaustion exit (buy% spike then drop)
    if(footprintExhaustion&&entry.halfSold){
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,exitReason:"OF EXHAUSTION",type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];delete buyPctHistory[sym];continue;
    }

    // 5. Bid wall broken = exit
    if(of?.liqMap?.bidWallBroken&&entry.halfSold){
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,exitReason:"BID WALL BROKEN",type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];continue;
    }

    // 6. Volume dry-up: check order flow before reducing (not just volume)
    if(tech?.volDryUp&&!entry.volumeReduced){
      // Only reduce if order flow also weak — buyers may still be in control
      const ofWeak=!of||of.footprint?.buyPct<52||of.entryScore<1;
      if(ofWeak){
        const rq=Math.floor(parseFloat(pos.qty)*CONFIG.VOLUME_DRY_REDUCE);
        if(rq>=1){
          await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:String(rq),side:"sell",type:"market",time_in_force:"day"})});
          entry.volumeReduced=true;
          tradeLog.unshift({type:"REDUCE",symbol:sym,qty:rq,price:cur,reason:"Vol dry + weak OF",ts:new Date().toISOString()});
        }
      }
    }

    // 7. Below 9 EMA after half sold
    if(tech?.ema9&&cur<parseFloat(tech.ema9)&&entry.halfSold){
      await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:sym,qty:pos.qty,side:"sell",type:"market",time_in_force:"day"})});
      const t={symbol:sym,pnl:parseFloat(pos.unrealized_pl),pnlPct,entryPrice:pos.avg_entry_price,exitPrice:cur,reason:entry.reason,setup:entry.setup,exitReason:"BELOW 9 EMA",type:"SELL",price:cur,ts:new Date().toISOString()};
      tradeLog.unshift(t);await learnFromTrade(t);delete openTrades[sym];
    }
  }
};

// ════════════════════════════════════════════════════════════════════════════
// AUTO TRADER
// ════════════════════════════════════════════════════════════════════════════
const autoTrade = async () => {
  lastScanTime=new Date().toISOString();
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const d=et.getDay(),t=et.getHours()*100+et.getMinutes();
  const isOpen=d!==0&&d!==6&&t>=930&&t<1600;
  const isPre=d!==0&&d!==6&&t>=400&&t<930;
  const sess=isOpen?"REGULAR":isPre?"PRE":"OVERNIGHT/AH";
  console.log(`🔍 Scanning [${sess}]...`);

  try {
    const[positions,account]=await Promise.all([alpaca("/v2/positions").catch(()=>[]),alpaca("/v2/account").catch(()=>null)]);
    if(isOpen) await managePositions(positions);
    const cash=account?parseFloat(account.cash):0;
    if(cash<CONFIG.MIN_POSITION_USD){console.log("⚠️ Low cash");return;}
    const gainers=await getTopGainers();
    lastGainers=gainers.slice(0,20);
    if(!gainers.length){console.log("⏭️ No gainers");return;}
    console.log(`📊 ${gainers.length} gainers | Top: ${gainers.slice(0,5).map(g=>`${g.ticker}+${g.dp?.toFixed(0)}%`).join(", ")}`);
    const owned=Array.isArray(positions)?positions.map(p=>p.symbol):[];
    const candidates=gainers.filter(g=>!owned.includes(g.ticker)).slice(0,10);
    if(!candidates.length) return;

    const results=await Promise.all(candidates.map(async g=>{
      const[info,tech,l2,of]=await Promise.all([
        analyzeStock(g.ticker,g.c,g.dp),
        getFullTechnicals(g.ticker,g.c),
        getLevel2(g.ticker),
        getOrderFlow(g.ticker,g.c),
      ]);
      return {...g,info,tech,l2,of};
    }));

    // Filter: 10x+ vol OR high % move. Volume alone doesn't disqualify — check OF
    const qualified=results.filter(s=>{
      const volOk=parseFloat(s.tech?.volRatio||0)>=CONFIG.MIN_VOLUME_RATIO||s.dp>=20;
      // If low volume, need order flow to confirm buyers in control
      if(!volOk) return s.of?.footprint?.entryOk&&s.of?.liqMap?.entryFavorable;
      return volOk;
    });

    if(!qualified.length){console.log("⏭️ No qualified");return;}

    const candStr=qualified.slice(0,6).map(s=>{
      const t=s.tech,l=s.l2,of=s.of;
      return `${s.ticker}: $${s.c} +${s.dp?.toFixed(1)}% | Float:${s.info?.float}M\n`+
        `Chart: VWAP ${t?.aboveVWAP?"↑ABOVE":"↓below"} | EMA9:$${t?.ema9} | EMA20:$${t?.ema20} | Uptrend:${t?.uptrend?"YES✅":"no"} | EMAsUp:${t?.emasUp?"YES✅":"no"} | OverDayHigh:${t?.overDayHigh?"YES✅":"no"}\n`+
        `MACD: ${t?.macd?.bullish?"BULLISH✅":"bearish"} (${t?.macd?.macd}/${t?.macd?.signal}) | Vol:${t?.volRatio}x\n`+
        `Setups: SDFlip:${t?.sdFlip?.detected?"YES✅":"no"} | DipRip:${t?.dipRip?.detected?"YES✅":"no"} | VWAPreclaim:${t?.vwapReclaim?"YES✅":"no"} | 200MA:${t?.ma200Conf?"YES✅":"no"}\n`+
        `OrderFlow: ${of?.grade||"?"} | Buy%:${of?.footprint?.buyPct||"?"}% | ${of?.footprint?.imbalance||"?"}\n`+
        `HeatMap: ${of?.liqMap?.signal||"?"} | BidWall:${of?.liqMap?.bidWallBelow?"YES✅":"no"} | ThinAsk:${of?.liqMap?.thinAskAbove?"YES✅":"no"}\n`+
        `L2: ${l?.signal||"?"} | Spread:${l?.spread||"?"}% | News:${s.info?.hasCatalyst?"✅ "+s.info?.topHeadline?.slice(0,40):"none"}`;
    }).join("\n\n");

    lastAnalysis=candStr;

    const verdict=await groq(
      `REAL stocks — Jeezy strategy:\n\n${candStr}\n\n`+
      `Apply ALL rules:\n`+
      `1. S/D flip confirmed? (broke supply + higher lows forming)\n`+
      `2. Chart in uptrend? Above VWAP? Over daily high? EMAs stacked up?\n`+
      `3. MACD bullish? Histogram growing?\n`+
      `4. Order flow: buy% >52%? Bid wall below? Thin ask above?\n`+
      `5. Spread clean? Room to run above?\n`+
      `NOTE: Being up 40%+ does NOT disqualify if chart/OF confirms\n\n`+
      `Pick ALL qualifying (conviction ${CONFIG.MIN_CONVICTION}+).\n`+
      `Reply ONLY:\nBUY: TICKER | CONVICTION: X | SETUP: name | REASON: one line`,600
    );

    console.log("🤖",verdict);

    for(const line of verdict.split("\n").filter(l=>l.startsWith("BUY:"))){
      const m=line.match(/BUY:\s*([A-Z]+)\s*\|\s*CONVICTION:\s*([\d.]+)/i);
      if(!m) continue;
      const ticker=m[1].toUpperCase(),conviction=parseFloat(m[2]);
      if(conviction<CONFIG.MIN_CONVICTION||owned.includes(ticker)) continue;
      const stock=qualified.find(s=>s.ticker===ticker);
      if(!stock||stock.c<=0) continue;
      // Skip if spread too wide
      if(stock.l2&&parseFloat(stock.l2.spread)>5){console.log(`🚫 ${ticker} spread too wide`);continue;}
      // Skip if below VWAP with no reclaim
      if(stock.tech&&!stock.tech.aboveVWAP&&!stock.tech.vwapReclaim){console.log(`🚫 ${ticker} below VWAP`);continue;}
      // Skip if overhead supply too close (price within 2% of resistance)
      if(stock.tech?.sdFlip?.prevHigh&&!stock.tech.sdFlip.brokeAbove){console.log(`🚫 ${ticker} no supply break`);continue;}
      const qty=Math.floor((cash*CONFIG.POSITION_PCT)/stock.c);
      if(qty<1) continue;
      const setup=line.match(/SETUP:\s*([a-z_]+)/i)?.[1]||"momentum";
      const reason=line.match(/REASON:\s*(.+)/i)?.[1]||"Jeezy signal";
      const finalConviction=conviction+(stock.info?.convictionBonus||0);
      console.log(`🚀 BUY ${ticker} x${qty} @ $${stock.c} | ${setup} | c${finalConviction}`);
      const order=await alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:ticker,qty:String(qty),side:"buy",type:"market",time_in_force:"day"})});
      if(order.id){
        openTrades[ticker]={reason,setup,conviction:finalConviction,entryPrice:stock.c,qty,halfSold:false,peakPrice:stock.c,volumeReduced:false,time:new Date().toISOString(),hasCatalyst:stock.info?.hasCatalyst};
        buyPctHistory[ticker]=[];
        tradeLog.unshift({type:"BUY",symbol:ticker,qty,price:stock.c,conviction:finalConviction,reason,setup,target:(stock.c*(1+CONFIG.FIRST_TARGET_PCT/100)).toFixed(2),stop:(stock.c*(1-CONFIG.HARD_STOP_PCT/100)).toFixed(2),ts:new Date().toISOString()});
        await supabase("pulsetrader_trades",{method:"POST",body:JSON.stringify({symbol:ticker,side:"LONG",qty,entry_price:stock.c,reason:`AUTO[${setup}|c${finalConviction}]: ${reason}`})}).catch(()=>{});
        console.log(`✅ Bought ${ticker}`);
      } else await logError("order",`${ticker}: ${JSON.stringify(order)}`);
    }
  }catch(e){console.error("AutoTrade:",e.message);await logError("autoTrade",e);}
};

const startAutoTrader=()=>{if(autoTraderActive)return;autoTraderActive=true;console.log("🤖 AutoTrader STARTED — Jeezy Strategy");autoTrade();scanInterval=setInterval(autoTrade,CONFIG.SCAN_INTERVAL);};
const stopAutoTrader=()=>{if(scanInterval)clearInterval(scanInterval);autoTraderActive=false;scanInterval=null;console.log("⏹️ Stopped");};

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/autotrader/start",(_, res)=>{startAutoTrader();res.json({status:"started"});});
app.get( "/api/autotrader/start",(_, res)=>{startAutoTrader();res.json({status:"started"});});
app.post("/api/autotrader/stop", (_, res)=>{stopAutoTrader(); res.json({status:"stopped"});});
app.post("/api/autotrader/scan", async(_,res)=>{res.json({message:"Scan triggered"});autoTrade();});

app.get("/api/autotrader/status", async(_, res)=>{
  const[positions,account]=await Promise.all([alpaca("/v2/positions").catch(()=>[]),alpaca("/v2/account").catch(()=>null)]);
  const todayPnL=account?parseFloat(account.equity)-parseFloat(account.last_equity):0;
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const d=et.getDay(),t=et.getHours()*100+et.getMinutes();
  const sess=d===0||d===6?"WEEKEND":t>=930&&t<1600?"REGULAR":t>=400&&t<930?"PRE":"OVERNIGHT/AH";
  res.json({active:autoTraderActive,last_scan:lastScanTime,session:sess,open_positions:Array.isArray(positions)?positions.length:0,equity:account?parseFloat(account.equity).toFixed(2):"—",cash:account?parseFloat(account.cash).toFixed(2):"—",today_pnl:todayPnL.toFixed(2),today_pnl_pct:account?((todayPnL/parseFloat(account.last_equity))*100).toFixed(2)+"%":"—",config:{position_pct:(CONFIG.POSITION_PCT*100)+"%",first_target:CONFIG.FIRST_TARGET_PCT+"%",trail_stop:CONFIG.TRAIL_STOP_PCT+"%",hard_stop:CONFIG.HARD_STOP_PCT+"%",min_conviction:CONFIG.MIN_CONVICTION,scan_interval:"3 min"},recent_trades:tradeLog.slice(0,20),last_gainers:lastGainers,last_analysis:lastAnalysis,brain:{total_trades:BRAIN.totalTrades,wins:BRAIN.wins,losses:BRAIN.losses,win_rate:BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(1)+"%":"0%",total_pnl:BRAIN.totalPnL.toFixed(2),best_setups:BRAIN.bestSetups,best_tickers:BRAIN.bestTickers,lessons:BRAIN.lessons,adjusted_target:BRAIN.adjustedFirstTarget+"%",adjusted_stop:BRAIN.adjustedStop+"%"},watchlist_size:0});
});

app.post("/api/autotrader/sellall", async(_,res)=>{try{const p=await alpaca("/v2/positions");if(!Array.isArray(p)||!p.length)return res.json({message:"No positions"});await Promise.all(p.map(x=>alpaca("/v2/orders",{method:"POST",body:JSON.stringify({symbol:x.symbol,qty:x.qty,side:"sell",type:"market",time_in_force:"day"})})));res.json({message:`Sold ${p.length} positions`});}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/alerts",(_, res)=>res.json({alerts:[]}));

app.post("/api/chat", async(req,res)=>{
  const{messages}=req.body; if(!messages?.length)return res.status(400).json({error:"No messages"});
  try{
    const userMsg=messages[messages.length-1]?.content?.toLowerCase()||"";
    if(userMsg.match(/\b(movers?|gainers?|top stocks?|what.?s moving|spikes?)\b/)){
      const top=lastGainers.slice(0,8);
      if(top.length) return res.json({reply:`🔥 TOP MOVERS [${new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"})}]:\n\n${top.map((g,i)=>`${i+1}. ${g.ticker} +${(g.dp||0).toFixed(1)}% @ $${g.c}`).join("\n")}\n\nLast scan: ${lastScanTime?new Date(lastScanTime).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}):"pending"}`});
      // No cached movers — trigger a fresh scan and return status
      autoTrade().catch(()=>{});
      return res.json({reply:`🔍 Scanning market now... no movers cached yet.\n\nBot: ${autoTraderActive?"🟢 RUNNING":"🔴 PAUSED"} | Session: ${new Date().toLocaleString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",timeZoneName:"short"})}\n\nTry again in 30 seconds or type status for bot info.`});
    }
    if(userMsg.match(/\b(status|equity|bot running)\b/)){
      const[acc,pos]=await Promise.all([alpaca("/v2/account").catch(()=>null),alpaca("/v2/positions").catch(()=>[])]);
      if(acc){const pnl=parseFloat(acc.equity)-parseFloat(acc.last_equity);return res.json({reply:`📊 STATUS:\n• ${autoTraderActive?"🟢 RUNNING":"🔴 PAUSED"}\n• Equity: $${parseFloat(acc.equity).toFixed(2)}\n• Today: ${pnl>=0?"+":""}$${pnl.toFixed(2)}\n• Positions: ${Array.isArray(pos)?pos.length:0}\n• Brain: ${BRAIN.totalTrades}T | ${BRAIN.totalTrades>0?((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0):0}% WR`});}
    }
    if(userMsg.match(/\b(holdings?|positions?)\b/)){
      const pos=await alpaca("/v2/positions").catch(()=>[]);
      if(Array.isArray(pos)&&pos.length)return res.json({reply:`📊 POSITIONS (${pos.length}):\n\n${pos.map(p=>`${p.symbol}: ${p.qty} @ $${parseFloat(p.avg_entry_price).toFixed(2)} → $${parseFloat(p.current_price).toFixed(2)} | ${(parseFloat(p.unrealized_plpc)*100>=0?"+":"")}${(parseFloat(p.unrealized_plpc)*100).toFixed(1)}%`).join("\n")}`});
      return res.json({reply:"📊 No open positions."});
    }
    const tickerMatch=userMsg.match(/how.?s\s+([a-z]{1,5})\b/i);
    if(tickerMatch){
      const ticker=tickerMatch[1].toUpperCase();
      try{
        const[q,of,tech]=await Promise.all([finnhub(`/quote?symbol=${ticker}`),getOrderFlow(ticker,0),getFullTechnicals(ticker,0)]);
        if(q.c>0){const reply=await groq(`${ticker} @ $${q.c} ${q.dp>=0?"+":""}${q.dp?.toFixed(2)}%\nVWAP:${tech?.aboveVWAP?"above":"below"} | EMA9:$${tech?.ema9} | Uptrend:${tech?.uptrend} | EMAsUp:${tech?.emasUp}\nMACD:${tech?.macd?.bullish?"BULLISH":"bearish"} | OverDayHigh:${tech?.overDayHigh}\nOF: ${of?.grade} | Buy%:${of?.footprint?.buyPct}% | BidWall:${of?.liqMap?.bidWallBelow}\nJeezy setup? Entry/target/stop? 3 sentences.`,300);return res.json({reply:`📊 ${ticker} @ $${q.c}\n\n${reply}`});}
      }catch(_){}
    }
    const[spy,account]=await Promise.all([finnhub("/quote?symbol=SPY").catch(()=>null),alpaca("/v2/account").catch(()=>null)]);
    const ctx=[
      spy?.c?`[SPY $${spy.c} ${spy.dp>=0?"+":""}${spy.dp?.toFixed(2)}%]`:"",
      account?`[Equity:$${parseFloat(account.equity).toFixed(0)}|Cash:$${parseFloat(account.cash).toFixed(0)}]`:"",
      autoTraderActive?"[Bot:RUNNING]":"[Bot:PAUSED]",
      BRAIN.totalTrades>0?`[Brain:${BRAIN.totalTrades}T|${((BRAIN.wins/BRAIN.totalTrades)*100).toFixed(0)}%WR]`:"",
      lastGainers.length?`[TopMovers:${lastGainers.slice(0,3).map(g=>`${g.ticker}+${(g.dp||0).toFixed(0)}%`).join(",")}]`:"",
      "[NOTE: You can answer general trading questions, market news questions, and strategy questions. Not every question needs stock data.]"
    ].filter(Boolean).join(" ");
    const last=messages[messages.length-1];
    res.json({reply:await groqChat([...messages.slice(0,-1),{...last,content:last.content+"\n"+ctx}])});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/movers", async(req,res)=>{
  try{
    const{type="gainers"}=req.query;
    let raw=await getTopGainers();
    if(type==="losers"){try{const d=await alpacaData(`/v1beta1/screener/stocks/movers?by=percent_change&top=50`);raw=(d.losers||[]).filter(l=>l.price>=CONFIG.MIN_PRICE).map(l=>({ticker:l.symbol,c:l.price,dp:l.percent_change,v:l.volume||0}));}catch(_){}}
    if(type==="active"){try{const d=await alpacaData(`/v1beta1/screener/stocks/movers?by=volume&top=50`);raw=(d.most_actives||d.gainers||[]).slice(0,20).map(s=>({ticker:s.symbol,c:s.price,dp:s.percent_change||0,v:s.volume||0}));}catch(_){}}
    lastGainers=raw.slice(0,20);
    if(!raw.length)return res.json({gainers:[],scanned:0,ts:new Date().toISOString()});
    const top=raw.slice(0,15);
    const enriched=await Promise.all(top.map(async g=>{
      try{
        const ago3=new Date(Date.now()-3*86400000).toISOString().split("T")[0],today=new Date().toISOString().split("T")[0];
        const[prof,news]=await Promise.all([finnhub(`/stock/profile2?symbol=${g.ticker}`),finnhub(`/company-news?symbol=${g.ticker}&from=${ago3}&to=${today}`)]);
        const topNews=Array.isArray(news)?news.slice(0,3).map(n=>({headline:n.headline,source:n.source})):[];
        const vf=g.v>=1e6?(g.v/1e6).toFixed(1)+"M":g.v>=1e3?(g.v/1e3).toFixed(0)+"K":String(g.v||0);
        return{symbol:g.ticker,name:prof?.name||g.ticker,price:parseFloat(g.c||0).toFixed(2),change_pct:parseFloat(g.dp||0).toFixed(2),volume:g.v||0,volume_fmt:vf,float:prof?.shareOutstanding||null,mkt_cap:prof?.marketCapitalization||null,news:topNews,catalyst:topNews[0]?.headline||null};
      }catch(_){return{symbol:g.ticker,name:g.ticker,price:parseFloat(g.c||0).toFixed(2),change_pct:parseFloat(g.dp||0).toFixed(2),volume:g.v||0,volume_fmt:String(g.v||0),float:null,mkt_cap:null,news:[],catalyst:null};}
    }));
    let analysis="";
    try{const t5=enriched.slice(0,5).map(g=>`${g.symbol}(${g.name}): $${g.price} ${g.change_pct>=0?"+":""}${g.change_pct}% | ${g.catalyst||"no catalyst"}`).join("\n");analysis=await groq(`Jeezy strategy setups:\n\n${t5}\n\nFor each: S/D flip ready? Chart uptrend? VWAP? Entry/target? End: #1 PICK: [TICKER] — [reason]`,600);}catch(_){analysis="AI unavailable.";}
    res.json({gainers:enriched,analysis,scanned:raw.length,ts:new Date().toISOString()});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/sparks", async(req,res)=>{
  try{
    const{tickers=""}=req.query;const list=tickers.split(",").map(t=>t.trim().toUpperCase()).filter(Boolean).slice(0,20);
    if(!list.length)return res.json({});
    const now=new Date(),start=new Date(now);start.setHours(4,0,0,0);
    const results={};
    await Promise.all(list.map(async ticker=>{try{const d=await alpacaData(`/v2/stocks/${ticker}/bars?timeframe=1Min&start=${start.toISOString()}&feed=iex&limit=480`);const bars=d.bars||[];if(!bars.length){results[ticker]={closes:[],vols:[],pctFromOpen:0};return;}const open=bars[0].o,current=bars[bars.length-1].c;results[ticker]={closes:bars.map(b=>b.c),vols:bars.map(b=>b.v||0),open,current,pctFromOpen:open>0?parseFloat(((current-open)/open*100).toFixed(2)):0};}catch(_){results[ticker]={closes:[],vols:[],pctFromOpen:0};}}));
    res.json(results);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/orderflow/:ticker", async(req,res)=>{try{const ticker=req.params.ticker.toUpperCase();const q=await finnhub(`/quote?symbol=${ticker}`);const of=await getOrderFlow(ticker,q.c||0);res.json({ticker,price:q.c,pct:q.dp,orderFlow:of,ts:new Date().toISOString()});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/holdings", async(_,res)=>{try{const positions=await alpaca("/v2/positions");if(!Array.isArray(positions)||!positions.length)return res.json({holdings:[],total_value:"0.00",total_pnl:"0.00",total_pnl_today:"0.00",count:0});const holdings=positions.map(p=>({symbol:p.symbol,qty:parseFloat(p.qty),side:p.side,avg_entry:parseFloat(p.avg_entry_price).toFixed(2),current_price:parseFloat(p.current_price).toFixed(2),market_value:parseFloat(p.market_value).toFixed(2),unrealized_pnl:parseFloat(p.unrealized_pl).toFixed(2),unrealized_pnl_pct:(parseFloat(p.unrealized_plpc)*100).toFixed(2)+"%",today_pnl:parseFloat(p.unrealized_intraday_pl).toFixed(2),today_pnl_pct:(parseFloat(p.unrealized_intraday_plpc)*100).toFixed(2)+"%",first_target:(parseFloat(p.avg_entry_price)*(1+CONFIG.FIRST_TARGET_PCT/100)).toFixed(2),hard_stop:(parseFloat(p.avg_entry_price)*(1-CONFIG.HARD_STOP_PCT/100)).toFixed(2),half_sold:openTrades[p.symbol]?.halfSold||false,setup:openTrades[p.symbol]?.setup||"unknown",tier:openTrades[p.symbol]?.tier||"?",has_catalyst:openTrades[p.symbol]?.hasCatalyst||false}));res.json({holdings,total_value:holdings.reduce((s,h)=>s+parseFloat(h.market_value),0).toFixed(2),total_pnl:holdings.reduce((s,h)=>s+parseFloat(h.unrealized_pnl),0).toFixed(2),total_pnl_today:holdings.reduce((s,h)=>s+parseFloat(h.today_pnl),0).toFixed(2),count:holdings.length});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/account", async(_,res)=>{try{const d=await alpaca("/v2/account");const pnl=parseFloat(d.equity)-parseFloat(d.last_equity);res.json({equity:parseFloat(d.equity).toFixed(2),cash:parseFloat(d.cash).toFixed(2),buying_power:parseFloat(d.buying_power).toFixed(2),pnl_today:pnl.toFixed(2),pnl_today_pct:((pnl/parseFloat(d.last_equity))*100).toFixed(2)+"%",day_trade_count:d.daytrade_count,status:d.status,paper:true});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/quote", async(req,res)=>{const{ticker="SPY"}=req.query;try{const[q,p]=await Promise.all([finnhub(`/quote?symbol=${ticker.toUpperCase()}`),finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`)]);res.json({ticker,price:q.c,change:q.d,pct:q.dp,high:q.h,low:q.l,open:q.o,prev:q.pc,name:p.name,industry:p.finnhubIndustry,market_cap:p.marketCapitalization,float:p.shareOutstanding});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/bars", async(req,res)=>{const{ticker="SPY",timeframe="5Min",limit=78}=req.query;try{const d=await alpacaData(`/v2/stocks/${ticker.toUpperCase()}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`);res.json({ticker:ticker.toUpperCase(),bars:d.bars||[],ts:new Date().toISOString()});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/pnl", async(_,res)=>{try{const trades=await supabase("pulsetrader_trades?order=created_at.desc&limit=500");if(!Array.isArray(trades))return res.status(500).json({error:"DB error"});const closed=trades.filter(t=>t.pnl!=null),open=trades.filter(t=>t.pnl==null),total=closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0),winners=closed.filter(t=>parseFloat(t.pnl)>0).length,best=closed.reduce((b,t)=>(!b||parseFloat(t.pnl)>parseFloat(b.pnl)?t:b),null),worst=closed.reduce((b,t)=>(!b||parseFloat(t.pnl)<parseFloat(b.pnl)?t:b),null);res.json({summary:{total_pnl:total.toFixed(2),avg_pnl:closed.length?(total/closed.length).toFixed(2):"0.00",win_rate:closed.length?((winners/closed.length)*100).toFixed(1)+"%":"0%",total_trades:trades.length,closed:closed.length,open:open.length,winners,losers:closed.length-winners,best_trade:best?{symbol:best.symbol,pnl:best.pnl}:null,worst_trade:worst?{symbol:worst.symbol,pnl:worst.pnl}:null},recent:trades.slice(0,20),open_positions:open});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/trades", async(_,res)=>{try{res.json(await supabase("pulsetrader_trades?order=created_at.desc&limit=500").then(d=>Array.isArray(d)?d:[]));}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/order", async(req,res)=>{const{symbol,side,qty,type="market",limit_price,time_in_force="day"}=req.body;if(!symbol||!side||!qty)return res.status(400).json({error:"required"});try{const body={symbol:symbol.toUpperCase(),side,qty:String(qty),type,time_in_force};if(type==="limit"&&limit_price)body.limit_price=String(limit_price);res.json({success:true,order:await alpaca("/v2/orders",{method:"POST",body:JSON.stringify(body)})});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/teach", async(req,res)=>{const{tickers,context,instruction}=req.body;if(!tickers?.length)return res.status(400).json({error:"tickers required"});const list=Array.isArray(tickers)?tickers:[tickers],lessons=[];for(const ticker of list){try{const week=new Date(Date.now()-7*86400000).toISOString().split("T")[0],today=new Date().toISOString().split("T")[0];const[quote,profile,news,tech,of]=await Promise.all([finnhub(`/quote?symbol=${ticker.toUpperCase()}`),finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),getFullTechnicals(ticker.toUpperCase(),0),getOrderFlow(ticker.toUpperCase(),0)]);const headlines=Array.isArray(news)?news.slice(0,6).map(n=>`- ${n.headline}`).join("\n"):"No news.";const analysis=await groq(`${instruction||"Analyze Jeezy strategy"}\n\n${ticker.toUpperCase()}: $${quote.c} ${quote.dp>=0?"+":""}${quote.dp?.toFixed(2)}%\nChart: VWAP:${tech?.aboveVWAP?"above":"below"} | Uptrend:${tech?.uptrend} | EMAsUp:${tech?.emasUp} | OverDayHigh:${tech?.overDayHigh}\nMACD:${tech?.macd?.bullish?"BULLISH":"bearish"} | SDFlip:${tech?.sdFlip?.detected}\nOF: ${of?.grade} | Buy%:${of?.footprint?.buyPct}% | BidWall:${of?.liqMap?.bidWallBelow}\n${context?"Context:"+context+"\n":""}News:\n${headlines}`,1000);const lesson=analysis.slice(-150);BRAIN.lessons.unshift(lesson);BRAIN.lessons=BRAIN.lessons.slice(0,10);await supabase("bot_lessons",{method:"POST",body:JSON.stringify({ticker:ticker.toUpperCase(),lesson,pattern:instruction||"user taught",taught_by:"user"})}).catch(()=>{});lessons.push({ticker:ticker.toUpperCase(),analysis,lesson,tech,orderFlow:of});}catch(e){lessons.push({ticker,error:e.message});}}res.json({message:`Studied ${lessons.length} stocks`,lessons});});

app.get("/api/autotrader/brain",   (_, res) => res.json({...BRAIN, watchlist:[]}));
app.get("/api/autotrader/gainers", (_, res) => res.json({ gainers: lastGainers, analysis: lastAnalysis, ts: lastScanTime }));

app.get("/api/orders", async (req, res) => {
  try {
    const o = await alpaca("/v2/orders?status=all&limit=25&direction=desc");
    if (!Array.isArray(o)) return res.json([]);
    res.json(o.map(x => ({ id: x.id, symbol: x.symbol, side: x.side, type: x.type, qty: x.qty, filled_qty: x.filled_qty, price: x.filled_avg_price || x.limit_price || null, status: x.status, submitted: x.submitted_at, filled: x.filled_at })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/trade", async (req, res) => {
  const { symbol, side, qty, entry_price, exit_price, reason } = req.body;
  if (!symbol || !side || !qty || !entry_price) return res.status(400).json({ error: "required fields missing" });
  let pnl = null, pnl_pct = null;
  if (exit_price) { const dir = side.toUpperCase() === "SHORT" ? -1 : 1; pnl = ((+exit_price - +entry_price) * +qty * dir).toFixed(2); pnl_pct = (((+exit_price - +entry_price) / +entry_price) * 100 * dir).toFixed(2); }
  try {
    const r = await supabase("pulsetrader_trades", { method: "POST", body: JSON.stringify({ symbol: symbol.toUpperCase(), side: side.toUpperCase(), qty: +qty, entry_price: +entry_price, exit_price: exit_price ? +exit_price : null, pnl: pnl ? +pnl : null, pnl_pct: pnl_pct ? +pnl_pct : null, reason: reason || null }) });
    res.json({ success: true, trade: Array.isArray(r) ? r[0] : r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/trade/:id", async (req, res) => {
  try { await supabase(`pulsetrader_trades?id=eq.${req.params.id}`, { method: "DELETE" }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/news", async (req, res) => {
  const { ticker } = req.query;
  try {
    const today = new Date().toISOString().split("T")[0];
    const week  = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const news  = ticker
      ? await finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`)
      : await finnhub("/news?category=general");
    res.json((Array.isArray(news) ? news : []).slice(0, 20).map(n => ({ headline: n.headline, summary: n.summary || null, source: n.source, url: n.url, datetime: n.datetime, ticker: ticker?.toUpperCase() || null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/edgar", async (req, res) => {
  const { ticker = "SPY" } = req.query;
  try {
    const week = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    const [p, n, tech, of] = await Promise.all([
      finnhub(`/stock/profile2?symbol=${ticker.toUpperCase()}`),
      finnhub(`/company-news?symbol=${ticker.toUpperCase()}&from=${week}&to=${today}`),
      getFullTechnicals(ticker.toUpperCase(), 0),
      getOrderFlow(ticker.toUpperCase(), 0),
    ]);
    const headlines = Array.isArray(n) ? n.slice(0, 8).map(x => `- ${x.headline}`).join("\n") : "No news.";
    const ai = await groq(
      `${ticker.toUpperCase()} | Float:${p.shareOutstanding}M | Cap:$${p.marketCapitalization}B\n` +
      `Chart: VWAP:${tech?.aboveVWAP?"above":"below"} | Uptrend:${tech?.uptrend} | EMAsUp:${tech?.emasUp} | OverDayHigh:${tech?.overDayHigh}\n` +
      `MACD:${tech?.macd?.bullish?"BULLISH":"bearish"} | SDFlip:${tech?.sdFlip?.detected} | Vol:${tech?.volRatio}x\n` +
      `OrderFlow: ${of?.grade} | Buy%:${of?.footprint?.buyPct}% | BidWall:${of?.liqMap?.bidWallBelow}\n` +
      `News:\n${headlines}\n\nJeezy setup? Entry, target, stop, conviction.`
    );
    res.json({ ticker: ticker.toUpperCase(), data: ai, tech, orderFlow: of, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/earnings", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const next7 = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
    const cal   = await finnhub(`/calendar/earnings?from=${today}&to=${next7}`);
    const top   = cal?.earningsCalendar?.slice(0, 20) || [];
    const list  = top.map(e => `${e.symbol}|${e.date}|EPS:${e.epsEstimate ?? "N/A"}`).join("\n");
    const ai    = await groq(`Earnings:\n${list || "No data"}\n\nWhich are Jeezy-style setups? S/D flip potential? Entry, target, stop.`);
    res.json({ calendar: top, ai_summary: ai, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/spikes", async (req, res) => {
  try {
    const gainers = await getTopGainers();
    if (!gainers.length) return res.json({ data: "No candidates.", candidates: [], ts: new Date().toISOString() });
    const candidates = gainers.slice(0, 8);
    const str = candidates.map(g => `${g.ticker} +${g.dp?.toFixed(1)}% $${g.c}`).join("\n");
    const ai  = await groq(`Early movers — Jeezy strategy:\n${str}\n\nS/D flip confirmed? Order flow bullish? MACD bullish? Over daily high? Best 3 to enter NOW?`, 800);
    res.json({ data: ai, candidates, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const [account, positions, trades] = await Promise.all([alpaca("/v2/account").catch(() => null), alpaca("/v2/positions").catch(() => []), supabase("pulsetrader_trades?order=created_at.desc&limit=500").catch(() => [])]);
    const t = Array.isArray(trades) ? trades : [], closed = t.filter(x => x.pnl != null), total = closed.reduce((s, x) => s + parseFloat(x.pnl || 0), 0), winners = closed.filter(x => parseFloat(x.pnl) > 0).length, todayPnL = account ? parseFloat(account.equity) - parseFloat(account.last_equity) : 0;
    res.json({ account: account ? { equity: parseFloat(account.equity).toFixed(2), cash: parseFloat(account.cash).toFixed(2), pnl_today: todayPnL.toFixed(2), pnl_today_pct: ((todayPnL / parseFloat(account.last_equity)) * 100).toFixed(2) + "%" } : null, auto_trader: { active: autoTraderActive, last_scan: lastScanTime, recent_trades: tradeLog.slice(0, 5) }, brain: { win_rate: BRAIN.totalTrades > 0 ? ((BRAIN.wins / BRAIN.totalTrades) * 100).toFixed(1) + "%" : "0%", total_trades: BRAIN.totalTrades, total_pnl: BRAIN.totalPnL.toFixed(2), lessons: BRAIN.lessons.slice(0, 3) }, holdings: Array.isArray(positions) ? positions.map(p => ({ symbol: p.symbol, qty: parseFloat(p.qty), avg_entry: parseFloat(p.avg_entry_price).toFixed(2), current_price: parseFloat(p.current_price).toFixed(2), unrealized_pnl: parseFloat(p.unrealized_pl).toFixed(2), unrealized_pnl_pct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + "%", setup: openTrades[p.symbol]?.setup || "unknown", half_sold: openTrades[p.symbol]?.halfSold || false })) : [], trade_summary: { total_pnl: total.toFixed(2), win_rate: closed.length ? ((winners / closed.length) * 100).toFixed(1) + "%" : "0%", total_trades: t.length, open: t.filter(x => x.pnl == null).length, closed: closed.length } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health",(_, res)=>res.json({status:"ok",version:"12.0.0",strategy:"Jeezy Strategy — S/D Flip + AH Gapper + Dip&Rip + VWAP + 200MA + Order Flow + Heat Map",auto_trader:autoTraderActive,brain_trades:BRAIN.totalTrades,ts:new Date().toISOString()}));

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════
const PORT=process.env.PORT||3001;
app.listen(PORT, async()=>{
  console.log(`⚡ PulseTrader v12.0 on port ${PORT}`);
  console.log(`   Security : Cookie login at /login | Passcode: ${PASSCODE}`);
  console.log(`   Strategy : Jeezy Strategy — 6 Setups`);
  console.log(`   Entry    : S/D Flip | AH Gapper | Dip&Rip | VWAP | 200MA | Two-Way`);
  console.log(`   OrderFlow: Footprint buy% + Liquidity Heat Map`);
  console.log(`   Exit     : +${CONFIG.FIRST_TARGET_PCT}% half | Trail 9EMA | OF exhaust | Bid wall break`);
  console.log(`   Brain    : Persists via Supabase`);
  await loadMemory();
  console.log("🤖 Auto-starting...");
  startAutoTrader();
});
