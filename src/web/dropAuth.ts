import { createHmac, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { getDiscordClient } from "../bot/client.js";
import { getGuild } from "../bot/guild.js";
import { cookieOptions, clearCookieOptions, env } from "../env.js";
import { discordRedirectUri } from "../scrims/links.js";
import { getScrim, listInvites, addInvite, type Scrim } from "../scrims/store.js";

export const DROP_COOKIE = "drop_player";
const OAUTH_COOKIE = "drop_oauth";

export type MapAccess = {
  userId: string;
  teamName: string;
  fortniteNick: string;
  dropped: boolean;
  canClaim: boolean;
  isStaff: boolean;
};

function redirectUri(req: Request): string {
  return discordRedirectUri(req);
}

function signState(value: string): string {
  return createHmac("sha256", env.sessionSecret).update(value).digest("hex").slice(0, 24);
}

export function beginDiscordLogin(req: Request, res: Response): void {
  const scrimId = String(req.query.scrim ?? "").trim();
  const kind = String(req.query.next ?? "") === "admin" ? "admin" : "map";
  if (kind === "map" && !getScrim(scrimId)) {
    res.status(404).send("Scrim não encontrada");
    return;
  }
  if (!env.discordClientId || !env.discordClientSecret) {
    res
      .status(503)
      .send(
        "Login Discord não configurado. No Developer Portal, copie o Client Secret e coloque DISCORD_CLIENT_SECRET. Redirect: " +
          redirectUri(req),
      );
    return;
  }
  const nonce = randomUUID();
  const payload = `${nonce}|${kind}|${scrimId}`;
  res.cookie(OAUTH_COOKIE, `${payload}.${signState(payload)}`, cookieOptions(10 * 60 * 1000));
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", env.discordClientId);
  url.searchParams.set("redirect_uri", redirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", nonce);
  res.redirect(url.toString());
}

export async function finishDiscordLogin(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  const raw = String(req.signedCookies?.[OAUTH_COOKIE] ?? "");
  const [payload, signature] = raw.split(".");
  const [nonce, kind, scrimId] = (payload ?? "").split("|");
  res.clearCookie(OAUTH_COOKIE, clearCookieOptions);
  if (!code || !payload || signature !== signState(payload) || nonce !== state) {
    res.status(400).send("Login Discord inválido. Tente de novo.");
    return;
  }

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.discordClientId,
      client_secret: env.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(req),
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenJson.access_token) {
    res.status(400).send("Não foi possível autenticar no Discord.");
    return;
  }

  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const me = (await meRes.json()) as { id?: string };
  if (!me.id) {
    res.status(400).send("Não foi possível ler sua conta Discord.");
    return;
  }

  if (kind === "admin") {
    const check = await explainAdminAccess(me.id);
    if (!check.ok) {
      res.status(403).type("html").send(
        `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:32px;max-width:560px">
        <p>${escapeHtml(check.reason)}</p>
        <p><a href="/painel">Voltar ao painel</a></p></body>`,
      );
      return;
    }
    res.cookie("scrim_session", `discord:${me.id}`, cookieOptions(7 * 24 * 60 * 60 * 1000));
    res.redirect("/painel");
    return;
  }

  if (!scrimId || !getScrim(scrimId)) {
    res.status(404).send("Scrim não encontrada");
    return;
  }

  res.cookie(DROP_COOKIE, me.id, cookieOptions(12 * 60 * 60 * 1000));
  res.redirect(`/mapa/${scrimId}`);
}

function mapUserId(req: Request): string {
  const signed = String(req.signedCookies?.[DROP_COOKIE] ?? "").trim();
  if (signed) {
    return signed;
  }
  const session = String(req.signedCookies?.scrim_session ?? "").trim();
  if (session.startsWith("discord:")) {
    return session.slice("discord:".length);
  }
  return "";
}

export async function resolveMapAccess(
  req: Request,
  scrim: Scrim,
): Promise<
  | { ok: true; access: MapAccess }
  | { ok: false; status: 401 | 403; error: string; login?: boolean }
> {
  const userId = mapUserId(req);
  if (!userId) {
    return { ok: false, status: 401, error: "Entre com Discord para abrir o mapa.", login: true };
  }
  const client = getDiscordClient();
  if (!client?.isReady() || !scrim.discord) {
    return { ok: false, status: 403, error: "Mapa indisponível agora." };
  }
  const guild = await client.guilds.fetch(scrim.guildId).catch(() => null);
  const member = await guild?.members
    .fetch({ user: userId, force: true })
    .catch(() => null);

  let invite = listInvites(scrim.id).find((item) => item.discordUserId === userId) ?? null;
  const roleIds = member ? [...member.roles.cache.keys()] : [];
  const hasCheckinRole = Boolean(
    scrim.discord && roleIds.includes(scrim.discord.registeredRoleId),
  );
  const isStaff = scrim.staffRoleIds.some((id) => roleIds.includes(id));

  if (!invite && member && hasCheckinRole) {
    try {
      invite = addInvite({
        scrimId: scrim.id,
        discordUserId: member.id,
        displayName: member.displayName,
        teamName: member.displayName.slice(0, 32),
        fortniteNick: member.displayName,
      });
    } catch {
      invite = listInvites(scrim.id).find((item) => item.discordUserId === userId) ?? null;
    }
  }

  if (invite) {
    return {
      ok: true,
      access: {
        userId,
        teamName: invite.teamName,
        fortniteNick: invite.fortniteNick || invite.displayName,
        dropped: invite.dropped,
        canClaim: Boolean(scrim.dropsOpen),
        isStaff: false,
      },
    };
  }

  if (isStaff) {
    return {
      ok: true,
      access: {
        userId,
        teamName: "Staff",
        fortniteNick: "Staff",
        dropped: true,
        canClaim: false,
        isStaff: true,
      },
    };
  }

  return {
    ok: false,
    status: 403,
    error: member
      ? "Só quem fez check-in nesta scrim pode abrir o mapa."
      : "Você não está no servidor desta scrim.",
  };
}

export async function memberHasAdminRole(userId: string): Promise<boolean> {
  const check = await explainAdminAccess(userId);
  return check.ok;
}

export async function explainAdminAccess(
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (env.adminRoleIds.length === 0) {
    return {
      ok: false,
      reason:
        "ADMIN_ROLE_IDS no Railway está vazio ou não é ID numérico. No Discord: Configurações → Avançado → Modo desenvolvedor. Depois, em Cargos, botão direito no cargo → Copiar ID.",
    };
  }
  const client = getDiscordClient();
  if (!client?.isReady()) {
    return { ok: false, reason: "Bot Discord offline no Railway. Confira DISCORD_TOKEN." };
  }
  await client.guilds.fetch().catch(() => undefined);
  const guild = getGuild(client);
  if (!guild) {
    return {
      ok: false,
      reason: `O bot precisa estar no servidor ${env.discordGuildId}.`,
    };
  }

  const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  if (!member) {
    return {
      ok: false,
      reason: `Login ok, mas o bot não te encontrou em ${guild.name}. Entra nesse servidor com a mesma conta Discord do login.`,
    };
  }
  if (env.adminRoleIds.some((id) => member.roles.cache.has(id))) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Te achei em ${guild.name}. Nenhum cargo bate com ADMIN_ROLE_IDS. Copie o ID do cargo (não o nome) e cole no Railway, só números, separados por vírgula.`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function isStaffSession(req: Request): Promise<boolean> {
  const token = String(req.signedCookies?.scrim_session ?? "");
  if (!token) {
    return false;
  }
  if (token.startsWith("discord:")) {
    return memberHasAdminRole(token.slice("discord:".length));
  }
  return env.adminRoleIds.length === 0 && token === "admin";
}
