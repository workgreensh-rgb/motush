// 퀀트봇 공용: KIS 일봉·투자자동향·시총순위 조회, 지표 계산, 규칙 파라미터
import { sql } from "./_db.js";
import { getToken, kvGet, kvSet } from "./_kis.js";

const BASE = "https://openapi.koreainvestment.com:9443";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 규칙 v1 (여기 숫자만 바꾸면 전략이 바뀜) ── */
export const RULES = {
  rsiPeriod: 14, rsiOversold: 35, rsiLookback: 5,
  flowDays: 5, flowStreak: 2,
  volMult: 1.5, volAvgDays: 20,
  slots: 5, slotWeight: 0.2, dailyMax: 2,
  stopLoss: -10, takeProfit: 30, maxHoldDays: 20,
  kospiMA: 200,
  kospiTop: 200, kosdaqTop: 50,
  chunk: 20, timeBudgetMs: 7000
};

/* ── KIS 공통 헤더 ── */
async function kisGet(path, trId, params) {
  const token = await getToken();
  const qs = Object.keys(params).map((k) => k + "=" + encodeURIComponent(params[k])).join("&");
  const r = await fetch(BASE + path + "?" + qs, {
    headers: { "Content-Type": "application/json", authorization: "Bearer " + token,
      appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET, tr_id: trId, custtype: "P" }
  });
  const d = await r.json().catch(() => null);
  if (!d) throw new Error("KIS 응답 없음 " + trId);
  if (d.rt_cd && d.rt_cd !== "0") throw new Error("KIS " + trId + " " + (d.msg1 || d.msg_cd));
  return d;
}
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
export function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
export function kstDate() { return kstNow().toISOString().slice(0, 10); }

/* ── 일봉 (최근 ~100거래일, 수정주가) ── */
export async function dailyBars(code) {
  const end = kstNow(), start = new Date(end.getTime() - 200 * 86400000);
  const d = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", "FHKST03010100", {
    FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: ymd(start), FID_INPUT_DATE_2: ymd(end),
    FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "0"
  });
  const o1 = d.output1 || {};
  const bars = (d.output2 || []).filter((b) => b && b.stck_clpr).map((b) => ({
    date: b.stck_bsop_date, close: Number(b.stck_clpr), vol: Number(b.acml_vol) || 0, tv: Number(b.acml_tr_pbmn) || 0
  })).reverse(); // 과거 → 최근
  return { bars, cap: Number(o1.hts_avls) || 0, name: o1.hts_kor_isnm || "", price: Number(o1.stck_prpr) || (bars.length ? bars[bars.length - 1].close : 0) };
}

/* ── 종목별 투자자 매매동향 (일별, 외국인·기관 순매수 금액) ── */
export async function investorDaily(code) {
  const d = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-investor", "FHKST01010900",
    { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code });
  const rows = d.output || (Array.isArray(d.output1) ? d.output1 : []) || [];
  investorDaily.lastRaw = { keys: Object.keys(d), row: rows[0] || null };
  const pick = (r, re) => { for (const k of Object.keys(r)) if (re.test(k)) return Number(r[k]) || 0; return 0; };
  // 순매수 금액(원) = 순매수 수량 × 종가 (공식 필드: frgn_ntby_qty / orgn_ntby_qty / stck_clpr)
  return rows.filter((r) => r && r.stck_bsop_date).map((r) => {
    const close = Number(r.stck_clpr) || 0;
    const fq = Number(r.frgn_ntby_qty) || pick(r, /frgn.*ntby.*qty/);
    const oq = Number(r.orgn_ntby_qty) || pick(r, /orgn.*ntby.*qty/);
    return { date: r.stck_bsop_date, fgn: fq * close, inst: oq * close };
  }).reverse();
}

