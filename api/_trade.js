// 체결 공통 로직 — 사람(trade.js)과 봇(cron/quantbot.js)이 같은 경로로 체결
import { sql } from "./_db.js";
import { getQuotes, watchSymbol, resolveMeta, equityOf, stageOf, FEE_RATE, START_CASH } from "./_kis.js";

export class TradeError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// user: { id, name }  /  opts: { code, side, qty, reason, priceOverride? }
export async function executeTrade(user, opts) {
  const { code, side, qty, reason } = opts;
  const rs = String(reason || "").trim();
  if (rs.length < 2) throw new TradeError(400, "매매 사유를 입력해 주세요 (2자 이상)");
  if (rs.length > 200) throw new TradeError(400, "매매 사유는 200자 이내로 해주세요");

  const meta = await resolveMeta(code);
  if (!meta) throw new TradeError(400, "존재하지 않는 종목입니다");
  if (side !== "buy" && side !== "sell") throw new TradeError(400, "잘못된 주문 유형입니다");

  const rq = (x) => Math.round(Number(x) * 1e8) / 1e8;
  const isCoin = meta.market === "COIN";
  let n;
  if (isCoin) {
    n = rq(qty);
    if (!Number.isFinite(n) || n < 0.000001 || n > 1000000) throw new TradeError(400, "수량을 확인해 주세요 (소수점 6자리까지)");
  } else {
    n = Math.floor(Number(qty));
    if (!Number.isFinite(n) || n <= 0 || n > 100000000) throw new TradeError(400, "수량을 확인해 주세요");
  }

  let cache = await getQuotes(false);
  let item = cache.items[meta.sym];
  if (!item || !item.price || Date.now() - (item.ts || 0) > 120 * 1000) {
    const w = await watchSymbol(meta.sym);
    cache = w.cache;
    item = cache.items[meta.sym];
  }
  if (!item || !item.price) throw new TradeError(503, "시세를 찾지 못했습니다. 종목코드를 확인하거나 잠시 후 다시 시도해 주세요");

  const rows = await sql`SELECT cash, holdings, trades, trade_count FROM accounts WHERE user_id = ${user.id}`;
  if (!rows.length) throw new TradeError(404, "계좌를 찾을 수 없습니다");

  let cash = Number(rows[0].cash);
  const holdings = rows[0].holdings || {};
  let trades = rows[0].trades || [];
  const tradeCount = Number(rows[0].trade_count || 0) + 1;

  const price = opts.priceOverride || item.price;
  const gross = Math.round(price * n);
  if (gross < 100) throw new TradeError(400, "주문금액이 너무 작습니다");
  const fee = Math.round(gross * FEE_RATE);

  if (side === "buy") {
    if (gross + fee > cash) throw new TradeError(400, "현금이 부족합니다");
    cash -= gross + fee;
    const h = holdings[meta.sym] || { qty: 0, cost: 0 };
    holdings[meta.sym] = { qty: rq(h.qty + n), cost: h.cost + gross };
  } else {
    const h = holdings[meta.sym];
    if (!h || rq(h.qty) < rq(n)) throw new TradeError(400, "보유 수량이 부족합니다");
    cash += gross - fee;
    const rest = rq(h.qty - n);
    if (rest <= 0) delete holdings[meta.sym];
    else holdings[meta.sym] = { qty: rest, cost: Math.round(h.cost * (rest / h.qty)) };
  }

  const name = item.name || meta.name;
  trades = [{ ts: Date.now(), code: meta.sym, name, side, n, price, reason: rs, mkt: meta.market }, ...trades].slice(0, 30);

  const equity = equityOf(cash, holdings, cache);
  const ret = ((equity - START_CASH) / START_CASH) * 100;
  const st = stageOf(ret, tradeCount);

  try { await sql`INSERT INTO journal (user_id, kind, text, mood, stock, side) VALUES (${user.id}, 'trade', ${rs}, NULL, ${name}, ${side})`; } catch (e) {}
  try { await sql`INSERT INTO feed (name, avatar, stock, side, qty, price, reason, mkt) VALUES (${user.name}, ${opts.avatar || st.av}, ${name}, ${side}, ${n}, ${price}, ${rs}, ${meta.market})`; } catch (e) {}

  await sql`UPDATE accounts SET cash = ${Math.round(cash)}, holdings = ${JSON.stringify(holdings)}::jsonb,
    trades = ${JSON.stringify(trades)}::jsonb, trade_count = ${tradeCount}, updated_at = now() WHERE user_id = ${user.id}`;

  return { ok: true, filled: { code: meta.sym, name, side, n, price, mkt: meta.market },
    cash: Math.round(cash), holdings, trades, trade_count: tradeCount, equity, stage: st };
}
