import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  GuildMember,
  type Client,
  type Interaction,
} from "discord.js";
import {
  refreshRegistrationMessage,
  revealFillChannel,
  ensureDropMapEmbed,
  syncLobbyAccess,
} from "../scrims/lobby.js";
import {
  addBlacklist,
  addInvite,
  getActiveBan,
  getScrim,
  listInvites,
  removePlayer,
  teamCount,
} from "../scrims/store.js";
import { canRegisterNow, isLeavePunishable, memberRoleIds } from "../scrims/time.js";

function asMember(interaction: Interaction): GuildMember | null {
  if (interaction.member instanceof GuildMember) {
    return interaction.member;
  }
  return null;
}

async function resolveMember(interaction: Interaction): Promise<GuildMember | null> {
  const current = asMember(interaction);
  if (current) {
    return current;
  }
  if (interaction.guild) {
    return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  }
  return null;
}

async function giveRole(member: GuildMember, roleId: string) {
  await member.roles.add(roleId).catch(() => undefined);
}

async function takeRoles(member: GuildMember, roleIds: string[]) {
  await member.roles.remove(roleIds).catch(() => undefined);
}

export async function handleInteraction(interaction: Interaction, client: Client) {
  if (interaction.isButton()) {
    const [action, scrimId, extra] = interaction.customId.split(":");
    if (!scrimId) {
      return;
    }
    if (action === "reg") {
      await onRegisterButton(interaction, client, scrimId);
      return;
    }
    if (action === "leave") {
      await onLeave(interaction, client, scrimId);
      return;
    }
    if (action === "leaveyes") {
      await completeLeave(interaction, client, scrimId, true);
      return;
    }
    if (action === "leaveno") {
      await interaction.reply({ content: "Saída cancelada.", ephemeral: true });
      return;
    }
    if (action === "fill") {
      await onFillRequest(interaction, client, scrimId);
      return;
    }
    if (action === "fillyes" && extra) {
      await onFillDecision(interaction, client, scrimId, extra, true);
      return;
    }
    if (action === "fillno" && extra) {
      await onFillDecision(interaction, client, scrimId, extra, false);
    }
  }
}

async function onRegisterButton(
  interaction: ButtonInteraction,
  client: Client,
  scrimId: string,
) {
  const scrim = getScrim(scrimId);
  const member = await resolveMember(interaction);
  if (!scrim || !member) {
    await interaction.reply({ content: "Scrim indisponível.", ephemeral: true });
    return;
  }
  const ban = getActiveBan(member.id);
  if (ban) {
    const until = new Date(ban.expiresAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    await interaction.reply({
      content: `Você está na blacklist da closed até **${until}** (nick **${ban.fortniteNick}**). Check-in bloqueado.`,
      ephemeral: true,
    });
    return;
  }
  const dropmapMention = scrim.discord ? `<#${scrim.discord.dropmapId}>` : "canal de drop map";
  const chatMention = scrim.discord ? `<#${scrim.discord.chatId}>` : "chat";
  const already = listInvites(scrim.id).find((invite) => invite.discordUserId === member.id);
  if (already) {
    await replyOnlyToPlayer(
      interaction,
      member,
      `Você já está registrado.\nAbra ${dropmapMention} e marque o drop no mapa.\nChat: ${chatMention}.\nCódigo e getting-off só depois de marcar.`,
      { dm: false },
    );
    return;
  }
  const gate = canRegisterNow(memberRoleIds(member), scrim);
  if (!gate.ok) {
    await interaction.reply({ content: gate.reason, ephemeral: true });
    return;
  }
  if (teamCount(scrim.id) >= scrim.maxSlots) {
    await interaction.reply({
      content: "Lista cheia. Use o canal de segunda chance quando o staff liberar.",
      ephemeral: true,
    });
    return;
  }

  try {
    addInvite({
      scrimId: scrim.id,
      discordUserId: member.id,
      displayName: member.displayName,
      teamName: playerTeamName(scrim.id, member),
      fortniteNick: member.displayName,
    });
    if (scrim.discord) {
      await giveRole(member, scrim.discord.registeredRoleId);
      const live = getScrim(scrim.id);
      if (live) {
        await syncLobbyAccess(client, live).catch(() => undefined);
      }
    }
    await ensureDropMapEmbed(client, getScrim(scrim.id) ?? scrim);
    await refreshRegistrationMessage(client, scrim.id);
    const updated = getScrim(scrim.id);
    if (updated && teamCount(updated.id) >= updated.maxSlots) {
      await revealFillChannel(client, updated);
    }
    await replyOnlyToPlayer(
      interaction,
      member,
      [
        `Check-in feito na **${scrim.name}**.`,
        `Nick (Fortnite / apelido): **${member.displayName}**`,
        "",
        `Agora você vê ${chatMention} e ${dropmapMention}.`,
        "Abra o **mesmo link** da embed do dropmap, entre com este Discord e **marque o drop**.",
        "Canais de **código** e **getting-off** só liberam depois do drop no mapa.",
      ].join("\n"),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Não foi possível registrar";
    await interaction.reply({ content: message, ephemeral: true });
  }
}

async function replyOnlyToPlayer(
  interaction: ButtonInteraction,
  member: GuildMember,
  content: string,
  options?: { dm?: boolean },
) {
  await interaction.reply({
    content,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
  if (options?.dm === false) {
    return;
  }
  await member
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x3b82f6)
          .setTitle("Check-in confirmado")
          .setDescription(content),
      ],
    })
    .catch(() => undefined);
}

