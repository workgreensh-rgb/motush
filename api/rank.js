import { init, sql } from "./_db.js";
import { getQuotes, equityOf, stageOf, START_CASH } from "./_kis.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();

    const cache = await getQuotes(false);
    const rows = await sql`
      SELECT u.username, u.name, a.cash, a.holdings, a.trade_count
      FROM accounts a JOIN users u ON u.id = a.user_id
      LIMIT 200`;

    const board = rows
      .map((r) => {
        const eq = equityOf(r.cash, r.holdings, cache);
        const ret = ((eq - START_CASH) / START_CASH) * 100;
        const st = stageOf(ret, Number(r.trade_count || 0));
        return {
          username: r.username, name: r.name,
          avatar: st.av, lv: st.lv,
          equity: eq, ret
        };
      })
      .sort((a, b) => b.equity - a.equity)
      .slice(0, 100);

    return res.status(200).json({ board, ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류가 발생했습니다", detail: String(e.message || e) });
  }
}
