import { startBot } from "./bot/client.js";
import { env } from "./env.js";
import { createWebApp } from "./web/app.js";

async function main() {
  await startBot(env.discordToken);
  const app = await createWebApp();

  app.listen(env.port, () => {
    console.log(`[web] Painel em http://localhost:${env.port}`);
  });
}

main().catch((error) => {
  console.error("Falha ao iniciar:", error);
  process.exit(1);
});
