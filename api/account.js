import { init, sql, authUser } from "./_db.js";
import { getQuotes, equityOf, stageOf, START_CASH } from "./_kis.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();

    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: "로그인이 필요합니다" });

    const rows = await sql`SELECT cash, holdings, trades, trade_count FROM accounts WHERE user_id = ${user.id}`;
    if (!rows.length) return res.status(404).json({ error: "계좌를 찾을 수 없습니다" });

    const acc = rows[0];
    const cache = await getQuotes(false);
    const equity = equityOf(acc.cash, acc.holdings, cache);
    const ret = ((equity - START_CASH) / START_CASH) * 100;
    const tc = Number(acc.trade_count || 0);
    const st = stageOf(ret, tc);

    return res.status(200).json({
      username: user.username,
      name: user.name,
      avatar: st.av,
      stage: st,
      trade_count: tc,
      cash: Number(acc.cash),
      holdings: acc.holdings || {},
      trades: acc.trades || [],
      equity
    });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류가 발생했습니다", detail: String(e.message || e) });
  }
}
