import { neon } from "@neondatabase/serverless";

const CONN =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL;

export const sql = neon(CONN);

let ready = false;
export async function init() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    cash BIGINT NOT NULL,
    holdings JSONB NOT NULL DEFAULT '{}'::jsonb,
    trades JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS feed (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    stock TEXT NOT NULL,
    side TEXT NOT NULL,
    qty INTEGER NOT NULL,
    price BIGINT NOT NULL,
    ts TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS watchlist (
    user_id INTEGER REFERENCES users(id),
    sym TEXT NOT NULL,
    name TEXT,
    market TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, sym)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS memos (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    content TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS parties (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    intro TEXT DEFAULT '',
    pass_hash TEXT,
    owner_id INTEGER REFERENCES users(id),
    max_members INTEGER DEFAULT 10,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS party_members (
    party_id INTEGER REFERENCES parties(id),
    user_id INTEGER REFERENCES users(id),
    joined_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (party_id, user_id)
  )`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT '🐥'`;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS trade_count INTEGER DEFAULT 0`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT '🐥'`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS reason TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS mkt TEXT`;

  // 일회성 정리: HB·한빛건설 잔재 제거 (보유·거래기록·피드)
  try {
    const done = await sql`SELECT 1 FROM kv WHERE k = 'cleanup_hb_v1'`;
    if (!done.length) {
      await sql`UPDATE accounts SET holdings = (holdings - 'HB') - 'HBC'`;
      await sql`UPDATE accounts SET trades = COALESCE(
        (SELECT jsonb_agg(t) FROM jsonb_array_elements(accounts.trades) t
         WHERE NOT (t->>'code' IN ('HB','HBC') OR t->>'name' LIKE '%한빛%')),
        '[]'::jsonb)
        WHERE trades <> '[]'::jsonb`;
      await sql`DELETE FROM feed WHERE stock IN ('HB','HBC') OR stock LIKE '%한빛%'`;
      await sql`INSERT INTO kv (k, v) VALUES ('cleanup_hb_v1', '{"done":true}'::jsonb)
        ON CONFLICT (k) DO NOTHING`;
    }
  } catch (e) {}
  ready = true;
}

export async function authUser(req) {
  const h = req.headers["authorization"] || "";
  const token = h.replace("Bearer", "").trim();
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.username, u.name, u.avatar
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token}`;
  return rows[0] || null;
}
