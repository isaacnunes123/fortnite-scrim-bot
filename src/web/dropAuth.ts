import type { Request } from "express";
import { addInvite, listInvites, type Scrim } from "../scrims/store.js";
import { fetchGuildMember } from "./discordRest.js";

export const DROP_COOKIE = "drop_player";

export {
  beginDiscordLogin,
  finishDiscordLogin,
  isStaffSession,
  memberHasAdminRole,
  explainAdminAccess,
} from "./staffAuth.js";

export type MapAccess = {
  userId: string;
  teamName: string;
  fortniteNick: string;
  dropped: boolean;
  canClaim: boolean;
  isStaff: boolean;
};

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

  let invite = listInvites(scrim.id).find((item) => item.discordUserId === userId) ?? null;
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

  const member = await fetchGuildMember(userId, scrim.guildId);
  const roleIds = member?.roles ?? [];
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
