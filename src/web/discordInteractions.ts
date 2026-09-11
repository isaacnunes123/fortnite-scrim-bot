import { createPublicKey, verify } from "node:crypto";
import { env } from "../env.js";
import { ensureSlashCommandsRegistered, executeFillSlashCommand } from "../bot/slashFill.js";
import { registerPlayer, resolveScrimFromButton, type CheckinMember } from "../scrims/checkin.js";
import {
  dropMapMessagePayload,
  fillMessagePayload,
  registrationMessagePayload,
  type DiscordMessagePayload,
} from "../scrims/lobbyPayloads.js";
import {
  addBlacklist,
  addInvite,
  flushStore,
  getActiveBan,
  getScrim,
  listInvites,
  patchInviteRole,
  patchScrim,
  pullRemoteStore,
  remainingCheckinCooldown,
  removePlayer,
  teamCount,
  type Scrim,
} from "../scrims/store.js";
import { isLeavePunishable } from "../scrims/time.js";
import { closeRegistrationIfFull, handleAdminButton, processExpiredDropDeadlines } from "./adminLobby.js";
import { discordRequest, fetchGuildMember, fetchGuildRoles, highestMemberRole } from "./discordRest.js";
import { revealFillChannelViaRest } from "./lobbyRest.js";

const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const UPDATE_MESSAGE = 7;
const EPHEMERAL = 64;

export type DiscordHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

type HeaderMap = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderMap, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function verifyDiscordSignature(
  publicKeyHex: string,
  timestamp: string,
  rawBody: Buffer,
  signatureHex: string,
): boolean {
  if (!publicKeyHex || !timestamp || !signatureHex) {
    return false;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex) || !/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKeyHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp), rawBody]),
      key,
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}

function ephemeral(content: string, extra: Record<string, unknown> = {}): DiscordHttpResult {
  return {
    status: 200,
    body: {
      type: CHANNEL_MESSAGE,
      data: {
        content,
        flags: EPHEMERAL,
        allowed_mentions: { parse: [] },
        ...extra,
      },
    },
  };
}

function updateMessage(content: string): DiscordHttpResult {
  return {
    status: 200,
    body: {
      type: UPDATE_MESSAGE,
      data: { content, components: [] },
    },
  };
}

function parseMember(body: Record<string, unknown>): CheckinMember | null {
  const member = asRecord(body.member);
  const user = asRecord(member?.user) ?? asRecord(body.user);
  const id = String(user?.id ?? "").trim();
  if (!/^\d{17,20}$/.test(id)) {
    return null;
  }
  const nick = typeof member?.nick === "string" ? member.nick.trim() : "";
  const globalName = typeof user?.global_name === "string" ? user.global_name.trim() : "";
  const username = typeof user?.username === "string" ? user.username.trim() : "";
  const roles = Array.isArray(member?.roles) ? member.roles.map(String) : [];
  return {
    id,
    displayName: nick || globalName || username || id,
    roleIds: roles,
  };
}

