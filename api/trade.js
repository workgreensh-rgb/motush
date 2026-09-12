import { init, authUser } from "./_db.js";
import { executeTrade, TradeError } from "./_trade.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: "로그인이 필요합니다" });
    const { code, side, qty, reason } = req.body || {};
    const out = await executeTrade(user, { code, side, qty, reason });
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof TradeError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: "서버 오류가 발생했습니다", detail: String(e.message || e) });
  }
}
