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

const HEARTBEAT_ID = "discord";
let heartbeatTableReady = false;

async function ensureHeartbeatTable(db: Sql): Promise<void> {
  if (heartbeatTableReady) {
    return;
  }
  await db`CREATE TABLE IF NOT EXISTS bot_heartbeat (
    id TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  heartbeatTableReady = true;
}

/** Status do gateway. Tabela à parte — nunca mexe em app_store. */
export async function saveBotHeartbeat(payload: unknown): Promise<void> {
  if (!usesRemoteStore()) {
    return;
  }
  const db = client();
  await ensureHeartbeatTable(db);
  const json = JSON.stringify(payload);
  await db`
    INSERT INTO bot_heartbeat (id, payload, updated_at)
    VALUES (${HEARTBEAT_ID}, ${json}::jsonb, now())
    ON CONFLICT (id) DO UPDATE
    SET payload = EXCLUDED.payload, updated_at = now()
  `;
}

export async function loadBotHeartbeat(): Promise<{ payload: unknown; updatedAt: string } | null> {
  if (!usesRemoteStore()) {
    return null;
  }
  const db = client();
  await ensureHeartbeatTable(db);
  const rows = (await db`
    SELECT payload, updated_at FROM bot_heartbeat WHERE id = ${HEARTBEAT_ID} LIMIT 1
  `) as Array<{ payload: unknown; updated_at: string | Date }>;
  const row = rows[0];
  if (!row) {
    return null;
  }
  const updatedAt =
    row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? "");
  return { payload: row.payload, updatedAt };
}

let mapImagesReady = false;

async function ensureMapImagesTable(db: Sql): Promise<void> {
  if (mapImagesReady) {
    return;
  }
  await db`CREATE TABLE IF NOT EXISTS map_images (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    data_url TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  mapImagesReady = true;
}

/** Imagem do mapa fora do app_store — não infla presets/drops. */
export async function saveRemoteMapImage(id: string, mime: string, dataUrl: string): Promise<void> {
  if (!usesRemoteStore()) {
    throw new Error("DATABASE_URL não configurada");
  }
  const db = client();
  await ensureMapImagesTable(db);
  await db`
    INSERT INTO map_images (id, mime, data_url, updated_at)
    VALUES (${id}, ${mime}, ${dataUrl}, now())
    ON CONFLICT (id) DO UPDATE
    SET mime = EXCLUDED.mime, data_url = EXCLUDED.data_url, updated_at = now()
  `;
}

export async function loadRemoteMapImage(
  id: string,
): Promise<{ mime: string; dataUrl: string } | null> {
  if (!usesRemoteStore()) {
    return null;
  }
  const db = client();
  await ensureMapImagesTable(db);
  const rows = (await db`
    SELECT mime, data_url FROM map_images WHERE id = ${id} LIMIT 1
  `) as Array<{ mime: string; data_url: string }>;
  const row = rows[0];
  if (!row?.data_url) {
    return null;
  }
  return { mime: row.mime, dataUrl: row.data_url };
}
