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

3. Troque `ADMIN_PASSWORD` e `SESSION_SECRET` no `.env`

4. Instale e suba:

```bash
npm install
npm run dev
```

5. Abra [http://localhost:3000](http://localhost:3000) e entre com a senha do painel.

Sem `DISCORD_TOKEN` o site ainda abre; o card do bot fica offline até o token estar certo.

## Produção

São dois hosts, de propósito:

- **Vercel** (`buildscrims.online`) — só o site React (Vite). Não roda o bot Discord.
- **Railway** (`handsome-curiosity`) — bot Discord + API Express (`/api`, `/tabelas` via proxy).

O `npm start` (`node dist/index.js`) é o processo Node. A Vercel **não** deve publicar essa pasta. Se o domínio mostrar código-fonte preto (`startBot` / `createWebApp`), o Output Directory está em `dist` em vez de `dist/public`.

## Domínio próprio (Vercel + Railway)

O frontend usa caminhos relativos (`/api/...`, `/tabelas`). A Vercel serve o HTML/JS e faz rewrite de `/api` para o Railway.

1. Na Vercel → projeto → **Settings → Build & Development**:
   - Framework Preset: **Vite**
   - Build Command: `npx vite build`
   - Output Directory: **`dist/public`** (nunca `dist`)
   - Root Directory: raiz do repo
2. DNS no registrador (Hostinger etc.), apontando para a Vercel:
   - A `@` → `76.76.21.21`
   - CNAME `www` → `cname.vercel-dns.com` (ou o que a Vercel mostrar)
3. Na Vercel → **Domains**, o domínio `buildscrims.online` fica neste projeto. Não precisa (e não deve) apontar o domínio no Railway.
4. Variáveis no **Railway** (o backend que executa OAuth e o bot):
   - `PUBLIC_BASE_URL=https://buildscrims.online`
   - opcional: `DISCORD_REDIRECT_URI=https://buildscrims.online/api/auth/discord/callback`
   - opcional: `PUBLIC_HOSTS=www.buildscrims.online,fortnite-scrim-bot.vercel.app`
5. Discord Developer Portal → OAuth2 → Redirects, cadastre:
   - `https://buildscrims.online/api/auth/discord/callback`
   - mantenha também `https://handsome-curiosity-production-48d3.up.railway.app/api/auth/discord/callback` se ainda for usar o link Railway
6. Confira `https://buildscrims.online/api/health` (proxy) e a homepage **BUILD CLOSED**, não um arquivo `.js`.

Com Docker (só o backend Railway):

```bash
docker build -t fortnite-scrim-bot .
docker run -p 3000:3000 --env-file .env fortnite-scrim-bot
```

## Estrutura

- `src/bot` — cliente Discord
- `src/web` — API + login do painel
- `web/` — interface no navegador
