// 한국투자증권(KIS) 시세 클라이언트
// - 토큰: DB에 저장해 24시간 재사용 (1일 1회 발급 원칙 준수)
// - 시세: 종목별 30초 캐시, 호출당 최대 5종목만 갱신 + 130ms 간격 (초당 한도 준수)
// - 주문 API는 어떤 경우에도 호출하지 않음 (시세 조회 전용)
import { sql } from "./_db.js";

const BASE = "https://openapi.koreainvestment.com:9443";
export const START_CASH = 100000000;
export const FEE_RATE = 0.00015;

export const SYMBOLS = [
  // 국내 (실시간)
  { sym: "005930", name: "삼성전자", market: "KR", sector: "전기전자" },
  { sym: "000660", name: "SK하이닉스", market: "KR", sector: "반도체" },
  { sym: "005380", name: "현대차", market: "KR", sector: "자동차" },
  { sym: "000720", name: "현대건설", market: "KR", sector: "건설" },
  { sym: "034020", name: "두산에너빌리티", market: "KR", sector: "원전/기계" },
  { sym: "015760", name: "한국전력", market: "KR", sector: "유틸리티" },
  { sym: "035420", name: "NAVER", market: "KR", sector: "플랫폼" },
  { sym: "105560", name: "KB금융", market: "KR", sector: "금융" },
  // 미국 (지연 가능)
  { sym: "AAPL", excd: "NAS", name: "애플", market: "US", sector: "IT" },
  { sym: "NVDA", excd: "NAS", name: "엔비디아", market: "US", sector: "반도체" },
  { sym: "TSLA", excd: "NAS", name: "테슬라", market: "US", sector: "자동차" },
  { sym: "MSFT", excd: "NAS", name: "마이크로소프트", market: "US", sector: "IT" },
  { sym: "AMZN", excd: "NAS", name: "아마존", market: "US", sector: "커머스" },
  { sym: "GOOGL", excd: "NAS", name: "알파벳", market: "US", sector: "플랫폼" }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function kvGet(k) {
  try {
    const r = await sql`SELECT v FROM kv WHERE k = ${k}`;
    return r.length ? r[0].v : null;
  } catch (e) {
    return null;
  }
}
export async function kvSet(k, v) {
  await sql`INSERT INTO kv (k, v, updated_at) VALUES (${k}, ${JSON.stringify(v)}::jsonb, now())
    ON CONFLICT (k) DO UPDATE SET v = ${JSON.stringify(v)}::jsonb, updated_at = now()`;
}

async function getToken() {
  const saved = await kvGet("kis_token");
  const now = Date.now();
  if (saved && saved.exp - now > 10 * 60 * 1000) return saved.token; // 만료 10분 전까지 재사용
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
  if (saved) return saved.token; // 발급 제한에 걸리면 기존 토큰으로 계속
  throw new Error("KIS 토큰 발급 실패");
}

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
  if (!o || !o.stck_prpr) return null;
  return { price: Number(o.stck_prpr), chg: Number(o.prdy_ctrt) };
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
    if (rate) {
      await kvSet("fx", { rate, ts: Date.now() });
      return rate;
    }
  } catch (e) {}
  return c ? c.rate : 1400;
}

// 시세 캐시 반환. refresh=true면 가장 오래된 종목 최대 5개만 갱신 (호출 한도 준수)
export async function getQuotes(refresh) {
  let cache = (await kvGet("quotes")) || { items: {}, ts: 0 };
  const fx = await getFx();
  if (refresh) {
    const now = Date.now();
    const stale = SYMBOLS
      .filter((s) => {
        const it = cache.items[s.sym];
        return !it || now - (it.ts || 0) > 30 * 1000;
      })
      .sort((a, b) => ((cache.items[a.sym] || {}).ts || 0) - ((cache.items[b.sym] || {}).ts || 0))
      .slice(0, 5);
    if (stale.length) {
      try {
        const token = await getToken();
        for (const s of stale) {
          try {
            let q = null;
            if (s.market === "KR") {
              q = await fetchKR(token, s.sym);
            } else {
              const u = await fetchUS(token, s.excd, s.sym);
              if (u) q = { price: Math.round(u.usd * fx), usd: u.usd, chg: u.chg };
            }
            if (q) {
              const prev = cache.items[s.sym] || {};
              const hist = (prev.hist || []).concat(q.price).slice(-40);
              cache.items[s.sym] = Object.assign({}, q, {
                name: s.name, market: s.market, sector: s.sector, ts: Date.now(), hist
              });
            }
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

export function equityOf(cash, holdings, cache) {
  let eq = Number(cash) || 0;
  const h = holdings || {};
  for (const sym of Object.keys(h)) {
    const it = cache.items[sym];
    if (it) eq += it.price * (Number(h[sym].qty) || 0);
  }
  return Math.round(eq);
}