function playerTeamName(scrimId: string, member: GuildMember): string {
  const base = (member.displayName || member.user.username).slice(0, 32);
  const taken = listInvites(scrimId).some(
    (invite) => invite.teamName === base && invite.discordUserId !== member.id,
  );
  if (!taken) {
    return base;
  }
  return `${base.slice(0, 27)}-${member.id.slice(-4)}`;
}

async function onLeave(
  interaction: ButtonInteraction,
  client: Client,
  scrimId: string,
) {
  const scrim = getScrim(scrimId);
  const member = await resolveMember(interaction);
  if (!scrim || !member) {
    await interaction.reply({ content: "Scrim indisponível.", ephemeral: true });
    return;
  }
  const existing = listInvites(scrim.id).find((invite) => invite.discordUserId === member.id);
  if (!existing) {
    await interaction.reply({ content: "Você não está nesta scrim.", ephemeral: true });
    return;
  }

  if (!isLeavePunishable(scrim)) {
    await completeLeave(interaction, client, scrimId, false);
    return;
  }

  await interaction.reply({
    content: `O horário livre de saída (**${scrim.leaveUntil}**) já passou.\nSe confirmar, você entra na **blacklist da closed** por **${scrim.punishHours}h** (ID + nick **${existing.fortniteNick || member.displayName}**) e não poderá fazer check-in até acabar a punição.`,
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`leaveyes:${scrim.id}`)
          .setLabel("Confirmar saída e aceitar punição")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`leaveno:${scrim.id}`)
          .setLabel("Cancelar")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function replyLeave(interaction: ButtonInteraction, content: string) {
  if (interaction.customId.startsWith("leaveyes:")) {
    await interaction.update({ content, components: [] });
    return;
  }
  await interaction.reply({ content, ephemeral: true });
}

async function completeLeave(
  interaction: ButtonInteraction,
  client: Client,
  scrimId: string,
  punish: boolean,
) {
  const scrim = getScrim(scrimId);
  const member = await resolveMember(interaction);
  if (!scrim || !member) {
    await replyLeave(interaction, "Scrim indisponível.");
    return;
  }
  const existing = listInvites(scrim.id).find((invite) => invite.discordUserId === member.id);
  if (!existing) {
    await replyLeave(interaction, "Você não está nesta scrim.");
    return;
  }

  removePlayer(scrim.id, member.id);
  if (scrim.discord) {
    await takeRoles(member, [
      scrim.discord.registeredRoleId,
      scrim.discord.confirmedRoleId,
    ]);
  }
  await refreshRegistrationMessage(client, scrim.id);

  if (punish) {
    const entry = addBlacklist({
      discordUserId: member.id,
      displayName: member.displayName,
      fortniteNick: existing.fortniteNick || member.displayName,
      reason: "Saída após o horário definido pela staff",
      hours: scrim.punishHours,
      scrimId: scrim.id,
    });
    const until = new Date(entry.expiresAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    if (scrim.discord) {
      const admin = await client.channels.fetch(scrim.discord.adminId);
      if (admin && "send" in admin) {
        await admin.send(
          `⛔ Blacklist: <@${member.id}> · Fortnite **${entry.fortniteNick}** até ${until}`,
        );
      }
    }
    await replyLeave(
      interaction,
      `Saída confirmada. Você está na blacklist da closed até **${until}**.`,
    );
    return;
  }

  await replyLeave(
    interaction,
    `Você saiu da scrim dentro do horário (${scrim.leaveUntil}). Sem punição.`,
  );
}

async function onFillRequest(
  interaction: ButtonInteraction,
  client: Client,
  scrimId: string,
) {
  const scrim = getScrim(scrimId);
  const member = await resolveMember(interaction);
  if (!scrim?.discord || !member) {
    await interaction.reply({ content: "Scrim indisponível.", ephemeral: true });
    return;
  }
  const ban = getActiveBan(member.id);
  if (ban) {
    const until = new Date(ban.expiresAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    await interaction.reply({
      content: `Você está na blacklist da closed até **${until}**. Não pode pedir fill.`,
      ephemeral: true,
    });
    return;
  }
  if (!scrim.discord.fillChatOpen) {
    await interaction.reply({
      content: "Ainda bloqueado. Espere um staff liberar os pedidos.",
      ephemeral: true,
    });
    return;
  }
  if (!scrim.accessRoleIds.some((id) => memberRoleIds(member).includes(id))) {
    await interaction.reply({
      content: "Só quem tem cargo da divisão pode pedir vaga.",
      ephemeral: true,
    });
    return;
  }

  const admin = await client.channels.fetch(scrim.discord.adminId);
  if (admin && "send" in admin) {
    await admin.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xf5c542)
          .setTitle("Pedido de segunda chance")
          .setDescription(`<@${member.id}> pediu vaga em **${scrim.name}**.`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`fillyes:${scrim.id}:${member.id}`)
            .setLabel("Adicionar")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`fillno:${scrim.id}:${member.id}`)
            .setLabel("Recusar")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    });
  }
  await interaction.reply({
    content: "Pedido enviado aos staffs.",
    ephemeral: true,
  });
}

