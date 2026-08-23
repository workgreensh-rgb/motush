import { init } from "./_db.js";
import { getQuotes, SYMBOLS } from "./_kis.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();
    const cache = await getQuotes(true);
    const list = SYMBOLS.map((s) => {
      const it = cache.items[s.sym] || {};
      return {
        sym: s.sym,
        name: s.name,
        market: s.market,
        sector: s.sector,
        price: it.price || null,
        usd: it.usd || null,
        chg: typeof it.chg === "number" ? it.chg : null,
        hist: it.hist || [],
        ts: it.ts || null
      };
    });
    return res.status(200).json({ fx: cache.fx, ts: Date.now(), list });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류가 발생했습니다", detail: String(e.message || e) });
  }
}
