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

## Produção (host)

O mesmo processo serve o site e o bot:

```bash
npm install
npm run build
set NODE_ENV=production
npm start
```

A host precisa expor a porta (`PORT`, padrão `3000`) e ter as variáveis do `.env`.

## Domínio próprio (Railway)

O frontend usa caminhos relativos (`/api/...`, `/painel`). Um único build serve o endereço Railway e o domínio comprado.

1. No Railway do projeto **handsome-curiosity** → serviço → **Settings → Networking → Custom Domain**, ou no CLI: `railway domain seudominio.com`.
2. No DNS do registrador, crie **os dois** records que o Railway mostrar (CNAME/ALIAS + TXT de verificação). Sem o TXT o domínio fica em 404.
3. Variáveis no Railway (sem barra no final):
   - `PUBLIC_BASE_URL=https://seudominio.com`
   - opcional: `DISCORD_REDIRECT_URI=https://seudominio.com/api/auth/discord/callback`
   - opcional: `PUBLIC_HOSTS=www.seudominio.com`
4. Discord Developer Portal → OAuth2 → Redirects, adicione:
   - `https://seudominio.com/api/auth/discord/callback`
   - mantenha também `https://handsome-curiosity-production-48d3.up.railway.app/api/auth/discord/callback` se ainda for usar o link Railway
5. Confira em `/api/health` se `publicBaseUrl` e `discordRedirectUri` batem com o domínio.

Com Docker:

```bash
docker build -t fortnite-scrim-bot .
docker run -p 3000:3000 --env-file .env fortnite-scrim-bot
```

## Estrutura

- `src/bot` — cliente Discord
- `src/web` — API + login do painel
- `web/` — interface no navegador
