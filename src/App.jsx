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

// ─── ANOMALY DETECTION ENGINE ────────────────────────────────────────────────
// Historique des rates pour détecter les spikes (garde 20 snapshots par paire)
const rateHistory = {};

function recordRates(rows) {
  const now = Date.now();
  rows.forEach(r => {
    const key = `${r.exchange}-${r.symbol}`;
    if (!rateHistory[key]) rateHistory[key] = [];
    rateHistory[key].push({ apr: r.apr, ts: now });
    if (rateHistory[key].length > 20) rateHistory[key].shift();
  });
}

// Score d'anomalie : 0=normal, 1=suspect, 2=danger
function getAnomalyScore(row) {
  const key = `${row.exchange}-${row.symbol}`;
  const hist = rateHistory[key] || [];
  if (hist.length < 3) return { score: 0, reason: null };

  const aprs = hist.map(h => h.apr);
  const avg = aprs.reduce((a, b) => a + b, 0) / aprs.length;
  const current = row.apr;

  // Pattern 1 : spike soudain (rate > 3x la moyenne historique)
  if (current > avg * 3 && current > 50) {
    return { score: 2, reason: `Spike ×${(current/avg).toFixed(1)} vs moyenne (${avg.toFixed(0)}% APR)` };
  }

  // Pattern 2 : rate anormalement élevé (>200% APR) sans historique stable
  if (current > 200) {
    const stable = aprs.filter(a => a > 100).length;
    if (stable < 3) return { score: 2, reason: `Rate >200% APR sans historique stable` };
  }

  // Pattern 3 : spike modéré (2x la moyenne)
  if (current > avg * 2 && current > 30) {
    return { score: 1, reason: `Rate ×${(current/avg).toFixed(1)} vs moyenne — surveiller` };
  }

  // Pattern 4 : rate très instable (variance élevée)
  const variance = aprs.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / aprs.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev > avg * 0.5 && avg > 20) {
    return { score: 1, reason: `Rate instable (σ=${stdDev.toFixed(0)}%) — risque d'inversion` };
  }

  return { score: 0, reason: null };
}

function anomalyLabel(score) {
  if (score === 2) return { text: "⚠ DANGER", color: "#f43f5e" };
  if (score === 1) return { text: "⚡ SUSPECT", color: "#f59e0b" };
  return { text: "✓ NORMAL", color: "#22c55e" };
}



// ─── SMALL CAPS ENGINE ───────────────────────────────────────────────────────
// Cibles : APR > 30%, exchange MEXC ou Hyperliquid, paire non-majeure
const MAJORS = new Set(["BTC","ETH","BNB","SOL","XRP","ADA","DOGE","LTC","DOT","AVAX","LINK","ATOM"]);

function isSmallCap(row) {
  return (row.exchange === "MEXC" || row.exchange === "Hyperliquid") && !MAJORS.has(row.symbol);
}

