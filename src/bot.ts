import express from "express";
import { startBot, getBotStatus } from "./bot/client.js";
import { pulseBotHeartbeat, startBotHeartbeat } from "./bot/heartbeat.js";
import { env } from "./env.js";
import { ensureStore } from "./scrims/store.js";

/**
 * Processo 24/7 do Discord (gateway). Não publica o site.
 * Site público: Vercel (buildscrims.online).
 *
 *   npm run bot
 *   node dist/bot.js
 */
async function main() {
  const app = express();
  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "fortnite-scrim-bot",
      host: "bot",
      ...getBotStatus(),
    });
  });
  app.get("/", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "fortnite-scrim-bot",
      host: "bot",
      hint: "/health",
    });
  });

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(env.port, "0.0.0.0", () => {
      console.log(`[bot] Health em http://0.0.0.0:${env.port}/health (sem site público)`);
      resolve();
    });
    server.on("error", reject);
  });

  const { createWebApp } = await import("./web/app.js");
  await createWebApp({ serveUi: false, app });

  startBotHeartbeat(getBotStatus);
  pulseBotHeartbeat(getBotStatus());

  if (!env.discordToken) {
    console.error("[bot] DISCORD_TOKEN vazio — o HTTP fica no ar para o Railway, mas o Discord fica offline.");
    return;
  }

  try {
    await ensureStore();
  } catch (error) {
    console.error("[bot] Store atrasada (o gateway sobe mesmo assim):", error);
  }

  try {
    await startBot(env.discordToken);
  } catch (error) {
    console.error("[bot] Falha ao conectar no Discord:", error);
    console.error("[bot] Processo HTTP segue no ar — Railway não deve matar o healthcheck.");
    pulseBotHeartbeat(getBotStatus());
  }
}

main().catch((error) => {
  console.error("Falha ao iniciar o bot:", error);
  process.exit(1);
});
