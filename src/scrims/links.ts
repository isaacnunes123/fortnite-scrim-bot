import { env } from "../env.js";

export function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL?.trim() || `http://localhost:${env.port}`).replace(
    /\/$/,
    "",
  );
}

export function dropMapUrl(scrimId: string): string {
  return `${publicBaseUrl()}/mapa/${scrimId}`;
}