// Score de durabilité 1-4 jours (0-100)
// Basé sur : stabilité historique + niveau APR + exchange
function getDurabilityScore(row) {
  const key = `${row.exchange}-${row.symbol}`;
  const hist = rateHistory[key] || [];
  const apr = row.apr;

  if (apr < 20) return 0;

  // Base score selon APR
  let score = Math.min(40, apr * 0.4);

  if (hist.length >= 3) {
    const aprs = hist.map(h => h.apr);
    const avg = aprs.reduce((a, b) => a + b, 0) / aprs.length;
    const variance = aprs.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / aprs.length;
    const stdDev = Math.sqrt(variance);
    const cv = avg > 0 ? stdDev / avg : 1; // coefficient of variation

    // Stabilité : CV faible = rate stable = bonus
    const stabilityBonus = Math.max(0, 40 * (1 - cv * 2));
    score += stabilityBonus;

    // Tendance : rate qui monte = +bonus, qui baisse = malus
    const recent = aprs.slice(-3);
    const trend = recent[recent.length - 1] - recent[0];
    if (trend > 0) score += 10;
    else if (trend < -avg * 0.2) score -= 15;

    // Persistance : si tous les snapshots > 20% APR = très bon signe
    const allHigh = aprs.every(a => a > 20);
    if (allHigh && hist.length >= 5) score += 10;
  } else {
    // Pas d'historique — score conservateur
    score = Math.min(score, 35);
  }

  // MEXC bonus (rates structurellement plus élevés sur meme coins)
  if (row.exchange === "MEXC" && apr > 50) score += 8;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function durabilityLabel(score) {
  if (score >= 70) return { text: "★★★ Excellent", color: "#10b981", days: "3-4j" };
  if (score >= 50) return { text: "★★☆ Bon",       color: "#06b6d4", days: "2-3j" };
  if (score >= 30) return { text: "★☆☆ Moyen",     color: "#eab308", days: "1-2j" };
  return             { text: "☆☆☆ Faible",          color: "#6b7280", days: "<1j" };
}

// Calcul profit net sur N jours
function calcProfit(row, capitalEUR, days) {
  const capUSD = capitalEUR * 1.08;
  const dailyAPR = row.apr / 100 / 365;
  const grossProfit = capUSD * dailyAPR * days;
  // Fees : 0.04% taker × 2 legs (entrée) + 0.04% × 2 (sortie)
  const fees = capUSD * 0.0004 * 4;
  return { gross: grossProfit, fees, net: grossProfit - fees, roi: (grossProfit - fees) / capUSD * 100 };
}

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
  bg:      "#04060f",   // near-black, slightly warmer
  surface: "#080c18",   // nav/sidebar
  card:    "#0c1120",   // cards
  border:  "#141e35",   // subtle borders
  b2:      "#1c2a48",   // stronger borders
  accent:  "#2563eb",   // primary blue
  teal:    "#06b6d4",   // cyan — main highlight
  gold:    "#eab308",   // amber — high rates
  red:     "#e11d48",   // danger
  green:   "#10b981",   // success
  purple:  "#7c3aed",   // arb
  muted:   "#334466",   // muted text
  text:    "#7a90b4",   // body text
  white:   "#dde6f5",   // headings
};

const css = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Outfit:wght@500;600;700;800&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:${C.bg};color:${C.text};font-family:'JetBrains Mono',monospace;overflow-x:hidden}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${C.b2};border-radius:2px}

@keyframes fade-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes scan-h{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}
@keyframes row-in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
@keyframes count-up{from{opacity:.3}to{opacity:1}}
@keyframes glow-gold{0%,100%{box-shadow:0 0 0 transparent}50%{box-shadow:0 0 20px ${C.gold}33}}

/* LAYOUT */
.root{display:grid;grid-template-columns:280px 1fr;grid-template-rows:58px 1fr;min-height:100vh}
.nav{grid-column:1/-1;background:${C.surface};border-bottom:1px solid ${C.border};display:flex;align-items:center;padding:0 24px;gap:16px;position:sticky;top:0;z-index:100;box-shadow:0 1px 0 ${C.b2}}
.sidebar{background:${C.bg};border-right:1px solid ${C.border};padding:20px 16px;overflow-y:auto;height:calc(100vh - 58px);position:sticky;top:58px}
.main{padding:22px;overflow-y:auto;height:calc(100vh - 58px)}

