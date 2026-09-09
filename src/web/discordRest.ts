import { env } from "../env.js";

const API = "https://discord.com/api/v10";

export type DiscordMemberInfo = {
  id: string;
  roles: string[];
  displayName: string;
  guildName: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function discordGet(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!env.discordToken) {
    return { ok: false, status: 0, body: null };
  }
  const response = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bot ${env.discordToken}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
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
