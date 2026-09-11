import { env } from "../env.js";
import type { CheckinMember } from "../scrims/checkin.js";
import { addLog, findScrimForChannel, type Scrim } from "../scrims/store.js";
import { discordErrorMessage, discordRequest } from "../web/discordRest.js";
import { revealFillChannelViaRest, setFillChatOpenViaRest } from "../web/lobbyRest.js";
import { isHomeGuild } from "./guild.js";

export const FILL_SLASH_COMMANDS = [
  {
    name: "abrirvaga",
    description: "Liberar pedidos de fill (vaga) nesta lobby",
    type: 1,
    dm_permission: false,
  },
  {
    name: "fecharvaga",
    description: "Mutar / bloquear pedidos de fill nesta lobby",
    type: 1,
    dm_permission: false,
  },
] as const;

export type FillSlashName = (typeof FILL_SLASH_COMMANDS)[number]["name"];

export type SlashRegisterResult = {
  ok: boolean;
  detail: string;
};

let registerOnce: Promise<SlashRegisterResult> | null = null;

function isFillStaff(member: CheckinMember | null, scrim: Scrim): boolean {
  if (!member) {
    return false;
  }
  const allowed = new Set([...scrim.staffRoleIds, ...env.adminRoleIds]);
  return member.roleIds.some((id) => allowed.has(id));
}

export function isFillSlashCommand(name: string): name is FillSlashName {
  return name === "abrirvaga" || name === "fecharvaga";
}

export async function registerSlashCommandsViaRest(): Promise<SlashRegisterResult> {
  if (!env.discordToken || !env.discordClientId || !env.discordGuildId) {
    return {
      ok: false,
      detail: "DISCORD_TOKEN, DISCORD_CLIENT_ID ou DISCORD_GUILD_ID ausente.",
    };
  }
  const clear = await discordRequest("PUT", `/applications/${env.discordClientId}/commands`, []);
  if (!clear.ok) {
    return {
      ok: false,
      detail: discordErrorMessage(clear.body, `Falha ao limpar comandos globais (${clear.status}).`),
    };
  }
  const put = await discordRequest(
    "PUT",
    `/applications/${env.discordClientId}/guilds/${env.discordGuildId}/commands`,
    FILL_SLASH_COMMANDS,
  );
  if (!put.ok) {
    return {
      ok: false,
      detail: discordErrorMessage(
        put.body,
        `Falha ao registrar /abrirvaga e /fecharvaga no servidor (${put.status}).`,
      ),
    };
  }
  return {
    ok: true,
    detail: `Comandos slash /abrirvaga e /fecharvaga registrados no servidor ${env.discordGuildId}.`,
  };
}

export function ensureSlashCommandsRegistered(): Promise<SlashRegisterResult> {
  if (!registerOnce) {
    registerOnce = registerSlashCommandsViaRest()
      .then((result) => {
        if (!result.ok) {
          registerOnce = null;
        }
        return result;
      })
      .catch((error) => {
        registerOnce = null;
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "Falha ao registrar comandos slash.",
        };
      });
  }
  return registerOnce;
}

export async function executeFillSlashCommand(input: {
  commandName: string;
  guildId: string;
  channelId: string;
  parentId: string | null;
  member: CheckinMember | null;
}): Promise<string> {
  if (!isFillSlashCommand(input.commandName)) {
    throw new Error("Comando desconhecido.");
  }
  if (!input.channelId) {
    throw new Error("Use este comando no servidor, no canal da lobby.");
  }
  if (!isHomeGuild(input.guildId)) {
    throw new Error("Este bot só funciona no servidor da closed.");
  }
  const scrim = findScrimForChannel(input.guildId, input.channelId, input.parentId);
  if (!scrim?.discord) {
    throw new Error("Não achei a scrim deste canal. Use no fill, admin ou outro canal da lobby.");
  }
  if (!isFillStaff(input.member, scrim)) {
    throw new Error("Só staff desta scrim pode liberar ou mutar o fill.");
  }
  const open = input.commandName === "abrirvaga";
  if (open) {
    await revealFillChannelViaRest(scrim);
  }
  await setFillChatOpenViaRest(scrim, open);
  addLog({
    scrimId: scrim.id,
    kind: "fill",
    summary: open ? "Fill liberado" : "Fill bloqueado",
    detail: `${input.member?.displayName ?? "staff"} usou /${input.commandName}`,
  });
  const mention = `<#${scrim.discord.fillId}>`;
  return open
    ? `Fill liberado em ${mention}. Players já podem pedir vaga.`
    : `Fill mutado em ${mention}. Pedidos de vaga estão bloqueados.`;
}
