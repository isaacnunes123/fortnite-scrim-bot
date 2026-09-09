import type { Request } from "express";
import { env } from "../env.js";

type HostRequest = Pick<Request, "protocol" | "get">;

function stripSlash(value: string): string {
  return value.trim().replace(/\/$/, "");
}

function hostnameOf(originOrHost: string): string {
  const raw = stripSlash(originOrHost);
  if (!raw) {
    return "";
  }
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.split("/")[0]?.split(":")[0]?.toLowerCase() ?? "";
  }
}

function originFromHost(protocol: string, host: string): string {
  const proto = protocol.split(",")[0]?.trim() || "https";
  const safeHost = host.split(",")[0]?.trim() ?? "";
  return `${proto}://${safeHost}`.replace(/\/$/, "");
}

export function configuredPublicOrigins(): string[] {
  const values = [
    process.env.PUBLIC_BASE_URL,
    process.env.DISCORD_REDIRECT_URI,
    process.env.RAILWAY_PUBLIC_DOMAIN,
    process.env.RAILWAY_STATIC_URL,
  ];
  const extras = (process.env.PUBLIC_HOSTS ?? "").split(/[,;\s]+/);
  return [...values, ...extras]
    .map((item) => stripSlash(item ?? ""))
    .filter(Boolean)
    .map((item) => (item.includes("://") ? item : `https://${item}`));
}

export function publicBaseUrl(): string {
  const fromEnv = stripSlash(process.env.PUBLIC_BASE_URL ?? "");
  if (fromEnv) {
    return fromEnv;
  }
  const railway = stripSlash(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || "");
  if (railway) {
    return railway.includes("://") ? railway : `https://${railway}`;
  }
  return `http://localhost:${env.port}`;
}

export function isAllowedPublicHost(host: string): boolean {
  const hostname = hostnameOf(host);
  if (!hostname) {
    return false;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return true;
  }
  if (hostname.endsWith(".up.railway.app") || hostname.endsWith(".railway.app")) {
    return true;
  }
  if (hostname.endsWith(".vercel.app")) {
    return true;
  }
  if (hostname === "buildscrims.online" || hostname === "www.buildscrims.online") {
    return true;
  }
  return configuredPublicOrigins().some((origin) => {
    const allowed = hostnameOf(origin);
    return Boolean(allowed) && (hostname === allowed || hostname === `www.${allowed}` || `www.${hostname}` === allowed);
  });
}

export function requestOrigin(req: HostRequest): string | null {
  const proto = (req.get?.("x-forwarded-proto") || req.protocol || "https").split(",")[0]?.trim() || "https";
  const host = (req.get?.("x-forwarded-host") || req.get?.("host") || "").split(",")[0]?.trim();
  if (!host) {
    return null;
  }
  return originFromHost(proto, host);
}

export function publicOriginForRequest(req?: HostRequest): string {
  if (req) {
    const incoming = requestOrigin(req);
    if (incoming && isAllowedPublicHost(incoming)) {
      return incoming;
    }
  }
  return publicBaseUrl();
}

export function discordRedirectUri(req?: HostRequest): string {
  const explicit = stripSlash(process.env.DISCORD_REDIRECT_URI ?? "");
  if (explicit) {
    return explicit.endsWith("/api/auth/discord/callback")
      ? explicit
      : `${explicit}/api/auth/discord/callback`;
  }
  const configured = stripSlash(process.env.PUBLIC_BASE_URL ?? "");
  if (configured) {
    const origin = configured.includes("://") ? configured : `https://${configured}`;
    return `${origin}/api/auth/discord/callback`;
  }
  if (req) {
    const incoming = requestOrigin(req);
    if (incoming && isAllowedPublicHost(incoming)) {
      return `${incoming}/api/auth/discord/callback`;
    }
  }
  return `${publicBaseUrl()}/api/auth/discord/callback`;
}

export function dropMapUrl(scrimId: string): string {
  return `${publicBaseUrl()}/mapa/${scrimId}`;
}
