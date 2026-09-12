// 자동매매 탭 API — GET 상태/신호/로그, POST 설정(관리자)
import { init, sql, authUser } from "./_db.js";
import { kvGet, kvSet, getQuotes, equityOf, START_CASH } from "./_kis.js";
import { RULES, kstDate, botConfig, botLog } from "./_quant.js";
import { isOwner } from "./cron/quantbot.js";

export default async function handler(req, res) {
  try {
    await init();
    const user = await authUser(req);
    const owner = !!(user && isOwner(user));

    if (req.method === "GET") {
      const cfg = await botConfig();
      const run = (await kvGet("qb_run")) || {};
      const today = kstDate();
      const un = process.env.BOT_USERNAME || "quantbota";
      const b = await sql`SELECT u.id, u.name, a.cash, a.holdings FROM users u JOIN accounts a ON a.user_id = u.id WHERE u.username = ${un}`;
      let equity = 0, ret = 0;
      if (b.length) { const cache = await getQuotes(false); equity = equityOf(b[0].cash, b[0].holdings, cache); ret = ((equity - START_CASH) / START_CASH) * 100; }
      const positions = await sql`SELECT sym, name, entry_date, entry_price, entry_score, qty, days_held, mfe, last_ret FROM bot_positions WHERE status = 'open' ORDER BY id`;
      const closed = await sql`SELECT sym, name, entry_date, exit_date, exit_kind, exit_ret, days_held, mfe FROM bot_positions WHERE status = 'closed' ORDER BY id DESC LIMIT 20`;
      const latestDate = (await sql`SELECT run_date FROM bot_signals ORDER BY id DESC LIMIT 1`)[0];
      const sigDate = latestDate ? latestDate.run_date : today;
      const signals = await sql`SELECT sym, name, score, rsi_low, rsi_now, flow_sum, streak, vol_ratio, cap, tv, price, action, note FROM bot_signals WHERE run_date = ${sigDate} ORDER BY score DESC NULLS LAST LIMIT 30`;
      const logs = owner ? await sql`SELECT level, msg, ts FROM bot_logs ORDER BY id DESC LIMIT 30` : [];
      return res.status(200).json({
        owner, rules: RULES, config: { on: cfg.on, brake: cfg.brake },
        run: { date: run.date || null, phase: run.phase || null, note: run.note || "", progress: run.universe ? (run.idx || 0) + "/" + run.universe.length : "", regime: run.regime || null, finished: run.finished || null },
        bot: { name: b.length ? b[0].name : "퀀트봇A", equity, ret, slots: positions.length },
        positions: positions.map((p) => ({ ...p, entry_price: Number(p.entry_price), entry_score: Number(p.entry_score), mfe: Number(p.mfe), last_ret: Number(p.last_ret) })),
        closed: closed.map((p) => ({ ...p, exit_ret: Number(p.exit_ret), mfe: Number(p.mfe) })),
        signals_date: sigDate,
        signals: signals.map((s) => ({ ...s, score: Number(s.score), rsi_low: Number(s.rsi_low), rsi_now: Number(s.rsi_now), flow_sum: Number(s.flow_sum), vol_ratio: Number(s.vol_ratio), cap: Number(s.cap), tv: Number(s.tv), price: Number(s.price) })),
        logs: logs.map((l) => ({ level: l.level, msg: l.msg, ts: new Date(l.ts).getTime() }))
      });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    if (!owner) return res.status(403).json({ error: "관리자만 변경할 수 있습니다" });
    const { action } = req.body || {};
    const cfg = await botConfig();
    if (action === "toggle") { cfg.on = !cfg.on; await kvSet("qb_config", cfg); await botLog("info", "봇 " + (cfg.on ? "ON" : "OFF") + " (관리자)"); return res.status(200).json({ config: cfg }); }
    if (action === "brake") { cfg.brake = !cfg.brake; await kvSet("qb_config", cfg); await botLog("info", "이벤트 브레이크 " + (cfg.brake ? "ON" : "OFF") + " (관리자)"); return res.status(200).json({ config: cfg }); }
    if (action === "universe_manual") {
      const list = Array.isArray(req.body.list) ? req.body.list.filter((x) => x && /^\d{6}$/.test(String(x.code))).slice(0, 400) : [];
      await kvSet("qb_universe_manual", list); await kvSet("qb_universe", { ts: 0, list: [] });
      return res.status(200).json({ ok: true, n: list.length });
    }
    return res.status(400).json({ error: "알 수 없는 요청입니다" });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류", detail: String(e.message || e) });
  }
}
