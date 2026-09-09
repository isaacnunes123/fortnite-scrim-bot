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
   - Em **OAuth2 → URL Generator**, marque `bot` e a permissão de entrar no servidor, depois convide o bot

3. Preencha `ADMIN_ROLE_IDS` (IDs dos cargos Discord da staff) e `SESSION_SECRET` no `.env`

4. Instale e suba:

```bash
npm install
npm run dev
```

5. Abra [http://localhost:3000](http://localhost:3000) e entre no painel com Discord. Só quem tem um cargo de `ADMIN_ROLE_IDS` no servidor entra.

Sem `DISCORD_TOKEN` o site ainda abre; o card do bot fica offline até o token estar certo.

## Produção (Vercel = site; bot = host 24/7)

São dois papéis, de propósito:

- **Vercel** (`https://buildscrims.online`) — site React + API serverless (`/api`). Tabelas públicas, detalhe da tabela, login da staff e CRUD de tabelas **não precisam do Railway**.
- **Bot Discord** — o gateway do Discord **não roda na Vercel**. Sem um processo Node 24/7 (Fly.io, VPS, Railway, etc.), check-in, lobby, código da partida e mapa de drop ficam offline. O site e as tabelas continuam no ar.

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
   - `YUNITE_API_KEY`
   - `DATABASE_URL` (Neon — veja abaixo)
5. Discord Developer Portal → OAuth2 → Redirects, cadastre:
   - `https://buildscrims.online/api/auth/discord/callback`
6. Confira `https://buildscrims.online/api/health` — tem que voltar `"service":"fortnite-scrim-bot"` e `"host":"vercel"`.

### Neon (gratuito) para as tabelas

1. Crie um projeto em [https://neon.tech](https://neon.tech)
2. Copie a connection string e cole na Vercel como `DATABASE_URL`
3. A API cria a tabela `app_store` sozinha no primeiro request

Sem `DATABASE_URL`, `/tabelas` ainda abre (não dá mais “Falha na requisição”), mas o que a staff salvar some no próximo cold start.

Com Docker (só o bot + Express 24/7):

```bash
docker build -t fortnite-scrim-bot .
docker run -p 3000:3000 --env-file .env fortnite-scrim-bot
```

## Estrutura

- `src/bot` — cliente Discord (host 24/7)
- `src/web` — API do site (Express local + funções Vercel)
- `api/` — handler serverless da Vercel
- `web/` — interface no navegador
