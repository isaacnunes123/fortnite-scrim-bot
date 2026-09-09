import type { GuildMember } from "discord.js";
import type { PriorityWindow, Scrim } from "./store.js";

const ZONE = "America/Sao_Paulo";

export function clockMinutes(timeZone = ZONE): number {
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

export function parseBrasiliaDateTime(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00.000-03:00`);
}

export function formatWindowWhen(window: PriorityWindow): string {
  if (window.date && window.time) {
    const [year, month, day] = window.date.split("-");
    return `${day}/${month}/${year} às ${window.time}`;
  }
  return window.time;
}

export function formatLeaveUntil(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const [date, time] = value.split("T");
    const [year, month, day] = (date ?? "").split("-");
    return `${day}/${month}/${year} às ${(time ?? "").slice(0, 5)}`;
  }
  return value;
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
    return { ok: false, reason: "Você não tem o cargo desta divisão, então não entra nesta scrim." };
  }

  const matching = scrim.windows.filter((window) => roleIds.includes(window.roleId));
  const windows = matching.length > 0 ? matching : scrim.windows.filter((window) => !window.roleId);
  if (windows.length === 0) {
    return { ok: false, reason: "Seu cargo ainda não tem horário de check-in nesta scrim." };
  }

  const dated = windows.map((window) => ({
    window,
    at:
      window.date && window.time
        ? parseBrasiliaDateTime(window.date, window.time)
        : Date.now() - (clockMinutes() - parseClock(window.time)) * 60_000,
  }));
  dated.sort((a, b) => a.at - b.at);
  const first = dated[0]!;
  if (Date.now() < first.at) {
    return {
      ok: false,
      reason: `Seu check-in abre em ${formatWindowWhen(first.window)}.`,
    };
  }
  return { ok: true };
}

export function isLeavePunishable(scrim: Scrim): boolean {
  if (!scrim.leaveUntil) {
    return false;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(scrim.leaveUntil)) {
    const [date, time] = scrim.leaveUntil.split("T");
    return Date.now() > parseBrasiliaDateTime(date ?? "", (time ?? "").slice(0, 5));
  }
  return clockMinutes() > parseClock(scrim.leaveUntil);
}
