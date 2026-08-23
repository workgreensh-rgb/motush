// 한국투자증권(KIS) 시세 클라이언트 + 전 종목 지원 + 성장 캐릭터
// - 토큰: DB 저장, 24시간 재사용
// - 기본 18종목 + 검색·거래된 종목을 동적으로 캐시에 편입
// - 국내 전 종목 마스터: 한투 공개 마스터파일을 1일 1회 수신·캐시
// - 주문 API는 어떤 경우에도 호출하지 않음 (시세 조회 전용)
import { sql } from "./_db.js";

const BASE = "https://openapi.koreainvestment.com:9443";
export const START_CASH = 100000000;
export const FEE_RATE = 0.00015;

export const SYMBOLS = [
  { sym: "005930", name: "삼성전자", market: "KR", sector: "전기전자" },
  { sym: "000660", name: "SK하이닉스", market: "KR", sector: "반도체" },
  { sym: "373220", name: "LG에너지솔루션", market: "KR", sector: "2차전지" },
  { sym: "207940", name: "삼성바이오로직스", market: "KR", sector: "바이오" },
  { sym: "005380", name: "현대차", market: "KR", sector: "자동차" },
  { sym: "000270", name: "기아", market: "KR", sector: "자동차" },
  { sym: "068270", name: "셀트리온", market: "KR", sector: "바이오" },
  { sym: "000720", name: "현대건설", market: "KR", sector: "건설" },
  { sym: "034020", name: "두산에너빌리티", market: "KR", sector: "원전/기계" },
  { sym: "015760", name: "한국전력", market: "KR", sector: "유틸리티" },
  { sym: "035420", name: "NAVER", market: "KR", sector: "플랫폼" },
  { sym: "105560", name: "KB금융", market: "KR", sector: "금융" },
  { sym: "AAPL", excd: "NAS", name: "애플", market: "US", sector: "IT" },
  { sym: "NVDA", excd: "NAS", name: "엔비디아", market: "US", sector: "반도체" },
  { sym: "TSLA", excd: "NAS", name: "테슬라", market: "US", sector: "자동차" },
  { sym: "MSFT", excd: "NAS", name: "마이크로소프트", market: "US", sector: "IT" },
  { sym: "AMZN", excd: "NAS", name: "아마존", market: "US", sector: "커머스" },
  { sym: "GOOGL", excd: "NAS", name: "알파벳", market: "US", sector: "플랫폼" }
];
const BASE_SET = {};
SYMBOLS.forEach((s) => (BASE_SET[s.sym] = true));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 성장 캐릭터 ── */
export function stageOf(retPct, trades) {
  const r = Number(retPct) || 0, t = Number(trades) || 0;
  if (t >= 30 || r >= 15) return { lv: 3, av: "🦅", name: "독수리" };
  if (t >= 10 || r >= 5) return { lv: 2, av: "🐥", name: "청춘새" };
  return { lv: 1, av: "🐣", name: "아기새" };
}

/* ── kv 저장 ── */
export async function kvGet(k) {
  try {
    const r = await sql`SELECT v FROM kv WHERE k = ${k}`;
    return r.length ? r[0].v : null;
  } catch (e) { return null; }
}
export async function kvSet(k, v) {
  await sql`INSERT INTO kv (k, v, updated_at) VALUES (${k}, ${JSON.stringify(v)}::jsonb, now())
    ON CONFLICT (k) DO UPDATE SET v = ${JSON.stringify(v)}::jsonb, updated_at = now()`;
}

/* ── 토큰 ── */
async function getToken() {
  const saved = await kvGet("kis_token");
  const now = Date.now();
  if (saved && saved.exp - now > 10 * 60 * 1000) return saved.token;
  try {
    const r = await fetch(BASE + "/oauth2/tokenP", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET
      })
    });
    const d = await r.json().catch(() => null);
    if (d && d.access_token) {
      const exp = now + (Number(d.expires_in || 86400) - 3600) * 1000;
      await kvSet("kis_token", { token: d.access_token, exp });
      return d.access_token;
    }
  } catch (e) {}
  if (saved) return saved.token;
  throw new Error("KIS 토큰 발급 실패");
}

