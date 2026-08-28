// 실시간 체결 피드 (전체공개, 매매 사유 포함)
import { init, sql } from "./_db.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();
    const rows = await sql`
      SELECT name, avatar, stock, side, qty, price, reason, mkt, ts FROM feed
      ORDER BY id DESC LIMIT 20`;
    return res.status(200).json({
      feed: rows.map((r) => ({
        name: r.name, avatar: r.avatar || "🐥", stock: r.stock, side: r.side,
        qty: Number(r.qty), price: Number(r.price),
        reason: r.reason || "", mkt: r.mkt || "",
        ts: new Date(r.ts).getTime()
      }))
    });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류", detail: String(e.message || e) });
  }
}
