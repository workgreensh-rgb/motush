// 퀀트봇A 실행기 — 여러 번 호출해도 안전(멱등). 한 호출당 최대 ~7초 작업 후 진행상태 저장.
// 진입점: /api/quant?run=1 (Vercel Cron · 외부 핑 · 관리자 "지금 실행")
import { init, sql, authUser } from "./_db.js";
import { kvGet, kvSet, START_CASH, FEE_RATE, equityOf, getQuotes } from "./_kis.js";
import { executeTrade } from "./_trade.js";
import { RULES, kstDate, kstNow, dailyBars, investorDaily, kospiRegime, getUniverse, evaluate, scoreAll,
  buyReason, sellReason, botLog, botConfig, isUniverseCandidate, capOf } from "./_quant.js";
import { getMaster } from "./_kis.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT_AVATAR = "🤖";

async function isAuthorized(req) {
  const h = String(req.headers["authorization"] || "");
  const secret = process.env.CRON_SECRET;
  if (secret && h === "Bearer " + secret) return "cron";
  if (req.query && secret && req.query.key === secret) return "cron";
  const u = await authUser(req);
  if (u && isOwner(u)) return "owner";
  return null;
}
export function isOwner(u) {
  const o = process.env.OWNER_USERNAME;
  return o ? u.username === o : u.id === 1;
}
async function botUser() {
  const un = process.env.BOT_USERNAME || "quantbota";
  const r = await sql`SELECT id, username, name FROM users WHERE username = ${un}`;
  return r[0] || null;
}