/* NAV */
.logo{font-family:'Outfit',sans-serif;font-weight:800;font-size:16px;color:${C.white};display:flex;align-items:center;gap:10px;letter-spacing:-0.3px}
.logo-mark{background:linear-gradient(135deg,${C.teal},${C.accent});width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px ${C.teal}44}
.logo-name{display:flex;flex-direction:column;gap:0px}
.logo-title{font-family:'Outfit',sans-serif;font-weight:800;font-size:15px;color:${C.white};letter-spacing:-0.3px;line-height:1.1}
.logo-by{font-size:10px;color:${C.muted};font-weight:400;letter-spacing:0;display:flex;align-items:center;gap:3px;line-height:1}
.tg-icon{color:#26a8ea;font-size:11px}
.nav-tabs{display:flex;gap:2px;margin-left:16px}
.nav-tab{padding:6px 14px;border-radius:7px;border:none;background:transparent;color:${C.muted};font-family:'JetBrains Mono',monospace;font-size:12px;cursor:pointer;transition:all .15s}
.nav-tab:hover{color:${C.text}}
.nav-tab.active{background:${C.teal}15;color:${C.teal};border:1px solid ${C.teal}33}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:14px}
.live-badge{display:flex;align-items:center;gap:6px;background:${C.card};border:1px solid ${C.border};border-radius:20px;padding:4px 12px;font-size:11px;color:${C.muted}}
.live-dot{width:6px;height:6px;border-radius:50%;background:${C.teal};animation:pulse 1.3s infinite}
.refresh-btn{padding:5px 12px;border-radius:8px;border:1px solid ${C.border};background:transparent;color:${C.muted};font-family:'JetBrains Mono',monospace;font-size:11px;cursor:pointer;transition:all .15s}
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
.kpi{background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:16px;animation:fade-up .35s ease both;transition:border-color .2s}
.kpi:hover{border-color:${C.b2}}
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
.view-tab{padding:7px 16px;border-radius:8px;border:1px solid ${C.border};background:transparent;color:${C.muted};font-family:'JetBrains Mono',monospace;font-size:12px;cursor:pointer;transition:all .15s}
.view-tab:hover{color:${C.text};border-color:${C.b2}}
.view-tab.active{background:${C.teal}18;border-color:${C.teal}55;color:${C.teal}}

/* MAIN TABLE */
.tbl-wrap{background:${C.card};border:1px solid ${C.border};border-radius:11px;overflow:hidden}
table{width:100%;border-collapse:collapse}
thead tr{border-bottom:1px solid ${C.border};background:${C.bg}}
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

.action-btn{padding:5px 14px;border-radius:6px;font-family:'JetBrains Mono',monospace;font-size:11px;cursor:pointer;transition:all .15s;border:1px solid}
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
.arb-btn{padding:8px 18px;border-radius:8px;border:1px solid ${C.teal}44;background:${C.teal}18;color:${C.teal};font-family:'JetBrains Mono',monospace;font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap}
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
.close-btn{padding:5px 12px;border-radius:6px;border:1px solid ${C.red}44;background:${C.red}11;color:${C.red};font-family:'JetBrains Mono',monospace;font-size:10px;cursor:pointer;transition:all .15s}
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


