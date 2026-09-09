import http from "node:http";
import express from "express";

function listenPort(): number {
  const parsed = Number.parseInt(String(process.env.PORT ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

async function main() {
  const app = express();
  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "fortnite-scrim-bot",
      host: "node",
    });
  });

  const port = listenPort();
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      console.log(`[web] Painel em http://0.0.0.0:${port}`);
      resolve();
    });
  });

  try {
    const { createWebApp } = await import("./web/app.js");
    await createWebApp({ app });
  } catch (error) {
    console.error("[web] Falha ao montar o app (HTTP /health segue):", error);
  }

  try {
    const { startBot } = await import("./bot/client.js");
    const { env } = await import("./env.js");
    await startBot(env.discordToken);
  } catch (error) {
    console.error("[bot] Falha ao iniciar o bot — API continua no ar:", error);
  }
}

main().catch((error) => {
  console.error("Falha ao iniciar:", error);
  process.exit(1);
});
