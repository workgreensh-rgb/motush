// 파티: 친구 그룹 (1인 최대 2파티)
// GET  ?action=list          파티 목록 + 내 소속
// GET  ?action=detail&id=N   파티 상세 (멤버 포트폴리오·매매 사유 피드) — 멤버만
// POST {action:create|join|leave, ...}
import { init, sql, authUser } from "./_db.js";
import { getQuotes, equityOf, stageOf, START_CASH } from "./_kis.js";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

const MAX_PARTIES_PER_USER = 2;

function classify(sym) {
  if (sym.indexOf("C:") === 0) return "coin";
  if (/^\d{6}$/.test(sym)) return "kr";
  return "us";
}
function breakdownOf(cash, holdings, cache) {
  const b = { kr: 0, us: 0, coin: 0, cash: Math.max(0, Number(cash) || 0) };
  const h = holdings || {};
  for (const sym of Object.keys(h)) {
    const it = cache.items[sym];
    const qty = Number(h[sym].qty) || 0;
    const v = it && it.price ? Math.round(it.price * qty) : Number(h[sym].cost) || 0;
    b[classify(sym)] += v;
  }
  return b;
}
async function myPartyCount(uid) {
  const r = await sql`SELECT COUNT(*)::int AS c FROM party_members WHERE user_id = ${uid}`;
  return r[0].c;
}