async function addMemberRole(guildId: string, userId: string, roleId: string): Promise<void> {
  await discordRequest("PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
}

async function takeMemberRole(guildId: string, userId: string, roleId: string): Promise<void> {
  await discordRequest("DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
}

async function editMessage(
  channelId: string,
  messageId: string,
  payload: DiscordMessagePayload,
): Promise<void> {
  await discordRequest("PATCH", `/channels/${channelId}/messages/${messageId}`, payload);
}

async function sendChannelMessage(
  channelId: string,
  payload: DiscordMessagePayload,
): Promise<string | null> {
  const result = await discordRequest("POST", `/channels/${channelId}/messages`, payload);
  const id = String(asRecord(result.body)?.id ?? "").trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

async function refreshRegistrationRest(scrim: Scrim): Promise<void> {
  const live = getScrim(scrim.id) ?? scrim;
  if (!live.discord?.registrationMessageId) {
    return;
  }
  await editMessage(
    live.discord.registrationId,
    live.discord.registrationMessageId,
    registrationMessagePayload(live),
  );
}

async function refreshDropMapRest(scrim: Scrim): Promise<void> {
  const live = getScrim(scrim.id) ?? scrim;
  if (!live.discord) {
    return;
  }
  const payload = dropMapMessagePayload(live);
  if (live.discord.dropMapMessageId) {
    await editMessage(live.discord.dropmapId, live.discord.dropMapMessageId, payload);
    return;
  }
  const id = await sendChannelMessage(live.discord.dropmapId, payload);
  if (id) {
    patchScrim(live.id, {
      discord: { ...live.discord, dropMapMessageId: id },
    });
  }
}

async function revealFillRest(scrim: Scrim): Promise<void> {
  await revealFillChannelViaRest(scrim);
  const live = getScrim(scrim.id) ?? scrim;
  if (live.discord?.fillId) {
    await sendChannelMessage(live.discord.fillId, fillMessagePayload(getScrim(live.id) ?? live)).catch(
      () => undefined,
    );
  }
}

async function applyRegisterSideEffects(scrim: Scrim, userId: string): Promise<void> {
  const live = getScrim(scrim.id) ?? scrim;
  if (live.discord) {
    await addMemberRole(live.guildId || env.discordGuildId, userId, live.discord.registeredRoleId).catch(
      () => undefined,
    );
  }
  await Promise.all([
    refreshRegistrationRest(live).catch(() => undefined),
    refreshDropMapRest(live).catch(() => undefined),
  ]);
  const updated = getScrim(live.id) ?? live;
  if (teamCount(updated.id) >= updated.maxSlots) {
    await revealFillRest(updated).catch(() => undefined);
    await closeRegistrationIfFull(updated).catch(() => undefined);
  }
  try {
    const member = await fetchGuildMember(userId, live.guildId || env.discordGuildId);
    const roles = await fetchGuildRoles();
    const highest = member ? highestMemberRole(member.roles, roles) : null;
    if (highest) {
      patchInviteRole(live.id, userId, highest);
    }
  } catch {
    /* cargo é opcional no check-in */
  }
}

async function applyLeaveSideEffects(scrim: Scrim, userId: string): Promise<void> {
  const live = getScrim(scrim.id) ?? scrim;
  if (live.discord) {
    const guildId = live.guildId || env.discordGuildId;
    await takeMemberRole(guildId, userId, live.discord.registeredRoleId).catch(() => undefined);
    await takeMemberRole(guildId, userId, live.discord.confirmedRoleId).catch(() => undefined);
  }
  await Promise.all([
    refreshRegistrationRest(live).catch(() => undefined),
    refreshDropMapRest(live).catch(() => undefined),
  ]);
}

async function notifyAdmin(scrim: Scrim, content: string): Promise<void> {
  if (!scrim.discord?.adminId) {
    return;
  }
  await sendChannelMessage(scrim.discord.adminId, { content }).catch(() => undefined);
}

async function handleRegister(
  scrimId: string,
  guildId: string,
  channelId: string,
  member: CheckinMember | null,
): Promise<DiscordHttpResult> {
  const scrim = resolveScrimFromButton(scrimId, guildId, channelId);
  const result = registerPlayer(scrim, member);
  if (!result.ok) {
    return ephemeral(result.content);
  }
  if (!result.already) {
    await applyRegisterSideEffects(result.scrim, member!.id);
  }
  return ephemeral(result.content);
}

async function handleLeave(
  scrimId: string,
  guildId: string,
  channelId: string,
  member: CheckinMember | null,
): Promise<DiscordHttpResult> {
  const scrim = resolveScrimFromButton(scrimId, guildId, channelId);
  if (!scrim || !member) {
    return ephemeral("Scrim indisponível.");
  }
  const existing = listInvites(scrim.id).find((invite) => invite.discordUserId === member.id);
  if (!existing) {
    return ephemeral("Você não está nesta scrim.");
  }
  if (!isLeavePunishable(scrim)) {
    return completeLeave(scrim, member, existing.fortniteNick || member.displayName, false, false);
  }
  return ephemeral(
    `O horário livre de saída (**${scrim.leaveUntil}**) já passou.\nSe confirmar, você entra na **blacklist da closed** por **${scrim.punishHours}h** (ID + nick **${existing.fortniteNick || member.displayName}**) e não poderá fazer check-in até acabar a punição.`,
    {
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              custom_id: `leaveyes:${scrim.id}`,
              label: "Confirmar saída e aceitar punição",
            },
            {
              type: 2,
              style: 2,
              custom_id: `leaveno:${scrim.id}`,
              label: "Cancelar",
            },
          ],
        },
      ],
    },
  );
}