/* ── 시총 순위 (코스피 0001 / 코스닥 1001) ── */
export async function marketCapRanking(mkt) {
  const d = await kisGet("/uapi/domestic-stock/v1/ranking/market-cap", "FHPST01740000", {
    fid_cond_mrkt_div_code: "J", fid_cond_scr_div_code: "20174", fid_div_cls_code: "0", fid_input_iscd: mkt,
    fid_trgt_cls_code: "0", fid_trgt_exls_cls_code: "0", fid_input_price_1: "", fid_input_price_2: "", fid_vol_cnt: ""
  });
  return (d.output || []).map((r) => ({ code: r.mksc_shrn_iscd, name: r.hts_kor_isnm, cap: Number(r.stck_avls) || 0 })).filter((r) => /^\d{6}$/.test(r.code));
}

/* ── 코스피 지수 일봉 → 200일선 ── */
export async function kospiRegime() {
  const closes = [];
  const end = kstNow();
  for (let i = 0; i < 8 && Object.keys(closes.reduce((m, x) => (m[x.d] = 1, m), {})).length < RULES.kospiMA + 5; i++) {
    const e = new Date(end.getTime() - i * 60 * 86400000), s = new Date(e.getTime() - 60 * 86400000);
    const d = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice", "FHKUP03500100", {
      FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: "0001", FID_INPUT_DATE_1: ymd(s), FID_INPUT_DATE_2: ymd(e), FID_PERIOD_DIV_CODE: "D"
    });
    (d.output2 || []).forEach((b) => { if (b.bstp_nmix_prpr) closes.push({ d: b.stck_bsop_date, c: Number(b.bstp_nmix_prpr) }); });
    await sleep(120);
  }
  const uniq = {}; closes.forEach((x) => (uniq[x.d] = x.c));
  const keys = Object.keys(uniq).sort();
  const arr = keys.map((k) => uniq[k]);
  const lastDate = keys[keys.length - 1] || "";
  if (arr.length < RULES.kospiMA) return { ok: true, last: arr[arr.length - 1] || 0, ma: 0, n: arr.length, lastDate, note: "데이터 부족, 필터 미적용" };
  const ma = arr.slice(-RULES.kospiMA).reduce((a, b) => a + b, 0) / RULES.kospiMA;
  const last = arr[arr.length - 1];
  return { ok: last >= ma, last, ma: Math.round(ma * 100) / 100, n: arr.length, lastDate };
}

/* ── 유니버스 제외 규칙: ETF·ETN·우선주·스팩·리츠 등 ── */
const EXCL = /ETF|ETN|KODEX|TIGER|ACE |KBSTAR|RISE |SOL |ARIRANG|HANARO|PLUS |KOSEF|TIMEFOLIO|WON |1Q |KIWOOM|마이티|스팩|리츠|인프라|선물|레버리지|인버스|채권|국고|MMF|액티브|\d+호$/i;
export function isUniverseCandidate(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  if (EXCL.test(n)) return false;
  if (/(우|우B|우C|우\(전환\))$/.test(n)) return false; // 우선주
  if (/\d우$/.test(n)) return false; // 현대차2우
  return true;
}
/* ── 현재가(시총) 단건 ── */
export async function capOf(code) {
  const d = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", { fid_cond_mrkt_div_code: "J", fid_input_iscd: code });
  const o = d.output || {};
  return { cap: Number(o.hts_avls) || 0, price: Number(o.stck_prpr) || 0, halt: o.trht_yn === "Y",
    k200: String(o.rprs_mrkt_kor_name || "").toUpperCase().indexOf("KOSPI200") >= 0 };
}

/* ── 유니버스: 시총 상위 (1일 캐시). API가 30건만 주면 구축본(qb_universe_manual) 우선 ── */
export async function getUniverse(log) {
  const c = await kvGet("qb_universe");
  if (c && Date.now() - c.ts < 20 * 3600 * 1000 && c.list.length >= 50) return c.list;
  let list = [];
  const built = await kvGet("qb_universe_manual");
  if (built && Array.isArray(built.list) && built.list.length >= 100) {
    if (log) log("info", `구축 유니버스 사용 ${built.list.length}종목 (${built.date || ""})`);
    await kvSet("qb_universe", { ts: Date.now(), list: built.list });
    return built.list;
  }
  try {
    const kp = await marketCapRanking("0001"); await sleep(150);
    const kq = await marketCapRanking("1001");
    list = kp.slice(0, RULES.kospiTop).map((x) => ({ ...x, m: "KOSPI" })).concat(kq.slice(0, RULES.kosdaqTop).map((x) => ({ ...x, m: "KOSDAQ" })));
    if (log) log("info", `시총순위 수신 코스피 ${kp.length} · 코스닥 ${kq.length}`);
  } catch (e) { if (log) log("warn", "시총순위 API 실패: " + e.message); }
  if (list.length) await kvSet("qb_universe", { ts: Date.now(), list });
  else if (c) list = c.list;
  return list;
}

