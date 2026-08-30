// 시장 탭: 내 관심종목 + 메모장 (로그인 필수)
import { init, sql, authUser } from "./_db.js";
import { resolveMeta, watchSymbol } from "./_kis.js";

async function myWatch(uid) {
  const rows = await sql`SELECT sym, name, market FROM watchlist WHERE user_id = ${uid} ORDER BY created_at`;
  return rows.map((r) => ({ sym: r.sym, name: r.name, market: r.market }));
}

export default async function handler(req, res) {
  try {
    await init();
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: "로그인이 필요합니다" });

    async function myJournal(uid) {
      const rows = await sql`
        SELECT id, kind, text, mood, stock, side, ts FROM journal
        WHERE user_id = ${uid} ORDER BY id DESC LIMIT 60`;
      return rows.map((r) => ({
        id: r.id, kind: r.kind, text: r.text, mood: r.mood || "",
        stock: r.stock || "", side: r.side || "", ts: new Date(r.ts).getTime()
      }));
    }
    async function myStreak(uid) {
      const rows = await sql`
        SELECT DISTINCT to_char(ts AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS d
        FROM journal WHERE user_id = ${uid} ORDER BY d DESC LIMIT 120`;
      if (!rows.length) return 0;
      const day = (off) => {
        const t = new Date(Date.now() + 9 * 3600 * 1000 - off * 86400000);
        return t.toISOString().slice(0, 10);
      };
      let idx = 0, streak = 0;
      // 오늘 또는 어제부터 이어지는 연속 기록일 수
      let off = rows[0].d === day(0) ? 0 : rows[0].d === day(1) ? 1 : -1;
      if (off < 0) return 0;
      while (idx < rows.length && rows[idx].d === day(off)) { streak++; idx++; off++; }
      return streak;
    }

    if (req.method === "GET") {
      const watch = await myWatch(user.id);
      const journal = await myJournal(user.id);
      const streak = await myStreak(user.id);
      return res.status(200).json({ watch, journal, streak });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    const { action, code, sym, content } = req.body || {};

    if (action === "add") {
      const meta = await resolveMeta(code);
      if (!meta) return res.status(400).json({ error: "존재하지 않는 종목입니다" });
      const cnt = await sql`SELECT COUNT(*)::int AS c FROM watchlist WHERE user_id = ${user.id}`;
      if (cnt[0].c >= 30) return res.status(400).json({ error: "관심종목은 최대 30개까지 등록할 수 있습니다" });
      try { await watchSymbol(meta.sym); } catch (e) {} // 시세 캐시에 미리 편입
      await sql`INSERT INTO watchlist (user_id, sym, name, market)
        VALUES (${user.id}, ${meta.sym}, ${meta.name}, ${meta.market})
        ON CONFLICT (user_id, sym) DO NOTHING`;
      return res.status(200).json({ watch: await myWatch(user.id) });
    }

    if (action === "remove") {
      await sql`DELETE FROM watchlist WHERE user_id = ${user.id} AND sym = ${String(sym || "")}`;
      return res.status(200).json({ watch: await myWatch(user.id) });
    }

    if (action === "journal_add") {
      const txt = String(content || "").trim().slice(0, 500);
      if (txt.length < 1) return res.status(400).json({ error: "내용을 입력해 주세요" });
      const md = ["확신", "관망", "불안", "풀매수"].indexOf(String(req.body.mood || "")) >= 0 ? String(req.body.mood) : null;
      await sql`INSERT INTO journal (user_id, kind, text, mood) VALUES (${user.id}, 'memo', ${txt}, ${md})`;
      return res.status(200).json({ journal: await myJournal(user.id), streak: await myStreak(user.id) });
    }

    if (action === "journal_export") {
      const rows = await sql`
        SELECT kind, text, mood, stock, side, ts FROM journal
        WHERE user_id = ${user.id} ORDER BY id ASC LIMIT 2000`;
      return res.status(200).json({ entries: rows.map((r) => ({
        kind: r.kind, text: r.text, mood: r.mood || "", stock: r.stock || "",
        side: r.side || "", ts: new Date(r.ts).getTime()
      })) });
    }

    if (action === "journal_del") {
      const jid = Math.floor(Number(req.body.id));
      if (Number.isFinite(jid)) await sql`DELETE FROM journal WHERE id = ${jid} AND user_id = ${user.id}`;
      return res.status(200).json({ journal: await myJournal(user.id), streak: await myStreak(user.id) });
    }

    if (action === "memo") {
      const c = String(content || "").slice(0, 2000);
      await sql`INSERT INTO memos (user_id, content, updated_at) VALUES (${user.id}, ${c}, now())
        ON CONFLICT (user_id) DO UPDATE SET content = ${c}, updated_at = now()`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "알 수 없는 요청입니다" });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류가 발생했습니다", detail: String(e.message || e) });
  }
}
