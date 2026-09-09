import { startBot } from "./bot/client.js";
import { env } from "./env.js";
import { createWebApp } from "./web/app.js";

async function main() {
  const app = await createWebApp();
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(env.port, "0.0.0.0", () => {
      console.log(`[web] Painel em http://0.0.0.0:${env.port}`);
      resolve();
    });
    server.on("error", reject);
  });
  try {
    await startBot(env.discordToken);
  } catch (error) {
    console.error("[bot] Falha ao iniciar o bot — API continua no ar:", error);
  }
}

main().catch((error) => {
  console.error("Falha ao iniciar:", error);
  process.exit(1);
});