/* ── 시세 조회 ── */
async function fetchKR(token, code) {
  const url = BASE + "/uapi/domestic-stock/v1/quotations/inquire-price"
    + "?fid_cond_mrkt_div_code=J&fid_input_iscd=" + code;
  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer " + token,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "FHKST01010100",
      custtype: "P"
    }
  });
  const d = await r.json().catch(() => null);
  const o = d && d.output;
  if (!o || !o.stck_prpr || !Number(o.stck_prpr)) return null;
  return { price: Number(o.stck_prpr), chg: Number(o.prdy_ctrt), cap: Number(o.hts_avls) || 0 };
}
async function fetchUS(token, excd, symb) {
  const url = BASE + "/uapi/overseas-price/v1/quotations/price"
    + "?AUTH=&EXCD=" + excd + "&SYMB=" + symb;
  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer " + token,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: "HHDFS00000300",
      custtype: "P"
    }
  });
  const d = await r.json().catch(() => null);
  const o = d && d.output;
  const last = o && Number(o.last);
  if (!last) return null;
  return { usd: last, chg: Number(o.rate) || 0 };
}
async function getFx() {
  const c = await kvGet("fx");
  if (c && Date.now() - c.ts < 3600 * 1000) return c.rate;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const d = await r.json();
    const rate = d && d.rates && Number(d.rates.KRW);
    if (rate) { await kvSet("fx", { rate, ts: Date.now() }); return rate; }
  } catch (e) {}
  return c ? c.rate : 1400;
}

