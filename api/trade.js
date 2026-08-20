import { init, sql, authUser } from "./_db.js";
import { TICKERS, currentPrice, equityOf, FEE_RATE } from "./_engine.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "허용되지 않는 요청입니다" });
    await init();

    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: "로그인이 필요합니다" });

    const { code, side, qty } = req.body || {};
    const tk = TICKERS.find((x) => x.code === code);
    const n = Math.floor(Number(qty));
    if (!tk) return res.status(400).json({ error: "존재하지 않는 종목입니다" });
    if (side !== "buy" && side !== "sell") return res.status(400).json({ error: "잘못된 주문 유형입니다" });
    if (!Number.isFinite(n) || n <= 0 || n > 100000000)
      return res.status(400).json({ error: "수량을 확인해 주세요" });

    const rows = await sql`SELECT cash, holdings, trades FROM accounts WHERE user_id = ${user.id}`;
    if (!rows.length) return res.status(404).json({ error: "계좌를 찾을 수 없습니다" });

    let cash = Number(rows[0].cash);
    const holdings = rows[0].holdings || {};
    let trades = rows[0].trades || [];

    const price = currentPrice(code); // 서버가 시세 결정 (조작 방지)
    const gross = price * n;
    const fee = Math.round(gross * FEE_RATE);

    if (side === "buy") {
      if (gross + fee > cash) return res.status(400).json({ error: "현금이 부족합니다" });
      cash -= gross + fee;
      const h = holdings[code] || { qty: 0, cost: 0 };
      holdings[code] = { qty: h.qty + n, cost: h.cost + gross };
    } else {
      const h = holdings[code];
      if (!h || h.qty < n) return res.status(400).json({ error: "보유 수량이 부족합니다" });
      cash += gross - fee;
      const rest = h.qty - n;
      if (rest === 0) delete holdings[code];
      else holdings[code] = { qty: rest, cost: Math.round(h.cost * (rest / h.qty)) };
    }

    trades = [
      { ts: Date.now(), code, name: tk.name, side, n, price },
      ...trades
    ].slice(0, 30);

    await sql`
      UPDATE accounts
      SET cash = ${Math.round(cash)},
          holdings = ${JSON.stringify(holdings)}::jsonb,
          trades = ${JSON.stringify(trades)}::jsonb,
          updated_at = now()
      WHERE user_id = ${user.id}`;

    return res.status(200).json({
      ok: true,
      filled: { code, name: tk.name, side, n, price },
      cash: Math.round(cash),
      holdings,
      trades,
      equity: equityOf(cash, holdings)
    });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류가 발생했습니다", detail: String(e.message || e) });
  }
}
