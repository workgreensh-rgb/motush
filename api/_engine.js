// 결정론적 시세 엔진 (서버 사이드) — 클라이언트와 동일한 수식
export const EPOCH = Date.UTC(2026, 0, 1);
export const START_CASH = 100000000;
export const FEE_RATE = 0.00015;

export const TICKERS = [
  { code: "HBC", name: "한빛건설", sector: "건설", base: 42500, vol: 1.0 },
  { code: "CRN", name: "청룡원자력", sector: "원전", base: 128000, vol: 1.3 },
  { code: "MRP", name: "미르전력", sector: "유틸", base: 23800, vol: 0.6 },
  { code: "NRS", name: "나래반도체", sector: "IT", base: 87400, vol: 1.6 },
  { code: "OSB", name: "온새미바이오", sector: "바이오", base: 156000, vol: 2.2 },
  { code: "GAB", name: "가온배터리", sector: "2차전지", base: 64200, vol: 1.8 },
  { code: "BDS", name: "바다조선", sector: "조선", base: 31900, vol: 1.2 },
  { code: "SBC", name: "새벽커머스", sector: "플랫폼", base: 48700, vol: 1.5 },
  { code: "HGF", name: "한결금융", sector: "금융", base: 71300, vol: 0.7 },
  { code: "DRE", name: "두루엔터", sector: "엔터", base: 95600, vol: 1.9 }
];

function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const waveCache = {};
function wavesFor(code) {
  if (waveCache[code]) return waveCache[code];
  const rng = mulberry32(hashStr("mt-" + code));
  const periods = [4, 17, 63, 240, 1440, 4320, 10080];
  const waves = periods.map((p, i) => ({
    p,
    amp: (0.004 + rng() * 0.01) * Math.sqrt(i + 1),
    ph: rng() * Math.PI * 2
  }));
  const drift = (rng() - 0.45) * 0.000004;
  waveCache[code] = { waves, drift, seed: hashStr("j-" + code) };
  return waveCache[code];
}
export function nowMin() {
  return (Date.now() - EPOCH) / 60000;
}
export function priceAt(t, tk) {
  const { waves, drift, seed } = wavesFor(tk.code);
  let lo = drift * t;
  for (const w of waves) lo += w.amp * tk.vol * Math.sin((2 * Math.PI * t) / w.p + w.ph);
  const m = Math.floor(t);
  const j = (mulberry32(seed ^ m)() - 0.5) * 0.006 * tk.vol;
  const raw = tk.base * Math.exp(lo + j);
  const tick = raw >= 100000 ? 100 : raw >= 10000 ? 50 : 10;
  return Math.max(tick, Math.round(raw / tick) * tick);
}
export function currentPrice(code) {
  const tk = TICKERS.find((x) => x.code === code);
  if (!tk) return null;
  return priceAt(nowMin(), tk);
}
export function equityOf(cash, holdings) {
  let eq = Number(cash) || 0;
  const h = holdings || {};
  for (const code of Object.keys(h)) {
    const p = currentPrice(code);
    if (p) eq += p * (Number(h[code].qty) || 0);
  }
  return Math.round(eq);
}
