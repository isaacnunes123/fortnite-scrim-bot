import { env } from "../env.js";
import { publicBaseUrl } from "./links.js";
import {
  addInvite,
  adoptScrim,
  findScrimForChannel,
  getActiveBan,
  getScrim,
  listInvites,
  pullRemoteStore,
  remainingCheckinCooldown,
  teamCount,
  type Scrim,
} from "./store.js";
import { canRegisterNow } from "./time.js";
export type CheckinMember = {
  id: string;
  displayName: string;
  roleIds: string[];
};

export function resolveScrimFromButton(
  scrimId: string,
  guildId?: string,
  channelId?: string,
  parentId?: string | null,
): Scrim | null {
  const id = String(scrimId ?? "").trim();
  if (id) {
    const direct = getScrim(id);
    if (direct) {
      return direct;
    }
    if (guildId && /^\d{17,20}$/.test(id)) {
      const byCustomId = findScrimForChannel(guildId, id);
      if (byCustomId) {
        return byCustomId;
      }
    }
  }
  if (guildId && channelId) {
    return findScrimForChannel(guildId, channelId, parentId);
  }
  return null;
}

async function fetchScrimFromSite(
  scrimId: string,
  channelId?: string,
  parentId?: string | null,
): Promise<Scrim | null> {
  const base = publicBaseUrl().replace(/\/$/, "");
  if (!base || base.includes("localhost") || base.includes("railway.app")) {
    return null;
  }
  const params = new URLSearchParams();
  if (channelId) {
    params.set("channelId", channelId);
  }
  if (parentId) {
    params.set("parentId", parentId);
  }
  const query = params.toString();
  const url = `${base}/api/internal/scrims/${encodeURIComponent(scrimId || "unknown")}${query ? `?${query}` : ""}`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${env.sessionSecret}` },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { scrim?: Scrim };
    return body.scrim ? adoptScrim(body.scrim) : null;
  } catch (error) {
    console.error("[checkin] fetchScrimFromSite:", error);
    return null;
  }
}

export async function resolveScrimFromButtonLive(
  scrimId: string,
  guildId?: string,
  channelId?: string,
  parentId?: string | null,
): Promise<Scrim | null> {
  await pullRemoteStore();
  const local = resolveScrimFromButton(scrimId, guildId, channelId, parentId);
  if (local) {
    return local;
  }
  return fetchScrimFromSite(scrimId, channelId, parentId);
}

export function playerTeamName(scrimId: string, displayName: string, userId: string): string {
  const base = (displayName || userId).slice(0, 32);
  const taken = listInvites(scrimId).some(
    (invite) => invite.teamName === base && invite.discordUserId !== userId,
  );
  if (!taken) {
    return base;
  }
  return `${base.slice(0, 27)}-${userId.slice(-4)}`;
}

export type RegisterOutcome =
  | { ok: false; content: string }
  | { ok: true; already: boolean; content: string; scrim: Scrim };

function alreadyMessage(scrim: Scrim): string {
  const dropmapMention = scrim.discord ? `<#${scrim.discord.dropmapId}>` : "canal de drop map";
  const chatMention = scrim.discord ? `<#${scrim.discord.chatId}>` : "chat";
  return `Você já está registrado.\nAbra ${dropmapMention} e marque o drop no mapa.\nChat: ${chatMention}.\nCódigo e getting-off só depois de marcar.`;
}

function successMessage(scrim: Scrim, displayName: string): string {
  const dropmapMention = scrim.discord ? `<#${scrim.discord.dropmapId}>` : "canal de drop map";
  const chatMention = scrim.discord ? `<#${scrim.discord.chatId}>` : "chat";
  return [
    `Check-in feito na **${scrim.name}**.`,
    `Nick (Fortnite / apelido): **${displayName}**`,
    "",
    `Agora você vê ${chatMention} e ${dropmapMention}.`,
    "Abra o **mesmo link** da embed do dropmap, entre com este Discord e **marque o drop**.",
    "Canais de **código** e **getting-off** só liberam depois do drop no mapa.",
  ].join("\n");
}

export function registerPlayer(scrim: Scrim | null, member: CheckinMember | null): RegisterOutcome {
  if (!scrim || !member) {
    return { ok: false, content: "Scrim indisponível." };
  }
  const ban = getActiveBan(member.id);
  if (ban) {
    const until = new Date(ban.expiresAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    return {
      ok: false,
      content: `Você está na blacklist da closed até **${until}** (nick **${ban.fortniteNick}**). Check-in bloqueado.`,
    };
  }
  const wait = remainingCheckinCooldown(member.id);
  if (wait > 0) {
    return {
      ok: false,
      content: `Você saiu há pouco. Espere **${wait}s** para fazer check-in de novo (evita saída sem querer).`,
    };
  }
  const already = listInvites(scrim.id).find((invite) => invite.discordUserId === member.id);
  if (already) {
    return { ok: true, already: true, content: alreadyMessage(scrim), scrim };
  }
  const gate = canRegisterNow(member.roleIds, scrim);
  if (!gate.ok) {
    return { ok: false, content: gate.reason };
  }
  if (teamCount(scrim.id) >= scrim.maxSlots) {
    return {
      ok: false,
      content: "Lista cheia. Use o canal de segunda chance quando o staff liberar.",
    };
  }
  try {
    addInvite({
      scrimId: scrim.id,
      discordUserId: member.id,
      displayName: member.displayName,
      teamName: playerTeamName(scrim.id, member.displayName, member.id),
      fortniteNick: member.displayName,
    });
    return { ok: true, already: false, content: successMessage(scrim, member.displayName), scrim };
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : "Não foi possível registrar",
    };
  }
}