async function onFillDecision(
  interaction: ButtonInteraction,
  client: Client,
  scrimId: string,
  userId: string,
  accept: boolean,
) {
  const scrim = getScrim(scrimId);
  if (!scrim?.discord) {
    await interaction.reply({ content: "Scrim indisponível.", ephemeral: true });
    return;
  }
  if (!accept) {
    await interaction.reply({ content: "Pedido recusado.", ephemeral: true });
    await interaction.message.edit({ components: [] }).catch(() => undefined);
    return;
  }

  const guild = interaction.guild;
  const member = await guild?.members.fetch(userId).catch(() => null);
  if (!member) {
    await interaction.reply({ content: "Player não está no servidor.", ephemeral: true });
    return;
  }
  const ban = getActiveBan(member.id);
  if (ban) {
    await interaction.reply({
      content: "Esse player está na blacklist da closed. Check-in bloqueado.",
      ephemeral: true,
    });
    return;
  }
  try {
    const invite = addInvite({
      scrimId: scrim.id,
      discordUserId: member.id,
      displayName: member.displayName,
      teamName: member.displayName.slice(0, 32),
      fortniteNick: member.displayName,
    });
    await giveRole(member, scrim.discord.registeredRoleId);
    await ensureDropMapEmbed(client, getScrim(scrim.id) ?? scrim);
    await refreshRegistrationMessage(client, scrim.id);
    await interaction.reply({
      content: `Adicionado: **${invite.teamName}**.`,
      ephemeral: true,
    });
    await interaction.message.edit({ components: [] }).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao adicionar";
    await interaction.reply({ content: message, ephemeral: true });
  }
}