/* SMALL CAPS */
.sc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.sc-card{background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:16px;transition:border-color .2s;animation:fade-up .25s ease}
.sc-card:hover{border-color:${C.b2}}
.sc-card.tier-hot{border-color:#10b98133;background:linear-gradient(135deg,${C.card},#0a1f1800)}
.sc-card.tier-good{border-color:#06b6d433}
.sc-card.tier-mid{border-color:#eab30833}
.sc-card-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.sc-sym{font-family:'Outfit',sans-serif;font-size:18px;font-weight:800;color:${C.white}}
.sc-exch{font-size:10px;padding:2px 7px;border-radius:4px;font-weight:700;margin-left:6px}
.sc-apr{font-family:'Outfit',sans-serif;font-size:22px;font-weight:800}
.sc-apr.hot{color:#10b981} .sc-apr.good{color:#06b6d4} .sc-apr.mid{color:#eab308}
.sc-profit-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:10px 0}
.sc-profit-cell{background:${C.surface};border-radius:6px;padding:8px;text-align:center}
.sc-profit-label{font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px}
.sc-profit-val{font-family:'Outfit',sans-serif;font-size:13px;font-weight:700;color:#10b981}
.sc-profit-fee{font-size:9px;color:${C.muted};margin-top:1px}
.sc-dur{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid ${C.border}22}
.sc-dur-label{font-size:11px;font-weight:600}
.sc-days{font-size:10px;color:${C.muted}}
.sc-open-btn{padding:6px 14px;border-radius:7px;font-family:'JetBrains Mono',monospace;font-size:11px;cursor:pointer;transition:all .15s;background:#10b98118;border:1px solid #10b98144;color:#10b981}
.sc-open-btn:hover{background:#10b98128}
.sc-open-btn.active{background:#eab30818;border-color:#eab30844;color:#eab308;cursor:default}
.sc-empty{text-align:center;padding:48px 24px;color:${C.muted};font-size:12px;line-height:1.8}
.sc-filters{display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.sc-filter-btn{padding:5px 12px;border-radius:20px;border:1px solid ${C.border};background:transparent;color:${C.muted};font-family:'JetBrains Mono',monospace;font-size:11px;cursor:pointer;transition:all .15s}
.sc-filter-btn:hover{border-color:${C.b2};color:${C.text}}
.sc-filter-btn.active{background:#10b98118;border-color:#10b98144;color:#10b981}
.sc-info{background:${C.surface};border:1px solid ${C.border};border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:11px;color:${C.text};line-height:1.7}

/* MOBILE BOTTOM NAV */
.mob-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:${C.surface};border-top:1px solid ${C.border};z-index:200;padding:0 8px env(safe-area-inset-bottom,0)}
.mob-nav-inner{display:flex;justify-content:space-around;align-items:center;height:56px}
.mob-tab{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 16px;border:none;background:transparent;color:${C.muted};font-family:'JetBrains Mono',monospace;font-size:9px;cursor:pointer;border-radius:8px;transition:all .15s;text-transform:uppercase;letter-spacing:.8px}
.mob-tab.active{color:${C.teal}}
.mob-tab-icon{font-size:18px;line-height:1}

/* MOBILE CARDS (table → cards on small screen) */
.rate-card{background:${C.card};border:1px solid ${C.border};border-radius:10px;padding:14px;margin-bottom:8px;animation:fade-up .2s ease}
.rate-card.anm-danger{border-left:3px solid ${C.red};background:${C.red}08}
.rate-card.anm-suspect{border-left:3px solid #f59e0b;background:#f59e0b08}
.rate-card-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.rate-card-sym{display:flex;align-items:center;gap:8px}
.rate-card-right{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.rate-card-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.rate-card-cell{background:${C.surface};border-radius:6px;padding:8px}
.rate-card-cell-label{font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px}
.rate-card-cell-val{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;color:${C.white}}

/* MOBILE CAPITAL STRIP */
.mob-cap-strip{display:none;background:${C.surface};border-bottom:1px solid ${C.border};padding:10px 16px;align-items:center;justify-content:space-between;gap:12px}
.mob-cap-input{flex:1;padding:7px 10px 7px 24px;background:${C.card};border:1px solid ${C.b2};border-radius:8px;color:${C.white};font-family:'Outfit',sans-serif;font-size:15px;font-weight:700;outline:none;-moz-appearance:textfield}
.mob-cap-input::-webkit-inner-spin-button,.mob-cap-input::-webkit-outer-spin-button{-webkit-appearance:none}
.mob-cap-prefix{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:${C.gold};font-size:14px;pointer-events:none}
.mob-cap-wrap{position:relative;flex:1}
.mob-best{font-family:'Outfit',sans-serif;font-size:13px;font-weight:700;color:${C.teal};white-space:nowrap}
.mob-best-label{font-size:9px;color:${C.muted};text-align:right}

@media(max-width:760px){
  .root{grid-template-columns:1fr;grid-template-rows:50px auto 1fr}
  .nav{height:50px;padding:0 14px;gap:10px}
  .nav-tabs{display:none}
  .nav-right .live-badge{display:none}
  .sidebar{display:none}
  .main{padding:12px 12px 72px;height:auto}
  .mob-nav{display:block}
  .mob-cap-strip{display:flex}
  .kpi-row{grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px}
  .kpi{padding:10px}
  .kpi-num{font-size:18px}
  .kpi-lbl{font-size:9px}
  .tbl-wrap{display:none}
  .mob-cards{display:block}
  .view-tabs{flex-wrap:wrap;gap:4px}
  .view-tab{padding:5px 10px;font-size:11px}
  .arb-row{grid-template-columns:1fr auto;grid-template-rows:auto auto;gap:8px;padding:12px}
  .arb-spread{grid-row:2;grid-column:1/-1;display:flex;align-items:center;gap:12px;text-align:left}
  .spread-arrow{font-size:16px}
  .spread-apr{font-size:16px}
  .pos-row{grid-template-columns:1fr 1fr;gap:6px}
  .logo-mark{width:22px;height:22px;font-size:11px}
  .logo{font-size:14px}
}
@media(min-width:761px){
  .mob-cards{display:none}
  .mob-nav{display:none}
  .mob-cap-strip{display:none}
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


function MobileRateCards({ rows, capital, onOpen, positions }) {
  const capUSD = capital * 1.08;
  return (
    <div className="mob-cards">
      {rows.length === 0 && (
        <div style={{textAlign:"center",padding:32,color:"#3d4f70",fontSize:12}}>Chargement...</div>
      )}
      {rows.map((r, i) => {
        const anm = getAnomalyScore(r);
        const anmLbl = anomalyLabel(anm.score);
        const monthlyGain = capUSD * Math.abs(r.apr) / 100 / 12;
        const isOpen = positions.some(p => p.symbol === r.symbol && p.exchange === r.exchange);
        const s = EX_STYLE[r.exchange] || { bg:"#111", border:"#333", color:"#888", short:"??" };
        const colors = ["#0ea5e9","#f59e0b","#10b981","#8b5cf6","#ef4444","#f97316","#06b6d4","#ec4899"];
        const col = colors[r.symbol.charCodeAt(0) % colors.length];
        return (
          <div key={`${r.exchange}-${r.symbol}-${i}`}
            className={`rate-card ${anm.score===2?"anm-danger":anm.score===1?"anm-suspect":""}`}>
            <div className="rate-card-top">
              <div className="rate-card-sym">
                <div style={{width:32,height:32,borderRadius:"50%",background:col+"22",border:`1px solid ${col}44`,color:col,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Outfit,sans-serif",fontSize:11,fontWeight:700,flexShrink:0}}>
                  {r.symbol.slice(0,2)}
                </div>
                <div>
                  <div style={{fontFamily:"Outfit,sans-serif",fontSize:14,fontWeight:700,color:"#e8eeff"}}>{r.symbol}</div>
                  <span style={{background:s.bg,border:`1px solid ${s.border}`,color:s.color,fontSize:9,padding:"1px 5px",borderRadius:3,fontWeight:600}}>{s.short}</span>
                </div>
              </div>
              <div className="rate-card-right">
                <span style={{background:anmLbl.color+"22",border:`1px solid ${anmLbl.color}44`,color:anmLbl.color,fontSize:9,padding:"2px 6px",borderRadius:4,fontWeight:600}}>{anmLbl.text}</span>
                {!isOpen && r.apr >= 5 && (
                  <button style={{padding:"4px 10px",borderRadius:5,border:`1px solid #00d4aa44`,background:"#00d4aa18",color:"#00d4aa",fontFamily:"DM Mono,monospace",fontSize:10,cursor:"pointer"}}
                    onClick={() => onOpen(r)}>▶ Ouvrir</button>
                )}
                {isOpen && <span style={{fontSize:10,color:"#f0b429"}}>✓ Ouverte</span>}
              </div>
            </div>
            <div className="rate-card-grid">
              <div className="rate-card-cell">
                <div className="rate-card-cell-label">APR</div>
                <div className="rate-card-cell-val" style={{color:r.apr>=50?"#f0b429":r.apr>=15?"#00d4aa":"#8899bb"}}>{fmtAPR(r.apr)}</div>
              </div>
              <div className="rate-card-cell">
                <div className="rate-card-cell-label">Rate/{r.intervalHours}h</div>
                <div className="rate-card-cell-val" style={{fontSize:11}}>{fmtRate(r.rate)}</div>
              </div>
              <div className="rate-card-cell">
                <div className="rate-card-cell-label">+/mois</div>
                <div className="rate-card-cell-val" style={{color:"#00d4aa",fontSize:12}}>+{fmtUSD(monthlyGain)}</div>
              </div>
            </div>
            {anm.reason && <div style={{fontSize:10,color:"#f59e0b",marginTop:8,lineHeight:1.4}}>⚠ {anm.reason}</div>}
          </div>
        );
      })}
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

// ─── SMALL CAPS COMPONENT ───────────────────────────────────────────────────
function SmallCapsTab({ rows, capital, positions, onOpen }) {
  const [minAPR, setMinAPR] = useState(30);
  const [exchFilter, setExchFilter] = useState("all"); // all | mexc | hl

  const candidates = rows
    .filter(r => isSmallCap(r))
    .filter(r => r.apr >= minAPR)
    .filter(r => exchFilter === "all" || r.exchange.toLowerCase().includes(exchFilter))
    .map(r => ({
      ...r,
      durability: getDurabilityScore(r),
      durLabel: durabilityLabel(getDurabilityScore(r)),
      anomaly: getAnomalyScore(r),
      p1: calcProfit(r, capital, 1),
      p2: calcProfit(r, capital, 2),
      p4: calcProfit(r, capital, 4),
    }))
    .filter(c => c.anomaly.score < 2) // exclure les DANGER
    .sort((a, b) => b.durability - a.durability);

  const tierClass = (score) => score >= 70 ? "tier-hot" : score >= 50 ? "tier-good" : "tier-mid";
  const aprClass  = (apr)   => apr >= 100 ? "hot" : apr >= 50 ? "good" : "mid";
  const capUSD = capital * 1.08;

  return (
    <div>
      <div className="sc-info">
        <b style={{color:"#e8eeff"}}>🔥 Small Caps Structurellement Rentables</b> — Paires MEXC &amp; Hyperliquid hors top-12. 
        Les traders retail longuent massivement ces tokens, créant un rate positif persistant de plusieurs jours.
        Stratégie : <b style={{color:"#10b981"}}>achat spot + short perp ×1</b> → tu encaisses le funding sans exposition au prix.
        Les rates DANGER (spikes) sont exclus automatiquement.
      </div>

      <div className="sc-filters">
        <span style={{fontSize:11,color:"#334466",marginRight:4}}>Exchange :</span>
        {[["all","Tous"],["mexc","MEXC"],["hl","Hyperliquid"]].map(([v,l]) => (
          <button key={v} className={`sc-filter-btn ${exchFilter===v?"active":""}`} onClick={() => setExchFilter(v)}>{l}</button>
        ))}
        <span style={{fontSize:11,color:"#334466",marginLeft:12,marginRight:4}}>Min APR :</span>
        {[30,50,80,120].map(v => (
          <button key={v} className={`sc-filter-btn ${minAPR===v?"active":""}`} onClick={() => setMinAPR(v)}>{v}%+</button>
        ))}
        <span style={{fontSize:11,color:"#7a90b4",marginLeft:"auto"}}>{candidates.length} paires · capital {capital}€</span>
      </div>

      {candidates.length === 0 ? (
        <div className="sc-empty">
          Aucune small cap avec APR ≥ {minAPR}% et score NORMAL.<br/>
          Baisse le filtre Min APR ou attends le prochain refresh (60s).
        </div>
      ) : (
        <div className="sc-grid">
          {candidates.map((c, i) => {
            const isOpen = positions.some(p => p.symbol === c.symbol && p.exchange === c.exchange);
            const exStyle = c.exchange === "MEXC"
              ? { bg:"#001a10", border:"#00c97444", color:"#00c974" }
              : { bg:"#051520", border:"#0ea5e944", color:"#38bdf8" };
            return (
              <div key={`${c.exchange}-${c.symbol}-${i}`} className={`sc-card ${tierClass(c.durability)}`}>
                <div className="sc-card-top">
                  <div style={{display:"flex",alignItems:"center"}}>
                    <span className="sc-sym">{c.symbol}</span>
                    <span className="sc-exch" style={{background:exStyle.bg,border:`1px solid ${exStyle.border}`,color:exStyle.color}}>
                      {c.exchange === "MEXC" ? "MX" : "HL"}
                    </span>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div className={`sc-apr ${aprClass(c.apr)}`}>{fmtAPR(c.apr)}</div>
                    <div style={{fontSize:10,color:"#334466"}}>APR · {c.intervalHours}h interval</div>
                  </div>
                </div>

                {/* Profit estimé sur 1j / 2j / 4j */}
                <div className="sc-profit-grid">
                  {[["1 jour", c.p1], ["2 jours", c.p2], ["4 jours", c.p4]].map(([label, p]) => (
                    <div key={label} className="sc-profit-cell">
                      <div className="sc-profit-label">{label}</div>
                      <div className="sc-profit-val">+{fmtUSD(p.net)}</div>
                      <div className="sc-profit-fee">fees {fmtUSD(p.fees)}</div>
                    </div>
                  ))}
                </div>

                <div className="sc-dur">
                  <div>
                    <div className="sc-dur-label" style={{color:c.durLabel.color}}>{c.durLabel.text}</div>
                    <div className="sc-days">Durée estimée : {c.durLabel.days} · Score {c.durability}/100</div>
                    {c.anomaly.score === 1 && (
                      <div style={{fontSize:10,color:"#eab308",marginTop:3}}>⚡ {c.anomaly.reason}</div>
                    )}
                  </div>
                  <button
                    className={`sc-open-btn ${isOpen?"active":""}`}
                    onClick={() => !isOpen && onOpen(c)}
                    disabled={isOpen}>
                    {isOpen ? "✓ Ouverte" : "▶ Entrer"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [authed, setAuthed] = useState(false);
  const [pwd, setPwd] = useState("");
  const [pwdErr, setPwdErr] = useState("");
  const [tab, setTab] = useState("rates");         // rates | arb | positions | smallcaps
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [capital, setCapital] = useState(500);
  const [enabledExchanges, setEnabledExchanges] = useState(["Hyperliquid","Binance","Bybit","MEXC"]);
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
    try {
      const res = await fetch("/api/rates");
      const data = await res.json();
      const rows = Array.isArray(data.rows) ? data.rows : [];
      recordRates(rows);
      setRows(rows);
      setLastUpdate(new Date());
    } catch (e) {
      console.error("fetchAll error:", e);
    } finally {
      setLoading(false);
    }
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

  // Filtered + sorted rows — guard against non-array
  const safeRows = Array.isArray(rows) ? rows : [];
  const filtered = safeRows
    .filter(r => enabledExchanges.includes(r.exchange))
    .filter(r => filterPositive ? r.apr > 0 : true)
    .sort((a, b) => {
      if (sortBy === "apr") return b.apr - a.apr;
      if (sortBy === "rate") return b.rate - a.rate;
      if (sortBy === "symbol") return a.symbol.localeCompare(b.symbol);
      return 0;
    })
    .slice(0, 80);

  const arbs = findCrossArb(safeRows.filter(r => enabledExchanges.includes(r.exchange)));
  const bestAPR = filtered[0]?.apr || 0;
  const posCount = positions.length;
  const totalPnL = positions.reduce((s, p) => s + p.pnl, 0);
  const avgAPR = filtered.length ? filtered.slice(0, 10).reduce((s, r) => s + r.apr, 0) / 10 : 0;
  const capUSD = capital * 1.08;

  // Login gate
  if (!authed) return (
    <>
      <style>{css}</style>
      <div className="login-bg">
        <div className="login-card">
          <div className="login-logo">📡 FundingBot</div>
          <div className="login-sub">Accès sécurisé · by <span style={{color:"#26a8ea"}}>unknown_qan</span></div>
          <input
            className="login-input"
            type="password"
            placeholder="••••••"
            value={pwd}
            onChange={e => { setPwd(e.target.value); setPwdErr(""); }}
            onKeyDown={e => {
              if (e.key === "Enter") {
                if (pwd === "admin") setAuthed(true);
                else setPwdErr("Mot de passe incorrect");
              }
            }}
            autoFocus
          />
          <button className="login-btn" onClick={() => {
            if (pwd === "admin") setAuthed(true);
            else setPwdErr("Mot de passe incorrect");
          }}>Connexion</button>
          <div className="login-err">{pwdErr}</div>
        </div>
      </div>
    </>
  );

  return (
    <>
      <style>{css}</style>
      <div className="root">

        {/* NAV */}
        <nav className="nav">
          <div className="logo">
            <div className="logo-mark">📡</div>
            <div className="logo-name">
              <span className="logo-title">FundingBot</span>
              <span className="logo-by">
                by&nbsp;
                <svg width="11" height="11" viewBox="0 0 24 24" fill="#26a8ea" style={{display:"inline",verticalAlign:"middle",marginRight:2}}><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248l-2.01 9.47c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.873.75z"/></svg>
                <span style={{color:"#26a8ea"}}>unknown_qan</span>
              </span>
            </div>
          </div>
          <div className="nav-tabs">
            {[["rates","📊 Rates"],["arb","⚡ Cross-Arb"],["smallcaps","🔥 Small Caps"],["positions","🏦 Positions"]].map(([id,label])=>(
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
                      const anm = getAnomalyScore(r);
                      const anmLbl = anomalyLabel(anm.score);
                      return (
                        <tr key={`${r.exchange}-${r.symbol}-${i}`} className={anm.score===2?"anm-danger":anm.score===1?"anm-suspect":""}>
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
                          <td>
                            <span className="anm-badge" style={{background:anmLbl.color+"22",border:`1px solid ${anmLbl.color}44`,color:anmLbl.color}}>{anmLbl.text}</span>
                            {anm.reason && <div className="anm-reason" title={anm.reason}>{anm.reason}</div>}
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
              <MobileRateCards rows={filtered} capital={capital} onOpen={setOpenModal} positions={positions} />
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


          {/* ── TAB : SMALL CAPS ── */}
          {tab === "smallcaps" && (
            <SmallCapsTab rows={safeRows} capital={capital} positions={positions} onOpen={setOpenModal} />
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

      {
/* SMALL CAPS */
.sc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.sc-card{background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:16px;transition:border-color .2s;animation:fade-up .25s ease}
.sc-card:hover{border-color:${C.b2}}
.sc-card.tier-hot{border-color:#10b98133;background:linear-gradient(135deg,${C.card},#0a1f1800)}
.sc-card.tier-good{border-color:#06b6d433}
.sc-card.tier-mid{border-color:#eab30833}
.sc-card-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.sc-sym{font-family:'Outfit',sans-serif;font-size:18px;font-weight:800;color:${C.white}}
.sc-exch{font-size:10px;padding:2px 7px;border-radius:4px;font-weight:700;margin-left:6px}
.sc-apr{font-family:'Outfit',sans-serif;font-size:22px;font-weight:800}
.sc-apr.hot{color:#10b981} .sc-apr.good{color:#06b6d4} .sc-apr.mid{color:#eab308}
.sc-profit-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:10px 0}
.sc-profit-cell{background:${C.surface};border-radius:6px;padding:8px;text-align:center}
.sc-profit-label{font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px}
.sc-profit-val{font-family:'Outfit',sans-serif;font-size:13px;font-weight:700;color:#10b981}
.sc-profit-fee{font-size:9px;color:${C.muted};margin-top:1px}
.sc-dur{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid ${C.border}22}
.sc-dur-label{font-size:11px;font-weight:600}
.sc-days{font-size:10px;color:${C.muted}}
.sc-open-btn{padding:6px 14px;border-radius:7px;font-family:'JetBrains Mono',monospace;font-size:11px;cursor:pointer;transition:all .15s;background:#10b98118;border:1px solid #10b98144;color:#10b981}
.sc-open-btn:hover{background:#10b98128}
.sc-open-btn.active{background:#eab30818;border-color:#eab30844;color:#eab308;cursor:default}
.sc-empty{text-align:center;padding:48px 24px;color:${C.muted};font-size:12px;line-height:1.8}
.sc-filters{display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.sc-filter-btn{padding:5px 12px;border-radius:20px;border:1px solid ${C.border};background:transparent;color:${C.muted};font-family:'JetBrains Mono',monospace;font-size:11px;cursor:pointer;transition:all .15s}
.sc-filter-btn:hover{border-color:${C.b2};color:${C.text}}
.sc-filter-btn.active{background:#10b98118;border-color:#10b98144;color:#10b981}
.sc-info{background:${C.surface};border:1px solid ${C.border};border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:11px;color:${C.text};line-height:1.7}

/* MOBILE BOTTOM NAV */}
      <nav className="mob-nav">
        <div className="mob-nav-inner">
          {[["rates","📊","Rates"],["arb","⚡","Arb"],["smallcaps","🔥","S.Caps"],["positions","🏦","Pos"]].map(([id,icon,label])=>(
            <button key={id} className={`mob-tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>
              <span className="mob-tab-icon">{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}


