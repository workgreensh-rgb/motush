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
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT '🐥'`;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS trade_count INTEGER DEFAULT 0`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT '🐥'`;
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
