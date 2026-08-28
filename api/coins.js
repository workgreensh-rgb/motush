// 코인 시총 TOP 10 (CoinGecko, 서버 5분 캐시) — 시세 로직은 _kis.js getCoins 공용
import { init } from "./_db.js";
import { getCoins } from "./_kis.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();
    const d = await getCoins();
    if (!d.coins.length) return res.status(503).json({ error: "코인 시세를 불러오지 못했습니다" });
    return res.status(200).json({ coins: d.coins, ts: d.ts });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류", detail: String(e.message || e) });
  }
}
