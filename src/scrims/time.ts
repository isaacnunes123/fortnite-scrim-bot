import type { GuildMember, Role } from "discord.js";
import type { Scrim } from "./store.js";

export function clockMinutes(timeZone = "America/Sao_Paulo"): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function parseClock(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

export function memberRoleIds(member: GuildMember): string[] {
  return [...member.roles.cache.keys()];
}

export function canSeeScrim(roleIds: string[], scrim: Scrim): boolean {
  return scrim.accessRoleIds.some((roleId) => roleIds.includes(roleId));
}

export function canRegisterNow(
  roleIds: string[],
  scrim: Scrim,
): { ok: true } | { ok: false; reason: string } {
  if (!canSeeScrim(roleIds, scrim)) {
    return { ok: false, reason: "Você não tem cargo de acesso desta divisão." };
  }

  const now = clockMinutes();
  const matching = scrim.windows.filter((window) => roleIds.includes(window.roleId));
  if (matching.length > 0) {
    const opensAt = Math.min(...matching.map((window) => parseClock(window.time)));
    if (now < opensAt) {
      const hour = String(Math.floor(opensAt / 60)).padStart(2, "0");
      const minute = String(opensAt % 60).padStart(2, "0");
      return { ok: false, reason: `Seu horário de registro abre às ${hour}:${minute}.` };
    }
    return { ok: true };
  }

  const fallback = scrim.windows.find((window) => !window.roleId);
  if (!fallback) {
    return { ok: false, reason: "Seu cargo ainda não tem horário de registro." };
  }
  if (now < parseClock(fallback.time)) {
    return { ok: false, reason: `Quem não tem prioridade registra a partir das ${fallback.time}.` };
  }
  return { ok: true };
}

export function isLeavePunishable(scrim: Scrim): boolean {
  if (!scrim.leaveUntil) {
    return false;
  }
  return clockMinutes() > parseClock(scrim.leaveUntil);
}
