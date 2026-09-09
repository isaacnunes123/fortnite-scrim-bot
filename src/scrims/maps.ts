import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./store.js";

export const DEFAULT_MAP_URL = "/maps/island.png";
export const uploadDir = path.join(dataDir(), "maps");

function mapExt(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) {
    return "jpg";
  }
  if (mime.includes("webp")) {
    return "webp";
  }
  return "png";
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
