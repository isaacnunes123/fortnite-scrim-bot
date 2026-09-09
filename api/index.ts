import type { IncomingMessage, ServerResponse } from "node:http";
import { createSiteApp, flushStore } from "../src/web/siteApi.js";
import { handleDiscordHttpInteraction } from "../src/web/discordInteractions.js";
import { ensureStore } from "../src/scrims/store.js";

export const config = {
  maxDuration: 60,
};

const app = createSiteApp();

type VercelReq = IncomingMessage & {
  query?: { path?: string | string[] };
};

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function withApiPrefix(req: VercelReq): void {
  const forwarded = headerValue(req.headers["x-forwarded-uri"]);
  const incoming = req.url ?? "/";
  const incomingQuery = incoming.includes("?") ? incoming.slice(incoming.indexOf("?")) : "";
  const raw =
    forwarded.startsWith("/api")
      ? forwarded.includes("?")
        ? forwarded
        : `${forwarded}${incomingQuery}`
      : incoming;
  const qIndex = raw.indexOf("?");
  let pathname = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const query = qIndex >= 0 ? raw.slice(qIndex) : incomingQuery;
  if (pathname === "/api/index") {
    pathname = "/api";
  }
  if (pathname !== "/api" && pathname.startsWith("/api/")) {
    req.url = `${pathname}${query}`;
    return;
  }
  const parts = req.query?.path;
  const fromQuery = Array.isArray(parts) ? parts.join("/") : parts ? String(parts) : "";
  const suffix = (fromQuery || pathname.replace(/^\//, "")).replace(/^api\/?/, "");
  req.url = `/api/${suffix}`.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/api";
  if (query) {
    req.url += query;
  }
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const already = (req as IncomingMessage & { body?: unknown }).body;
  if (Buffer.isBuffer(already)) {
    return Promise.resolve(already);
  }
  if (typeof already === "string") {
    return Promise.resolve(Buffer.from(already));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function requestPath(req: VercelReq): string {
  return (req.url ?? "/").split("?")[0] || "/";
}

export default async function handler(req: VercelReq, res: ServerResponse): Promise<void> {
  withApiPrefix(req);
  if (requestPath(req) === "/api/discord/interactions" && req.method === "POST") {
    const raw = await readRawBody(req);
    await ensureStore();
    const result = await handleDiscordHttpInteraction(req.headers, raw);
    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
    await flushStore().catch((error) => {
      console.error("[api] flushStore:", error);
    });
    return;
  }
  await ensureStore();
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    res.once("finish", done);
    res.once("close", done);
    app(req, res);
  });
  await flushStore().catch((error) => {
    console.error("[api] flushStore:", error);
  });
}
