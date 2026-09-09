import { startBot, getBotStatus } from "./bot/client.js";
import { env } from "./env.js";
import { ensureStore } from "./scrims/store.js";
import { createWebApp } from "./web/app.js";

/**
 * Processo 24/7 do Discord (gateway). Não publica o site.
 * Site público: Vercel (buildscrims.online).
 *
 *   npm run bot
 *   node dist/bot.js
 */
async function main() {
  if (!env.discordToken) {
    console.error("[bot] DISCORD_TOKEN vazio — este processo é só o gateway e precisa do token.");
    process.exit(1);
  }

  await ensureStore();

  const app = await createWebApp({ serveUi: false });
  app.get("/health", (_req, res) => {
    const status = getBotStatus();
    res.json({
      ok: true,
      service: "fortnite-scrim-bot",
      host: "bot",
      ...status,
    });
  });

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(env.port, "0.0.0.0", () => {
      console.log(`[bot] Health em http://0.0.0.0:${env.port}/health (sem site público)`);
      resolve();
    });
    server.on("error", reject);
  });

  try {
    await startBot(env.discordToken);
  } catch (error) {
    console.error("[bot] Falha ao conectar no Discord:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Falha ao iniciar o bot:", error);
  process.exit(1);
});
