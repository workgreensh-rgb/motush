// 국내 전 종목 검색 (코스피+코스닥 마스터 기반)
import { init } from "./_db.js";
import { getMaster } from "./_kis.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();
    const q = String((req.query && req.query.q) || "").trim().toLowerCase();
    if (!q) return res.status(200).json({ results: [] });
    const map = await getMaster();
    const out = [];
    for (const code of Object.keys(map)) {
      const e = map[code];
      if (e.n.toLowerCase().indexOf(q) >= 0 || code.indexOf(q) === 0) {
        out.push({ code, name: e.n, mkt: e.m });
        if (out.length >= 100) break;
      }
    }
    // 이름 짧은 순(정확 일치 우선 느낌)으로 상위 20개
    out.sort((a, b) => a.name.length - b.name.length);
    return res.status(200).json({ results: out.slice(0, 20), total: Object.keys(map).length });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류", detail: String(e.message || e) });
  }
}