/* ── 지표 ── */
export function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) ag += d; else al -= d; }
  ag /= period; al /= period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/* ── 종목 1개 평가 → 신호 or null (탈락 사유 포함) ── */
export function evaluate(bars, flows, cap) {
  const R = RULES;
  if (bars.length < R.volAvgDays + R.rsiPeriod + 2) return { pass: false, why: "일봉 부족" };
  const closes = bars.map((b) => b.close);
  const rsi = rsiSeries(closes, R.rsiPeriod);
  const n = bars.length - 1;
  const rsiNow = rsi[n], rsiPrev = rsi[n - 1];
  const win = rsi.slice(n - R.rsiLookback + 1, n + 1).filter((x) => x !== null);
  const rsiLow = Math.min(...win);
  const volAvg = bars.slice(n - R.volAvgDays, n).reduce((a, b) => a + b.vol, 0) / R.volAvgDays;
  const volRatio = volAvg > 0 ? bars[n].vol / volAvg : 0;
  const f5 = flows.slice(-R.flowDays);
  const flowSum = f5.reduce((a, x) => a + x.fgn + x.inst, 0);
  let streak = 0;
  for (let i = flows.length - 1; i >= 0; i--) { if (flows[i].fgn + flows[i].inst > 0) streak++; else break; }
  const tv5 = bars.slice(-R.flowDays).reduce((a, b) => a + b.tv, 0);
  const out = { rsiNow, rsiPrev, rsiLow, volRatio, flowSum, streak, tv: bars[n].tv, cap, price: closes[n],
    flowStrength: tv5 > 0 ? flowSum / tv5 : 0 };
  if (rsiLow > R.rsiOversold) return { ...out, pass: false, why: "RSI 과매도 미기록" };
  if (!(rsiNow > rsiPrev)) return { ...out, pass: false, why: "RSI 반등 미확인" };
  if (!(flowSum > 0)) return { ...out, pass: false, why: "5일 수급 음수" };
  if (streak < R.flowStreak) return { ...out, pass: false, why: "연속 순매수 부족" };
  if (volRatio < R.volMult) return { ...out, pass: false, why: "거래량 부족" };
  return { ...out, pass: true, why: "" };
}

/* ── 점수: 세 항목 0~1 정규화 후 평균 ── */
export function scoreAll(sigs) {
  if (!sigs.length) return sigs;
  const norm = (arr, k) => { const v = arr.map((s) => s[k]); const mn = Math.min(...v), mx = Math.max(...v); return arr.map((s) => (mx > mn ? (s[k] - mn) / (mx - mn) : 0.5)); };
  const a = norm(sigs, "flowStrength"), b = norm(sigs.map((s) => ({ d: 50 - s.rsiLow })), "d"), c = norm(sigs, "volRatio");
  sigs.forEach((s, i) => (s.score = Math.round(((a[i] + b[i] + c[i]) / 3) * 100) / 100));
  return sigs.sort((x, y) => y.score - x.score);
}

