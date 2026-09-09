import { env } from "../env.js";
import { dropMapUrl } from "../scrims/links.js";
import { dropMapMessagePayload } from "../scrims/lobbyPayloads.js";
import {
  claimDrop,
  getScrim,
  listInvites,
  markDropped,
  patchScrim,
} from "../scrims/store.js";
import {
  addMemberRole,
  discordRequest,
  fetchGuildMember,
  type DiscordMemberInfo,
} from "./discordRest.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fallbackAvatar(userId: string): string {
  return `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(userId || "0") % 5n)}.png`;
}

async function refreshDropMapRest(scrimId: string): Promise<void> {
  const live = getScrim(scrimId);
  if (!live?.discord) {
    return;
  }
  const payload = dropMapMessagePayload(live);
  if (live.discord.dropMapMessageId) {
    await discordRequest(
      "PATCH",
      `/channels/${live.discord.dropmapId}/messages/${live.discord.dropMapMessageId}`,
      payload,
    );
    return;
  }
  const result = await discordRequest("POST", `/channels/${live.discord.dropmapId}/messages`, payload);
  const id = String(asRecord(result.body)?.id ?? "").trim();
  if (/^\d{17,20}$/.test(id)) {
    patchScrim(live.id, {
      discord: { ...live.discord, dropMapMessageId: id },
    });
  }
}

async function notifyDropClaimed(
  userId: string,
  scrimName: string,
  dropName: string,
  teamName: string,
  scrimId: string,
  codeId: string,
  leaveId: string,
): Promise<void> {
  const dm = await discordRequest("POST", "/users/@me/channels", { recipient_id: userId });
  const channelId = String(asRecord(dm.body)?.id ?? "").trim();
  if (!/^\d{17,20}$/.test(channelId)) {
    return;
  }
  await discordRequest("POST", `/channels/${channelId}/messages`, {
    embeds: [
      {
        color: 0x3ee0a2,
        title: "Drop confirmado",
        description: [
          `**${dropName}** na scrim **${scrimName}**`,
          `Time / nick: **${teamName}**`,
          "",
          `Agora você vê <#${codeId}> e <#${leaveId}>.`,
          `Mapa: ${dropMapUrl(scrimId)}`,
        ].join("\n"),
      },
    ],
  });
}

export async function applyPlayerDropViaRest(
  scrimId: string,
  userId: string,
  dropId: string,
  options?: { ignoreClosed?: boolean },
) {
  const scrim = getScrim(scrimId);
  const invite = listInvites(scrimId).find((item) => item.discordUserId === userId);
  if (!scrim || !invite) {
    throw new Error("Você não está registrado nesta scrim");
  }
  if (!scrim.dropsOpen && !options?.ignoreClosed) {
    throw new Error("A staff fechou a marcação de drops");
  }

  const guildId = scrim.guildId || env.discordGuildId;
  let member: DiscordMemberInfo | null = null;
  if (guildId) {
    member = await fetchGuildMember(userId, guildId);
  }
  const displayName = member?.displayName || invite.displayName;
  const avatarUrl = member?.avatarUrl || fallbackAvatar(userId);
  const drop = claimDrop(scrimId, dropId, invite.teamName, {
    userId,
    displayName,
    avatarUrl,
  });

  const team = listInvites(scrimId).filter((item) => item.teamName === invite.teamName);
  for (const memberInvite of team) {
    markDropped(scrimId, memberInvite.discordUserId, drop.name);
    if (scrim.discord && guildId) {
      await addMemberRole(guildId, memberInvite.discordUserId, scrim.discord.confirmedRoleId).catch(
        () => undefined,
      );
    }
  }

  if (scrim.discord) {
    await refreshDropMapRest(scrim.id).catch(() => undefined);
    await notifyDropClaimed(
      userId,
      scrim.name,
      drop.name,
      invite.teamName,
      scrim.id,
      scrim.discord.codeId,
      scrim.discord.leaveId,
    ).catch(() => undefined);
  }

  return drop;
}
