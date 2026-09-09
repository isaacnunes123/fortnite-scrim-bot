import { Client, GatewayIntentBits, Events } from "discord.js";
import { handleChatCommand, registerSlashCommands } from "./commands.js";
import { handleInteraction } from "./interactions.js";
import { env } from "../env.js";
import { enforceHomeGuild } from "./guild.js";
import { pulseBotHeartbeat, startBotHeartbeat, stopBotHeartbeat } from "./heartbeat.js";

export type BotStatus = {
  configured: boolean;
  ready: boolean;
  username: string | null;
  id: string | null;
  guildCount: number;
  uptimeMs: number | null;
};

type BotRuntime = {
  client: Client | null;
  readyAt: number | null;
};

const runtime: BotRuntime = {
  client: null,
  readyAt: null,
};

export function getDiscordClient(): Client | null {
  return runtime.client;
}

export function getBotStatus(): BotStatus {
  const client = runtime.client;
  const ready = Boolean(client?.isReady());
  const user = client?.user;

  return {
    configured: Boolean(client),
    ready,
    username: user?.tag ?? null,
    id: user?.id ?? null,
    guildCount: client?.guilds.cache.size ?? 0,
    uptimeMs: runtime.readyAt ? Date.now() - runtime.readyAt : null,
  };
}

export async function startBot(token: string): Promise<Client | null> {
  if (!token) {
    console.warn(
      "[bot] DISCORD_TOKEN vazio — o painel sobe, mas o bot fica offline até você configurar o token.",
    );
    return null;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (readyClient) => {
    runtime.readyAt = Date.now();
    console.log(`[bot] Conectado como ${readyClient.user.tag}`);
    startBotHeartbeat(getBotStatus);
    pulseBotHeartbeat(getBotStatus());
    enforceHomeGuild(readyClient)
      .then(() => registerSlashCommands(readyClient))
      .catch((error) => {
        console.error("[bot] Falha ao registrar comandos:", error);
      });
  });

  client.on(Events.ShardDisconnect, () => {
    runtime.readyAt = null;
    pulseBotHeartbeat(getBotStatus());
  });

  client.on(Events.Invalidated, () => {
    runtime.readyAt = null;
    stopBotHeartbeat();
    pulseBotHeartbeat(getBotStatus());
  });

  client.on(Events.GuildCreate, (guild) => {
    if (guild.id === env.discordGuildId) {
      return;
    }
    console.warn(`[bot] Convite em ${guild.name} ignorado — saindo`);
    guild.leave().catch(() => undefined);
  });

  client.on(Events.Error, (error) => {
    console.error("[bot] Erro no cliente Discord:", error);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) {
      handleChatCommand(interaction, client).catch((error) => {
        console.error("[bot] Erro no comando:", error);
      });
      return;
    }
    handleInteraction(interaction, client).catch((error) => {
      console.error("[bot] Erro na interação:", error);
    });
  });

  runtime.client = client;
  await client.login(token);
  return client;
}
