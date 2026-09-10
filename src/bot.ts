import http from "node:http";

/**
 * Processo 24/7 do Discord (gateway). Não publica o site.
 * Site público: Vercel (buildscrims.online).
 *
 * Railway precisa de HTTP em 0.0.0.0:PORT no primeiro tick — antes de
 * express/discord/createWebApp, que podem lançar na importação.
 *   npm run bot
 *   node dist/bot.js
 */

type HealthExtra = Record<string, unknown>;

function listenPort(): number {
  const parsed = Number.parseInt(String(process.env.PORT ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

let readHealth: () => HealthExtra = () => ({
  configured: false,
  ready: false,
  presence: "offline",
  username: null,
  id: null,
  guildCount: 0,
  uptimeMs: null,
});

function slimHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const urlPath = (req.url ?? "/").split("?")[0] || "/";
  if (urlPath === "/health") {
    json(res, 200, {
      ok: true,
      service: "fortnite-scrim-bot",
      host: "bot",
      ...readHealth(),
    });
    return;
  }
  if (urlPath === "/") {
    json(res, 200, {
      ok: true,
      service: "fortnite-scrim-bot",
      host: "bot",
      hint: "/health",
    });
    return;
  }
  json(res, 503, { ok: false, starting: true });
}

const port = listenPort();
const server = http.createServer(slimHandler);
server.on("error", (error) => {
  console.error("[bot] HTTP server error (processo segue):", error);
});
server.listen(port, "0.0.0.0", () => {
  console.log(`[bot] HTTP em http://0.0.0.0:${port}/health (bind antes de qualquer import)`);
});

process.on("unhandledRejection", (error) => {
  console.error("[bot] unhandledRejection (HTTP segue no ar):", error);
});

async function boot(): Promise<void> {
  const { default: express } = await import("express");
  const app = express();

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

  server.removeAllListeners("request");
  server.on("request", app);

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
    const { processExpiredDropDeadlines } = await import("./web/adminLobby.js");
    setInterval(() => {
      void processExpiredDropDeadlines().catch((error) => {
        console.error("[bot] expire drop deadline:", error);
      });
    }, 20_000);
  } catch (error) {
    console.error("[bot] Falha ao conectar no Discord:", error);
    console.error("[bot] Processo HTTP segue no ar — Railway não deve matar o healthcheck.");
    pulseBotHeartbeat(getBotStatus());
  }
}

boot().catch((error) => {
  console.error("[bot] Falha depois do listen (HTTP /health segue):", error);
});
