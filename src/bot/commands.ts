import {
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { env } from "../env.js";
import { getActiveBan, listInvitesForUser } from "../scrims/store.js";

const scrimCommand = new SlashCommandBuilder()
  .setName("scrim")
  .setDescription("Ver se você está na lista fechada de uma scrim");

export async function registerSlashCommands(client: Client): Promise<void> {
  if (!env.discordToken || !env.discordClientId) {
    return;
  }

  const rest = new REST({ version: "10" }).setToken(env.discordToken);
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    console.warn("[bot] Nenhum servidor para registrar /scrim");
    return;
  }
  for (const guild of guilds) {
    await rest.put(Routes.applicationGuildCommands(env.discordClientId, guild.id), {
      body: [scrimCommand.toJSON()],
    });
    console.log(`[bot] Comando /scrim registrado em ${guild.name}`);
  }
}

export async function handleChatCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== "scrim") {
    return;
  }

  const ban = getActiveBan(interaction.user.id);
  const banLine = ban
    ? `⛔ Blacklist da closed até **${new Date(ban.expiresAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}** (nick **${ban.fortniteNick}**). Check-in bloqueado.\n\n`
    : "";

  const rows = listInvitesForUser(interaction.user.id);
  if (rows.length === 0) {
    await interaction.reply({
      content: `${banLine}Você não está em nenhuma lista fechada no momento.`,
      ephemeral: true,
    });
    return;
  }

  const lines = rows.map(
    (row) => `• **${row.scrim.name}** — time **${row.teamName}** (${row.scrim.mode})`,
  );
  await interaction.reply({
    content: `${banLine}Você está convocado:\n${lines.join("\n")}`,
    ephemeral: true,
  });
}
