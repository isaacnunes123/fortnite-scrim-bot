import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
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
  applyEmbedVars,
  claimDrop,
  getScrim,
  listInvites,
  markDropped,
  nextLobbyNumber,
  patchScrim,
  teamCount,
  type DiscordLobby,
  type EmbedCopy,
  type Scrim,
} from "./store.js";
import { clockMinutes, parseClock } from "./time.js";


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

function parseColor(hex: string, fallback: number): number {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(value) ? value : fallback;
}

function scrimVars(scrim: Scrim, extra: Record<string, string> = {}): Record<string, string> {
  return {
    name: scrim.name,
    teams: String(teamCount(scrim.id)),
    max: String(scrim.maxSlots),
    windows: extra.windows ?? "",
    url: dropMapUrl(scrim.id),
    leaveUntil: scrim.leaveUntil || "não definido",
    punishHours: String(scrim.punishHours),
    code: scrim.matchCode || "—",
    ...extra,
  };
}

function embedFrom(copy: EmbedCopy, vars: Record<string, string>, fallbackColor: number) {
  const footer = applyEmbedVars(copy.footer, vars).slice(0, 2048);
  const embed = new EmbedBuilder()
    .setColor(parseColor(copy.color, fallbackColor))
    .setTitle(applyEmbedVars(copy.title, vars).slice(0, 256) || "Scrim")
    .setDescription(applyEmbedVars(copy.description, vars).slice(0, 4096) || "—");
  if (footer) {
    embed.setFooter({ text: footer });
  }
  return embed;
}

export function registrationEmbed(scrim: Scrim, guild: Guild) {
  const lines = scrim.windows.map((window) => {
    if (!window.roleId) {
      return `Quem **não** tem os cargos de prioridade registra às \`${window.time}\``;
    }
    const role = guild.roles.cache.get(window.roleId);
    return `${role ?? `<@&${window.roleId}>`} registra às \`${window.time}\``;
  });
  return embedFrom(scrim.embeds.registration, scrimVars(scrim, { windows: lines.join("\n") }), 0x3ee0a2);
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
  return embedFrom(scrim.embeds.leave, scrimVars(scrim), 0xff5c5c);
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
  const guild = getGuild(client, scrim.guildId);
  if (!guild) {
    throw new Error("Servidor não encontrado. Escolha o servidor no painel.");
  }

  const lobbyNumber = nextLobbyNumber(scrim.guildId);
  const prefix = `lobby-${lobbyNumber}`;

  const registered = await guild.roles.create({
    name: `${prefix}-in`,
    mentionable: false,
    reason: `Registro ${scrim.name}`,
  });
  const confirmed = await guild.roles.create({
    name: `${prefix}-ready`,
    mentionable: false,
    reason: `Drop confirmado ${scrim.name}`,
  });

  const staffOverwrites = scrim.staffRoleIds.map((roleId) => roleView(roleId, true));
  const accessView = scrim.accessRoleIds.map((roleId) => roleView(roleId, false));

  const category = await guild.channels.create({
    name: `${prefix} ${scrim.name}`.slice(0, 100),
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      everyoneDeny(guild),
      botAllow(guild, client),
      ...accessView,
      ...staffOverwrites,
    ],
  });

  const makeText = async (
    name: string,
    overwrites: OverwriteResolvable[],
  ): Promise<TextChannel> => {
    return guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [everyoneDeny(guild), botAllow(guild, client), ...overwrites],
    });
  };

  const registration = await makeText(`${prefix}-registration`, [
    ...accessView,
    ...staffOverwrites,
  ]);
  const dropmap = await makeText(`${prefix}-dropmap`, [
    roleView(registered.id, false),
    ...staffOverwrites,
  ]);
  const code = await makeText(`${prefix}-code`, [
    roleView(confirmed.id, false),
    ...staffOverwrites,
  ]);
  const chat = await makeText(`${prefix}-chat`, [
    roleView(registered.id, true),
    ...staffOverwrites,
  ]);
  const leave = await makeText(`${prefix}-getting-off`, [
    roleView(confirmed.id, false),
    ...staffOverwrites,
  ]);
  const fill = await makeText(`${prefix}-fill-requests`, [...staffOverwrites]);
  const admin = await makeText(`${prefix}-admin`, [...staffOverwrites]);

  const discord: DiscordLobby = {
    lobbyNumber,
    categoryId: category.id,
    registrationId: registration.id,
    dropmapId: dropmap.id,
    codeId: code.id,
    chatId: chat.id,
    leaveId: leave.id,
    fillId: fill.id,
    adminId: admin.id,
    registeredRoleId: registered.id,
    confirmedRoleId: confirmed.id,
    registrationMessageId: null,
    leaveMessageId: null,
    dropMapMessageId: null,
    fillVisible: false,
    fillChatOpen: false,
  };

  const saved = patchScrim(scrim.id, { discord });

  const registerMsg = await registration.send({
    embeds: [registrationEmbed(saved, guild)],
    components: [registrationRow(saved.id)],
  });
  const leaveMsg = await leave.send({
    embeds: [leaveEmbed(saved)],
    components: [leaveRow(saved.id)],
  });
  const withIds = patchScrim(scrim.id, {
    discord: {
      ...discord,
      registrationMessageId: registerMsg.id,
      leaveMessageId: leaveMsg.id,
    },
  });
  const withDrop = await ensureDropMapEmbed(client, withIds);
  await syncLobbyAccess(client, withDrop).catch(() => undefined);
  await fill.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xf5c542)
        .setTitle("Segunda chance")
        .setDescription(
          "Este canal aparece quando a lista fecha. Fica bloqueado até um staff liberar os pedidos.",
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`fill:${scrim.id}`)
          .setLabel("Pedir vaga")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      ),
    ],
  });
  await admin.send(
    `Staff: painel em ${process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`}`,
  );

  schedulePriorityPings(client, withDrop);
  return withDrop;
}

function dropMapPayload(scrim: Scrim) {
  const url = dropMapUrl(scrim.id);
  const open = scrim.dropsOpen !== false;
  const copy = open ? scrim.embeds.dropmapOpen : scrim.embeds.dropmapClosed;
  return {
    embeds: [embedFrom(copy, scrimVars(scrim), open ? 0x3b82f6 : 0x111111).setURL(url)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel(open ? "Abrir mapa e marcar drop" : "Ver mapa ao vivo")
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
    embeds: [embedFrom(scrim.embeds.code, scrimVars(scrim), 0xc8f542)],
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
  const now = clockMinutes();
  for (const window of scrim.windows) {
    const target = parseClock(window.time);
    const delayMin = target - now;
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
        ? `<@&${window.roleId}> vocês já podem registrar`
        : "Quem não tem cargo de prioridade já pode registrar";
      await (channel as TextChannel).send(who);
    };
    if (delayMin <= 0) {
      void run();
    } else {
      timers.push(setTimeout(() => void run(), delayMin * 60_000));
    }
  }
  pingTimers.set(scrim.id, timers);
}