/* ── 사유 문자열 ── */
export const fmtCap = (v) => (v >= 10000 ? (v / 10000).toFixed(1) + "조" : Math.round(v) + "억"); // hts_avls 단위: 억
export const fmtEok = (won) => Math.round(won / 1e8) + "억";
export function buyReason(s) {
  return `[퀀트봇A] 수급 5일 ${s.flowSum >= 0 ? "+" : ""}${fmtEok(s.flowSum)}(${s.streak}일 연속) · RSI ${Math.round(s.rsiLow)}→${Math.round(s.rsiNow)} 반등 · 거래량 ${s.volRatio.toFixed(1)}배 · 시총 ${fmtCap(s.cap)} · 거래대금 ${fmtEok(s.tv)} · 점수 ${s.score}`.slice(0, 200);
}
export function sellReason(kind, ret, days, mfe, cap, tv) {
  const p = (x) => (x >= 0 ? "+" : "") + x.toFixed(1) + "%";
  const head = kind === "tp" ? `익절 ${p(ret)}` : kind === "sl" ? `손절 ${p(ret)}` : `시간청산 ${days}일 ${p(ret)}`;
  return `[퀀트봇A] ${head} · 보유 ${days}일 · 최고 ${p(mfe)} · 시총 ${fmtCap(cap)} · 거래대금 ${fmtEok(tv)}`.slice(0, 200);
}

/* ── 로그 ── */
export async function botLog(level, msg) {
  try { await sql`INSERT INTO bot_logs (level, msg) VALUES (${level}, ${String(msg).slice(0, 500)})`; } catch (e) {}
}
export async function botConfig() {
  const c = (await kvGet("qb_config")) || {};
  return { on: c.on !== false, brake: !!c.brake, ...c };
}


/* ── 공매도 일별추이 (당일 공매도 대금 비중 %) — 응답 필드 검증 필요 ── */
export async function shortSalePct(code) {
  const end = kstNow(), start = new Date(end.getTime() - 14 * 86400000);
  const d = await kisGet("/uapi/domestic-stock/v1/quotations/daily-short-sale", "FHPST04830000", {
    FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: ymd(start), FID_INPUT_DATE_2: ymd(end)
  });
  const rows = d.output2 || d.output || [];
  const r = rows[0];
  shortSalePct.lastRaw = r || null;
  if (!r) return null;
  const pick = (re) => { for (const k of Object.keys(r)) if (re.test(k)) { const v = Number(r[k]); if (Number.isFinite(v)) return v; } return null; };
  // 우선순위: 비중 필드 → 공매도대금/전체대금 → 공매도수량/전체수량
  const rate = pick(/ssts.*(rate|rt|wght)|shrt.*(rate|rt)/i);
  if (rate !== null && rate >= 0 && rate <= 100) return rate;
  const sp = pick(/ssts.*pbmn/i), tp = pick(/acml_tr_pbmn|tot.*pbmn/i);
  if (sp !== null && tp) return (sp / tp) * 100;
  const sq = pick(/ssts.*qty/i), tq = pick(/acml_vol|tot.*vol|cntg_vol/i);
  if (sq !== null && tq) return (sq / tq) * 100;
  return null;
}

/* ── 수급 탭용 지표 ── */
export function flowMetrics(bars, flows, cap) {
  const n = bars.length - 1;
  if (n < 20) return null;
  const closes = bars.map((b) => b.close);
  const rsi = rsiSeries(closes, RULES.rsiPeriod);
  const adv20 = Math.round(bars.slice(n - 19, n + 1).reduce((a, b) => a + b.tv, 0) / 20);
  const sum = (arr, k, d) => Math.round(arr.slice(-d).reduce((a, x) => a + x[k], 0));
  return {
    price: closes[n], adv20, rsi: rsi[n] === null ? null : Math.round(rsi[n] * 10) / 10,
    f1: sum(flows, "fgn", 1), f5: sum(flows, "fgn", 5), f20: sum(flows, "fgn", 20),
    i1: sum(flows, "inst", 1), i5: sum(flows, "inst", 5), i20: sum(flows, "inst", 20), cap
  };
}
export function verdictOf(m) {
  const s5 = m.f5 + m.i5, s20 = m.f20 + m.i20, r = m.rsi;
  if (r !== null && r <= RULES.rsiOversold && s5 > 0) return "과매도 + 수급 유입";
  if (s20 > 0 && s5 > 0) return r !== null && r >= 70 ? "담는 중 · 과열" : "계속 담는 중";
  if (s20 <= 0 && s5 > 0) return "빼다가 다시 담기";
  if (s20 > 0 && s5 <= 0) return "찼다가 빼는 중";
  return "계속 비우는 중";
}
