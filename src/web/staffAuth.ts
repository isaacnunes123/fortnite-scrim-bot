import { createHmac, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { cookieOptions, clearCookieOptions, env } from "../env.js";
import { discordRedirectUri } from "../scrims/links.js";
import { getScrim } from "../scrims/store.js";
import { fetchGuildMember } from "./discordRest.js";

export const COOKIE_NAME = "scrim_session";
const OAUTH_COOKIE = "drop_oauth";

function redirectUri(req: Request): string {
  return discordRedirectUri(req);
}

function signState(value: string): string {
  return createHmac("sha256", env.sessionSecret).update(value).digest("hex").slice(0, 24);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
        "Login Discord não configurado. No Developer Portal, copie o Client Secret e coloque DISCORD_CLIENT_SECRET na Vercel. Redirect: " +
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
    res.cookie(COOKIE_NAME, `discord:${me.id}`, cookieOptions(7 * 24 * 60 * 60 * 1000));
    res.redirect("/painel");
    return;
  }

  if (!scrimId || !getScrim(scrimId)) {
    res.status(404).send("Scrim não encontrada");
    return;
  }

  res.cookie("drop_player", me.id, cookieOptions(12 * 60 * 60 * 1000));
  res.redirect(`/mapa/${scrimId}`);
}

export async function explainAdminAccess(
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (env.adminRoleIds.length === 0) {
    return {
      ok: false,
      reason:
        "ADMIN_ROLE_IDS está vazio ou não é ID numérico. No Discord: Configurações → Avançado → Modo desenvolvedor. Depois, em Cargos, botão direito no cargo → Copiar ID. Cole na Vercel (e no host do bot, se houver).",
    };
  }
  if (!env.discordToken) {
    return {
      ok: false,
      reason:
        "DISCORD_TOKEN não está na Vercel. O site não precisa do gateway 24/7 para o login da staff, mas precisa do token para conferir seu cargo via API REST.",
    };
  }
  const member = await fetchGuildMember(userId);
  if (!member) {
    return {
      ok: false,
      reason: `Login ok, mas não te encontrei no servidor ${env.discordGuildId}. Entra nesse servidor com a mesma conta Discord do login e confira se o bot ainda está no servidor.`,
    };
  }
  if (env.adminRoleIds.some((id) => member.roles.includes(id))) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Te achei em ${member.guildName || "o servidor"}. Nenhum cargo bate com ADMIN_ROLE_IDS. Copie o ID do cargo (não o nome) e cole na Vercel, só números, separados por vírgula.`,
  };
}

export async function memberHasAdminRole(userId: string): Promise<boolean> {
  const check = await explainAdminAccess(userId);
  return check.ok;
}

export async function isStaffSession(req: Request): Promise<boolean> {
  const token = String(req.signedCookies?.[COOKIE_NAME] ?? "");
  if (!token) {
    return false;
  }
  if (token.startsWith("discord:")) {
    return memberHasAdminRole(token.slice("discord:".length));
  }
  return env.adminRoleIds.length === 0 && token === "admin";
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await isStaffSession(req))) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }
  next();
}
