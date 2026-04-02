// api/rates.js — Vercel Serverless Function
// Appelé par le frontend : GET /api/rates
// Proxy les 4 exchanges côté serveur → pas de CORS

export default async function handler(req, res) {
  // CORS headers pour le frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=30"); // cache Vercel 30s

  try {
    const [hl, bn, bb, mx] = await Promise.allSettled([
      fetchHyperliquid(),
      fetchBinance(),
      fetchBybit(),
      fetchMEXC(),
    ]);

    const rows = [
      ...(hl.status === "fulfilled" ? hl.value : []),
      ...(bn.status === "fulfilled" ? bn.value : []),
      ...(bb.status === "fulfilled" ? bb.value : []),
      ...(mx.status === "fulfilled" ? mx.value : []),
    ];

    res.status(200).json({
      ok: true,
      count: rows.length,
      ts: Date.now(),
      rows,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── HYPERLIQUID ──────────────────────────────────────────────────────────────
async function fetchHyperliquid() {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  const [meta, ctxs] = await res.json();
  const hlNext = Date.now() + 3600000; // funding every 1h

  return meta.universe
    .map((m, i) => ({
      exchange: "Hyperliquid",
      symbol: m.name,
      rate: parseFloat(ctxs[i]?.funding ?? 0),
      markPrice: parseFloat(ctxs[i]?.markPx ?? 0),
      openInterest: parseFloat(ctxs[i]?.openInterest ?? 0),
      intervalHours: 1,
      nextFunding: hlNext,
    }))
    .filter(d => d.markPrice > 0 && !isNaN(d.rate))
    .map(d => ({ ...d, apr: annualRate(d.rate, 1) }));
}

// ─── BINANCE ──────────────────────────────────────────────────────────────────
async function fetchBinance() {
  const res = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex");
  const data = await res.json();

  return data
    .filter(d => d.symbol.endsWith("USDT"))
    .map(d => ({
      exchange: "Binance",
      symbol: d.symbol.replace("USDT", ""),
      rate: parseFloat(d.lastFundingRate),
      markPrice: parseFloat(d.markPrice),
      openInterest: 0,
      intervalHours: 8,
      nextFunding: d.nextFundingTime,
    }))
    .filter(d => !isNaN(d.rate) && d.markPrice > 0)
    .map(d => ({ ...d, apr: annualRate(d.rate, 8) }));
}

// ─── BYBIT ────────────────────────────────────────────────────────────────────
async function fetchBybit() {
  const res = await fetch("https://api.bybit.com/v5/market/tickers?category=linear");
  const data = await res.json();
  const bnNext = Date.now() + 8 * 3600000;

  return (data?.result?.list ?? [])
    .filter(d => d.symbol.endsWith("USDT") && d.fundingRate)
    .map(d => ({
      exchange: "Bybit",
      symbol: d.symbol.replace("USDT", ""),
      rate: parseFloat(d.fundingRate),
      markPrice: parseFloat(d.markPrice),
      openInterest: parseFloat(d.openInterestValue ?? 0),
      intervalHours: 8,
      nextFunding: bnNext,
    }))
    .filter(d => !isNaN(d.rate) && d.markPrice > 0)
    .map(d => ({ ...d, apr: annualRate(d.rate, 8) }));
}

// ─── MEXC ─────────────────────────────────────────────────────────────────────
async function fetchMEXC() {
  // MEXC Futures public API — pas d'auth requise pour les rates
  const res = await fetch("https://contract.mexc.com/api/v1/contract/funding_rate");
  const data = await res.json();
  const mxNext = Date.now() + 8 * 3600000;

  if (!data?.data) return [];

  return data.data
    .filter(d => d.symbol.endsWith("_USDT"))
    .map(d => ({
      exchange: "MEXC",
      symbol: d.symbol.replace("_USDT", ""),
      rate: parseFloat(d.fundingRate),
      markPrice: parseFloat(d.fairPrice ?? 0),
      openInterest: 0,
      intervalHours: 8,
      nextFunding: mxNext,
    }))
    .filter(d => !isNaN(d.rate) && d.markPrice > 0)
    .map(d => ({ ...d, apr: annualRate(d.rate, 8) }));
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function annualRate(rate, intervalHours) {
  return rate * (24 / intervalHours) * 365 * 100;
}
