import type { IncomingMessage, ServerResponse } from "node:http";
import { createSiteApp, flushStore } from "../src/web/siteApi.js";
import { ensureStore } from "../src/scrims/store.js";

export const config = {
  maxDuration: 30,
};

const app = createSiteApp();

type VercelReq = IncomingMessage & {
  query?: { path?: string | string[] };
};

function withApiPrefix(req: VercelReq): void {
  const raw = req.url ?? "/";
  const qIndex = raw.indexOf("?");
  const pathname = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const query = qIndex >= 0 ? raw.slice(qIndex) : "";
  if (pathname === "/api" || pathname.startsWith("/api/")) {
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
