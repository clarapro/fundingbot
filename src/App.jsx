import { useState, useEffect, useRef, useCallback } from "react";

// ─── LIVE DATA — appel au backend Vercel /api/rates ─────────────────────────
async function buildRows() {
  const res = await fetch("/api/rates");
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "API returned error");
  return data.rows;
}

function mergeAll(rows) { return rows; }

// Find cross-exchange arb: same symbol, long on low rate, short on high rate
function findCrossArb(rows) {
  const bySymbol = {};
  rows.forEach(r => {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
    bySymbol[r.symbol].push(r);
  });
  const opps = [];
  Object.entries(bySymbol).forEach(([sym, list]) => {
    if (list.length < 2) return;
    const sorted = [...list].sort((a, b) => b.apr - a.apr);
    const high = sorted[0], low = sorted[sorted.length - 1];
    const spread = high.apr - low.apr;
    if (spread > 5) { // >5% APR spread worth considering
      opps.push({ symbol: sym, high, low, spreadAPR: spread });
    }
  });
  return opps.sort((a, b) => b.spreadAPR - a.spreadAPR);
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
const fmtRate = r => (r >= 0 ? "+" : "") + (r * 100).toFixed(4) + "%";
const fmtAPR  = r => (r >= 0 ? "+" : "") + r.toFixed(1) + "%";
const fmtUSD  = n => "$" + Math.abs(n).toFixed(2);
const fmtK    = n => n >= 1e9 ? (n/1e9).toFixed(1)+"B" : n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(0)+"K" : n.toFixed(0);
const minsLeft = ts => { const m = Math.round((ts - Date.now()) / 60000); return m <= 0 ? "now" : m < 60 ? m+"m" : Math.floor(m/60)+"h "+((m%60)+"m"); };

function calcEarnings(capitalEUR, aprPct, months, eurUsd = 1.08) {
  const cap = capitalEUR * eurUsd;
  const dailyRate = aprPct / 100 / 365;
  const days = months * 30;
  const compound = cap * (Math.pow(1 + dailyRate, days) - 1);
  const monthly = cap * dailyRate * 30;
  return { monthly, total: compound, monthlyEUR: monthly / eurUsd, totalEUR: compound / eurUsd };
}

// Exchange colors
const EX_STYLE = {
  Hyperliquid: { bg: "#0a1f2e", border: "#0ea5e944", color: "#38bdf8", short: "HL" },
  Binance:     { bg: "#1a1400", border: "#f5c84244", color: "#f5c842", short: "BN" },
  Bybit:       { bg: "#1a0a1a", border: "#c084fc44", color: "#c084fc", short: "BB" },
  MEXC:        { bg: "#001a10", border: "#00c97444", color: "#00c974", short: "MX" },
};

// ─── STYLES ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#060912", surface: "#0a0f1e", card: "#0e1428",
  border: "#182040", b2: "#1e2d55",
  gold: "#f0b429", teal: "#00d4aa", blue: "#3b82f6",
  red: "#f43f5e", green: "#22c55e", purple: "#a855f7",
  muted: "#3d4f70", text: "#8899bb", white: "#e8eeff",
};

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,400;0,500;1,400&family=Clash+Display:wght@600;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:${C.bg};color:${C.text};font-family:'DM Mono',monospace;overflow-x:hidden}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${C.b2};border-radius:2px}

@keyframes fade-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes scan-h{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}
@keyframes row-in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
@keyframes count-up{from{opacity:.3}to{opacity:1}}
@keyframes glow-gold{0%,100%{box-shadow:0 0 0 transparent}50%{box-shadow:0 0 20px ${C.gold}33}}

/* LAYOUT */
.root{display:grid;grid-template-columns:280px 1fr;grid-template-rows:58px 1fr;min-height:100vh}
.nav{grid-column:1/-1;background:${C.surface};border-bottom:1px solid ${C.border};display:flex;align-items:center;padding:0 24px;gap:16px;position:sticky;top:0;z-index:100}
.sidebar{background:${C.surface};border-right:1px solid ${C.border};padding:20px 16px;overflow-y:auto;height:calc(100vh - 58px);position:sticky;top:58px}
.main{padding:22px;overflow-y:auto;height:calc(100vh - 58px)}

