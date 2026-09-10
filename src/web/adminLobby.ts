import { env } from "../env.js";
import { dropMapUrl } from "../scrims/links.js";
import { adminMessagePayload } from "../scrims/lobbyPayloads.js";
import {
  deleteRegistrationChannelViaRest,
  lockLobbyChatViaRest,
  teardownLobbyViaRest,
} from "../scrims/provisionRest.js";
import {
  deleteScrim,
  deleteTablesForScrim,
  expireUnmarkedCheckins,
  flushStore,
  getScrim,
  listInvites,
  patchScrim,
  teamCount,
  type Invite,
  type Scrim,
} from "../scrims/store.js";
import type { CheckinMember } from "../scrims/checkin.js";
import { discordRequest } from "./discordRest.js";
import { removePlayerFromLobbyViaRest } from "./lobbyRest.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isLobbyStaff(member: CheckinMember | null, scrim: Scrim): boolean {
  if (!member) {
    return false;
  }
  const allowed = new Set([...env.adminRoleIds, ...scrim.staffRoleIds]);
  return member.roleIds.some((id) => allowed.has(id));
}

async function sendDm(userId: string, content: string): Promise<boolean> {
  const dm = await discordRequest("POST", "/users/@me/channels", { recipient_id: userId });
  const channelId = String(asRecord(dm.body)?.id ?? "").trim();
  if (!/^\d{17,20}$/.test(channelId)) {
    return false;
  }
  const sent = await discordRequest("POST", `/channels/${channelId}/messages`, { content });
  return sent.ok;
}

export async function processExpiredDropDeadlines(): Promise<Invite[]> {
  const expired = expireUnmarkedCheckins();
  for (const invite of expired) {
    const scrim = getScrim(invite.scrimId);
    if (scrim) {
      await removePlayerFromLobbyViaRest(scrim, invite.discordUserId).catch(() => undefined);
    }
    await sendDm(
      invite.discordUserId,
      "Seu check-in foi desfeito: você não marcou e confirmou o drop em **3 minutos**. Pode registrar de novo só depois de **3 minutos**.",
    ).catch(() => undefined);
  }
  if (expired.length > 0) {
    await flushStore().catch(() => undefined);
  }
  return expired;
}

export async function closeRegistrationIfFull(scrim: Scrim): Promise<void> {
  const live = getScrim(scrim.id) ?? scrim;
  if (!live.discord || live.discord.registrationClosed || teamCount(live.id) < live.maxSlots) {
    return;
  }
  await deleteRegistrationChannelViaRest(live);
  patchScrim(live.id, {
    discord: {
      ...live.discord,
      registrationId: "",
      registrationMessageId: null,
      registrationClosed: true,
    },
  });
}

export async function ensureAdminPanel(scrim: Scrim): Promise<void> {
  if (!scrim.discord?.adminId || scrim.discord.adminPanelAt) {
    return;
  }
  await discordRequest(
    "POST",
    `/channels/${scrim.discord.adminId}/messages`,
    adminMessagePayload(scrim.id, Boolean(scrim.discord.chatLocked)),
  );
  patchScrim(scrim.id, {
    discord: { ...scrim.discord, adminPanelAt: new Date().toISOString() },
  });
}

async function refreshAdminPanel(scrim: Scrim): Promise<void> {
  if (!scrim.discord?.adminId) {
    return;
  }
  await discordRequest(
    "POST",
    `/channels/${scrim.discord.adminId}/messages`,
    adminMessagePayload(scrim.id, Boolean(scrim.discord.chatLocked)),
  );
}

