import { init } from "./_db.js";
import { getQuotes, watchSymbol, SYMBOLS } from "./_kis.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();

    const watch = req.query && req.query.watch;
    let cache;
    if (watch) {
      const w = await watchSymbol(String(watch));
      cache = w.cache;
    } else {
      cache = await getQuotes(true);
    }

    const list = [];
    SYMBOLS.forEach((s) => {
      const it = cache.items[s.sym] || {};
      list.push({
        sym: s.sym, name: s.name, market: s.market, sector: s.sector,
        price: it.price || null, usd: it.usd || null,
        chg: typeof it.chg === "number" ? it.chg : null,
        cap: it.cap || 0, hist: it.hist || [], ts: it.ts || null
      });
    });
    // 편입 종목 (검색·거래로 추가된 것)
    Object.keys(cache.items).forEach((sym) => {
      const it = cache.items[sym];
      if (!it || !it.extra || !it.price) return;
      list.push({
        sym, name: it.name || sym, market: it.market || "KR", sector: it.sector || "검색",
        price: it.price, usd: it.usd || null,
        chg: typeof it.chg === "number" ? it.chg : null,
        cap: it.cap || 0, hist: it.hist || [], ts: it.ts || null, extra: true
      });
    });
    return res.status(200).json({ fx: cache.fx, ts: Date.now(), list });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류가 발생했습니다", detail: String(e.message || e) });
  }
}