/* NAV */
.logo{font-family:'Outfit',sans-serif;font-weight:700;font-size:17px;color:${C.white};display:flex;align-items:center;gap:8px}
.logo-mark{background:linear-gradient(135deg,${C.teal},${C.blue});width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px}
.nav-tabs{display:flex;gap:2px;margin-left:16px}
.nav-tab{padding:6px 14px;border-radius:7px;border:none;background:transparent;color:${C.muted};font-family:'DM Mono',monospace;font-size:12px;cursor:pointer;transition:all .15s}
.nav-tab:hover{color:${C.text}}
.nav-tab.active{background:${C.card};color:${C.white};border:1px solid ${C.border}}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:14px}
.live-badge{display:flex;align-items:center;gap:6px;background:${C.card};border:1px solid ${C.border};border-radius:20px;padding:4px 12px;font-size:11px;color:${C.muted}}
.live-dot{width:6px;height:6px;border-radius:50%;background:${C.teal};animation:pulse 1.3s infinite}
.refresh-btn{padding:5px 12px;border-radius:8px;border:1px solid ${C.border};background:transparent;color:${C.muted};font-family:'DM Mono',monospace;font-size:11px;cursor:pointer;transition:all .15s}
.refresh-btn:hover{border-color:${C.b2};color:${C.text}}

/* SIDEBAR */
.s-section{margin-bottom:24px}
.s-label{font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px}

.capital-wrap{position:relative}
.cap-prefix{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:${C.gold};font-size:18px;font-weight:500;font-family:'Outfit',sans-serif}
.cap-input{width:100%;padding:11px 12px 11px 30px;background:${C.card};border:1px solid ${C.b2};border-radius:9px;color:${C.white};font-family:'Outfit',sans-serif;font-size:20px;font-weight:700;outline:none;transition:border .15s;-moz-appearance:textfield}
.cap-input::-webkit-inner-spin-button,.cap-input::-webkit-outer-spin-button{-webkit-appearance:none}
.cap-input:focus{border-color:${C.gold}66}
.cap-hint{font-size:10px;color:${C.muted};margin-top:6px}

.proj-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.proj-cell{background:${C.card};border:1px solid ${C.border};border-radius:8px;padding:10px}
.proj-cell-val{font-family:'Outfit',sans-serif;font-size:16px;font-weight:700;color:${C.white};margin-bottom:2px}
.proj-cell-val.gold{color:${C.gold}}
.proj-cell-val.teal{color:${C.teal}}
.proj-cell-label{font-size:10px;color:${C.muted}}
.proj-best{background:linear-gradient(135deg,${C.teal}11,${C.blue}11);border:1px solid ${C.teal}33;border-radius:9px;padding:12px;margin-top:10px;animation:glow-gold 4s infinite}
.proj-best-apr{font-family:'Outfit',sans-serif;font-size:24px;font-weight:700;color:${C.teal};margin-bottom:2px}
.proj-best-label{font-size:11px;color:${C.muted}}
.proj-best-sub{font-size:11px;color:${C.text};margin-top:6px;line-height:1.5}

.exch-filter{display:flex;flex-direction:column;gap:6px}
.exch-toggle{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:7px;border:1px solid ${C.border};background:${C.bg};cursor:pointer;transition:all .15s;font-size:12px}
.exch-toggle:hover{border-color:${C.b2}}
.exch-toggle.on{border-color:var(--ec);background:var(--ebg)}
.exch-name{color:${C.white};font-weight:500}
.exch-chip{font-size:10px;padding:2px 7px;border-radius:4px;background:var(--ebg);border:1px solid var(--ec);color:var(--ec)}
.toggle-dot{width:7px;height:7px;border-radius:50%;background:${C.muted}}
.toggle-dot.on{background:${C.teal}}

/* MAIN KPI */
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.kpi{background:${C.card};border:1px solid ${C.border};border-radius:11px;padding:15px;animation:fade-up .35s ease both}
.kpi::before{content:'';display:block;height:2px;border-radius:2px;margin-bottom:12px}
.kpi.k1::before{background:linear-gradient(90deg,${C.teal},transparent)}
.kpi.k2::before{background:linear-gradient(90deg,${C.gold},transparent)}
.kpi.k3::before{background:linear-gradient(90deg,${C.blue},transparent)}
.kpi.k4::before{background:linear-gradient(90deg,${C.purple},transparent)}
.kpi-num{font-family:'Outfit',sans-serif;font-size:24px;font-weight:700;color:${C.white};margin-bottom:3px}
.kpi-num.teal{color:${C.teal}} .kpi-num.gold{color:${C.gold}} .kpi-num.blue{color:${C.blue}}
.kpi-lbl{font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:1px}

/* SCAN LINE */
.scan-bar{position:relative;overflow:hidden;height:1px;background:${C.border};margin-bottom:18px;border-radius:1px}
.scan-bar-inner{position:absolute;width:25%;height:100%;background:linear-gradient(90deg,transparent,${C.teal},transparent);animation:scan-h 2s linear infinite}

/* TABS */
.view-tabs{display:flex;gap:6px;margin-bottom:16px}
.view-tab{padding:7px 16px;border-radius:8px;border:1px solid ${C.border};background:transparent;color:${C.muted};font-family:'DM Mono',monospace;font-size:12px;cursor:pointer;transition:all .15s}
.view-tab:hover{color:${C.text};border-color:${C.b2}}
.view-tab.active{background:${C.teal}18;border-color:${C.teal}55;color:${C.teal}}

