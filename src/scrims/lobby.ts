import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type OverwriteResolvable,
  type TextChannel,
} from "discord.js";
import { getGuild } from "../bot/guild.js";
import { dropMapUrl } from "./links.js";
import {
  addLog,
  claimDrop,
  flushStore,
  getScrim,
  listInvites,
  markDropped,
  patchScrim,
  type Scrim,
} from "./store.js";
import {
  dropMapMessagePayload,
  embedPayload,
  leaveMessagePayload,
  registrationMessagePayload,
  registrationWindowLines,
  scrimEmbedVars,
  type DiscordEmbedPayload,
} from "./lobbyPayloads.js";
import {
  DiscordProvisionError,
  explainDiscordError,
  provisionLobbyViaRest,
} from "./provisionRest.js";
import { clockMinutes, parseBrasiliaDateTime, parseClock } from "./time.js";

export { DiscordProvisionError, explainDiscordError };

export async function assertBotCanProvision(guild: Guild, client: Client): Promise<void> {
  const me = guild.members.me ?? (await guild.members.fetch(client.user!.id));
  const missing: string[] = [];
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    missing.push("Gerenciar Canais");
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    missing.push("Gerenciar Cargos");
  }
  if (missing.length > 0) {
    throw new DiscordProvisionError(
      `O bot precisa das permissões ${missing.join(" e ")} neste servidor para criar a categoria (check-in, mapa, código, chat, saída, fill e admin). Abra Configurações do servidor → Cargos → cargo do bot e marque essas permissões. O cargo do bot deve ficar acima dos cargos da divisão.`,
    );
  }
}

const provisioningIds = new Set<string>();

export function beginLobbyProvision(client: Client, scrim: Scrim): void {
  if (provisioningIds.has(scrim.id)) {
    return;
  }
  provisioningIds.add(scrim.id);
  void (async () => {
    try {
      const ready = await provisionLobby(client, scrim);
      patchScrim(ready.id, { provisionStatus: "ready", provisionError: null });
      addLog({
        scrimId: ready.id,
        kind: "scrim",
        summary: "Categoria criada no Discord",
        detail: ready.discord ? `lobby ${ready.discord.lobbyNumber}` : ready.name,
      });
      await flushStore();
    } catch (error) {
      const message = explainDiscordError(error);
      console.error("[lobby] provision:", error);
      const live = getScrim(scrim.id);
      if (live?.discord) {
        await teardownLobby(client, live).catch(() => undefined);
      }
      patchScrim(scrim.id, {
        discord: null,
        provisionStatus: "failed",
        provisionError: message,
      });
      addLog({
        scrimId: scrim.id,
        kind: "scrim",
        summary: "Falha ao criar canais no Discord",
        detail: message,
      });
      await flushStore().catch((flushError) => {
        console.error("[lobby] flush após falha:", flushError);
      });
    } finally {
      provisioningIds.delete(scrim.id);
    }
  })();
}

function everyoneDeny(guild: Guild): OverwriteResolvable {
  return {
    id: guild.roles.everyone.id,
    deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
  };
}

function botAllow(guild: Guild, client: Client): OverwriteResolvable {
  return {
    id: client.user!.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.EmbedLinks,
    ],
  };
}

function roleView(roleId: string, send: boolean): OverwriteResolvable {
  return {
    id: roleId,
    allow: send
      ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
      : [PermissionFlagsBits.ViewChannel],
    deny: send ? [] : [PermissionFlagsBits.SendMessages],
  };
}

function embedFromPayload(payload: DiscordEmbedPayload) {
  const embed = new EmbedBuilder()
    .setColor(payload.color)
    .setTitle(payload.title)
    .setDescription(payload.description);
  if (payload.footer?.text) {
    embed.setFooter({ text: payload.footer.text });
  }
  if (payload.url) {
    embed.setURL(payload.url);
  }
  return embed;
}

