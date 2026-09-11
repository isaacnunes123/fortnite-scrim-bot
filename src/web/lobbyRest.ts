import { env } from "../env.js";
import {
  dropMapMessagePayload,
  embedPayload,
  fillMessagePayload,
  leaveMessagePayload,
  registrationMessagePayload,
  scrimEmbedVars,
} from "../scrims/lobbyPayloads.js";
import { getScrim, patchScrim, type Scrim } from "../scrims/store.js";
import { discordRequest, fetchBotUserId, fetchGuildMember, takeMemberRole } from "./discordRest.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageIdOf(body: unknown): string | null {
  const id = String(asRecord(body)?.id ?? "").trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

function messageHasCustomId(message: unknown, customId: string): boolean {
  const record = asRecord(message);
  const rows = Array.isArray(record?.components) ? record.components : [];
  for (const row of rows) {
    const buttons = asRecord(row)?.components;
    if (!Array.isArray(buttons)) {
      continue;
    }
    for (const button of buttons) {
      if (String(asRecord(button)?.custom_id ?? "") === customId) {
        return true;
      }
    }
  }
  return false;
}

async function listChannelMessages(channelId: string, limit = 20): Promise<unknown[]> {
  const result = await discordRequest("GET", `/channels/${channelId}/messages?limit=${limit}`);
  return result.ok && Array.isArray(result.body) ? result.body : [];
}

async function editChannelMessage(
  channelId: string,
  messageId: string,
  payload: unknown,
): Promise<boolean> {
  const result = await discordRequest(
    "PATCH",
    `/channels/${channelId}/messages/${messageId}`,
    payload,
  );
  return result.ok;
}

async function sendChannelMessage(channelId: string, payload: unknown): Promise<string | null> {
  const result = await discordRequest("POST", `/channels/${channelId}/messages`, payload);
  return messageIdOf(result.body);
}

export async function postMatchCodeViaRest(scrim: Scrim): Promise<void> {
  if (!scrim.discord || !scrim.matchCode) {
    return;
  }
  await sendChannelMessage(scrim.discord.codeId, {
    embeds: [embedPayload(scrim.embeds.code, scrimEmbedVars(scrim), 0xc8f542)],
  });
}

export async function refreshLeaveMessageViaRest(scrimId: string): Promise<void> {
  const scrim = getScrim(scrimId);
  if (!scrim?.discord) {
    return;
  }
  const payload = leaveMessagePayload(scrim);
  let messageId = scrim.discord.leaveMessageId;
  if (!messageId) {
    const recent = await listChannelMessages(scrim.discord.leaveId, 20);
    const found = recent.find((item) => messageHasCustomId(item, `leave:${scrim.id}`));
    messageId = messageIdOf(found);
  }
  if (messageId && (await editChannelMessage(scrim.discord.leaveId, messageId, payload))) {
    if (!scrim.discord.leaveMessageId) {
      patchScrim(scrim.id, {
        discord: { ...scrim.discord, leaveMessageId: messageId },
      });
    }
    return;
  }
  const sent = await sendChannelMessage(scrim.discord.leaveId, payload);
  if (sent) {
    patchScrim(scrim.id, {
      discord: { ...scrim.discord, leaveMessageId: sent },
    });
  }
}

export async function refreshRegistrationMessageViaRest(scrimId: string): Promise<void> {
  const scrim = getScrim(scrimId);
  if (!scrim?.discord?.registrationMessageId) {
    return;
  }
  await editChannelMessage(
    scrim.discord.registrationId,
    scrim.discord.registrationMessageId,
    registrationMessagePayload(scrim),
  );
}

export async function ensureDropMapEmbedViaRest(scrim: Scrim): Promise<Scrim> {
  if (!scrim.discord) {
    return scrim;
  }
  const live = getScrim(scrim.id) ?? scrim;
  if (!live.discord) {
    return live;
  }
  const payload = dropMapMessagePayload(live);
  if (live.discord.dropMapMessageId) {
    const edited = await editChannelMessage(
      live.discord.dropmapId,
      live.discord.dropMapMessageId,
      payload,
    );
    if (edited) {
      return getScrim(live.id) ?? live;
    }
  }
  const sent = await sendChannelMessage(live.discord.dropmapId, payload);
  if (!sent) {
    return getScrim(live.id) ?? live;
  }
  return patchScrim(live.id, {
    discord: { ...live.discord, dropMapMessageId: sent },
  });
}

export async function setDropMarkingOpenViaRest(scrim: Scrim, open: boolean): Promise<Scrim> {
  const updated = patchScrim(scrim.id, { dropsOpen: open });
  return ensureDropMapEmbedViaRest(updated);
}

const VIEW = 1n << 10n;
const SEND = 1n << 11n;