export async function handleAdminButton(
  action: string,
  scrim: Scrim,
  member: CheckinMember | null,
): Promise<{ ok: boolean; content: string; extra?: { components?: unknown[] } }> {
  if (!isLobbyStaff(member, scrim)) {
    return { ok: false, content: "Só staff pode usar este painel." };
  }
  if (action === "nagdrop") {
    const pending = listInvites(scrim.id).filter((invite) => !invite.dropped);
    let sent = 0;
    for (const invite of pending) {
      const ok = await sendDm(
        invite.discordUserId,
        `Você fez check-in em **${scrim.name}** e ainda **não marcou o drop**. Abra o mapa e confirme: ${dropMapUrl(scrim.id)}`,
      );
      if (ok) {
        sent += 1;
      }
    }
    if (scrim.discord?.adminId && pending.length) {
      const mentions = pending.map((invite) => `<@${invite.discordUserId}>`).join(" ");
      await discordRequest("POST", `/channels/${scrim.discord.adminId}/messages`, {
        content: `Sem drop (${pending.length}): ${mentions}`.slice(0, 1900),
      }).catch(() => undefined);
    }
    return { ok: true, content: pending.length ? `Avisados ${sent}/${pending.length} sem drop.` : "Todos que deram check-in já marcaram drop." };
  }
  if (action === "nagcode") {
    if (!scrim.discord) {
      return { ok: false, content: "Lobby Discord indisponível." };
    }
    const marked = listInvites(scrim.id).filter((invite) => invite.dropped);
    let sent = 0;
    for (const invite of marked) {
      const ok = await sendDm(
        invite.discordUserId,
        `Confira <#${scrim.discord.codeId}> para entrar na scrim **${scrim.name}**.`,
      );
      if (ok) {
        sent += 1;
      }
    }
    return { ok: true, content: marked.length ? `DM de código enviada para ${sent}/${marked.length}.` : "Ninguém marcou drop ainda." };
  }
  if (action === "lockchat") {
    if (!scrim.discord) {
      return { ok: false, content: "Lobby Discord indisponível." };
    }
    const locked = !scrim.discord.chatLocked;
    await lockLobbyChatViaRest(scrim, locked);
    const updated = patchScrim(scrim.id, {
      discord: { ...scrim.discord, chatLocked: locked },
    });
    await refreshAdminPanel(updated).catch(() => undefined);
    return { ok: true, content: locked ? "Chat da lobby bloqueado." : "Chat da lobby liberado." };
  }
  if (action === "finish") {
    return {
      ok: true,
      content: "Isso apaga os canais no Discord e **mantém** o mapa e a tabela no site. Confirma?",
      extra: {
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 2, custom_id: `finishyes:${scrim.id}`, label: "Confirmar finalizar" },
              { type: 2, style: 2, custom_id: `finishno:${scrim.id}`, label: "Cancelar" },
            ],
          },
        ],
      },
    };
  }
  if (action === "finishyes") {
    await teardownLobbyViaRest(scrim);
    patchScrim(scrim.id, {
      discord: null,
      provisionStatus: "finished",
      provisionError: null,
    });
    await flushStore();
    return { ok: true, content: "Scrim finalizada. Canais apagados. Mapa e tabela continuam no site." };
  }
  if (action === "finishno") {
    return { ok: true, content: "Finalizar cancelado." };
  }
  if (action === "kill") {
    return {
      ok: true,
      content: "Isso apaga os canais **e** remove a scrim do site (mapas e tabelas vinculadas). Confirma?",
      extra: {
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 4, custom_id: `killyes:${scrim.id}`, label: "Confirmar exclusão" },
              { type: 2, style: 2, custom_id: `killno:${scrim.id}`, label: "Cancelar" },
            ],
          },
        ],
      },
    };
  }
  if (action === "killyes") {
    await teardownLobbyViaRest(scrim);
    deleteTablesForScrim(scrim.id);
    deleteScrim(scrim.id);
    await flushStore();
    return { ok: true, content: "Scrim excluída: Discord, mapa e tabelas vinculadas." };
  }
  if (action === "killno") {
    return { ok: true, content: "Exclusão cancelada." };
  }
  return { ok: false, content: "Ação desconhecida." };
}