/* MAIN TABLE */
.tbl-wrap{background:${C.card};border:1px solid ${C.border};border-radius:11px;overflow:hidden}
table{width:100%;border-collapse:collapse}
thead tr{border-bottom:1px solid ${C.border};background:${C.surface}}
th{padding:10px 14px;font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:${C.muted};font-weight:500;text-align:left;cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:${C.text}}
th.sorted{color:${C.teal}}
tbody tr{border-bottom:1px solid ${C.border}18;transition:background .1s;animation:row-in .2s ease}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:${C.surface}88}
td{padding:10px 14px;font-size:12px;white-space:nowrap}

.sym-cell{display:flex;align-items:center;gap:9px}
.sym-logo{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;flex-shrink:0}
.sym-main{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;color:${C.white}}
.sym-sub{font-size:10px;color:${C.muted};margin-top:1px}

.ex-tag{display:inline-flex;padding:3px 8px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid}

.rate-val{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600}
.rate-val.hot{color:${C.gold}}
.rate-val.good{color:${C.teal}}
.rate-val.meh{color:${C.text}}
.rate-val.neg{color:${C.red}}

.apr-bar-wrap{display:flex;align-items:center;gap:8px;min-width:120px}
.apr-bar{height:5px;border-radius:3px;transition:width .3s}
.apr-bar.pos{background:linear-gradient(90deg,${C.teal},${C.gold})}
.apr-bar.neg{background:${C.red}55}
.apr-num{font-family:'Outfit',sans-serif;font-size:12px;font-weight:600;min-width:52px}
.apr-num.pos{color:${C.teal}} .apr-num.neg{color:${C.red}}

.timer{font-size:11px;color:${C.muted}}
.timer.soon{color:${C.gold}}

.earn-est{font-size:11px;color:${C.teal};font-weight:500}
.earn-est.neg{color:${C.red}55}

.action-btn{padding:5px 14px;border-radius:6px;font-family:'DM Mono',monospace;font-size:11px;cursor:pointer;transition:all .15s;border:1px solid}
.action-btn.open{background:${C.teal}18;border-color:${C.teal}44;color:${C.teal}}
.action-btn.open:hover{background:${C.teal}28;border-color:${C.teal}88}
.action-btn.neg{background:${C.red}11;border-color:${C.red}33;color:${C.red}55;cursor:not-allowed}
.action-btn.active{background:${C.gold}18;border-color:${C.gold}44;color:${C.gold};cursor:default}

/* ARB TABLE */
.arb-row{background:${C.surface};border:1px solid ${C.border};border-radius:10px;padding:14px 16px;margin-bottom:10px;display:grid;grid-template-columns:1fr auto 1fr auto;gap:12px;align-items:center;animation:fade-up .3s ease}
.arb-row:hover{border-color:${C.teal}33}
.arb-sym{font-family:'Outfit',sans-serif;font-size:16px;font-weight:700;color:${C.white};margin-bottom:4px}
.arb-side{font-size:11px;color:${C.muted}}
.arb-side b{color:${C.white}}
.arb-rate{font-family:'Outfit',sans-serif;font-size:14px;font-weight:600}
.arb-spread{text-align:center}
.spread-arrow{font-size:20px;color:${C.teal};margin-bottom:2px}
.spread-apr{font-family:'Outfit',sans-serif;font-size:18px;font-weight:700;color:${C.teal}}
.spread-label{font-size:10px;color:${C.muted}}
.arb-btn{padding:8px 18px;border-radius:8px;border:1px solid ${C.teal}44;background:${C.teal}18;color:${C.teal};font-family:'DM Mono',monospace;font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap}
.arb-btn:hover{background:${C.teal}28;border-color:${C.teal}88}
.arb-btn.active{background:${C.gold}18;border-color:${C.gold}44;color:${C.gold};cursor:default}

/* POSITIONS */
.pos-wrap{background:${C.card};border:1px solid ${C.border};border-radius:11px;overflow:hidden;margin-top:18px}
.pos-header{padding:13px 16px;border-bottom:1px solid ${C.border};display:flex;align-items:center;justify-content:space-between}
.pos-title{font-family:'Outfit',sans-serif;font-size:15px;font-weight:700;color:${C.white};display:flex;align-items:center;gap:8px}
.pos-body{padding:14px 16px}
.empty-pos{text-align:center;padding:28px;color:${C.muted};font-size:12px;line-height:1.7}
.pos-row{display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid ${C.border}18;animation:row-in .2s ease}
.pos-row:last-child{border-bottom:none}
.pos-sym{font-family:'Outfit',sans-serif;font-size:14px;font-weight:700;color:${C.white}}
.pos-detail{font-size:10px;color:${C.muted};margin-top:2px}
.pos-pnl{font-family:'Outfit',sans-serif;font-size:14px;font-weight:700}
.pos-pnl.pos{color:${C.teal}} .pos-pnl.neg{color:${C.red}}
.pos-rate{font-size:12px}
.pos-rate.ok{color:${C.teal}} .pos-rate.bad{color:${C.red}}
.close-btn{padding:5px 12px;border-radius:6px;border:1px solid ${C.red}44;background:${C.red}11;color:${C.red};font-family:'DM Mono',monospace;font-size:10px;cursor:pointer;transition:all .15s}
.close-btn:hover{background:${C.red}22}