export function registrationEmbed(scrim: Scrim, _guild?: Guild) {
  const payload = registrationMessagePayload(scrim).embeds?.[0];
  if (payload) {
    return embedFromPayload(payload);
  }
  return embedFromPayload(
    embedPayload(
      scrim.embeds.registration,
      scrimEmbedVars(scrim, { windows: registrationWindowLines(scrim) }),
      0x3ee0a2,
    ),
  );
}

export function registrationRow(scrimId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`reg:${scrimId}`)
      .setLabel("Registrar")
      .setStyle(ButtonStyle.Primary),
  );
}

export function leaveEmbed(scrim: Scrim) {
  const payload = leaveMessagePayload(scrim).embeds?.[0];
  return payload
    ? embedFromPayload(payload)
    : embedFromPayload(embedPayload(scrim.embeds.leave, scrimEmbedVars(scrim), 0xff5c5c));
}

export function leaveRow(scrimId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`leave:${scrimId}`)
      .setLabel("Sair da scrim")
      .setStyle(ButtonStyle.Danger),
  );
}

export async function refreshLeaveMessage(client: Client, scrimId: string) {
  const scrim = getScrim(scrimId);
  if (!scrim?.discord) {
    return;
  }
  const channel = await client.channels.fetch(scrim.discord.leaveId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    return;
  }
  const payload = {
    embeds: [leaveEmbed(scrim)],
    components: [leaveRow(scrim.id)],
  };
  let messageId = scrim.discord.leaveMessageId;
  if (!messageId) {
    const recent = await channel.messages.fetch({ limit: 20 });
    const found = recent.find((item) => item.resolveComponent(`leave:${scrim.id}`));
    messageId = found?.id ?? null;
  }
  if (messageId) {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) {
      await message.edit(payload);
      if (!scrim.discord.leaveMessageId) {
        patchScrim(scrim.id, {
          discord: { ...scrim.discord, leaveMessageId: message.id },
        });
      }
      return;
    }
  }
  const sent = await channel.send(payload);
  patchScrim(scrim.id, {
    discord: { ...scrim.discord, leaveMessageId: sent.id },
  });
}

export async function refreshRegistrationMessage(client: Client, scrimId: string) {
  const scrim = getScrim(scrimId);
  if (!scrim?.discord?.registrationMessageId) {
    return;
  }
  const channel = await client.channels.fetch(scrim.discord.registrationId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    return;
  }
  const guild = channel.guild;
  const message = await channel.messages.fetch(scrim.discord.registrationMessageId);
  await message.edit({
    embeds: [registrationEmbed(scrim, guild)],
    components: [registrationRow(scrim.id)],
  });
}

export async function provisionLobby(client: Client, scrim: Scrim): Promise<Scrim> {
  const ready = await provisionLobbyViaRest(scrim);
  schedulePriorityPings(client, ready);
  return ready;
}

function dropMapPayload(scrim: Scrim) {
  const payload = dropMapMessagePayload(scrim);
  const url = payload.embeds?.[0]?.url || dropMapUrl(scrim.id);
  const embed = payload.embeds?.[0]
    ? embedFromPayload(payload.embeds[0])
    : new EmbedBuilder().setColor(0x3b82f6).setTitle("Mapa");
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel(scrim.dropsOpen !== false ? "Abrir mapa e marcar drop" : "Ver mapa ao vivo")
          .setStyle(ButtonStyle.Link)
          .setURL(url),
      ),
    ],
  };
}

export async function ensureDropMapEmbed(client: Client, scrim: Scrim): Promise<Scrim> {
  if (!scrim.discord) {
    return scrim;
  }
  const channel = await client.channels.fetch(scrim.discord.dropmapId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    return scrim;
  }
  const payload = dropMapPayload(scrim);
  let messageId = scrim.discord.dropMapMessageId;
  if (messageId) {
    const existing = await channel.messages.fetch(messageId).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return getScrim(scrim.id) ?? scrim;
    }
  }
  const sent = await channel.send(payload);
  return patchScrim(scrim.id, {
    discord: { ...scrim.discord, dropMapMessageId: sent.id },
  });
}

