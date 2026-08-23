// 코인 시총 TOP 10 (CoinGecko, 서버 5분 캐시)
import { init } from "./_db.js";
import { kvGet, kvSet } from "./_kis.js";

const KO = {
  bitcoin: "비트코인", ethereum: "이더리움", tether: "테더", binancecoin: "BNB",
  solana: "솔라나", ripple: "리플", "usd-coin": "USDC", dogecoin: "도지코인",
  cardano: "에이다", tron: "트론", "staked-ether": "스테이킹 이더", avalanche: "아발란체"
};

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();
    const cached = await kvGet("coins");
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000)
      return res.status(200).json({ coins: cached.coins, ts: cached.ts });

    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=krw&order=market_cap_desc&per_page=10&page=1&price_change_percentage=24h"
    );
    const d = await r.json();
    if (!Array.isArray(d)) {
      if (cached) return res.status(200).json({ coins: cached.coins, ts: cached.ts });
      return res.status(503).json({ error: "코인 시세를 불러오지 못했습니다" });
    }
    const coins = d.map((c) => ({
      sym: String(c.symbol || "").toUpperCase(),
      name: KO[c.id] || c.name,
      price: Math.round(Number(c.current_price) || 0),
      chg: Number(c.price_change_percentage_24h) || 0
    }));
    await kvSet("coins", { coins, ts: Date.now() });
    return res.status(200).json({ coins, ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류", detail: String(e.message || e) });
  }
}
