import { GuildMember, type ChatInputCommandInteraction, type Client } from "discord.js";
import { memberRoleIds } from "../scrims/time.js";
import {
  ensureSlashCommandsRegistered,
  executeFillSlashCommand,
  isFillSlashCommand,
} from "./slashFill.js";

export async function registerSlashCommands(_client?: Client): Promise<void> {
  const result = await ensureSlashCommandsRegistered();
  if (result.ok) {
    console.log(`[bot] ${result.detail}`);
    return;
  }
  console.warn(`[bot] Comandos slash não registrados: ${result.detail}`);
}

export async function handleChatCommand(
  interaction: ChatInputCommandInteraction,
  _client: Client,
): Promise<void> {
  if (!isFillSlashCommand(interaction.commandName)) {
    return;
  }

  const parentId =
    interaction.channel && "parentId" in interaction.channel
      ? (interaction.channel.parentId ?? null)
      : null;
  const resolved =
    interaction.member instanceof GuildMember
      ? interaction.member
      : interaction.guild
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
  const member = resolved
    ? {
        id: resolved.id,
        displayName: resolved.displayName,
        roleIds: memberRoleIds(resolved),
      }
    : null;

  try {
    const text = await executeFillSlashCommand({
      commandName: interaction.commandName,
      guildId: interaction.guildId ?? "",
      channelId: interaction.channelId,
      parentId,
      member,
    });
    await interaction.reply({ content: text, ephemeral: true });
  } catch (error) {
    if (interaction.replied || interaction.deferred) {
      return;
    }
    await interaction.reply({
      content: error instanceof Error ? error.message : "Não foi possível alterar o fill.",
      ephemeral: true,
    });
  }
}
