import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  loadRemoteMapImage,
  saveRemoteMapImage,
  usesEphemeralFs,
  usesRemoteStore,
} from "./durable.js";
import { dataDir } from "./store.js";

export const DEFAULT_MAP_URL = "/maps/island.png";
export const uploadDir = path.join(dataDir(), "maps");
const MAX_MAP_BYTES = 6_000_000;

function mapExt(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) {
    return "jpg";
  }
  if (mime.includes("webp")) {
    return "webp";
  }
  return "png";
}

export function normalizeMapMime(mime: string): string {
  const raw = mime.split(";")[0]?.trim().toLowerCase() || "image/png";
  if (raw === "image/jpg") {
    return "image/jpeg";
  }
  if (raw === "image/png" || raw === "image/jpeg" || raw === "image/webp") {
    return raw;
  }
  return "image/png";
}

export function toMapDataUrl(buffer: Buffer, mime: string): string {
  return `data:${normalizeMapMime(mime)};base64,${buffer.toString("base64")}`;
}

export function parseMapDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { mime: normalizeMapMime(match[1]), buffer: Buffer.from(match[2], "base64") };
}

export function mapImagePublicPath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "");
  return `/api/map-images/${safe}`;
}

export function saveUploadedMap(buffer: Buffer, mime: string): string {
  const ext = mapExt(mime);
  fs.mkdirSync(uploadDir, { recursive: true });
  const file = `${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, file), buffer);
  return `/uploads/${file}`;
}

export function savePresetMap(id: string, buffer: Buffer, mime: string): string {
  const ext = mapExt(mime);
  const dir = path.join(process.cwd(), "presets", "maps");
  fs.mkdirSync(dir, { recursive: true });
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buffer);
  return `/preset-files/${file}`;
}

function blobToken(): string {
  return (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim();
}

async function putVercelBlob(id: string, buffer: Buffer, mime: string, token: string): Promise<string> {
  const pathname = `maps/${id}.${mapExt(mime)}`;
  const response = await fetch(`https://blob.vercel-storage.com/${pathname}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-api-version": "7",
      "x-content-type": mime,
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
    },
    body: new Uint8Array(buffer),
  });
  const payload = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !payload.url) {
    throw new Error(payload.error || `Vercel Blob recusou o upload (${response.status})`);
  }
  return payload.url;
}

export async function persistMapImage(input: {
  id: string;
  buffer: Buffer;
  mime: string;
  fileStem?: string;
}): Promise<string> {
  const buffer = input.buffer;
  const mime = normalizeMapMime(input.mime);
  if (buffer.length < 32) {
    throw new Error("Arquivo de mapa inválido");
  }
  if (buffer.length > MAX_MAP_BYTES) {
    throw new Error("A imagem passa de 6 MB. Manda um JPG ou um PNG mais leve.");
  }
  const token = blobToken();
  if (token) {
    try {
      const url = await putVercelBlob(input.id, buffer, mime, token);
      return `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
    } catch (error) {
      console.warn("[maps] Vercel Blob falhou, tentando Neon/disco:", error);
    }
  }
  if (usesRemoteStore()) {
    await saveRemoteMapImage(input.id, mime, toMapDataUrl(buffer, mime));
    return `${mapImagePublicPath(input.id)}?v=${Date.now()}`;
  }
  if (usesEphemeralFs()) {
    throw new Error(
      "Upload de mapa não persiste na Vercel. Cole DATABASE_URL (Neon) ou BLOB_READ_WRITE_TOKEN e tente de novo.",
    );
  }
  try {
    return savePresetMap(input.fileStem || input.id, buffer, mime);
  } catch {
    return saveUploadedMap(buffer, mime);
  }
}

export async function readPersistedMap(id: string): Promise<{ mime: string; buffer: Buffer } | null> {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe) {
    return null;
  }
  const remote = await loadRemoteMapImage(safe);
  if (remote) {
    const parsed = parseMapDataUrl(remote.dataUrl);
    if (parsed) {
      return parsed;
    }
    return { mime: normalizeMapMime(remote.mime), buffer: Buffer.from(remote.dataUrl, "base64") };
  }
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const preset = path.join(process.cwd(), "presets", "maps", `${safe}.${ext}`);
    if (fs.existsSync(preset)) {
      return {
        mime: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png",
        buffer: fs.readFileSync(preset),
      };
    }
  }
  return null;
}

export function resolvePublicMapUrl(url: string | null | undefined): {
  url: string;
  missing: boolean;
} {
  const raw = (url ?? "").trim();
  if (!raw || raw === DEFAULT_MAP_URL) {
    return { url: DEFAULT_MAP_URL, missing: false };
  }
  if (raw.startsWith("data:image/")) {
    return { url: raw, missing: false };
  }
  if (raw.startsWith("/api/map-images/")) {
    return { url: raw, missing: false };
  }
  if (/^https?:\/\//i.test(raw)) {
    return { url: raw, missing: false };
  }
  if (raw.startsWith("/uploads/")) {
    const file = path.join(uploadDir, path.basename(raw));
    if (fs.existsSync(file)) {
      return { url: raw, missing: false };
    }
    return { url: DEFAULT_MAP_URL, missing: true };
  }
  if (raw.startsWith("/preset-files/")) {
    const file = path.join(process.cwd(), "presets", "maps", path.basename(raw));
    if (fs.existsSync(file)) {
      return { url: raw, missing: false };
    }
    return { url: DEFAULT_MAP_URL, missing: true };
  }
  return { url: raw, missing: false };
}
