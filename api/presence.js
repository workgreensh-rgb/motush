// 접속자 집계: 전체 동시접속 / 모투선수(로그인) 동시접속 / 누적 방문
import { init, authUser } from "./_db.js";
import { kvGet, kvSet } from "./_kis.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();

    const { vid, first } = req.body || {};
    const id = String(vid || "").slice(0, 40);
    const user = await authUser(req); // 로그인 상태면 모투선수

    const now = Date.now();
    const map = (await kvGet("presence")) || {};
    // 60초 내 신호만 유지
    for (const k of Object.keys(map)) {
      if (now - (map[k].ts || 0) > 60 * 1000) delete map[k];
    }
    if (id) map[id] = { ts: now, p: !!user };
    await kvSet("presence", map);

    let total = (await kvGet("total_visits")) || { n: 0 };
    if (first) {
      total = { n: (total.n || 0) + 1 };
      await kvSet("total_visits", total);
    }

    const all = Object.keys(map).length;
    let players = 0;
    for (const k of Object.keys(map)) if (map[k].p) players++;

    return res.status(200).json({ now: all, players, total: total.n || 0 });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류", detail: String(e.message || e) });
  }
}
