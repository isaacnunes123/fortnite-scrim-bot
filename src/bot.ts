import http from "node:http";
import express from "express";

/**
 * Processo 24/7 do Discord (gateway). Não publica o site.
 * Site público: Vercel (buildscrims.online).
 *
 * Railway precisa de HTTP na PORT antes de qualquer login Discord.
 *   npm run bot
 *   node dist/bot.js
 */

type HealthExtra = Record<string, unknown>;

function listenPort(): number {
  const parsed = Number.parseInt(String(process.env.PORT ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

async function main() {
  const app = express();
  let readHealth: () => HealthExtra = () => ({
    configured: false,
    ready: false,
    presence: "offline",
    username: null,
    id: null,
    guildCount: 0,
    uptimeMs: null,
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "fortnite-scrim-bot",
      host: "bot",
      ...readHealth(),
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

  const port = listenPort();
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      console.log(`[bot] HTTP em http://0.0.0.0:${port}/health (bind antes do Discord)`);
      resolve();
    });
  });
  server.on("error", (error) => {
    console.error("[bot] HTTP server error (processo segue):", error);
  });

  process.on("unhandledRejection", (error) => {
    console.error("[bot] unhandledRejection (HTTP segue no ar):", error);
  });

  try {
    const { startBot, getBotStatus } = await import("./bot/client.js");
    const { pulseBotHeartbeat, startBotHeartbeat } = await import("./bot/heartbeat.js");
    const { env } = await import("./env.js");

    readHealth = () => getBotStatus();

    try {
      const { createWebApp } = await import("./web/app.js");
      await createWebApp({ serveUi: false, app });
    } catch (error) {
      console.error("[bot] API interna não montou (HTTP /health segue):", error);
    }

    startBotHeartbeat(getBotStatus);
    pulseBotHeartbeat(getBotStatus());

    if (!env.discordToken) {
      console.error("[bot] DISCORD_TOKEN vazio — o HTTP fica no ar para o Railway, mas o Discord fica offline.");
      return;
    }

    try {
      const { ensureStore } = await import("./scrims/store.js");
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
  } catch (error) {
    console.error("[bot] Falha depois do listen (HTTP /health segue):", error);
  }
}

main().catch((error) => {
  console.error("Falha ao iniciar o bot:", error);
  process.exit(1);
});