async function completeLeave(
  scrim: Scrim,
  member: CheckinMember,
  fortniteNick: string,
  punish: boolean,
  asUpdate: boolean,
): Promise<DiscordHttpResult> {
  removePlayer(scrim.id, member.id);
  await applyLeaveSideEffects(scrim, member.id);
  const wait = remainingCheckinCooldown(member.id);
  const reply = asUpdate ? updateMessage : ephemeral;
  if (punish) {
    const entry = addBlacklist({
      discordUserId: member.id,
      displayName: member.displayName,
      fortniteNick,
      reason: "Saída após o horário definido pela staff",
      hours: scrim.punishHours,
      scrimId: scrim.id,
    });
    const until = new Date(entry.expiresAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    await notifyAdmin(
      scrim,
      `⛔ Blacklist: <@${member.id}> · Fortnite **${entry.fortniteNick}** até ${until}`,
    );
    return reply(`Saída confirmada. Seu drop foi liberado. Você está na blacklist da closed até **${until}**.`);
  }
  return reply(
    `Você saiu da scrim dentro do horário (${scrim.leaveUntil}). Sem punição. Drop liberado. Espere **${wait || 90}s** para fazer check-in de novo.`,
  );
}

async function handleLeaveYes(
  scrimId: string,
  guildId: string,
  channelId: string,
  member: CheckinMember | null,
): Promise<DiscordHttpResult> {
  const scrim = resolveScrimFromButton(scrimId, guildId, channelId);
  if (!scrim || !member) {
    return updateMessage("Scrim indisponível.");
  }
  const existing = listInvites(scrim.id).find((invite) => invite.discordUserId === member.id);
  if (!existing) {
    return updateMessage("Você não está nesta scrim.");
  }
  return completeLeave(scrim, member, existing.fortniteNick || member.displayName, true, true);
}

async function handleFill(
  scrimId: string,
  guildId: string,
  channelId: string,
  member: CheckinMember | null,
): Promise<DiscordHttpResult> {
  const scrim = resolveScrimFromButton(scrimId, guildId, channelId);
  if (!scrim?.discord || !member) {
    return ephemeral("Scrim indisponível.");
  }
  const ban = getActiveBan(member.id);
  if (ban) {
    const until = new Date(ban.expiresAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    return ephemeral(`Você está na blacklist da closed até **${until}**. Não pode pedir fill.`);
  }
  if (!scrim.discord.fillChatOpen) {
    return ephemeral("Ainda bloqueado. Espere um staff liberar os pedidos.");
  }
  if (!scrim.accessRoleIds.some((id) => member.roleIds.includes(id))) {
    return ephemeral("Só quem tem cargo da divisão pode pedir vaga.");
  }
  await sendChannelMessage(scrim.discord.adminId, {
    embeds: [
      {
        color: 0xf5c542,
        title: "Pedido de segunda chance",
        description: `<@${member.id}> pediu vaga em **${scrim.name}**.`,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            custom_id: `fillyes:${scrim.id}:${member.id}`,
            label: "Adicionar",
          },
          {
            type: 2,
            style: 4,
            custom_id: `fillno:${scrim.id}:${member.id}`,
            label: "Recusar",
          },
        ],
      },
    ],
  });
  return ephemeral("Pedido enviado aos staffs.");
}

async function handleFillDecision(
  scrimId: string,
  guildId: string,
  channelId: string,
  userId: string,
  accept: boolean,
): Promise<DiscordHttpResult> {
  const scrim = resolveScrimFromButton(scrimId, guildId, channelId);
  if (!scrim?.discord) {
    return ephemeral("Scrim indisponível.");
  }
  if (!accept) {
    return ephemeral("Pedido recusado.");
  }
  const fetched = await fetchGuildMember(userId);
  if (!fetched) {
    return ephemeral("Player não está no servidor.");
  }
  if (getActiveBan(fetched.id)) {
    return ephemeral("Esse player está na blacklist da closed. Check-in bloqueado.");
  }
  try {
    const invite = addInvite({
      scrimId: scrim.id,
      discordUserId: fetched.id,
      displayName: fetched.displayName,
      teamName: fetched.displayName.slice(0, 32),
      fortniteNick: fetched.displayName,
      ignoreCooldown: true,
    });
    await applyRegisterSideEffects(scrim, fetched.id);
    return ephemeral(`Adicionado: **${invite.teamName}**.`);
  } catch (error) {
    return ephemeral(error instanceof Error ? error.message : "Falha ao adicionar");
  }
}

