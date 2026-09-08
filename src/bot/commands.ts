import {
  REST,
  Routes,
  SlashCommandBuilder,
  GuildMember,
  type ChatInputCommandInteraction,
  type Client,
  type TextBasedChannel,
} from "discord.js";
import { env } from "../env.js";
import { revealFillChannel, setFillChatOpen } from "../scrims/lobby.js";
import { addLog, findScrimForChannel, type Scrim } from "../scrims/store.js";

const openFillCommand = new SlashCommandBuilder()
  .setName("abrirvaga")
  .setDescription("Liberar pedidos de fill (vaga) nesta lobby");

const closeFillCommand = new SlashCommandBuilder()
  .setName("fecharvaga")
  .setDescription("Mutar / bloquear pedidos de fill nesta lobby");

function slashPayload() {
  return [openFillCommand, closeFillCommand].map((command) => command.toJSON());
}

export async function registerSlashCommands(client: Client): Promise<void> {
  if (!env.discordToken || !env.discordClientId) {
    return;
  }

  const rest = new REST({ version: "10" }).setToken(env.discordToken);
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    console.warn("[bot] Nenhum servidor para registrar comandos slash");
    return;
  }
  for (const guild of guilds) {
    await rest.put(Routes.applicationGuildCommands(env.discordClientId, guild.id), {
      body: slashPayload(),
    });
    console.log(`[bot] Comandos slash registrados em ${guild.name}`);
  }
}

function isFillStaff(member: GuildMember, scrim: Scrim): boolean {
  const allowed = new Set([...scrim.staffRoleIds, ...env.adminRoleIds]);
  return member.roles.cache.some((role) => allowed.has(role.id));
}

function parentIdOf(channel: TextBasedChannel): string | null {
  if ("parentId" in channel && typeof channel.parentId === "string") {
    return channel.parentId;
  }
  return null;
}

async function toggleFillForContext(
  client: Client,
  member: GuildMember,
  channel: TextBasedChannel | null,
  open: boolean,
): Promise<string> {
  if (!channel || channel.isDMBased() || !member.guild) {
    throw new Error("Use este comando no servidor, no canal da lobby.");
  }
  const scrim = findScrimForChannel(member.guild.id, channel.id, parentIdOf(channel));
  if (!scrim?.discord) {
    throw new Error("Não achei a scrim deste canal. Use no fill, admin ou outro canal da lobby.");
  }
  if (!isFillStaff(member, scrim)) {
    throw new Error("Só staff desta scrim pode liberar ou mutar o fill.");
  }
  if (open) {
    await revealFillChannel(client, scrim);
  }
  await setFillChatOpen(client, scrim, open);
  addLog({
    scrimId: scrim.id,
    kind: "fill",
    summary: open ? "Fill liberado" : "Fill bloqueado",
    detail: `${member.displayName} usou /${open ? "abrirvaga" : "fecharvaga"}`,
  });
  const mention = `<#${scrim.discord.fillId}>`;
  return open
    ? `Fill liberado em ${mention}. Players já podem pedir vaga.`
    : `Fill mutado em ${mention}. Pedidos de vaga estão bloqueados.`;
}

export async function handleChatCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  if (interaction.commandName !== "abrirvaga" && interaction.commandName !== "fecharvaga") {
    return;
  }

  const member =
    interaction.member instanceof GuildMember
      ? interaction.member
      : interaction.guild
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
  if (!member) {
    await interaction.reply({
      content: "Não consegui ler seu cargo neste servidor.",
      ephemeral: true,
    });
    return;
  }
  try {
    const text = await toggleFillForContext(
      client,
      member,
      interaction.channel,
      interaction.commandName === "abrirvaga",
    );
    await interaction.reply({ content: text, ephemeral: true });
  } catch (error) {
    await interaction.reply({
      content: error instanceof Error ? error.message : "Não foi possível alterar o fill.",
      ephemeral: true,
    });
  }
}
