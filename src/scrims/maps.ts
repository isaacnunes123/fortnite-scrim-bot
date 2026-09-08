import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./store.js";

export const DEFAULT_MAP_URL = "/maps/island.png";
export const uploadDir = path.join(dataDir(), "maps");

export function saveUploadedMap(buffer: Buffer, mime: string): string {
  const ext = mime.includes("jpeg") || mime.includes("jpg")
    ? "jpg"
    : mime.includes("webp")
      ? "webp"
      : "png";
  fs.mkdirSync(uploadDir, { recursive: true });
  const file = `${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, file), buffer);
  return `/uploads/${file}`;
}