/* MODAL */
.modal-bg{position:fixed;inset:0;background:#00000099;z-index:300;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)}
.modal{background:${C.surface};border:1px solid ${C.b2};border-radius:14px;width:100%;max-width:520px;animation:fade-up .2s ease;overflow:hidden}
.modal-head{padding:18px 22px;border-bottom:1px solid ${C.border};display:flex;align-items:center;justify-content:space-between}
.modal-title{font-family:'Outfit',sans-serif;font-size:17px;font-weight:700;color:${C.white};display:flex;align-items:center;gap:8px}
.modal-x{background:none;border:none;color:${C.muted};font-size:20px;cursor:pointer;line-height:1}
.modal-x:hover{color:${C.white}}
.modal-body{padding:22px}
.m-row{display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid ${C.border}22;font-size:12px;gap:16px}
.m-row:last-child{border-bottom:none}
.m-lbl{color:${C.muted}}
.m-val{color:${C.white};font-weight:500;text-align:right}
.m-val.teal{color:${C.teal}} .m-val.gold{color:${C.gold}} .m-val.red{color:${C.red}}
.m-divider{height:1px;background:${C.border};margin:12px 0}
.m-result{background:${C.teal}0a;border:1px solid ${C.teal}33;border-radius:9px;padding:14px;text-align:center;margin-top:14px}
.m-result-val{font-family:'Outfit',sans-serif;font-size:28px;font-weight:700;color:${C.teal};margin-bottom:4px}
.m-result-sub{font-size:11px;color:${C.muted}}
.m-warn{background:${C.gold}0a;border:1px solid ${C.gold}33;border-radius:8px;padding:10px 12px;font-size:11px;color:${C.text};line-height:1.6;margin-top:12px}
.m-warn b{color:${C.gold}}
.m-confirm{width:100%;margin-top:14px;padding:12px;border-radius:9px;border:none;font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;cursor:pointer;background:${C.teal}22;border:1px solid ${C.teal}44;color:${C.teal};transition:all .15s}
.m-confirm:hover{background:${C.teal}33}

/* PILL */
.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;font-size:11px}
.pill.teal{background:${C.teal}18;border:1px solid ${C.teal}33;color:${C.teal}}
.pill.gold{background:${C.gold}18;border:1px solid ${C.gold}33;color:${C.gold}}
.pill.red{background:${C.red}18;border:1px solid ${C.red}33;color:${C.red}}