export async function setDropMarkingOpen(
  client: Client,
  scrim: Scrim,
  open: boolean,
): Promise<Scrim> {
  const updated = patchScrim(scrim.id, { dropsOpen: open });
  return ensureDropMapEmbed(client, updated);
}

export async function syncLobbyAccess(client: Client, scrim: Scrim): Promise<void> {
  if (!scrim.discord) {
    return;
  }
  const guild = getGuild(client, scrim.guildId);
  if (!guild) {
    return;
  }
  const staffOverwrites = scrim.staffRoleIds.map((roleId) => roleView(roleId, true));
  const registered = roleView(scrim.discord.registeredRoleId, false);
  const registeredChat = roleView(scrim.discord.registeredRoleId, true);
  const confirmed = roleView(scrim.discord.confirmedRoleId, false);

  const apply = async (channelId: string, extra: OverwriteResolvable[]) => {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.isDMBased() || !("permissionOverwrites" in channel)) {
      return;
    }
    await channel.permissionOverwrites.set([
      everyoneDeny(guild),
      botAllow(guild, client),
      ...staffOverwrites,
      ...extra,
    ]);
  };

  await apply(scrim.discord.dropmapId, [registered]);
  await apply(scrim.discord.chatId, [registeredChat]);
  await apply(scrim.discord.codeId, [confirmed]);
  await apply(scrim.discord.leaveId, [confirmed]);
}

export async function applyPlayerDrop(
  client: Client,
  scrimId: string,
  userId: string,
  dropId: string,
  options?: { ignoreClosed?: boolean },
) {
  const scrim = getScrim(scrimId);
  const invite = listInvites(scrimId).find((item) => item.discordUserId === userId);
  if (!scrim?.discord || !invite) {
    throw new Error("Você não está registrado nesta scrim");
  }
  if (!scrim.dropsOpen && !options?.ignoreClosed) {
    throw new Error("A staff fechou a marcação de drops");
  }
  const guild = await client.guilds.fetch(scrim.guildId);
  const marker = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  const user = marker?.user ?? (await client.users.fetch(userId).catch(() => null));
  const displayName = marker?.displayName || user?.globalName || user?.username || invite.displayName;
  const avatarUrl =
    marker?.displayAvatarURL({ size: 128, extension: "png", forceStatic: true }) ||
    user?.displayAvatarURL({ size: 128, extension: "png", forceStatic: true }) ||
    `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(userId) % 5n)}.png`;
  const drop = claimDrop(scrimId, dropId, invite.teamName, {
    userId,
    displayName,
    avatarUrl,
  });
  const team = listInvites(scrimId).filter((item) => item.teamName === invite.teamName);
  for (const memberInvite of team) {
    markDropped(scrimId, memberInvite.discordUserId, drop.name);
    const member = await guild.members.fetch(memberInvite.discordUserId).catch(() => null);
    if (member && scrim.discord) {
      await member.roles.add(scrim.discord.confirmedRoleId).catch(() => undefined);
    }
  }
  await syncLobbyAccess(client, scrim).catch(() => undefined);
  if (marker || user) {
    const codeMention = `<#${scrim.discord.codeId}>`;
    const leaveMention = `<#${scrim.discord.leaveId}>`;
    await (marker ?? user)!
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3ee0a2)
            .setTitle("Drop confirmado")
            .setDescription(
              [
                `**${drop.name}** na scrim **${scrim.name}**`,
                `Time / nick: **${invite.teamName}**`,
                "",
                `Agora você vê ${codeMention} e ${leaveMention}.`,
                `Mapa: ${dropMapUrl(scrim.id)}`,
              ].join("\n"),
            ),
        ],
      })
      .catch(() => undefined);
  }
  return drop;
}

