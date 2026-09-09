import type { Client, Guild } from "discord.js";
import { env } from "../env.js";

export function isHomeGuild(guildId: string | null | undefined): boolean {
  return Boolean(guildId && guildId === env.discordGuildId);
}

export function getPrimaryGuild(client: Client): Guild | null {
  return client.guilds.cache.get(env.discordGuildId) ?? null;
}

export function getGuild(client: Client, guildId?: string | null): Guild | null {
  if (guildId && !isHomeGuild(guildId)) {
    return null;
  }
  return getPrimaryGuild(client);
}

export function listBotGuilds(client: Client) {
  const home = getPrimaryGuild(client);
  if (!home) {
    return [];
  }
  return [{ id: home.id, name: home.name, memberCount: home.memberCount }];
}

export async function enforceHomeGuild(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    if (guild.id === env.discordGuildId) {
      continue;
    }
    console.warn(`[bot] Saindo de ${guild.name} (${guild.id}) — o bot só opera em ${env.discordGuildId}`);
    await guild.leave().catch((error) => {
      console.error(`[bot] Não consegui sair de ${guild.id}:`, error);
    });
  }
  if (!client.guilds.cache.has(env.discordGuildId)) {
    console.error(
      `[bot] O bot não está no servidor ${env.discordGuildId}. Convide-o só para esse servidor.`,
    );
  }
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
    throw new Error("Bot Discord offline ou sem servidor");
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
      `Você foi convocado para a scrim fechada **${input.scrimName}**.\nTime: **${input.teamName}** · modo ${input.mode}`,
    );
    return true;
  } catch {
    return false;
  }
}

export async function rosterForScrim(
  client: Client,
  guildId: string,
  invites: Array<{
    id: string;
    scrimId: string;
    discordUserId: string;
    displayName: string;
    teamName: string;
    createdAt: string;
    dropped: boolean;
    fortniteNick: string;
  }>,
) {
  const guild = getGuild(client, guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  return Promise.all(
    invites.map(async (invite) => {
      const member = guild
        ? await guild.members.fetch({ user: invite.discordUserId, force: true }).catch(() => null)
        : null;
      const highest = member?.roles.cache
        .filter((role) => role.id !== guild?.id)
        .sort((a, b) => b.position - a.position)
        .first();
      const roles = member
        ? [...member.roles.cache.values()]
            .filter((role) => role.id !== guild?.id)
            .sort((a, b) => b.position - a.position)
            .slice(0, 8)
            .map((role) => ({ name: role.name, color: role.hexColor }))
        : [];
      return {
        ...invite,
        username: member?.user.username ?? invite.displayName,
        globalName: member?.user.globalName ?? "",
        avatarUrl: member?.displayAvatarURL({ size: 128, extension: "png" }) ?? "",
        highestRoleName: highest?.name ?? "—",
        highestRoleColor: highest && highest.color ? highest.hexColor : "#6b7280",
        roles,
        inServer: Boolean(member),
        boosted: Boolean(member?.premiumSince),
        joinedAt: member?.joinedAt?.toISOString() ?? null,
      };
    }),
  );
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
