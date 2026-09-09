import { env } from "../env.js";

const API = "https://discord.com/api/v10";

export type DiscordMemberInfo = {
  id: string;
  roles: string[];
  displayName: string;
  guildName: string;
};

export type DiscordRoleInfo = {
  id: string;
  name: string;
  color: string;
};

export class DiscordRestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DiscordRestError";
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type DiscordApiResult = { ok: boolean; status: number; body: unknown };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function discordRequest(
  method: string,
  path: string,
  body?: unknown,
  attempts = 5,
): Promise<DiscordApiResult> {
  if (!env.discordToken) {
    return { ok: false, status: 0, body: null };
  }
  let last: DiscordApiResult = { ok: false, status: 0, body: null };
  for (let i = 0; i < attempts; i += 1) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${env.discordToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      const retryBody = await response.json().catch(() => null);
      const retryAfter = Number(asRecord(retryBody)?.retry_after ?? 1);
      await sleep(Math.min(Math.max(retryAfter * 1000, 250) + 50, 8_000));
      last = { ok: false, status: 429, body: retryBody };
      continue;
    }
    if (response.status === 204) {
      return { ok: true, status: 204, body: null };
    }
    const json = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body: json };
  }
  return last;
}

async function discordGet(path: string): Promise<DiscordApiResult> {
  return discordRequest("GET", path);
}

export async function fetchGuildName(): Promise<string> {
  if (!env.discordGuildId) {
    return "";
  }
  const result = await discordGet(`/guilds/${env.discordGuildId}`);
  const record = asRecord(result.body);
  return typeof record?.name === "string" ? record.name : env.discordGuildId;
}

export async function fetchGuildMember(userId: string): Promise<DiscordMemberInfo | null> {
  if (!env.discordToken || !env.discordGuildId || !userId) {
    return null;
  }
  const result = await discordGet(`/guilds/${env.discordGuildId}/members/${userId}`);
  if (!result.ok) {
    return null;
  }
  const record = asRecord(result.body);
  if (!record) {
    return null;
  }
  const user = asRecord(record.user);
  const roles = Array.isArray(record.roles) ? record.roles.map(String) : [];
  const nick = typeof record.nick === "string" ? record.nick.trim() : "";
  const globalName = typeof user?.global_name === "string" ? user.global_name.trim() : "";
  const username = typeof user?.username === "string" ? user.username.trim() : "";
  return {
    id: String(user?.id ?? userId),
    roles,
    displayName: nick || globalName || username || userId,
    guildName: await fetchGuildName(),
  };
}

function roleHexColor(color: unknown): string {
  const n = typeof color === "number" ? color : Number(color);
  if (!Number.isFinite(n) || n <= 0) {
    return "#000000";
  }
  return `#${Math.trunc(n).toString(16).padStart(6, "0")}`;
}

export function discordErrorMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const message = typeof record?.message === "string" ? record.message.trim() : "";
  return message || fallback;
}

export function discordErrorCode(body: unknown): number | null {
  const record = asRecord(body);
  const code = Number(record?.code);
  return Number.isFinite(code) ? code : null;
}

export async function fetchBotUserId(): Promise<string> {
  const result = await discordGet("/users/@me");
  const record = asRecord(result.body);
  const id = typeof record?.id === "string" ? record.id.trim() : "";
  if (!result.ok || !/^\d{17,20}$/.test(id)) {
    throw new DiscordRestError(
      "DISCORD_TOKEN rejeitado pelo Discord. Confira o token do bot na Vercel.",
      result.status === 401 ? 401 : 502,
    );
  }
  return id;
}

/** GET /guilds/{id}/roles — bot token only. Does not need Server Members Intent. */
export async function fetchGuildRoles(): Promise<DiscordRoleInfo[]> {
  if (!env.discordToken) {
    throw new DiscordRestError(
      "DISCORD_TOKEN não está na Vercel. O painel lista os cargos com o token do bot (API REST), sem precisar do gateway.",
      503,
    );
  }
  if (!env.discordGuildId) {
    throw new DiscordRestError("DISCORD_GUILD_ID não está configurado.", 503);
  }

  const result = await discordGet(`/guilds/${env.discordGuildId}/roles`);
  if (!result.ok) {
    const detail = discordErrorMessage(result.body, "");
    if (result.status === 401) {
      throw new DiscordRestError(
        "DISCORD_TOKEN rejeitado pelo Discord. Confira o token do bot na Vercel.",
        401,
      );
    }
    if (result.status === 403 || result.status === 404) {
      throw new DiscordRestError(
        `O bot não consegue ler os cargos do servidor ${env.discordGuildId}. Convide o bot para esse servidor. Não precisa ligar Server Members Intent.${detail ? ` ${detail}` : ""}`,
        result.status,
      );
    }
    throw new DiscordRestError(
      detail || `Discord REST falhou ao listar cargos (${result.status || "sem resposta"}).`,
      result.status >= 400 ? result.status : 502,
    );
  }
  if (!Array.isArray(result.body)) {
    throw new DiscordRestError("Resposta inesperada do Discord ao listar cargos.", 502);
  }

  return result.body
    .map((item) => {
      const record = asRecord(item);
      if (!record) {
        return null;
      }
      const id = String(record.id ?? "").trim();
      const name = String(record.name ?? "").trim();
      if (!/^\d{17,20}$/.test(id) || !name) {
        return null;
      }
      return {
        id,
        name,
        color: roleHexColor(record.color),
        position: Number(record.position) || 0,
        managed: Boolean(record.managed),
      };
    })
    .filter((role): role is NonNullable<typeof role> => Boolean(role))
    .filter((role) => role.id !== env.discordGuildId && !role.managed)
    .sort((a, b) => b.position - a.position)
    .map(({ id, name, color }) => ({ id, name, color }));
}
