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
  ready = true;
}

export async function authUser(req) {
  const h = req.headers["authorization"] || "";
  const token = h.replace("Bearer", "").trim();
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.username, u.name
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token}`;
  return rows[0] || null;
}