/* ── 국내 전 종목 마스터 (1일 캐시) ── */
let masterMemo = null;
export async function getMaster() {
  if (masterMemo) return masterMemo;
  const c = await kvGet("krmaster");
  if (c && Date.now() - c.ts < 24 * 3600 * 1000) { masterMemo = c.map; return c.map; }
  try {
    const AdmZip = (await import("adm-zip")).default;
    const iconv = (await import("iconv-lite")).default;
    const map = {};
    const files = [["kospi", 228, "KOSPI"], ["kosdaq", 222, "KOSDAQ"]];
    for (const [nm, tail, mkt] of files) {
      const r = await fetch("https://new.real.download.dws.co.kr/common/master/" + nm + "_code.mst.zip");
      if (!r.ok) throw new Error("master fetch " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const zip = new AdmZip(buf);
      const data = zip.getEntries()[0].getData();
      let start = 0;
      for (let i = 0; i <= data.length; i++) {
        if (i === data.length || data[i] === 0x0a) {
          const lineLen = i - start;
          if (lineLen > tail + 10) {
            const head = data.slice(start, i - tail + 1);
            let dec = iconv.decode(head, "euc-kr").replace(/[\r\ufffd]/g, "");
            const code = dec.slice(0, 9).trim();
            const name = dec.slice(21).trim();
            if (/^\d{6}$/.test(code) && name) map[code] = { n: name, m: mkt };
          }
          start = i + 1;
        }
      }
    }
    if (Object.keys(map).length > 500) {
      await kvSet("krmaster", { ts: Date.now(), map });
      masterMemo = map;
      return map;
    }
  } catch (e) {}
  masterMemo = c ? c.map : {};
  return masterMemo;
}

/* ── 종목 해석 (임의 코드/티커 → 메타) ── */
export async function resolveMeta(codeRaw) {
  const code = String(codeRaw || "").trim().toUpperCase();
  const base = SYMBOLS.find((s) => s.sym === code);
  if (base) return base;
  if (/^\d{6}$/.test(code)) {
    const m = await getMaster();
    const e = m[code];
    return { sym: code, name: e ? e.n : "종목 " + code, market: "KR", sector: e ? e.m : "KRX", extra: true };
  }
  if (/^[A-Z.]{1,6}$/.test(code)) {
    return { sym: code, name: code, market: "US", sector: "미국", excd: null, extra: true };
  }
  return null;
}

async function fetchLive(token, meta, fx) {
  if (meta.market === "KR") {
    const q = await fetchKR(token, meta.sym);
    return q ? { price: q.price, chg: q.chg, cap: q.cap } : null;
  }
  const tries = meta.excd ? [meta.excd] : ["NAS", "NYS", "AMS"];
  for (const ex of tries) {
    const u = await fetchUS(token, ex, meta.sym);
    if (u) { meta.excd = ex; return { price: Math.round(u.usd * fx), usd: u.usd, chg: u.chg, excd: ex }; }
    await sleep(140);
  }
  return null;
}

function putItem(cache, meta, q) {
  const prev = cache.items[meta.sym] || {};
  cache.items[meta.sym] = Object.assign({}, q, {
    name: meta.name, market: meta.market, sector: meta.sector,
    excd: meta.excd || q.excd || prev.excd,
    extra: !BASE_SET[meta.sym],
    ts: Date.now(),
    hist: (prev.hist || []).concat(q.price).slice(-40)
  });
}

/* ── 특정 종목 즉시 시세 확보 (검색/거래용) ── */
export async function watchSymbol(code) {
  const meta = await resolveMeta(code);
  if (!meta) return { cache: (await kvGet("quotes")) || { items: {}, ts: 0 }, meta: null };
  let cache = (await kvGet("quotes")) || { items: {}, ts: 0 };
  const fx = await getFx();
  const it = cache.items[meta.sym];
  if (!(it && it.price && Date.now() - (it.ts || 0) < 45 * 1000)) {
    try {
      const token = await getToken();
      const q = await fetchLive(token, meta, fx);
      if (q) { putItem(cache, meta, q); cache.ts = Date.now(); await kvSet("quotes", cache); }
      else {
        cache.items[meta.sym] = Object.assign({}, it || {}, { name: meta.name, market: meta.market, sector: meta.sector, fail: Date.now(), extra: true });
        await kvSet("quotes", cache);
      }
    } catch (e) {}
  }
  cache.fx = fx;
  return { cache, meta };
}

/* ── 전체 시세 캐시 (기본 45s, 편입종목 90s TTL, 호출당 6종목) ── */
export async function getQuotes(refresh) {
  let cache = (await kvGet("quotes")) || { items: {}, ts: 0 };
  const fx = await getFx();
  if (refresh) {
    const now = Date.now();
    // 보유 중인 편입 종목 수집 (전원 평가를 위해)
    let extraMetas = [];
    try {
      const rows = await sql`SELECT holdings FROM accounts`;
      const set = {};
      rows.forEach((r) => {
        Object.keys(r.holdings || {}).forEach((c) => { if (!BASE_SET[c]) set[c] = 1; });
      });
      // 최근 조회된 편입 종목도 유지 (10분)
      Object.keys(cache.items).forEach((c) => {
        const it = cache.items[c];
        if (it && it.extra && now - (it.ts || 0) < 10 * 60 * 1000) set[c] = 1;
      });
      for (const c of Object.keys(set).slice(0, 60)) {
        const it = cache.items[c];
        if (it && it.fail && now - it.fail < 3600 * 1000) continue; // 실패 종목 1시간 스킵
        const m = await resolveMeta(c);
        if (m) extraMetas.push(m);
      }
    } catch (e) {}

    const pool = [];
    SYMBOLS.forEach((s) => {
      const it = cache.items[s.sym];
      if (!it || now - (it.ts || 0) > 45 * 1000) pool.push({ meta: s, ts: (it && it.ts) || 0 });
    });
    extraMetas.forEach((m) => {
      const it = cache.items[m.sym];
      if (!it || now - (it.ts || 0) > 90 * 1000) pool.push({ meta: m, ts: (it && it.ts) || 0 });
    });
    const stale = pool.sort((a, b) => a.ts - b.ts).slice(0, 6);
    if (stale.length) {
      try {
        const token = await getToken();
        for (const s of stale) {
          try {
            const q = await fetchLive(token, s.meta, fx);
            if (q) putItem(cache, s.meta, q);
            else if (s.meta.extra) cache.items[s.meta.sym] = Object.assign({}, cache.items[s.meta.sym] || {}, { name: s.meta.name, market: s.meta.market, sector: s.meta.sector, fail: now, extra: true });
          } catch (e) {}
          await sleep(130);
        }
        cache.ts = Date.now();
        await kvSet("quotes", cache);
      } catch (e) {}
    }
  }
  cache.fx = fx;
  return cache;
}

/* ── 자산 평가 (시세 없으면 원금으로 평가) ── */
export function equityOf(cash, holdings, cache) {
  let eq = Number(cash) || 0;
  const h = holdings || {};
  for (const sym of Object.keys(h)) {
    const it = cache.items[sym];
    const qty = Number(h[sym].qty) || 0;
    if (it && it.price) eq += it.price * qty;
    else eq += Number(h[sym].cost) || 0;
  }
  return Math.round(eq);
}