export async function runBot(req, res) {
  const t0 = Date.now();
  try {
    await init();
    const who = await isAuthorized(req);
    if (!who) return res.status(401).json({ error: "권한이 없습니다" });

    const today = kstDate();
    if (req.query && req.query.build === "1" && who === "owner") return buildUniverse(req, res, t0);
    const bot = await botUser();
    if (!bot) return res.status(500).json({ error: "봇 계정(" + (process.env.BOT_USERNAME || "quantbota") + ")을 찾을 수 없습니다" });

    let st = (await kvGet("qb_run")) || {};
    if (req.query && req.query.reset === "1" && who === "owner") st = {};
    if (st.date !== today) st = { date: today, phase: "init", idx: 0, signals: [], started: Date.now() };
    const save = () => kvSet("qb_run", st);
    const log = (lv, m) => botLog(lv, m);

    if (st.phase === "done" || st.phase === "skip") return res.status(200).json({ phase: st.phase, note: st.note || "", date: today });

    /* ── INIT: 휴장 판단 · ON/OFF · 레짐 · 보유 점검(매도) ── */
    if (st.phase === "init") {
      const force = who === "owner" && req.query && req.query.force === "1";
      const dow = kstNow().getUTCDay();
      if (!force && (dow === 0 || dow === 6)) { st.phase = "skip"; st.note = "주말"; await save(); return res.status(200).json({ phase: "skip", note: "주말" }); }
      const cfg = await botConfig();
      const reg = await kospiRegime();
      const todayYmd = today.replace(/-/g, "");
      if (!force && reg.lastDate && reg.lastDate !== todayYmd) {
        st.phase = "skip"; st.note = "휴장일(지수 최근일 " + reg.lastDate + ")"; await save();
        await log("info", "휴장일로 판단, 스킵 (" + reg.lastDate + ")");
        return res.status(200).json({ phase: "skip", note: st.note });
      }
      st.regime = { ok: reg.ok, last: reg.last, ma: reg.ma, note: reg.note || "" };
      if (force) await log("warn", "테스트 실행(휴장 무시) — 직전 거래일 종가 기준");
      await log("info", `실행 시작 · 코스피 ${reg.last} / 200일선 ${reg.ma} → ${reg.ok ? "매수 허용" : "신규매수 중단"}${reg.note ? " (" + reg.note + ")" : ""}`);

      // 보유 점검 (매도 판단) — ON/OFF와 무관하게 청산 규칙은 항상 적용
      const opens = await sql`SELECT * FROM bot_positions WHERE status = 'open' ORDER BY id`;
      for (const p of opens) {
        try {
          const d = await dailyBars(p.sym);
          const last = d.bars[d.bars.length - 1];
          if (!last) continue;
          const price = d.price || last.close;
          const ret = ((price - Number(p.entry_price)) / Number(p.entry_price)) * 100;
          const hi = Math.max(...d.bars.filter((b) => b.date >= p.entry_date.replace(/-/g, "")).map((b) => b.close), price);
          const mfe = Math.max(Number(p.mfe) || 0, ((hi - Number(p.entry_price)) / Number(p.entry_price)) * 100);
          const days = Number(p.days_held || 0) + 1;
          let kind = null;
          if (ret <= RULES.stopLoss) kind = "sl";
          else if (ret >= RULES.takeProfit) kind = "tp";
          else if (days >= RULES.maxHoldDays) kind = "time";
          if (kind) {
            const reason = sellReason(kind, ret, days, mfe, d.cap, last.tv);
            const out = await executeTrade(bot, { code: p.sym, side: "sell", qty: p.qty, reason, priceOverride: price, avatar: BOT_AVATAR });
            await sql`UPDATE bot_positions SET status = 'closed', exit_date = ${today}, exit_price = ${price}, exit_kind = ${kind},
              exit_ret = ${Math.round(ret * 100) / 100}, days_held = ${days}, mfe = ${Math.round(mfe * 100) / 100}, last_ret = ${Math.round(ret * 100) / 100} WHERE id = ${p.id}`;
            await log("trade", `매도 ${p.name} ${p.qty}주 @${price.toLocaleString()} · ${reason}`);
          } else {
            await sql`UPDATE bot_positions SET days_held = ${days}, mfe = ${Math.round(mfe * 100) / 100}, last_ret = ${Math.round(ret * 100) / 100} WHERE id = ${p.id}`;
          }
        } catch (e) { await log("warn", `보유 점검 실패 ${p.sym}: ${e.message}`); }
        await sleep(120);
      }

      if (!cfg.on) { st.phase = "skip"; st.note = "봇 OFF"; await save(); await log("info", "봇 OFF 상태 — 매도 점검만 수행"); return res.status(200).json({ phase: "skip", note: "봇 OFF" }); }
      if (cfg.brake) { st.phase = "skip"; st.note = "이벤트 브레이크"; await save(); await log("info", "이벤트 브레이크 ON — 신규 매수 생략"); return res.status(200).json({ phase: "skip", note: "이벤트 브레이크" }); }

      st.universe = (await getUniverse(log)).map((u) => ({ code: u.code, name: u.name, m: u.m }));
      if (!st.universe.length) { st.phase = "skip"; st.note = "유니버스 비어있음"; await save(); await log("error", "유니버스 0종목 — 시총순위 API 확인 필요"); return res.status(200).json({ phase: "skip", note: st.note }); }
      await log("info", `유니버스 ${st.universe.length}종목 · 스캔 시작`);
      st.phase = "scan"; st.idx = 0; st.signals = []; st.rejects = 0;
      await save();
    }

    /* ── SCAN: 시간 예산 안에서 종목 처리 ── */
    if (st.phase === "scan") {
      const held = {};
      (await sql`SELECT sym FROM bot_positions WHERE status = 'open'`).forEach((r) => (held[r.sym] = 1));
      const PAR = 3;
      while (st.idx < st.universe.length && Date.now() - t0 < RULES.timeBudgetMs) {
        const batch = st.universe.slice(st.idx, st.idx + PAR).filter((u) => !held[u.code]);
        const rs = await Promise.all(batch.map(async (u) => {
          try {
            const [d, f] = await Promise.all([dailyBars(u.code), investorDaily(u.code)]);
            return { u, ev: evaluate(d.bars, f, d.cap), name: d.name || u.name };
          } catch (e) { return { u, err: e.message }; }
        }));
        if (!st.invLogged && investorDaily.lastRaw) {
          st.invLogged = true;
          await log("info", "투자자API 원본 · 최상위키 " + JSON.stringify(investorDaily.lastRaw.keys) + " · 행 " + JSON.stringify(investorDaily.lastRaw.row).slice(0, 380));
        }
        for (const r of rs) {
          if (r.err) { st.rejects++; if (st.rejects < 5) await log("warn", `${r.u.code} 조회 실패: ${r.err}`); continue; }
          if (r.ev.pass) st.signals.push({ code: r.u.code, name: r.name, ...r.ev });
          else { st.rejects++; st.why = st.why || {}; st.why[r.ev.why] = (st.why[r.ev.why] || 0) + 1;
            if (!st.sample && r.ev.flowSum !== undefined) st.sample = `${r.name} RSI ${Math.round(r.ev.rsiLow)}→${Math.round(r.ev.rsiNow)} 수급5일 ${Math.round(r.ev.flowSum / 1e8)}억 연속 ${r.ev.streak} 거래량 ${r.ev.volRatio.toFixed(1)}배`; }
        }
        st.idx += PAR;
        await sleep(320);
      }
      await save();
      if (st.idx < st.universe.length) return res.status(200).json({ phase: "scan", progress: st.idx + "/" + st.universe.length, signals: st.signals.length });
      st.phase = "exec"; await save();
    }

    /* ── EXEC: 점수 → 슬롯 채우기 ── */
    if (st.phase === "exec") {
      const sigs = scoreAll(st.signals);
      const openCnt = (await sql`SELECT COUNT(*)::int AS c FROM bot_positions WHERE status = 'open'`)[0].c;
      let free = Math.max(0, RULES.slots - openCnt);
      let budget = RULES.dailyMax;
      const acc = (await sql`SELECT cash, holdings FROM accounts WHERE user_id = ${bot.id}`)[0];
      const cache = await getQuotes(false);
      const equity = equityOf(acc.cash, acc.holdings, cache);
      let cash = Number(acc.cash);
      let bought = 0;
      for (const s of sigs) {
        let action = "skip", note = "";
        if (!st.regime.ok) { note = "시장 필터(200일선 하회)"; }
        else if (free <= 0) { note = "슬롯 부족"; }
        else if (budget <= 0) { note = "일일한도"; }
        else {
          const alloc = Math.floor(equity * RULES.slotWeight);
          const qty = Math.floor(alloc / (s.price * (1 + FEE_RATE)));
          if (qty <= 0 || s.price * qty * (1 + FEE_RATE) > cash) note = "현금 부족";
          else {
            try {
              const reason = buyReason(s);
              await executeTrade(bot, { code: s.code, side: "buy", qty, reason, priceOverride: s.price, avatar: BOT_AVATAR });
              await sql`INSERT INTO bot_positions (sym, name, entry_date, entry_price, entry_score, qty) VALUES (${s.code}, ${s.name}, ${today}, ${s.price}, ${s.score}, ${qty})`;
              cash -= s.price * qty * (1 + FEE_RATE); free--; budget--; bought++; action = "buy"; note = qty + "주";
              await log("trade", `매수 ${s.name} ${qty}주 @${s.price.toLocaleString()} · ${reason}`);
            } catch (e) { note = "체결 실패: " + e.message; await log("error", `매수 실패 ${s.name}: ${e.message}`); }
          }
        }
        await sql`INSERT INTO bot_signals (run_date, sym, name, score, rsi_low, rsi_now, flow_sum, streak, vol_ratio, cap, tv, price, action, note)
          VALUES (${today}, ${s.code}, ${s.name}, ${s.score}, ${Math.round(s.rsiLow * 10) / 10}, ${Math.round(s.rsiNow * 10) / 10}, ${Math.round(s.flowSum)}, ${s.streak},
            ${Math.round(s.volRatio * 100) / 100}, ${s.cap}, ${Math.round(s.tv)}, ${s.price}, ${action}, ${note})`;
      }
      st.phase = "done"; st.note = `신호 ${sigs.length}건 · 매수 ${bought}건`; st.finished = Date.now();
      await save();
      await log("info", `스캔 완료 · ${st.universe.length}종목 · ${st.note}`);
      if (st.why) await log("info", "탈락 사유 · " + Object.keys(st.why).map((k) => k + " " + st.why[k]).join(" · "));
      if (st.sample) await log("info", "샘플 · " + st.sample);
      return res.status(200).json({ phase: "done", note: st.note });
    }
    return res.status(200).json({ phase: st.phase });
  } catch (e) {
    await botLog("error", "실행 오류: " + String(e.message || e));
    return res.status(500).json({ error: "봇 실행 오류", detail: String(e.message || e) });
  }
}


