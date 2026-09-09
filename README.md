# fortnite-scrim-bot

Bot Discord + painel web para torneios fechados de treino no Fortnite.

Já funciona: painel no navegador, bot no Discord e **lista fechada** (criar scrim e convidar times/players).

No portal do Discord, convide pelo **ID do Discord** do player (clique no perfil com o modo desenvolvedor ligado).

## Rodar local

1. Copie o arquivo de ambiente:

```bash
copy .env.example .env
```

2. Crie uma aplicação em [Discord Developer Portal](https://discord.com/developers/applications):
   - **Bot** → copie o token para `DISCORD_TOKEN`
   - **General Information** → copie o Application ID para `DISCORD_CLIENT_ID`
   - **General Information** → copie a **Public Key** para `DISCORD_PUBLIC_KEY`
   - Em **OAuth2 → URL Generator**, marque `bot` e a permissão de entrar no servidor, depois convide o bot

3. Preencha `ADMIN_ROLE_IDS` (IDs dos cargos Discord da staff) e `SESSION_SECRET` no `.env`

4. Instale e suba:

```bash
npm install
npm run dev
```

5. Abra [http://localhost:3000](http://localhost:3000) e entre no painel com Discord. Só quem tem um cargo de `ADMIN_ROLE_IDS` no servidor entra.

Sem `DISCORD_TOKEN` o site ainda abre; o card do bot fica offline até o token estar certo.

Local só o Discord (sem site):

```bash
npm run build:bot
npm run bot
```

Equivale a `node dist/bot.js`. Esse processo precisa de `DISCORD_TOKEN`.

## Produção (Vercel = site; bot = host 24/7)

São dois papéis, de propósito:

- **Vercel** (`https://buildscrims.online`) — site React + API serverless (`/api`). **Ready** na Vercel só quer dizer que o site compilou. Serverless **não** mantém o gateway do Discord.
- **Bot Discord** — processo Node 24/7 no **mesmo GitHub repo**. Sem esse processo, o Discord mostra o bot offline e o painel diz **Bot Discord offline**. Tabelas e o site continuam no ar.

### Subir só o bot (Fly.io / Render / Railway serviço `bot`)

Não coloque o site de volta no Railway. O domínio público fica na Vercel.

1. Build: `npm install && npm run build:bot`
2. Start: `npm run bot` ou `node dist/bot.js`
3. Variáveis no **host do bot** (as mesmas do `.env`):
   - `DISCORD_TOKEN` (obrigatório)
   - `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`
   - `DISCORD_PUBLIC_KEY` (a mesma da Vercel — o gateway ignora os botões quando esta chave existe)
   - `SESSION_SECRET` (o mesmo da Vercel, se for encaminhar o painel)
   - `DATABASE_URL` (o mesmo Neon da Vercel — senão check-in e tabelas não compartilham dados)
   - `ADMIN_ROLE_IDS`, `YUNITE_API_KEY`, `PUBLIC_BASE_URL=https://buildscrims.online`
4. Na **Vercel**, para o painel **confirmar** que o bot está online (e para “Criar scrim no Discord”):
   - No Railway, serviço **bot** → **Settings → Networking → Generate Domain**
   - Copie a URL pública, **sem barra no final**, por exemplo: `https://bot-production-xxxx.up.railway.app`
   - Na Vercel: `BOT_PROCESS_URL=https://bot-production-xxxx.up.railway.app`
   - Não use `*.railway.internal` — a Vercel não alcança a rede privada do Railway
   - Sem essa variável **e** sem o mesmo `DATABASE_URL` nos dois lados, o painel fica em **Bot: sem confirmação** mesmo se o Discord estiver verde. Isso não significa que o bot caiu.

**Fly.io:** `fly launch` neste repo, start `node dist/bot.js`, cole as env. Desligue auto-stop (`min_machines_running = 1`) — se a máquina dormir, o Discord cai.  
**Render:** Web Service ou Background Worker, build `npm install && npm run build:bot`, start `npm run bot`.  
**Railway:** um serviço chamado **bot** (não o site). Painel do serviço:

- **Settings → Deploy → Pre-deploy Command:** apague (vazio). `npm run build:bot` aqui é o que quebra o deploy (segunda compilação; na imagem Docker nem existe `tsc`/`src`).
- **Settings → Build → Builder:** Nixpacks (não Dockerfile)
- **Settings → Build → Build Command:** `npm run build:bot`
- **Settings → Deploy → Start Command:** `node dist/bot.js`

O `railway.json` já define isso (`/health` na porta `PORT`, sem pre-deploy). Depois de salvar, redeploy.

**O bot ainda aparece offline?** Checklist:

1. Railway → serviço **bot** → **Deploy Logs**. Procure `Logged in as` / `Conectado como`. Se não aparecer:
   - `DISCORD_TOKEN` vazio ou inválido (Reset Token no portal e cole de novo no Railway)
   - start command ainda não é `node dist/bot.js`
   - o processo crashou depois do start
2. [Discord Developer Portal](https://discord.com/developers/applications) → Bot → **Privileged Gateway Intents**: este projeto só usa **Guilds**. Não precisa ligar Message Content / Server Members. O bot precisa estar **convidado no servidor** (`DISCORD_GUILD_ID`).
3. Railway → **Settings → Networking**: precisa de domínio **público**. Health: `https://SEU-DOMINIO.up.railway.app/health` deve voltar JSON com `"host":"bot"`.
4. Vercel → `BOT_PROCESS_URL` = essa mesma URL, **sem** `/health` e **sem** barra no final.
5. Se `https://buildscrims.online/api/health` mostrar `"bot":{"presence":"unknown"}`, o site não está vendo o Railway — Discord verde + painel amarelo é esperado até o passo 4.

A Vercel **não** deve publicar a pasta `dist` inteira. Se o domínio mostrar código-fonte preto (`startBot` / `createWebApp`), o Output Directory está em `dist` em vez de `dist/public`.

O disco da Vercel é efêmero. Tabelas e presets da staff precisam de **Postgres** (`DATABASE_URL`, Neon gratuito). O `store.json` que existia só num volume Railway **não é lido daqui** — se não houver backup, esses dados antigos se perderam.

## Domínio próprio (Vercel)

O frontend usa caminhos relativos (`/api/...`, `/tabelas`). A Vercel serve o HTML/JS **e** as funções `/api`.

1. Na Vercel → projeto → **Settings → Build & Development**:
   - Framework Preset: **Vite**
   - Build Command: `npx vite build`
   - Output Directory: **`dist/public`** (nunca `dist`)
   - Root Directory: raiz do repo
2. DNS no registrador (Hostinger etc.), apontando para a Vercel:
   - A `@` → `76.76.21.21`
   - CNAME `www` → `cname.vercel-dns.com` (ou o que a Vercel mostrar)
3. Na Vercel → **Domains**, o domínio `buildscrims.online` fica neste projeto.
4. Variáveis na **Vercel** (Production + Preview):
   - `PUBLIC_BASE_URL=https://buildscrims.online`
   - `SESSION_SECRET`, `ADMIN_ROLE_IDS`
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_TOKEN`, `DISCORD_GUILD_ID`
   - `DISCORD_PUBLIC_KEY` (General Information → Public Key — sem isso o botão **Registrar** não funciona)
   - `YUNITE_API_KEY`
   - `DATABASE_URL` (Neon — veja abaixo)
   - `BOT_PROCESS_URL` (URL pública do Railway, sem barra no final — sem isso o painel não marca “online”)
5. Discord Developer Portal → OAuth2 → Redirects, cadastre:
   - `https://buildscrims.online/api/auth/discord/callback`
6. Discord Developer Portal → **General Information** → **Interactions Endpoint URL**:
   - `https://buildscrims.online/api/discord/interactions`
   - O Discord manda um PING. Só salva se `DISCORD_PUBLIC_KEY` na Vercel for a Public Key certa.
   - Confira `https://buildscrims.online/api/discord/interactions` — tem que mostrar `"publicKeyConfigured":true`
7. Confira `https://buildscrims.online/api/health` — tem que voltar `"service":"fortnite-scrim-bot"` e `"host":"vercel"`.

O botão **Registrar** do check-in vai para essa URL HTTP (Vercel + Neon). **Não depende do Railway/gateway.** Coloque `DISCORD_PUBLIC_KEY` também no Railway para o gateway não responder o mesmo clique.

### Neon (gratuito) para as tabelas

1. Crie um projeto em [https://neon.tech](https://neon.tech)
2. Copie a connection string e cole na Vercel como `DATABASE_URL`
3. A API cria a tabela `app_store` sozinha no primeiro request

Sem `DATABASE_URL`, `/tabelas` ainda abre (não dá mais “Falha na requisição”), mas o que a staff salvar some no próximo cold start.

Com Docker (só o bot, sem o site):

```bash
docker build -t fortnite-scrim-bot .
docker run -p 3000:3000 --env-file .env fortnite-scrim-bot
```

## Estrutura

- `src/bot` — cliente Discord (host 24/7)
- `src/web` — API do site (Express local + funções Vercel)
- `api/` — handler serverless da Vercel
- `web/` — interface no navegador