async function dispatchButton(
  customId: string,
  guildId: string,
  channelId: string,
  member: CheckinMember | null,
): Promise<DiscordHttpResult> {
  const [action, scrimId, extra] = customId.split(":");
  if (!scrimId) {
    return ephemeral("Scrim indisponível.");
  }
  if (action === "reg") {
    return handleRegister(scrimId, guildId, channelId, member);
  }
  if (action === "leave") {
    return handleLeave(scrimId, guildId, channelId, member);
  }
  if (action === "leaveyes") {
    return handleLeaveYes(scrimId, guildId, channelId, member);
  }
  if (action === "leaveno") {
    return ephemeral("Saída cancelada.");
  }
  if (action === "fill") {
    return handleFill(scrimId, guildId, channelId, member);
  }
  if (action === "fillyes" && extra) {
    return handleFillDecision(scrimId, guildId, channelId, extra, true);
  }
  if (action === "fillno" && extra) {
    return handleFillDecision(scrimId, guildId, channelId, extra, false);
  }
  if (
    action === "nagdrop" ||
    action === "nagcode" ||
    action === "lockchat" ||
    action === "finish" ||
    action === "finishyes" ||
    action === "finishno" ||
    action === "kill" ||
    action === "killyes" ||
    action === "killno"
  ) {
    const scrim = resolveScrimFromButton(scrimId, guildId, channelId);
    if (!scrim) {
      return ephemeral("Scrim indisponível.");
    }
    const result = await handleAdminButton(action, scrim, member);
    if (result.extra?.components) {
      return ephemeral(result.content, { components: result.extra.components as never });
    }
    return ephemeral(result.content);
  }
  return ephemeral("Ação desconhecida.");
}

export async function handleDiscordHttpInteraction(
  headers: HeaderMap,
  rawBody: Buffer,
): Promise<DiscordHttpResult> {
  const signature = headerValue(headers, "x-signature-ed25519");
  const timestamp = headerValue(headers, "x-signature-timestamp");
  if (!env.discordPublicKey) {
    return { status: 401, body: { error: "DISCORD_PUBLIC_KEY não configurada na Vercel." } };
  }
  if (!verifyDiscordSignature(env.discordPublicKey, timestamp, rawBody, signature)) {
    return { status: 401, body: { error: "invalid request signature" } };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }

  const type = Number(parsed.type);
  if (type === PING) {
    void ensureSlashCommandsRegistered().then((result) => {
      if (result.ok) {
        console.log(`[discord-interactions] ${result.detail}`);
      } else {
        console.warn(`[discord-interactions] ${result.detail}`);
      }
    });
    return { status: 200, body: { type: PONG } };
  }

  await pullRemoteStore();
  await processExpiredDropDeadlines().catch(() => undefined);

  if (type === APPLICATION_COMMAND) {
    const data = asRecord(parsed.data);
    const channel = asRecord(parsed.channel);
    const commandName = String(data?.name ?? "");
    const guildId = String(parsed.guild_id ?? env.discordGuildId);
    const channelId = String(parsed.channel_id ?? channel?.id ?? "");
    const parentId = typeof channel?.parent_id === "string" ? channel.parent_id : null;
    const member = parseMember(parsed);
    let result: DiscordHttpResult;
    try {
      const content = await executeFillSlashCommand({
        commandName,
        guildId,
        channelId,
        parentId,
        member,
      });
      result = ephemeral(content);
    } catch (error) {
      result = ephemeral(
        error instanceof Error ? error.message : "Não foi possível alterar o fill.",
      );
    }
    await flushStore().catch((error) => {
      console.error("[discord-interactions] flushStore:", error);
    });
    return result;
  }

  if (type === MESSAGE_COMPONENT) {
    const data = asRecord(parsed.data);
    const customId = String(data?.custom_id ?? "");
    const guildId = String(parsed.guild_id ?? env.discordGuildId);
    const channelId = String(parsed.channel_id ?? "");
    const member = parseMember(parsed);
    const result = await dispatchButton(customId, guildId, channelId, member);
    await flushStore().catch((error) => {
      console.error("[discord-interactions] flushStore:", error);
    });
    return result;
  }

  return ephemeral("Este tipo de interação ainda não é suportado.");
}
