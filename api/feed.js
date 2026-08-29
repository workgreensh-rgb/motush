// 실시간 체결 피드 (전체공개, 매매 사유 포함) + 급상승 키워드 클라우드
import { init, sql } from "./_db.js";
import { kvGet, kvSet } from "./_kis.js";

// 키워드로 의미 없는 조사·상투어 제거
const STOP = new Set([
  "매수","매도","주식","종목","오늘","내일","어제","그리고","그래서","하지만","때문","때문에",
  "같아서","같아요","것","거","좀","많이","조금","계속","다시","진짜","그냥","일단","우선",
  "생각","예상","기대","느낌","해서","했음","했다","한다","할듯","높음","낮음","상승","하락",
  "수익","손절","익절","보유","추가","비중","포트","현금","살까","팔까","사자","팔자","가즈아",
  "https","http","www","com"
]);
const TAIL = ["에서","으로","이라","라서","해서","은","는","이","가","을","를","에","의","도","로","와","과","만","요"];

function tokenize(text, bag, w) {
  String(text || "")
    .split(/[^0-9A-Za-z가-힣]+/)
    .forEach((t) => {
      let s = t.trim();
      if (s.length < 2 || s.length > 12) return;
      // 조사 꼬리 제거 (3자 이상일 때만)
      for (const tail of TAIL) {
        if (s.length > 2 && s.endsWith(tail) && s.length - tail.length >= 2) {
          s = s.slice(0, s.length - tail.length);
          break;
        }
      }
      if (s.length < 2) return;
      const low = s.toLowerCase();
      if (STOP.has(s) || STOP.has(low)) return;
      if (/^\d+$/.test(s)) return; // 숫자만
      bag[s] = (bag[s] || 0) + w;
    });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();

    // ── 급상승 키워드 (5분 캐시) ──
    if (req.query && req.query.kw) {
      const c = await kvGet("kw_cloud");
      if (c && Date.now() - c.ts < 30 * 60 * 1000)
        return res.status(200).json({ words: c.words, ts: c.ts });

      const bag = {};
      const now = Date.now();
      // 1) 체결피드: 종목명(가중 3) + 매매사유 (24시간 내 2배)
      const fr = await sql`SELECT stock, reason, ts FROM feed ORDER BY id DESC LIMIT 300`;
      fr.forEach((r) => {
        const fresh = now - new Date(r.ts).getTime() < 24 * 3600 * 1000 ? 2 : 1;
        const nm = String(r.stock || "").trim();
        if (nm.length >= 2) bag[nm] = (bag[nm] || 0) + 3 * fresh;
        tokenize(r.reason, bag, 1 * fresh);
      });
      // 2) 메모장 전체
      const mr = await sql`SELECT content FROM memos`;
      mr.forEach((r) => tokenize(r.content, bag, 1));

      const words = Object.keys(bag)
        .map((w) => ({ w, n: bag[w] }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 24);
      await kvSet("kw_cloud", { words, ts: now });
      return res.status(200).json({ words, ts: now });
    }

    // ── 체결 피드 ──
    const rows = await sql`
      SELECT name, avatar, stock, side, qty, price, reason, mkt, ts FROM feed
      ORDER BY id DESC LIMIT 40`;
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
