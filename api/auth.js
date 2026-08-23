import { init, sql, authUser } from "./_db.js";
import { START_CASH } from "./_kis.js";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();

    const AVATARS = ["🐶","🐱","🐰","🦊","🐻","🐼","🐯","🦁","🐸","🐥","🐧","🐹"];
    const { action, username, password, name, avatar } = req.body || {};


    const u = String(username || "").trim().toLowerCase();

    if (!/^[a-z0-9_]{2,20}$/.test(u))
      return res.status(400).json({ error: "아이디는 영문 소문자·숫자·_ 조합 2~20자로 해주세요" });
    if (!password || String(password).length < 4)
      return res.status(400).json({ error: "비밀번호는 4자 이상으로 해주세요" });

    if (action === "signup") {
      const nm = String(name || "").trim().slice(0, 20) || u;
      const exists = await sql`SELECT 1 FROM users WHERE username = ${u}`;
      if (exists.length) return res.status(409).json({ error: "이미 사용 중인 아이디입니다" });

      const salt = randomBytes(16).toString("hex");
      const hash = scryptSync(String(password), salt, 32).toString("hex");
      const rows = await sql`
        INSERT INTO users (username, name, pass_hash)
        VALUES (${u}, ${nm}, ${salt + ":" + hash})
        RETURNING id, name, username`;
      const user = rows[0];
      await sql`INSERT INTO accounts (user_id, cash) VALUES (${user.id}, ${START_CASH})`;

      const token = randomBytes(24).toString("hex");
      await sql`INSERT INTO sessions (token, user_id) VALUES (${token}, ${user.id})`;
      return res.status(200).json({ token, name: user.name, username: user.username });
    }

    if (action === "login") {
      const rows = await sql`SELECT id, name, username, pass_hash FROM users WHERE username = ${u}`;
      if (!rows.length) return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다" });

      const [salt, hash] = String(rows[0].pass_hash).split(":");
      const test = scryptSync(String(password), salt, 32).toString("hex");
      const ok =
        hash.length === test.length &&
        timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
      if (!ok) return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다" });

      const token = randomBytes(24).toString("hex");
      await sql`INSERT INTO sessions (token, user_id) VALUES (${token}, ${rows[0].id})`;
      return res.status(200).json({ token, name: rows[0].name, username: rows[0].username });
    }

    return res.status(400).json({ error: "알 수 없는 요청입니다" });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류가 발생했습니다", detail: String(e.message || e) });
  }
}
