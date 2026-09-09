import type { IncomingMessage, ServerResponse } from "node:http";
import { createSiteApp, flushStore } from "../src/web/siteApi.js";
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

export default async function handler(req: VercelReq, res: ServerResponse): Promise<void> {
  withApiPrefix(req);
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