export async function revealFillChannelViaRest(scrim: Scrim): Promise<void> {
  const live = getScrim(scrim.id) ?? scrim;
  if (!live.discord || live.discord.fillVisible) {
    return;
  }
  for (const roleId of live.accessRoleIds) {
    await discordRequest("PUT", `/channels/${live.discord.fillId}/permissions/${roleId}`, {
      type: 0,
      allow: VIEW.toString(),
      deny: SEND.toString(),
    });
  }
  patchScrim(live.id, {
    discord: { ...live.discord, fillVisible: true },
  });
}

export async function setFillChatOpenViaRest(scrim: Scrim, open: boolean): Promise<void> {
  if (!scrim.discord) {
    return;
  }
  const payload = fillMessagePayload(scrim, open);
  const messages = await listChannelMessages(scrim.discord.fillId, 10);
  let botId = "";
  try {
    botId = await fetchBotUserId();
  } catch {
    botId = "";
  }
  const found =
    messages.find((item) => messageHasCustomId(item, `fill:${scrim.id}`)) ??
    messages.find((item) => String(asRecord(asRecord(item)?.author)?.id ?? "") === botId);
  const messageId = messageIdOf(found);
  if (messageId) {
    await editChannelMessage(scrim.discord.fillId, messageId, payload);
  } else {
    await sendChannelMessage(scrim.discord.fillId, payload);
  }
  const live = getScrim(scrim.id) ?? scrim;
  if (!live.discord) {
    return;
  }
  patchScrim(live.id, {
    discord: { ...live.discord, fillChatOpen: open },
  });
}

export async function removePlayerFromLobbyViaRest(scrim: Scrim, userId: string): Promise<void> {
  const live = getScrim(scrim.id) ?? scrim;
  if (live.discord) {
    const guildId = live.guildId || env.discordGuildId;
    await takeMemberRole(guildId, userId, live.discord.registeredRoleId).catch(() => undefined);
    await takeMemberRole(guildId, userId, live.discord.confirmedRoleId).catch(() => undefined);
  }
  await Promise.all([
    refreshRegistrationMessageViaRest(live.id).catch(() => undefined),
    ensureDropMapEmbedViaRest(live).catch(() => undefined),
  ]);
}

export async function resolveDiscordPlayerViaRest(
  query: string,
  guildId = env.discordGuildId,
): Promise<{ id: string; displayName: string }> {
  const cleaned = query.trim().replace(/^<@!?/, "").replace(/>$/, "");
  if (!cleaned) {
    throw new Error("Informe o ID do Discord, @ ou nick no servidor");
  }
  if (/^\d{17,20}$/.test(cleaned)) {
    const member = await fetchGuildMember(cleaned, guildId);
    if (member) {
      return { id: member.id, displayName: member.displayName };
    }
    throw new Error("Player não encontrado no servidor. Cole o ID do Discord.");
  }
  if (!guildId) {
    throw new Error("Player não encontrado no servidor. Cole o ID do Discord.");
  }
  const result = await discordRequest(
    "GET",
    `/guilds/${guildId}/members/search?query=${encodeURIComponent(cleaned)}&limit=5`,
  );
  const rows = result.ok && Array.isArray(result.body) ? result.body : [];
  const matches = rows
    .map((item) => {
      const record = asRecord(item);
      const user = asRecord(record?.user);
      const id = String(user?.id ?? "").trim();
      if (!/^\d{17,20}$/.test(id)) {
        return null;
      }
      const nick = typeof record?.nick === "string" ? record.nick.trim() : "";
      const globalName = typeof user?.global_name === "string" ? user.global_name.trim() : "";
      const username = typeof user?.username === "string" ? user.username.trim() : "";
      return { id, displayName: nick || globalName || username || id };
    })
    .filter((item): item is { id: string; displayName: string } => Boolean(item));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    const names = matches.map((item) => `${item.displayName} (${item.id})`).join(", ");
    throw new Error(`Vários players: ${names}. Use o ID do Discord.`);
  }
  throw new Error("Player não encontrado no servidor. Cole o ID do Discord.");
}

export async function notifyInviteViaRest(input: {
  discordUserId: string;
  scrimName: string;
  teamName: string;
  mode: string;
}): Promise<boolean> {
  const dm = await discordRequest("POST", "/users/@me/channels", {
    recipient_id: input.discordUserId,
  });
  const channelId = String(asRecord(dm.body)?.id ?? "").trim();
  if (!/^\d{17,20}$/.test(channelId)) {
    return false;
  }
  const sent = await discordRequest("POST", `/channels/${channelId}/messages`, {
    content: `Você foi convocado para a scrim fechada **${input.scrimName}**.\nTime: **${input.teamName}** · modo ${input.mode}`,
  });
  return sent.ok;
}
