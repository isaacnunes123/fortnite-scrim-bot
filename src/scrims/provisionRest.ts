import { env } from "../env.js";
import {
  DiscordRestError,
  discordErrorCode,
  discordErrorMessage,
  discordRequest,
  fetchBotUserId,
  fetchGuildName,
} from "../web/discordRest.js";
import {
  adminMessagePayload,
  dropMapMessagePayload,
  fillMessagePayload,
  leaveMessagePayload,
  lobbyChannelNames,
  registrationMessagePayload,
  type DiscordMessagePayload,
} from "./lobbyPayloads.js";
import {
  addLog,
  flushStore,
  getScrim,
  nextLobbyNumber,
  patchScrim,
  type DiscordLobby,
  type Scrim,
} from "./store.js";

const CHANNEL_CATEGORY = 4;
const CHANNEL_TEXT = 0;
const OVERWRITE_ROLE = 0;
const OVERWRITE_MEMBER = 1;

const PERM = {
  administrator: 1n << 3n,
  manageChannels: 1n << 4n,
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  manageMessages: 1n << 13n,
  embedLinks: 1n << 14n,
  manageRoles: 1n << 28n,
};

const VIEW = PERM.viewChannel;
const VIEW_SEND = PERM.viewChannel | PERM.sendMessages;
const BOT_ALLOW =
  PERM.viewChannel | PERM.sendMessages | PERM.manageChannels | PERM.manageMessages | PERM.embedLinks;

export class DiscordProvisionError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "DiscordProvisionError";
    this.status = status;
  }
}

const MISSING_PERMS =
  "O bot não tem permissão para criar canais ou cargos. No servidor: Configurações → Cargos → cargo do bot → marque Gerenciar Canais e Gerenciar Cargos. O cargo do bot precisa ficar acima dos cargos da divisão.";

