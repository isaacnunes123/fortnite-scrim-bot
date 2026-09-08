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

A host precisa expor a porta (`PORT`, padrão `3000`) e ter as variáveis do `.env`. Com Docker:

```bash
docker build -t fortnite-scrim-bot .
docker run -p 3000:3000 --env-file .env fortnite-scrim-bot
```

## Estrutura

- `src/bot` — cliente Discord
- `src/web` — API + login do painel
- `web/` — interface no navegador
