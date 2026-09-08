import { createHmac, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { getDiscordClient } from "../bot/client.js";
import { env } from "../env.js";
import { publicBaseUrl } from "../scrims/links.js";
import { getScrim, listInvites, type Scrim } from "../scrims/store.js";

export const DROP_COOKIE = "drop_player";
const OAUTH_COOKIE = "drop_oauth";

export type MapAccess = {
  userId: string;
  teamName: string;
  dropped: boolean;
  canClaim: boolean;
  isStaff: boolean;
};

function redirectUri(): string {
  return `${publicBaseUrl()}/api/auth/discord/callback`;
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
          redirectUri(),
      );
    return;
  }
  const nonce = randomUUID();
  const payload = `${nonce}|${kind}|${scrimId}`;
  res.cookie(OAUTH_COOKIE, `${payload}.${signState(payload)}`, {
    httpOnly: true,
    signed: true,
    sameSite: "lax",
    secure: env.isProduction,
    maxAge: 10 * 60 * 1000,
  });
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", env.discordClientId);
  url.searchParams.set("redirect_uri", redirectUri());
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
  res.clearCookie(OAUTH_COOKIE);
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
      redirect_uri: redirectUri(),
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
    const allowed = await memberHasAdminRole(me.id);
    if (!allowed) {
      res.status(403).send("Seu cargo no Discord não libera o painel.");
      return;
    }
    res.cookie("scrim_session", `discord:${me.id}`, {
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      secure: env.isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect("/");
    return;
  }

  if (!scrimId || !getScrim(scrimId)) {
    res.status(404).send("Scrim não encontrada");
    return;
  }

  res.cookie(DROP_COOKIE, me.id, {
    httpOnly: true,
    signed: true,
    sameSite: "lax",
    secure: env.isProduction,
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.redirect(`/mapa/${scrimId}`);
}

export async function resolveMapAccess(
  req: Request,
  scrim: Scrim,
): Promise<
  | { ok: true; access: MapAccess }
  | { ok: false; status: 401 | 403; error: string; login?: boolean }
> {
  const userId = String(req.signedCookies?.[DROP_COOKIE] ?? "");
  if (!userId) {
    return { ok: false, status: 401, error: "Entre com Discord para abrir o mapa.", login: true };
  }
  const client = getDiscordClient();
  if (!client?.isReady() || !scrim.discord) {
    return { ok: false, status: 403, error: "Mapa indisponível agora." };
  }
  const guild = await client.guilds.fetch(scrim.guildId).catch(() => null);
  const member = await guild?.members.fetch(userId).catch(() => null);
  if (!member) {
    return { ok: false, status: 403, error: "Você não está no servidor desta scrim." };
  }

  const roleIds = [...member.roles.cache.keys()];
  const hasCheckin = roleIds.includes(scrim.discord.registeredRoleId);
  const isStaff = scrim.staffRoleIds.some((id) => roleIds.includes(id));
  if (!hasCheckin && !isStaff) {
    return {
      ok: false,
      status: 403,
      error: "Só quem tem o cargo de check-in desta scrim pode abrir o mapa.",
    };
  }

  const invite = listInvites(scrim.id).find((item) => item.discordUserId === userId);
  if (!hasCheckin && isStaff) {
    return {
      ok: true,
      access: {
        userId,
        teamName: "Staff",
        dropped: true,
        canClaim: false,
        isStaff: true,
      },
    };
  }
  if (!invite) {
    return { ok: false, status: 403, error: "Você não está na lista desta scrim." };
  }

  return {
    ok: true,
    access: {
      userId,
      teamName: invite.teamName,
      dropped: invite.dropped,
      canClaim: Boolean(scrim.dropsOpen),
      isStaff: false,
    },
  };
}

export async function memberHasAdminRole(userId: string): Promise<boolean> {
  if (env.adminRoleIds.length === 0) {
    return false;
  }
  const client = getDiscordClient();
  if (!client?.isReady()) {
    return false;
  }
  const guilds = env.discordGuildId
    ? [await client.guilds.fetch(env.discordGuildId).catch(() => null)]
    : [...client.guilds.cache.values()];
  for (const guild of guilds) {
    if (!guild) {
      continue;
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && env.adminRoleIds.some((id) => member.roles.cache.has(id))) {
      return true;
    }
  }
  return false;
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
