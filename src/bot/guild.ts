import type { Client, Guild } from "discord.js";
import { env } from "../env.js";

export function getPrimaryGuild(client: Client): Guild | null {
  if (env.discordGuildId) {
    return client.guilds.cache.get(env.discordGuildId) ?? null;
  }
  return client.guilds.cache.first() ?? null;
}

export function getGuild(client: Client, guildId?: string | null): Guild | null {
  if (guildId) {
    return client.guilds.cache.get(guildId) ?? null;
  }
  return getPrimaryGuild(client);
}

export function listBotGuilds(client: Client) {
  return [...client.guilds.cache.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((guild) => ({
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount,
    }));
}

export async function resolveDiscordPlayer(
  client: Client,
  query: string,
  guildId?: string,
): Promise<{
  id: string;
  displayName: string;
}> {
  const guild = getGuild(client, guildId);
  if (!guild) {
    throw new Error("Bot offline ou sem servidor");
  }

  const cleaned = query.trim().replace(/^<@!?/, "").replace(/>$/, "");

  if (/^\d{17,20}$/.test(cleaned)) {
    const member = await guild.members.fetch(cleaned);
    return {
      id: member.id,
      displayName: member.displayName || member.user.username,
    };
  }

  const matches = await guild.members.search({ query: cleaned, limit: 5 }).catch(() => null);
  if (matches && matches.size === 1) {
    const member = matches.first()!;
    return {
      id: member.id,
      displayName: member.displayName || member.user.username,
    };
  }
  if (matches && matches.size > 1) {
    const names = [...matches.values()]
      .map((member) => `${member.displayName} (${member.id})`)
      .join(", ");
    throw new Error(`Vários players: ${names}. Use o ID do Discord.`);
  }

  throw new Error("Player não encontrado no servidor. Cole o ID do Discord.");
}

export async function notifyInvite(
  client: Client,
  input: {
    discordUserId: string;
    scrimName: string;
    teamName: string;
    mode: string;
  },
): Promise<boolean> {
  try {
    const user = await client.users.fetch(input.discordUserId);
    await user.send(
      `Você foi convocado para a scrim fechada **${input.scrimName}**.\nTime: **${input.teamName}** · modo ${input.mode}\nNo servidor, use \`/scrim\` para conferir.`,
    );
    return true;
  } catch {
    return false;
  }
}

export async function searchGuildMembers(client: Client, query: string, guildId?: string) {
  const guild = getGuild(client, guildId);
  if (!guild || query.trim().length < 2) {
    return [];
  }
  try {
    const matches = await guild.members.search({ query: query.trim(), limit: 8 });
    return [...matches.values()].map((member) => ({
      id: member.id,
      displayName: member.displayName || member.user.username,
    }));
  } catch {
    return [];
  }
}