export function explainDiscordError(error: unknown): string {
  if (error instanceof DiscordProvisionError || error instanceof DiscordRestError) {
    return error.message;
  }
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (/missing permissions|50013/i.test(text)) {
    return MISSING_PERMS;
  }
  if (/30013/.test(text)) {
    return "O servidor chegou no limite de canais do Discord. Apague categorias antigas de lobby e tente de novo.";
  }
  if (/30005/.test(text)) {
    return "O servidor chegou no limite de cargos do Discord. Apague cargos antigos de lobby (lobby-N-in / lobby-N-ready) e tente de novo.";
  }
  return text || "Não foi possível criar a categoria no Discord";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsePerms(value: unknown): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function overwrite(id: string, type: 0 | 1, allow: bigint, deny: bigint = 0n) {
  return {
    id,
    type,
    allow: allow.toString(),
    deny: deny.toString(),
  };
}

function everyoneDeny(guildId: string) {
  return overwrite(guildId, OVERWRITE_ROLE, 0n, VIEW_SEND);
}

function botAllow(botId: string) {
  return overwrite(botId, OVERWRITE_MEMBER, BOT_ALLOW);
}

function roleView(roleId: string, send: boolean) {
  return send
    ? overwrite(roleId, OVERWRITE_ROLE, VIEW_SEND)
    : overwrite(roleId, OVERWRITE_ROLE, VIEW, PERM.sendMessages);
}

function requireSnowflake(value: unknown, label: string): string {
  const id = String(value ?? "").trim();
  if (!/^\d{17,20}$/.test(id)) {
    throw new DiscordProvisionError(`Discord REST não devolveu um ${label} válido.`, 502);
  }
  return id;
}

function throwDiscord(result: { ok: boolean; status: number; body: unknown }, fallback: string): void {
  if (result.ok) {
    return;
  }
  const code = discordErrorCode(result.body);
  if (result.status === 401) {
    throw new DiscordRestError(
      "DISCORD_TOKEN rejeitado pelo Discord. Confira o token do bot na Vercel.",
      401,
    );
  }
  if (result.status === 403 || code === 50013 || code === 50001) {
    throw new DiscordRestError(MISSING_PERMS, 403);
  }
  if (code === 30013) {
    throw new DiscordProvisionError(
      "O servidor chegou no limite de canais do Discord. Apague categorias antigas de lobby e tente de novo.",
      400,
    );
  }
  if (code === 30005) {
    throw new DiscordProvisionError(
      "O servidor chegou no limite de cargos do Discord. Apague cargos antigos de lobby (lobby-N-in / lobby-N-ready) e tente de novo.",
      400,
    );
  }
  const detail = discordErrorMessage(result.body, fallback);
  throw new DiscordProvisionError(detail, result.status >= 400 ? result.status : 502);
}

export type DiscordGuildContext = {
  botId: string;
  guildId: string;
  guildName: string;
};

export async function fetchDiscordGuildContext(): Promise<DiscordGuildContext> {
  if (!env.discordToken) {
    throw new DiscordRestError(
      "DISCORD_TOKEN não está na Vercel. A criação da categoria usa a API REST do Discord (Gerenciar Canais / Gerenciar Cargos), sem precisar do Railway.",
      503,
    );
  }
  if (!env.discordGuildId) {
    throw new DiscordRestError("DISCORD_GUILD_ID não está configurado.", 503);
  }

  const botId = await fetchBotUserId();
  const guild = await discordRequest("GET", `/guilds/${env.discordGuildId}`);
  if (!guild.ok) {
    throwDiscord(guild, `O bot não consegue ler o servidor ${env.discordGuildId}. Convide o bot para esse servidor.`);
  }
  const guildName =
    String(asRecord(guild.body)?.name ?? "").trim() || (await fetchGuildName()) || env.discordGuildId;

  const member = await discordRequest("GET", `/guilds/${env.discordGuildId}/members/${botId}`);
  if (!member.ok) {
    throwDiscord(
      member,
      `O bot não está no servidor ${env.discordGuildId}. Convide o bot e marque Gerenciar Canais e Gerenciar Cargos.`,
    );
  }
  const memberRoles = Array.isArray(asRecord(member.body)?.roles)
    ? (asRecord(member.body)?.roles as unknown[]).map(String)
    : [];

  const roles = await discordRequest("GET", `/guilds/${env.discordGuildId}/roles`);
  if (roles.ok && Array.isArray(roles.body)) {
    let perms = 0n;
    for (const item of roles.body) {
      const record = asRecord(item);
      const id = String(record?.id ?? "");
      if (id === env.discordGuildId || memberRoles.includes(id)) {
        perms |= parsePerms(record?.permissions);
      }
    }
    const admin = (perms & PERM.administrator) === PERM.administrator;
    const missing: string[] = [];
    if (!admin && (perms & PERM.manageChannels) !== PERM.manageChannels) {
      missing.push("Gerenciar Canais");
    }
    if (!admin && (perms & PERM.manageRoles) !== PERM.manageRoles) {
      missing.push("Gerenciar Cargos");
    }
    if (missing.length > 0) {
      throw new DiscordRestError(
        `O bot precisa das permissões ${missing.join(" e ")} neste servidor para criar a categoria (check-in, mapa, código, chat, saída, fill e admin). Abra Configurações do servidor → Cargos → cargo do bot e marque essas permissões. O cargo do bot deve ficar acima dos cargos da divisão.`,
        403,
      );
    }
  }

  return { botId, guildId: env.discordGuildId, guildName };
}

type CreatedIds = {
  channels: string[];
  roles: string[];
};

async function createRole(guildId: string, name: string): Promise<string> {
  const result = await discordRequest("POST", `/guilds/${guildId}/roles`, {
    name,
    mentionable: false,
  });
  throwDiscord(result, `Não foi possível criar o cargo ${name}`);
  return requireSnowflake(asRecord(result.body)?.id, "cargo");
}

async function createChannel(
  guildId: string,
  input: {
    name: string;
    type: number;
    parent_id?: string;
    permission_overwrites: ReturnType<typeof overwrite>[];
  },
): Promise<string> {
  const result = await discordRequest("POST", `/guilds/${guildId}/channels`, input);
  throwDiscord(result, `Não foi possível criar o canal ${input.name}`);
  return requireSnowflake(asRecord(result.body)?.id, "canal");
}

async function createMessage(channelId: string, payload: DiscordMessagePayload): Promise<string> {
  const result = await discordRequest("POST", `/channels/${channelId}/messages`, payload);
  throwDiscord(result, "Não foi possível enviar a mensagem no canal da scrim");
  return requireSnowflake(asRecord(result.body)?.id, "id de mensagem");
}

async function teardownRest(guildId: string, created: CreatedIds): Promise<void> {
  for (const id of created.channels) {
    await discordRequest("DELETE", `/channels/${id}`).catch(() => undefined);
  }
  for (const id of created.roles) {
    await discordRequest("DELETE", `/guilds/${guildId}/roles/${id}`).catch(() => undefined);
  }
}

const provisioningIds = new Set<string>();

export async function provisionLobbyViaRest(scrim: Scrim): Promise<Scrim> {
  if (provisioningIds.has(scrim.id)) {
    const live = getScrim(scrim.id);
    if (live?.discord) {
      return live;
    }
  }
  provisioningIds.add(scrim.id);
  const created: CreatedIds = { channels: [], roles: [] };
  try {
    const ctx = await fetchDiscordGuildContext();
    const live = getScrim(scrim.id) ?? scrim;
    if (live.discord && live.provisionStatus === "ready") {
      return live;
    }

    const lobbyNumber = nextLobbyNumber(ctx.guildId);
    const names = lobbyChannelNames(lobbyNumber, live.name);
    const staff = live.staffRoleIds.map((roleId) => roleView(roleId, true));
    const accessView = live.accessRoleIds.map((roleId) => roleView(roleId, false));

    const [registeredRoleId, confirmedRoleId] = await Promise.all([
      createRole(ctx.guildId, names.registeredRole),
      createRole(ctx.guildId, names.confirmedRole),
    ]);
    created.roles.push(registeredRoleId, confirmedRoleId);

    const categoryId = await createChannel(ctx.guildId, {
      name: names.category,
      type: CHANNEL_CATEGORY,
      permission_overwrites: [everyoneDeny(ctx.guildId), botAllow(ctx.botId), ...accessView, ...staff],
    });
    created.channels.push(categoryId);

    const makeText = (name: string, extra: ReturnType<typeof overwrite>[]) =>
      createChannel(ctx.guildId, {
        name,
        type: CHANNEL_TEXT,
        parent_id: categoryId,
        permission_overwrites: [everyoneDeny(ctx.guildId), botAllow(ctx.botId), ...extra],
      });

    const [registrationId, dropmapId, codeId, chatId, leaveId, fillId, adminId] = await Promise.all([
      makeText(names.registration, [...accessView, ...staff]),
      makeText(names.dropmap, [roleView(registeredRoleId, false), ...staff]),
      makeText(names.code, [roleView(confirmedRoleId, false), ...staff]),
      makeText(names.chat, [roleView(registeredRoleId, true), ...staff]),
      makeText(names.leave, [roleView(confirmedRoleId, false), ...staff]),
      makeText(names.fill, [...staff]),
      makeText(names.admin, [...staff]),
    ]);
    created.channels.unshift(registrationId, dropmapId, codeId, chatId, leaveId, fillId, adminId);

    const discord: DiscordLobby = {
      lobbyNumber,
      categoryId,
      registrationId,
      dropmapId,
      codeId,
      chatId,
      leaveId,
      fillId,
      adminId,
      registeredRoleId,
      confirmedRoleId,
      registrationMessageId: null,
      leaveMessageId: null,
      dropMapMessageId: null,
      fillVisible: false,
      fillChatOpen: false,
    };

    const saved = patchScrim(live.id, {
      discord,
      guildId: ctx.guildId,
      guildName: ctx.guildName,
      provisionStatus: "pending",
      provisionError: null,
    });

    const [registerMsgId, leaveMsgId, dropMsgId] = await Promise.all([
      createMessage(registrationId, registrationMessagePayload(saved)),
      createMessage(leaveId, leaveMessagePayload(saved)),
      createMessage(dropmapId, dropMapMessagePayload(saved)),
    ]);
    await Promise.all([
      createMessage(fillId, fillMessagePayload(saved)),
      createMessage(adminId, adminMessagePayload()),
    ]);

    const ready = patchScrim(live.id, {
      discord: {
        ...discord,
        registrationMessageId: registerMsgId,
        leaveMessageId: leaveMsgId,
        dropMapMessageId: dropMsgId,
      },
      provisionStatus: "ready",
      provisionError: null,
    });
    addLog({
      scrimId: ready.id,
      kind: "scrim",
      summary: "Categoria criada no Discord",
      detail: `lobby ${ready.discord?.lobbyNumber ?? lobbyNumber} via REST`,
    });
    await flushStore();
    return ready;
  } catch (error) {
    const message = explainDiscordError(error);
    console.error("[lobby] provision REST:", error);
    await teardownRest(env.discordGuildId, created).catch(() => undefined);
    const live = getScrim(scrim.id);
    if (live) {
      patchScrim(scrim.id, {
        discord: null,
        provisionStatus: "failed",
        provisionError: message,
      });
      addLog({
        scrimId: scrim.id,
        kind: "scrim",
        summary: "Falha ao criar canais no Discord",
        detail: message,
      });
      await flushStore().catch((flushError) => {
        console.error("[lobby] flush após falha REST:", flushError);
      });
    }
    if (error instanceof DiscordRestError || error instanceof DiscordProvisionError) {
      throw error;
    }
    throw new DiscordProvisionError(message, 502);
  } finally {
    provisioningIds.delete(scrim.id);
  }
}
