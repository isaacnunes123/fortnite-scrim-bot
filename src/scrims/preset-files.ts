import fs from "node:fs";
import path from "node:path";

export function repoPresetsDir(): string {
  return path.join(process.cwd(), "presets");
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function tryWriteJsonFile(file: string, data: unknown): void {
  try {
    writeJsonFile(file, data);
  } catch (error) {
    console.warn(`[presets] Não consegui gravar ${file}:`, error);
  }
}