export async function postMatchCode(client: Client, scrim: Scrim): Promise<void> {
  if (!scrim.discord || !scrim.matchCode) {
    return;
  }
  const channel = await client.channels.fetch(scrim.discord.codeId);
  if (!channel?.isTextBased()) {
    return;
  }
  await (channel as TextChannel).send({
    embeds: [embedFromPayload(embedPayload(scrim.embeds.code, scrimEmbedVars(scrim), 0xc8f542))],
  });
}

export async function revealFillChannel(client: Client, scrim: Scrim): Promise<void> {
  if (!scrim.discord || scrim.discord.fillVisible) {
    return;
  }
  const channel = await client.channels.fetch(scrim.discord.fillId);
  if (!channel || channel.isDMBased() || !("permissionOverwrites" in channel)) {
    return;
  }
  for (const roleId of scrim.accessRoleIds) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: false,
    });
  }
  patchScrim(scrim.id, {
    discord: { ...scrim.discord, fillVisible: true },
  });
}

export async function setFillChatOpen(
  client: Client,
  scrim: Scrim,
  open: boolean,
): Promise<void> {
  if (!scrim.discord) {
    return;
  }
  const channel = await client.channels.fetch(scrim.discord.fillId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    return;
  }
  const text = channel as TextChannel;
  const messages = await text.messages.fetch({ limit: 10 });
  const botMsg = messages.find((message) => message.author.id === client.user?.id);
  if (botMsg) {
    await botMsg.edit({
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`fill:${scrim.id}`)
            .setLabel("Pedir vaga")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!open),
        ),
      ],
    });
  }
  patchScrim(scrim.id, {
    discord: { ...scrim.discord, fillChatOpen: open },
  });
}

export async function teardownLobby(client: Client, scrim: Scrim): Promise<void> {
  if (!scrim.discord) {
    return;
  }
  const guild = getGuild(client, scrim.guildId);
  if (!guild) {
    return;
  }
  const ids = [
    scrim.discord.registrationId,
    scrim.discord.dropmapId,
    scrim.discord.codeId,
    scrim.discord.chatId,
    scrim.discord.leaveId,
    scrim.discord.fillId,
    scrim.discord.adminId,
    scrim.discord.categoryId,
  ];
  for (const id of ids) {
    await guild.channels.delete(id).catch(() => undefined);
  }
  await guild.roles.delete(scrim.discord.registeredRoleId).catch(() => undefined);
  await guild.roles.delete(scrim.discord.confirmedRoleId).catch(() => undefined);
}

const pingTimers = new Map<string, NodeJS.Timeout[]>();

export function schedulePriorityPings(client: Client, scrim: Scrim): void {
  const old = pingTimers.get(scrim.id);
  if (old) {
    for (const timer of old) {
      clearTimeout(timer);
    }
  }
  const timers: NodeJS.Timeout[] = [];
  for (const window of scrim.windows) {
    const at =
      window.date && window.time
        ? parseBrasiliaDateTime(window.date, window.time)
        : Date.now() + (parseClock(window.time) - clockMinutes()) * 60_000;
    const delay = at - Date.now();
    const run = async () => {
      const live = getScrim(scrim.id);
      if (!live?.discord) {
        return;
      }
      const channel = await client.channels.fetch(live.discord.registrationId);
      if (!channel?.isTextBased()) {
        return;
      }
      const who = window.roleId
        ? `<@&${window.roleId}> o check-in de vocês já está aberto`
        : "Quem não tem cargo de prioridade já pode fazer check-in";
      await (channel as TextChannel).send(who);
    };
    if (delay > 0 && delay < 48 * 60 * 60 * 1000) {
      timers.push(setTimeout(() => void run(), delay));
    }
  }
  pingTimers.set(scrim.id, timers);
}