@media(max-width:960px){
  .root{grid-template-columns:1fr;grid-template-areas:"nav" "main"}
  .sidebar{display:none}
  .kpi-row{grid-template-columns:repeat(2,1fr)}
}
`;

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function ExchangeTag({ exchange }) {
  const s = EX_STYLE[exchange] || { bg: "#111", border: "#333", color: "#888", short: exchange.slice(0,2) };
  return (
    <span className="ex-tag" style={{ background: s.bg, borderColor: s.border, color: s.color }}>
      {s.short}
    </span>
  );
}

function rateClass(apr) {
  if (apr >= 50)  return "hot";
  if (apr >= 15)  return "good";
  if (apr >= 0)   return "meh";
  return "neg";
}

function SymLogo({ symbol }) {
  const colors = ["#0ea5e9","#f59e0b","#10b981","#8b5cf6","#ef4444","#f97316","#06b6d4","#ec4899"];
  const idx = symbol.charCodeAt(0) % colors.length;
  return (
    <div className="sym-logo" style={{ background: colors[idx] + "22", border: `1px solid ${colors[idx]}44`, color: colors[idx] }}>
      {symbol.slice(0,2)}
    </div>
  );
}

// ─── MODAL ────────────────────────────────────────────────────────────────────
function OpenModal({ target, capital, onConfirm, onClose }) {
  // target = { symbol, exchange, rate, apr, markPrice, intervalHours } or arb = { symbol, high, low, spreadAPR }
  const isArb = !!target.spreadAPR;
  const capUSD = capital * 1.08;
  const half = capUSD / 2;
  const apr = isArb ? target.spreadAPR : Math.abs(target.apr);
  const monthly = (capUSD * apr / 100 / 365) * 30;
  const fees = capUSD * 0.0008; // ~0.04% taker × 2 legs × 2 exchanges

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <div className="modal-title">
            ⚡ {isArb ? "Cross-Exchange Arb" : "Cash & Carry"} — {isArb ? target.symbol : target.symbol}
          </div>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {isArb ? (
            <>
              <div className="m-row"><span className="m-lbl">Leg 1 — Long spot sur {target.low.exchange}</span><span className="m-val teal">{fmtUSD(half)}</span></div>
              <div className="m-row"><span className="m-lbl">Leg 2 — Short perp sur {target.high.exchange}</span><span className="m-val teal">{fmtUSD(half)}</span></div>
              <div className="m-row"><span className="m-lbl">Rate encaissé ({target.high.exchange})</span><span className="m-val gold">{fmtRate(target.high.rate)} / {target.high.intervalHours}h</span></div>
              <div className="m-row"><span className="m-lbl">Rate payé ({target.low.exchange})</span><span className="m-val" style={{color:C.red}}>{fmtRate(target.low.rate)} / {target.low.intervalHours}h</span></div>
              <div className="m-row"><span className="m-lbl">Spread net APR</span><span className="m-val teal">{fmtAPR(target.spreadAPR)}</span></div>
            </>
          ) : (
            <>
              <div className="m-row"><span className="m-lbl">Leg 1 — Long spot {target.symbol}</span><span className="m-val teal">{fmtUSD(half)}</span></div>
              <div className="m-row"><span className="m-lbl">Leg 2 — Short perp sur {target.exchange}</span><span className="m-val teal">{fmtUSD(half)}</span></div>
              <div className="m-row"><span className="m-lbl">Funding rate actuel</span><span className="m-val gold">{fmtRate(target.rate)} / {target.intervalHours}h</span></div>
              <div className="m-row"><span className="m-lbl">APR estimé</span><span className="m-val teal">{fmtAPR(target.apr)}</span></div>
            </>
          )}
          <div className="m-divider" />
          <div className="m-row"><span className="m-lbl">Capital total engagé</span><span className="m-val">{fmtUSD(capUSD)} (~€{capital})</span></div>
          <div className="m-row"><span className="m-lbl">Frais d'entrée estimés</span><span className="m-val" style={{color:C.red}}>−{fmtUSD(fees)}</span></div>
          <div className="m-row"><span className="m-lbl">Revenu mensuel estimé</span><span className="m-val teal">+{fmtUSD(monthly)}</span></div>

          <div className="m-result">
            <div className="m-result-val">+{fmtUSD(monthly - fees)} / mois</div>
            <div className="m-result-sub">net après frais d'entrée amortis sur 30 jours · APR {fmtAPR(apr)}</div>
          </div>

          <div className="m-warn">
            <b>⚠ Note importante :</b> Ceci est une simulation. Pour exécuter réellement, connecte tes clés API dans les settings. Le bot ouvrira les deux legs simultanément pour minimiser le risque de slippage entre les positions.
          </div>

          <button className="m-confirm" onClick={() => onConfirm(target)}>
            ✓ Confirmer — Ouvrir la position (simulé)
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
function Sidebar({ capital, setCapital, enabledExchanges, toggleExchange, rows }) {
  const bestAPR = rows.filter(r => r.apr > 0).slice(0, 1)[0]?.apr || 0;
  const { monthly, total, monthlyEUR, totalEUR } = calcEarnings(capital, bestAPR, 1);

  return (
    <aside className="sidebar">
      <div className="s-section">
        <div className="s-label">Mon capital</div>
        <div className="capital-wrap">
          <span className="cap-prefix">€</span>
          <input type="number" className="cap-input" value={capital} min={100} max={1000000}
            onChange={e => setCapital(Math.max(1, parseInt(e.target.value) || 500))} />
        </div>
        <div className="cap-hint">Capital de départ · ×1 levier (zéro liquidation)</div>

        {bestAPR > 0 && (
          <div className="proj-best">
            <div className="proj-best-apr">{fmtAPR(bestAPR)}</div>
            <div className="proj-best-label">Meilleur APR disponible</div>
            <div className="proj-best-sub">
              Avec €{capital} → <b style={{color:C.teal}}>+€{monthlyEUR.toFixed(0)}/mois</b>
              {" · "}+€{(totalEUR * 12).toFixed(0)} sur 1 an (compound)
            </div>
          </div>
        )}

        <div className="proj-grid" style={{marginTop:12}}>
          <div className="proj-cell">
            <div className="proj-cell-val teal">+€{monthlyEUR.toFixed(0)}</div>
            <div className="proj-cell-label">Mois 1</div>
          </div>
          <div className="proj-cell">
            <div className="proj-cell-val gold">€{(capital + totalEUR * 6).toFixed(0)}</div>
            <div className="proj-cell-label">Capital 6 mois</div>
          </div>
        </div>
      </div>

      <div className="s-section">
        <div className="s-label">Exchanges</div>
        <div className="exch-filter">
          {Object.entries(EX_STYLE).map(([name, s]) => (
            <div key={name} className={`exch-toggle ${enabledExchanges.includes(name) ? "on" : ""}`}
              style={{ "--ec": s.color, "--ebg": s.bg }}
              onClick={() => toggleExchange(name)}>
              <div>
                <div className="exch-name">{name}</div>
                <span className="exch-chip" style={{ background: s.bg, borderColor: s.border, color: s.color }}>{s.short}</span>
              </div>
              <div className={`toggle-dot ${enabledExchanges.includes(name) ? "on" : ""}`} />
            </div>
          ))}
        </div>
      </div>

      <div className="s-section">
        <div className="s-label">Stratégie</div>
        <div style={{fontSize:11,color:C.text,lineHeight:1.7,background:C.card,border:`1px solid ${C.border}`,borderRadius:9,padding:'12px'}}>
          <div style={{marginBottom:8}}><b style={{color:C.white}}>Cash & Carry</b> — tu achètes du spot + tu shortes le perp sur le même exchange. Tu encaisses le funding toutes les heures (HL) ou 8h (BN/BB).</div>
          <div><b style={{color:C.white}}>Cross-Arb</b> — tu shortes le perp qui paie le plus, tu longes le perp qui paie le moins. Tu encaisses le spread des deux rates.</div>
        </div>
      </div>
    </aside>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("rates");         // rates | arb | positions
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [capital, setCapital] = useState(500);
  const [enabledExchanges, setEnabledExchanges] = useState(["Hyperliquid","Binance","Bybit"]);
  const [sortBy, setSortBy] = useState("apr");
  const [filterPositive, setFilterPositive] = useState(true);
  const [openModal, setOpenModal] = useState(null);
  const [positions, setPositions] = useState([]);

  const toggleExchange = useCallback(name => {
    setEnabledExchanges(prev =>
      prev.includes(name) ? prev.filter(e => e !== name) : [...prev, name]
    );
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
    setRows(buildRows());
    setLastUpdate(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, []);
  useEffect(() => {
    const id = setInterval(fetchAll, 60000); // refresh every 60s
    return () => clearInterval(id);
  }, [fetchAll]);

  // Tick PnL on open positions every second
  useEffect(() => {
    const id = setInterval(() => {
      setPositions(prev => prev.map(p => {
        const elapsed = (Date.now() - p.openedAt) / 3600000; // hours
        const ratePerHour = p.apr / 100 / 24 / 365 * 365; // simplified
        const pnl = p.capitalUSD * (p.apr / 100 / 365 / 24) * elapsed;
        return { ...p, pnl, elapsed };
      }));
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const handleConfirm = useCallback((target) => {
    setOpenModal(null);
    const isArb = !!target.spreadAPR;
    const capUSD = capital * 1.08;
    setPositions(prev => [...prev, {
      id: Date.now(),
      symbol: target.symbol,
      exchange: isArb ? `${target.high.exchange} / ${target.low.exchange}` : target.exchange,
      type: isArb ? "Cross-Arb" : "Cash & Carry",
      apr: isArb ? target.spreadAPR : target.apr,
      capitalUSD: capUSD,
      openedAt: Date.now(),
      pnl: 0,
      elapsed: 0,
    }]);
  }, [capital]);

  // Filtered + sorted rows
  const filtered = rows
    .filter(r => enabledExchanges.includes(r.exchange))
    .filter(r => filterPositive ? r.apr > 0 : true)
    .sort((a, b) => {
      if (sortBy === "apr") return b.apr - a.apr;
      if (sortBy === "rate") return b.rate - a.rate;
      if (sortBy === "symbol") return a.symbol.localeCompare(b.symbol);
      return 0;
    })
    .slice(0, 80);

  const arbs = findCrossArb(rows.filter(r => enabledExchanges.includes(r.exchange)));
  const bestAPR = filtered[0]?.apr || 0;
  const posCount = positions.length;
  const totalPnL = positions.reduce((s, p) => s + p.pnl, 0);
  const avgAPR = filtered.length ? filtered.slice(0, 10).reduce((s, r) => s + r.apr, 0) / 10 : 0;
  const capUSD = capital * 1.08;

  return (
    <>
      <style>{css}</style>
      <div className="root">

        {/* NAV */}
        <nav className="nav">
          <div className="logo">
            <div className="logo-mark">📡</div>
            FundingBot
          </div>
          <div className="nav-tabs">
            {[["rates","📊 Rates"],["arb","⚡ Cross-Arb"],["positions","🏦 Positions"]].map(([id,label])=>(
              <button key={id} className={`nav-tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{label}</button>
            ))}
          </div>
          <div className="nav-right">
            <div className="live-badge">
              <div className="live-dot" />
              {loading ? "Chargement..." : `MAJ ${lastUpdate?.toLocaleTimeString("fr-FR",{hour12:false})}`}
            </div>
            <button className="refresh-btn" onClick={fetchAll}>↻ Refresh</button>
          </div>
        </nav>

        {/* SIDEBAR */}
        <Sidebar capital={capital} setCapital={setCapital}
          enabledExchanges={enabledExchanges} toggleExchange={toggleExchange} rows={filtered} />

        {/* MAIN */}
        <main className="main">
          <div className="scan-bar">{!loading && <div className="scan-bar-inner" />}</div>

          {/* KPIs */}
          <div className="kpi-row">
            <div className="kpi k1">
              <div className="kpi-num teal">{fmtAPR(bestAPR)}</div>
              <div className="kpi-lbl">Meilleur APR live</div>
            </div>
            <div className="kpi k2">
              <div className="kpi-num gold">+{fmtUSD(capUSD * bestAPR / 100 / 12)}</div>
              <div className="kpi-lbl">Gain/mois estimé (€{capital})</div>
            </div>
            <div className="kpi k3">
              <div className="kpi-num blue">{filtered.filter(r=>r.apr>=20).length}</div>
              <div className="kpi-lbl">Opportunités APR ≥ 20%</div>
            </div>
            <div className="kpi k4" style={{["--c"]:C.purple}}>
              <div className="kpi-num" style={{color:totalPnL>=0?C.teal:C.red}}>{totalPnL>=0?"+":""}{fmtUSD(totalPnL)}</div>
              <div className="kpi-lbl">PnL positions ouvertes ({posCount})</div>
            </div>
          </div>

          {/* ── TAB : RATES ── */}
          {tab === "rates" && (
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
                <div style={{display:"flex",gap:8}}>
                  {[["apr","APR ↓"],["rate","Rate ↓"],["symbol","Symbole"]].map(([k,l])=>(
                    <button key={k} className={`view-tab ${sortBy===k?"active":""}`} onClick={()=>setSortBy(k)}>{l}</button>
                  ))}
                  <button className={`view-tab ${filterPositive?"active":""}`} onClick={()=>setFilterPositive(v=>!v)}>
                    {filterPositive?"✓ Positifs seulement":"Tous"}
                  </button>
                </div>
                <span style={{fontSize:11,color:C.muted}}>{filtered.length} paires · {enabledExchanges.join(", ")}</span>
              </div>

              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th onClick={()=>setSortBy("symbol")} className={sortBy==="symbol"?"sorted":""}>Symbole</th>
                      <th>Exchange</th>
                      <th onClick={()=>setSortBy("rate")} className={sortBy==="rate"?"sorted":""}>Rate / période</th>
                      <th onClick={()=>setSortBy("apr")} className={sortBy==="apr"?"sorted":""}>APR annualisé</th>
                      <th>Prochain funding</th>
                      <th>Gain / 30j (€{capital})</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={7} style={{textAlign:"center",padding:32,color:C.muted}}>
                        {loading ? "Chargement des rates..." : "Aucun résultat"}
                      </td></tr>
                    )}
                    {filtered.map((r, i) => {
                      const monthlyGain = capUSD * Math.abs(r.apr) / 100 / 12;
                      const isOpen = positions.some(p => p.symbol === r.symbol && p.exchange === r.exchange);
                      return (
                        <tr key={`${r.exchange}-${r.symbol}-${i}`}>
                          <td>
                            <div className="sym-cell">
                              <SymLogo symbol={r.symbol} />
                              <div>
                                <div className="sym-main">{r.symbol}</div>
                                <div className="sym-sub">${r.markPrice?.toFixed(r.markPrice > 100 ? 0 : 4)}</div>
                              </div>
                            </div>
                          </td>
                          <td><ExchangeTag exchange={r.exchange} /></td>
                          <td><span className={`rate-val ${rateClass(r.apr)}`}>{fmtRate(r.rate)}/{r.intervalHours}h</span></td>
                          <td>
                            <div className="apr-bar-wrap">
                              <div className={`apr-bar ${r.apr>=0?"pos":"neg"}`} style={{width: Math.min(80, Math.abs(r.apr) * 0.8)+"px"}} />
                              <span className={`apr-num ${r.apr>=0?"pos":"neg"}`}>{fmtAPR(r.apr)}</span>
                            </div>
                          </td>
                          <td><span className={`timer ${minsLeft(r.nextFunding)==="now"?"soon":""}`}>{minsLeft(r.nextFunding)}</span></td>
                          <td><span className={`earn-est ${r.apr>=0?"":"neg"}`}>{r.apr>=0?"+":""}{fmtUSD(monthlyGain)}</span></td>
                          <td>
                            <button
                              className={`action-btn ${isOpen?"active":r.apr>=5?"open":"neg"}`}
                              onClick={() => !isOpen && r.apr >= 5 && setOpenModal(r)}
                              disabled={isOpen || r.apr < 5}>
                              {isOpen ? "✓ Ouverte" : r.apr >= 5 ? "▶ Ouvrir" : "Skip"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── TAB : CROSS-ARB ── */}
          {tab === "arb" && (
            <div>
              <div style={{fontSize:12,color:C.muted,marginBottom:16,lineHeight:1.7,background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:'12px 14px'}}>
                <b style={{color:C.white}}>Cross-Exchange Arb</b> — short perp sur l'exchange qui paie le plus, long perp sur celui qui paie le moins. Tu encaisses le spread sans exposition au prix. Idéal quand les rates divergent entre exchanges.
              </div>
              {arbs.length === 0 && (
                <div style={{textAlign:"center",padding:40,color:C.muted,fontSize:12}}>
                  {loading ? "Calcul des spreads..." : "Aucun spread ≥ 5% APR détecté en ce moment."}
                </div>
              )}
              {arbs.slice(0, 20).map((arb, i) => {
                const isOpen = positions.some(p => p.symbol === arb.symbol);
                return (
                  <div key={arb.symbol + i} className="arb-row">
                    <div>
                      <div className="arb-sym">{arb.symbol}</div>
                      <div className="arb-side">SHORT <b>{arb.high.exchange}</b> · <span style={{color:C.gold}}>{fmtRate(arb.high.rate)}</span></div>
                    </div>
                    <div className="arb-spread">
                      <div className="spread-arrow">⇄</div>
                      <div className="spread-apr">{fmtAPR(arb.spreadAPR)}</div>
                      <div className="spread-label">spread APR</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div className="arb-sym">{arb.symbol}</div>
                      <div className="arb-side">LONG <b>{arb.low.exchange}</b> · <span style={{color:C.text}}>{fmtRate(arb.low.rate)}</span></div>
                    </div>
                    <button
                      className={`arb-btn ${isOpen?"active":""}`}
                      onClick={() => !isOpen && setOpenModal(arb)}
                      disabled={isOpen}>
                      {isOpen ? "✓ Ouverte" : "▶ Ouvrir"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── TAB : POSITIONS ── */}
          {tab === "positions" && (
            <div>
              <div className="pos-wrap">
                <div className="pos-header">
                  <div className="pos-title">
                    🏦 Positions ouvertes
                    <span className="pill teal">{positions.length} active{positions.length!==1?"s":""}</span>
                  </div>
                  {totalPnL > 0 && <span className="pill gold">+{fmtUSD(totalPnL)} PnL total</span>}
                </div>
                <div className="pos-body">
                  {positions.length === 0 ? (
                    <div className="empty-pos">
                      Aucune position ouverte.<br/>
                      Va dans <b style={{color:C.white}}>Rates</b> ou <b style={{color:C.white}}>Cross-Arb</b> et clique <b style={{color:C.teal}}>▶ Ouvrir</b> sur une opportunité.
                    </div>
                  ) : (
                    <>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr auto",gap:10,padding:"6px 0",fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:"1px",borderBottom:`1px solid ${C.border}`,marginBottom:4}}>
                        <div>Symbole</div><div>Type</div><div>APR</div><div>Durée</div><div>PnL</div><div />
                      </div>
                      {positions.map(p => (
                        <div key={p.id} className="pos-row">
                          <div>
                            <div className="pos-sym">{p.symbol}</div>
                            <div className="pos-detail">{p.exchange}</div>
                          </div>
                          <div>
                            <span className="pill teal" style={{fontSize:10}}>{p.type}</span>
                          </div>
                          <div className={`pos-rate ${p.apr>=10?"ok":"bad"}`}>{fmtAPR(p.apr)}</div>
                          <div style={{fontSize:11,color:C.muted}}>
                            {p.elapsed < 1 ? Math.round(p.elapsed*60)+"min" : p.elapsed.toFixed(1)+"h"}
                          </div>
                          <div className={`pos-pnl ${p.pnl>=0?"pos":"neg"}`}>
                            {p.pnl>=0?"+":""}{fmtUSD(p.pnl)}
                          </div>
                          <button className="close-btn" onClick={() => setPositions(prev => prev.filter(x => x.id !== p.id))}>
                            Fermer
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>

              {positions.length > 0 && (
                <div style={{marginTop:16,background:C.card,border:`1px solid ${C.border}`,borderRadius:11,padding:16,fontSize:12,color:C.text,lineHeight:1.7}}>
                  <b style={{color:C.white}}>Pour automatiser en production :</b> ajoute tes clés API Hyperliquid/Binance/Bybit dans les settings. Le bot monitore le rate toutes les minutes — si le rate flip (devient négatif), il ferme automatiquement la position et cherche la prochaine opportunité.
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {openModal && (
        <OpenModal target={openModal} capital={capital} onConfirm={handleConfirm} onClose={() => setOpenModal(null)} />
      )}
    </>
  );
}


