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

    if (req.method === "GET") {
      const watch = await myWatch(user.id);
      const m = await sql`SELECT content FROM memos WHERE user_id = ${user.id}`;
      return res.status(200).json({ watch, memo: m.length ? m[0].content : "" });
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
