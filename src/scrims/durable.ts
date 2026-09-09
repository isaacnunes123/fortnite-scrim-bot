import { neon } from "@neondatabase/serverless";

const STORE_ID = "default";

type Sql = ReturnType<typeof neon>;

let sql: Sql | null = null;
let tableReady = false;

export function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "").trim();
}

export function usesRemoteStore(): boolean {
  return Boolean(databaseUrl());
}

export function usesEphemeralFs(): boolean {
  return Boolean(process.env.VERCEL);
}

function client(): Sql {
  const url = databaseUrl();
  if (!url) {
    throw new Error("DATABASE_URL não configurada");
  }
  if (!sql) {
    sql = neon(url);
  }
  return sql;
}

async function ensureTable(db: Sql): Promise<void> {
  if (tableReady) {
    return;
  }
  await db`CREATE TABLE IF NOT EXISTS app_store (
    id TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  tableReady = true;
}

export async function loadRemoteStore(): Promise<unknown | null> {
  if (!usesRemoteStore()) {
    return null;
  }
  const db = client();
  await ensureTable(db);
  const rows = (await db`SELECT payload FROM app_store WHERE id = ${STORE_ID} LIMIT 1`) as Array<{
    payload: unknown;
  }>;
  return rows[0]?.payload ?? null;
}

export async function saveRemoteStore(payload: unknown): Promise<void> {
  if (!usesRemoteStore()) {
    return;
  }
  const db = client();
  await ensureTable(db);
  const json = JSON.stringify(payload);
  await db`
    INSERT INTO app_store (id, payload, updated_at)
    VALUES (${STORE_ID}, ${json}::jsonb, now())
    ON CONFLICT (id) DO UPDATE
    SET payload = EXCLUDED.payload, updated_at = now()
  `;
}