/* ── 유니버스 구축: 마스터 전 종목 시총 수집 → 코스피 200 + 코스닥 50 ── */
async function buildUniverse(req, res, t0) {
  let st = (await kvGet("qb_build")) || {};
  if (req.query.reset === "1" || !st.codes || st.idx >= st.codes.length) {
    const m = await getMaster();
    const codes = Object.keys(m).filter((c) => isUniverseCandidate(m[c].n)).map((c) => ({ code: c, name: m[c].n, m: m[c].m }));
    st = { codes, idx: 0, caps: {}, started: Date.now() };
    await botLog("info", `유니버스 구축 시작 · 후보 ${codes.length}종목 (마스터 ${Object.keys(m).length})`);
  }
  const PAR = 6;
  while (st.idx < st.codes.length && Date.now() - t0 < RULES.timeBudgetMs) {
    const batch = st.codes.slice(st.idx, st.idx + PAR);
    const rs = await Promise.all(batch.map((c) => capOf(c.code).catch(() => null)));
    rs.forEach((r, i) => { if (r && r.cap > 0 && !r.halt) st.caps[batch[i].code] = r.cap; });
    st.idx += batch.length;
    await sleep(320);
  }
  if (st.idx < st.codes.length) { await kvSet("qb_build", st); return res.status(200).json({ phase: "build", progress: st.idx + "/" + st.codes.length }); }
  const rank = (mk, n) => st.codes.filter((c) => c.m === mk && st.caps[c.code]).sort((a, b) => st.caps[b.code] - st.caps[a.code]).slice(0, n)
    .map((c) => ({ code: c.code, name: c.name, cap: st.caps[c.code], m: mk }));
  const list = rank("KOSPI", RULES.kospiTop).concat(rank("KOSDAQ", RULES.kosdaqTop));
  await kvSet("qb_universe_manual", { date: kstDate(), list });
  await kvSet("qb_universe", { ts: 0, list: [] });
  await kvSet("qb_build", {});
  await botLog("info", `유니버스 구축 완료 · 코스피 ${rank("KOSPI", RULES.kospiTop).length} + 코스닥 ${rank("KOSDAQ", RULES.kosdaqTop).length} = ${list.length}종목`);
  return res.status(200).json({ phase: "done", note: list.length + "종목" });
}