export default async function handler(req, res) {
  try {
    await init();
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: "로그인이 필요합니다" });

    if (req.method === "GET") {
      const action = (req.query && req.query.action) || "list";

      if (action === "list") {
        const rows = await sql`
          SELECT p.id, p.name, p.intro, p.max_members,
            (p.pass_hash IS NOT NULL) AS locked,
            (SELECT COUNT(*) FROM party_members m WHERE m.party_id = p.id)::int AS cnt,
            EXISTS(SELECT 1 FROM party_members m WHERE m.party_id = p.id AND m.user_id = ${user.id}) AS mine
          FROM parties p ORDER BY p.id DESC LIMIT 50`;
        return res.status(200).json({
          parties: rows.map((r) => ({
            id: r.id, name: r.name, intro: r.intro || "", max: r.max_members,
            locked: !!r.locked, cnt: r.cnt, mine: !!r.mine
          })),
          my_count: await myPartyCount(user.id)
        });
      }

      if (action === "detail") {
        const pid = parseInt(req.query.id, 10);
        if (!pid) return res.status(400).json({ error: "파티를 찾을 수 없습니다" });
        const isMem = await sql`SELECT 1 FROM party_members WHERE party_id = ${pid} AND user_id = ${user.id}`;
        if (!isMem.length) return res.status(403).json({ error: "파티 멤버만 볼 수 있습니다" });
        const p = await sql`SELECT id, name, intro, max_members FROM parties WHERE id = ${pid}`;
        if (!p.length) return res.status(404).json({ error: "파티를 찾을 수 없습니다" });

        const mem = await sql`
          SELECT u.username, u.name, a.cash, a.holdings, a.trades, a.trade_count
          FROM party_members m
          JOIN users u ON u.id = m.user_id
          JOIN accounts a ON a.user_id = u.id
          WHERE m.party_id = ${pid} ORDER BY m.joined_at`;

        const cache = await getQuotes(false);
        const agg = { kr: 0, us: 0, coin: 0, cash: 0 };
        let feed = [];
        const members = mem.map((r) => {
          const eq = equityOf(r.cash, r.holdings, cache);
          const ret = ((eq - START_CASH) / START_CASH) * 100;
          const st = stageOf(ret, Number(r.trade_count || 0));
          const bd = breakdownOf(r.cash, r.holdings, cache);
          for (const k of Object.keys(agg)) agg[k] += bd[k];
          (r.trades || []).forEach((t) => {
            feed.push({ name: r.name, avatar: st.av, ts: t.ts, side: t.side, stock: t.name, n: t.n, price: t.price, reason: t.reason || "", mkt: t.mkt || "" });
          });
          return { username: r.username, name: r.name, avatar: st.av, equity: eq, ret, breakdown: bd };
        });
        feed.sort((a, b) => b.ts - a.ts);
        feed = feed.slice(0, 40);

        return res.status(200).json({
          party: { id: p[0].id, name: p[0].name, intro: p[0].intro || "", max: p[0].max_members },
          members, agg, feed
        });
      }

      return res.status(400).json({ error: "알 수 없는 요청입니다" });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    const { action, party_id, name, intro, pass, max } = req.body || {};

    if (action === "create") {
      const nm = String(name || "").trim().slice(0, 20);
      if (nm.length < 2) return res.status(400).json({ error: "방제는 2~20자로 해주세요" });
      const it = String(intro || "").trim().slice(0, 60);
      let mx = parseInt(max, 10);
      if (!Number.isFinite(mx) || mx < 2 || mx > 30) mx = 10;
      if ((await myPartyCount(user.id)) >= MAX_PARTIES_PER_USER)
        return res.status(400).json({ error: "파티는 최대 " + MAX_PARTIES_PER_USER + "개까지 가입할 수 있습니다" });

      let ph = null;
      const pw = String(pass || "").trim();
      if (pw) {
        if (pw.length < 2) return res.status(400).json({ error: "파티 비밀번호는 2자 이상으로 해주세요" });
        const salt = randomBytes(16).toString("hex");
        ph = salt + ":" + scryptSync(pw, salt, 32).toString("hex");
      }
      const rows = await sql`
        INSERT INTO parties (name, intro, pass_hash, owner_id, max_members)
        VALUES (${nm}, ${it}, ${ph}, ${user.id}, ${mx}) RETURNING id`;
      await sql`INSERT INTO party_members (party_id, user_id) VALUES (${rows[0].id}, ${user.id})`;
      return res.status(200).json({ ok: true, id: rows[0].id });
    }

    if (action === "join") {
      const pid = parseInt(party_id, 10);
      const p = await sql`
        SELECT id, pass_hash, max_members,
          (SELECT COUNT(*) FROM party_members m WHERE m.party_id = parties.id)::int AS cnt
        FROM parties WHERE id = ${pid}`;
      if (!p.length) return res.status(404).json({ error: "파티를 찾을 수 없습니다" });
      const already = await sql`SELECT 1 FROM party_members WHERE party_id = ${pid} AND user_id = ${user.id}`;
      if (already.length) return res.status(400).json({ error: "이미 가입한 파티입니다" });
      if ((await myPartyCount(user.id)) >= MAX_PARTIES_PER_USER)
        return res.status(400).json({ error: "파티는 최대 " + MAX_PARTIES_PER_USER + "개까지 가입할 수 있습니다" });
      if (p[0].cnt >= p[0].max_members) return res.status(400).json({ error: "정원이 가득 찼습니다" });
      if (p[0].pass_hash) {
        const [salt, hash] = String(p[0].pass_hash).split(":");
        const test = scryptSync(String(pass || ""), salt, 32).toString("hex");
        const ok = hash.length === test.length &&
          timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
        if (!ok) return res.status(401).json({ error: "파티 비밀번호가 올바르지 않습니다" });
      }
      await sql`INSERT INTO party_members (party_id, user_id) VALUES (${pid}, ${user.id})`;
      return res.status(200).json({ ok: true, id: pid });
    }

    if (action === "leave") {
      const pid = parseInt(party_id, 10);
      await sql`DELETE FROM party_members WHERE party_id = ${pid} AND user_id = ${user.id}`;
      const left = await sql`SELECT COUNT(*)::int AS c FROM party_members WHERE party_id = ${pid}`;
      if (left[0].c === 0) await sql`DELETE FROM parties WHERE id = ${pid}`; // 빈 파티는 정리
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "알 수 없는 요청입니다" });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류가 발생했습니다", detail: String(e.message || e) });
  }
}
