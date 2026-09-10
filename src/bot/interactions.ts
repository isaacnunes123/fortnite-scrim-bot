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
import { registerPlayer, resolveScrimFromButtonLive } from "../scrims/checkin.js";
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
  pullRemoteStore,
  remainingCheckinCooldown,
  removePlayer,
  teamCount,
  type Scrim,
} from "../scrims/store.js";
import { isLeavePunishable, memberRoleIds } from "../scrims/time.js";

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

async function resolveButtonScrim(
  interaction: ButtonInteraction,
  scrimId: string,
): Promise<Scrim | null> {
  await pullRemoteStore();
  const parentId =
    interaction.channel && "parentId" in interaction.channel
      ? interaction.channel.parentId
      : null;
  return resolveScrimFromButtonLive(
    scrimId,
    interaction.guildId ?? undefined,
    interaction.channelId,
    parentId,
  );
}

export async function handleInteraction(interaction: Interaction, client: Client) {
  if (interaction.isButton()) {
    await pullRemoteStore().catch(() => undefined);
    const { processExpiredDropDeadlines } = await import("../web/adminLobby.js");
    await processExpiredDropDeadlines().catch(() => undefined);
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
      return;
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
      const { handleAdminButton } = await import("../web/adminLobby.js");
      const scrim = await resolveButtonScrim(interaction, scrimId);
      if (!scrim) {
        await interaction.reply({ content: "Scrim indisponível.", ephemeral: true });
        return;
      }
      const member = await resolveMember(interaction);
      const result = await handleAdminButton(
        action,
        scrim,
        member
          ? { id: member.id, displayName: member.displayName, roleIds: memberRoleIds(member) }
          : null,
      );
      await interaction.reply({
        content: result.content,
        ephemeral: true,
        ...(result.extra?.components ? { components: result.extra.components as never } : {}),
      });
    }
  }
}

async function onRegisterButton(
  interaction: ButtonInteraction,
  client: Client,
  scrimId: string,
) {
  await interaction.deferReply({ ephemeral: true });
  const scrim = await resolveButtonScrim(interaction, scrimId);
  const member = await resolveMember(interaction);
  const outcome = registerPlayer(
    scrim,
    member
      ? { id: member.id, displayName: member.displayName, roleIds: memberRoleIds(member) }
      : null,
  );
  if (!outcome.ok) {
    await interaction.editReply({ content: outcome.content });
    return;
  }
  if (outcome.already) {
    await replyOnlyToPlayer(interaction, member!, outcome.content, { dm: false });
    return;
  }

  try {
    if (outcome.scrim.discord && member) {
      await giveRole(member, outcome.scrim.discord.registeredRoleId);
      const live = getScrim(outcome.scrim.id);
      if (live) {
        await syncLobbyAccess(client, live).catch(() => undefined);
      }
    }
    await ensureDropMapEmbed(client, getScrim(outcome.scrim.id) ?? outcome.scrim);
    await refreshRegistrationMessage(client, outcome.scrim.id);
    const updated = getScrim(outcome.scrim.id);
    if (updated && teamCount(updated.id) >= updated.maxSlots) {
      await revealFillChannel(client, updated);
      const { closeRegistrationIfFull } = await import("../web/adminLobby.js");
      await closeRegistrationIfFull(updated).catch(() => undefined);
    }
    await replyOnlyToPlayer(interaction, member!, outcome.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Não foi possível registrar";
    await interaction.editReply({ content: message });
  }
}

async function replyOnlyToPlayer(
  interaction: ButtonInteraction,
  member: GuildMember,
  content: string,
  options?: { dm?: boolean },
) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({
      content,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }
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

async function onLeave(
  interaction: ButtonInteraction,
  client: Client,
  scrimId: string,
) {
  const scrim = await resolveButtonScrim(interaction, scrimId);
  if (!scrim) {
    return;
  }
  const member = await resolveMember(interaction);
  if (!member) {
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
  const scrim = await resolveButtonScrim(interaction, scrimId);
  if (!scrim) {
    return;
  }
  const member = await resolveMember(interaction);
  if (!member) {
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
    const live = getScrim(scrim.id);
    if (live) {
      await syncLobbyAccess(client, live).catch(() => undefined);
    }
  }
  await ensureDropMapEmbed(client, getScrim(scrim.id) ?? scrim);
  await refreshRegistrationMessage(client, scrim.id);
  const wait = remainingCheckinCooldown(member.id);

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
      `Saída confirmada. Seu drop foi liberado. Você está na blacklist da closed até **${until}**.`,
    );
    return;
  }

  await replyLeave(
    interaction,
    `Você saiu da scrim dentro do horário (${scrim.leaveUntil}). Sem punição. Drop liberado. Espere **${wait || 90}s** para fazer check-in de novo.`,
  );
}

async function onFillRequest(
  interaction: ButtonInteraction,
  client: Client,
  scrimId: string,
) {
  const scrim = await resolveButtonScrim(interaction, scrimId);
  if (!scrim?.discord) {
    return;
  }
  const member = await resolveMember(interaction);
  if (!member) {
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
  const scrim = await resolveButtonScrim(interaction, scrimId);
  if (!scrim?.discord) {
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
      ignoreCooldown: true,
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
