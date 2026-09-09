const FALLBACK_ORIGIN = "https://handsome-curiosity-production-48d3.up.railway.app";

export const config = { runtime: "edge" };

function backendOrigin() {
  const raw = String(process.env.RAILWAY_API_ORIGIN || FALLBACK_ORIGIN).trim();
  return raw.replace(/\/$/, "") || FALLBACK_ORIGIN;
}

export default async function handler(request) {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, `${backendOrigin()}/`);
  const headers = new Headers(request.headers);
  headers.set("host", target.host);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", "") || "https");
  headers.delete("connection");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  return fetch(target, init);
}
