import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { centroidOf, pointInPolygon, type Vertex } from "./geometry.js";
import { publish } from "./live.js";
import { readJsonFile, repoPresetsDir, tryWriteJsonFile } from "./preset-files.js";

export const MODE_SIZE = {
  solo: 1,
  duo: 2,
  trio: 3,
  squad: 4,
} as const;

export type ScrimMode = keyof typeof MODE_SIZE;

export type PriorityWindow = {
  roleId: string;
  time: string;
  date: string;
};

export type DropKind = "poi" | "contested" | "locked";

export type DropVertex = {
  x: number;
  y: number;
};

export type DropClaim = {
  teamName: string;
  userId: string;
  displayName: string;
  avatarUrl: string;
};

export type DropSpot = {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: DropKind;
  vertices: DropVertex[];
  claims: DropClaim[];
  claimedByTeam: string | null;
  claimedByUserId: string | null;
  claimedByName: string | null;
  claimedByAvatarUrl: string | null;
};

export type DiscordLobby = {
  lobbyNumber: number;
  categoryId: string;
  registrationId: string;
  dropmapId: string;
  codeId: string;
  chatId: string;
  leaveId: string;
  fillId: string;
  adminId: string;
  registeredRoleId: string;
  confirmedRoleId: string;
  registrationMessageId: string | null;
  leaveMessageId: string | null;
  dropMapMessageId: string | null;
  fillVisible: boolean;
  fillChatOpen: boolean;
};

export type EmbedCopy = {
  title: string;
  description: string;
  color: string;
  footer: string;
};

export type ScrimEmbeds = {
  registration: EmbedCopy;
  dropmapOpen: EmbedCopy;
  dropmapClosed: EmbedCopy;
  leave: EmbedCopy;
  code: EmbedCopy;
};

export type ActivityLog = {
  id: string;
  at: string;
  scrimId: string | null;
  kind: string;
  summary: string;
  detail: string;
};

export type Scrim = {
  id: string;
  name: string;
  mode: ScrimMode;
  maxSlots: number;
  createdAt: string;
  accessRoleIds: string[];
  staffRoleIds: string[];
  windows: PriorityWindow[];
  leaveUntil: string;
  punishHours: number;
  guildId: string;
  guildName: string;
  mapImageUrl: string;
  matchCode: string;
  discord: DiscordLobby | null;
  drops: DropSpot[];
  templateId: string;
  templateName: string;
  dropsOpen: boolean;
  teamsPerDrop: number;
  maxContestedDrops: number;
  embeds: ScrimEmbeds;
};

export type MapTemplate = {
  id: string;
  name: string;
  mapImageUrl: string;
  drops: DropSpot[];
  createdAt: string;
  maxContestedDrops: number;
};

export type ScrimPreset = {
  id: string;
  name: string;
  createdAt: string;
  mode: ScrimMode;
  maxSlots: number;
  teamsPerDrop: number;
  maxContestedDrops: number;
  templateId: string;
  accessRoleIds: string[];
  staffRoleIds: string[];
  windows: PriorityWindow[];
  leaveUntil: string;
  punishHours: number;
};

export type Invite = {
  id: string;
  scrimId: string;
  discordUserId: string;
  displayName: string;
  teamName: string;
  createdAt: string;
  dropped: boolean;
  fortniteNick: string;
  droppedAt: string | null;
  dropName: string | null;
};

export type BlacklistEntry = {
  id: string;
  discordUserId: string;
  displayName: string;
  fortniteNick: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  scrimId: string;
};

type StoreFile = {
  scrims: Scrim[];
  invites: Invite[];
  templates: MapTemplate[];
  scrimPresets: ScrimPreset[];
  blacklist: BlacklistEntry[];
  logs: ActivityLog[];
};

export function dataDir(): string {
  const fromEnv = process.env.DATA_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (process.env.NODE_ENV === "production" && fs.existsSync("/data")) {
    return "/data";
  }
  return path.join(process.cwd(), "data");
}

function storeFilePath(): string {
  return path.join(dataDir(), "store.json");
}

let cache: StoreFile | null = null;

function defaultTemplates(): MapTemplate[] {
  return [
    {
      id: "island-current",
      name: "Ilha atual",
      mapImageUrl: "/maps/island.png",
      drops: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      maxContestedDrops: 14,
    },
  ];
}

function emptyStore(): StoreFile {
  return {
    scrims: [],
    invites: [],
    templates: defaultTemplates(),
    scrimPresets: [],
    blacklist: [],
    logs: [],
  };
}

export function defaultEmbeds(): ScrimEmbeds {
  return {
    registration: {
      title: "Check-in da closed",
      color: "#3ee0a2",
      footer: "{name}",
      description:
        "{windows}\n\n**{teams}/{max}** times já na lista.\n\n1. Clique em **Registrar**.\n2. Só você vê se deu certo.\n3. Depois disso o Discord libera o **chat** e o **mapa de drop**.\n4. Código da partida e getting-off só depois de **marcar o drop** no mapa.",
    },
    dropmapOpen: {
      title: "Marque seu drop no mapa",
      color: "#3b82f6",
      footer: "{name}",
      description:
        "Depois do check-in, falta **só marcar o drop**.\n\n1. Clique em **Abrir mapa** e entre com o **mesmo Discord** do servidor.\n2. Clique no drop e **confirme**.\n3. Pronto: o Discord libera **código** e **getting-off**.\n\nO mapa atualiza sozinho. Você pode trocar de drop até a staff fechar a marcação.",
    },
    dropmapClosed: {
      title: "Marcação fechada",
      color: "#111111",
      footer: "{name}",
      description:
        "A staff **fechou** a marcação. Quem já marcou continua vendo o mapa ao vivo. Código e getting-off só para quem já confirmou o drop.",
    },
    leave: {
      title: "Sair da scrim",
      color: "#ff5c5c",
      footer: "{name}",
      description:
        "Saída livre até **{leaveUntil}** (horário de Brasília).\nSe você confirmar a saída **depois** desse horário, entra na **blacklist da closed** por **{punishHours}h** e não faz check-in até acabar a punição.",
    },
    code: {
      title: "Código da partida",
      color: "#c8f542",
      footer: "{name}",
      description: "`{code}`",
    },
  };
}

export function applyEmbedVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

function normalizeEmbeds(raw?: Partial<ScrimEmbeds> | null): ScrimEmbeds {
  const base = defaultEmbeds();
  const pick = (key: keyof ScrimEmbeds): EmbedCopy => {
    const item = raw?.[key];
    return {
      title: item?.title?.trim() || base[key].title,
      description: item?.description?.trim() || base[key].description,
      color: item?.color?.trim() || base[key].color,
      footer: item?.footer?.trim() || base[key].footer,
    };
  };
  return {
    registration: pick("registration"),
    dropmapOpen: pick("dropmapOpen"),
    dropmapClosed: pick("dropmapClosed"),
    leave: pick("leave"),
    code: pick("code"),
  };
}

function legacySquare(x: number, y: number, radius = 3.2): Vertex[] {
  return [
    { x: x - radius, y: y - radius },
    { x: x + radius, y: y - radius },
    { x: x + radius, y: y + radius },
    { x: x - radius, y: y + radius },
  ];
}

export function listDropClaims(drop: Partial<DropSpot> | null | undefined): DropClaim[] {
  if (!drop) {
    return [];
  }
  if (Array.isArray(drop.claims) && drop.claims.length > 0) {
    return drop.claims.map((claim) => ({
      teamName: String(claim.teamName ?? ""),
      userId: String(claim.userId ?? ""),
      displayName: String(claim.displayName ?? claim.teamName ?? ""),
      avatarUrl: String(claim.avatarUrl ?? ""),
    }));
  }
  if (drop.claimedByTeam) {
    return [
      {
        teamName: drop.claimedByTeam,
        userId: String(drop.claimedByUserId ?? ""),
        displayName: String(drop.claimedByName ?? drop.claimedByTeam),
        avatarUrl: String(drop.claimedByAvatarUrl ?? ""),
      },
    ];
  }
  return [];
}

function applyClaims(drop: DropSpot, claims: DropClaim[]): DropSpot {
  const first = claims[0] ?? null;
  drop.claims = claims;
  drop.claimedByTeam = first?.teamName ?? null;
  drop.claimedByUserId = first?.userId ?? null;
  drop.claimedByName = first?.displayName ?? null;
  drop.claimedByAvatarUrl = first?.avatarUrl ?? null;
  return drop;
}

export function clampMaxContestedDrops(value: unknown): number {
  if (value == null || value === "") {
    return 999;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    return 0;
  }
  return Math.min(200, n);
}

export function contestedDropCount(drops: DropSpot[]): number {
  return drops.filter((drop) => listDropClaims(drop).length >= 2).length;
}

export function normalizeWindow(raw: Partial<PriorityWindow> | null | undefined): PriorityWindow {
  return {
    roleId: String(raw?.roleId ?? "").trim(),
    time: String(raw?.time ?? "").trim().slice(0, 5),
    date: String(raw?.date ?? "").trim().slice(0, 10),
  };
}

export function clampTeamsPerDrop(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    return 1;
  }
  return Math.min(20, n);
}

export function normalizeDrop(raw: Partial<DropSpot> & { radius?: number }): DropSpot {
  const vertices =
    Array.isArray(raw.vertices) && raw.vertices.length >= 3
      ? raw.vertices.map((vertex) => ({
          x: Number(vertex.x),
          y: Number(vertex.y),
        }))
      : legacySquare(Number(raw.x ?? 50), Number(raw.y ?? 50), Number(raw.radius ?? 3.2));
  const center = centroidOf(vertices);
  return applyClaims(
    {
      id: String(raw.id ?? randomUUID()),
      name: String(raw.name ?? "Drop"),
      x: center.x,
      y: center.y,
      kind: "poi",
      vertices,
      claims: [],
      claimedByTeam: null,
      claimedByUserId: null,
      claimedByName: null,
      claimedByAvatarUrl: null,
    },
    listDropClaims(raw),
  );
}

function normalizeScrim(raw: Scrim): Scrim {
  return {
    ...raw,
    accessRoleIds: raw.accessRoleIds ?? [],
    staffRoleIds: raw.staffRoleIds ?? [],
    windows: (raw.windows ?? []).map(normalizeWindow),
    leaveUntil: raw.leaveUntil ?? "",
    punishHours: raw.punishHours ?? 24,
    guildId: raw.guildId ?? "",
    guildName: raw.guildName ?? "",
    mapImageUrl: raw.mapImageUrl ?? "",
    matchCode: raw.matchCode ?? "",
    discord: raw.discord
      ? {
          ...raw.discord,
          leaveMessageId: raw.discord.leaveMessageId ?? null,
          dropMapMessageId: raw.discord.dropMapMessageId ?? null,
        }
      : null,
    drops: (raw.drops ?? []).map(normalizeDrop),
    templateId: raw.templateId ?? "",
    templateName: raw.templateName ?? "",
    dropsOpen: raw.dropsOpen !== false,
    teamsPerDrop: clampTeamsPerDrop(raw.teamsPerDrop),
    maxContestedDrops: clampMaxContestedDrops(raw.maxContestedDrops),
    embeds: normalizeEmbeds(raw.embeds),
  };
}

function normalizeTemplate(raw: MapTemplate): MapTemplate {
  return {
    id: raw.id || randomUUID(),
    name: raw.name || "Preset",
    mapImageUrl: raw.mapImageUrl || "/maps/island.png",
    drops: (raw.drops ?? []).map((drop) =>
      normalizeDrop({
        ...drop,
        claims: [],
        claimedByTeam: null,
        claimedByUserId: null,
        claimedByName: null,
        claimedByAvatarUrl: null,
      }),
    ),
    createdAt: raw.createdAt || new Date().toISOString(),
    maxContestedDrops: clampMaxContestedDrops(
      (raw as MapTemplate).maxContestedDrops == null ? 14 : raw.maxContestedDrops,
    ),
  };
}

function normalizeScrimPreset(raw: Partial<ScrimPreset>): ScrimPreset {
  return {
    id: raw.id || randomUUID(),
    name: String(raw.name ?? "Preset de scrim").trim() || "Preset de scrim",
    createdAt: raw.createdAt || new Date().toISOString(),
    mode: isScrimMode(String(raw.mode ?? "")) ? (raw.mode as ScrimMode) : "trio",
    maxSlots: Number.isInteger(raw.maxSlots) && (raw.maxSlots ?? 0) > 0 ? Number(raw.maxSlots) : 20,
    teamsPerDrop: clampTeamsPerDrop(raw.teamsPerDrop),
    maxContestedDrops: clampMaxContestedDrops(raw.maxContestedDrops),
    templateId: String(raw.templateId ?? ""),
    accessRoleIds: Array.isArray(raw.accessRoleIds) ? raw.accessRoleIds.map(String) : [],
    staffRoleIds: Array.isArray(raw.staffRoleIds) ? raw.staffRoleIds.map(String) : [],
    windows: (raw.windows ?? []).map(normalizeWindow),
    leaveUntil: String(raw.leaveUntil ?? ""),
    punishHours: Number.isInteger(raw.punishHours) ? Number(raw.punishHours) : 24,
  };
}

function mergeLast<T extends { id: string }>(lists: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) {
    for (const item of list) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

function mergeTemplates(lists: MapTemplate[][]): MapTemplate[] {
  const byId = new Map<string, MapTemplate>();
  for (const list of lists) {
    for (const item of list) {
      const next = normalizeTemplate(item);
      const current = byId.get(next.id);
      if (!current || next.drops.length >= current.drops.length) {
        byId.set(next.id, next);
      }
    }
  }
  return [...byId.values()];
}

function mapPresetsPath(base: string): string {
  return path.join(base, "map-presets.json");
}

function scrimPresetsPath(base: string): string {
  return path.join(base, "scrim-presets.json");
}

function readDisk(): StoreFile {
  try {
    const raw = fs.readFileSync(storeFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as StoreFile;
    const storeTemplates = Array.isArray(parsed.templates)
      ? parsed.templates.map(normalizeTemplate)
      : [];
    const repoTemplates = readJsonFile<MapTemplate[]>(
      mapPresetsPath(repoPresetsDir()),
      [],
    ).map(normalizeTemplate);
    const dataTemplates = readJsonFile<MapTemplate[]>(
      mapPresetsPath(dataDir()),
      [],
    ).map(normalizeTemplate);
    const templates = mergeTemplates([
      defaultTemplates(),
      repoTemplates,
      dataTemplates,
      storeTemplates,
    ]);
    const storeScrimPresets = Array.isArray(parsed.scrimPresets)
      ? parsed.scrimPresets.map(normalizeScrimPreset)
      : [];
    const repoScrimPresets = readJsonFile<ScrimPreset[]>(
      scrimPresetsPath(repoPresetsDir()),
      [],
    ).map(normalizeScrimPreset);
    const dataScrimPresets = readJsonFile<ScrimPreset[]>(
      scrimPresetsPath(dataDir()),
      [],
    ).map(normalizeScrimPreset);
    return {
      scrims: (parsed.scrims ?? []).map(normalizeScrim),
      invites: (parsed.invites ?? []).map((invite) => ({
        ...invite,
        dropped: Boolean(invite.dropped),
        fortniteNick: invite.fortniteNick ?? "",
        droppedAt: invite.droppedAt ?? null,
        dropName: invite.dropName ?? null,
      })),
      templates: templates.length > 0 ? templates : defaultTemplates(),
      scrimPresets: mergeLast([repoScrimPresets, dataScrimPresets, storeScrimPresets]),
      blacklist: parsed.blacklist ?? [],
      logs: parsed.logs ?? [],
    };
  } catch {
    const repoTemplates = readJsonFile<MapTemplate[]>(mapPresetsPath(repoPresetsDir()), []).map(
      normalizeTemplate,
    );
    const repoScrimPresets = readJsonFile<ScrimPreset[]>(
      scrimPresetsPath(repoPresetsDir()),
      [],
    ).map(normalizeScrimPreset);
    return {
      ...emptyStore(),
      templates: repoTemplates.length > 0 ? repoTemplates : defaultTemplates(),
      scrimPresets: repoScrimPresets,
    };
  }
}

function getStore(): StoreFile {
  if (!cache) {
    cache = readDisk();
  }
  return cache;
}

function persist(): void {
  const store = getStore();
  const filePath = storeFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, filePath);
  tryWriteJsonFile(mapPresetsPath(dataDir()), store.templates);
  tryWriteJsonFile(scrimPresetsPath(dataDir()), store.scrimPresets);
  tryWriteJsonFile(mapPresetsPath(repoPresetsDir()), store.templates);
  tryWriteJsonFile(scrimPresetsPath(repoPresetsDir()), store.scrimPresets);
  publish({ type: "store" });
}

export function addLog(input: {
  scrimId?: string | null;
  kind: string;
  summary: string;
  detail?: string;
}): ActivityLog {
  const store = getStore();
  const log: ActivityLog = {
    id: randomUUID(),
    at: new Date().toISOString(),
    scrimId: input.scrimId ?? null,
    kind: input.kind,
    summary: input.summary,
    detail: input.detail ?? input.summary,
  };
  store.logs = [log, ...(store.logs ?? [])].slice(0, 400);
  persist();
  return log;
}

export function listLogs(scrimId?: string, limit = 80): ActivityLog[] {
  const rows = (getStore().logs ?? []).filter((item) => !scrimId || item.scrimId === scrimId);
  return rows.slice(0, limit);
}

export function cloneDrops(drops: DropSpot[]): DropSpot[] {
  return drops.map((drop) =>
    normalizeDrop({
      ...drop,
      id: randomUUID(),
      claims: [],
      claimedByTeam: null,
      claimedByUserId: null,
      claimedByName: null,
      claimedByAvatarUrl: null,
    }),
  );
}

export function listTemplates(): MapTemplate[] {
  return getStore().templates.slice().sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export function getTemplate(id: string): MapTemplate | null {
  const template = getStore().templates.find((item) => item.id === id);
  return template ? normalizeTemplate(template) : null;
}

export function createTemplate(name: string, mapImageUrl = "/maps/island.png"): MapTemplate {
  const store = getStore();
  const template: MapTemplate = {
    id: randomUUID(),
    name: name.trim() || "Novo preset",
    mapImageUrl: mapImageUrl || "/maps/island.png",
    drops: [],
    createdAt: new Date().toISOString(),
    maxContestedDrops: 14,
  };
  store.templates.push(template);
  persist();
  return template;
}

export function importTemplate(raw: unknown): MapTemplate {
  if (!raw || typeof raw !== "object") {
    throw new Error("Arquivo JSON inválido");
  }
  const data = raw as Record<string, unknown>;
  if (data.kind != null && data.kind !== "build-closed-map-preset") {
    throw new Error("Este JSON não é um preset de mapa da closed");
  }
  const name = String(data.name ?? "").trim();
  if (!name) {
    throw new Error("O JSON precisa ter um nome de preset");
  }
  const dropsRaw = Array.isArray(data.drops) ? data.drops : [];
  if (dropsRaw.length === 0) {
    throw new Error("O JSON não tem nenhum drop para importar");
  }
  const mapImageUrl = String(data.mapImageUrl ?? "").trim() || "/maps/island.png";
  const template = createTemplate(name, mapImageUrl);
  return patchTemplate(template.id, {
    drops: dropsRaw.map((item) =>
      normalizeDrop({
        ...(item as Partial<DropSpot>),
        claims: [],
        claimedByTeam: null,
        claimedByUserId: null,
        claimedByName: null,
        claimedByAvatarUrl: null,
      }),
    ),
  });
}

export function patchTemplate(id: string, patch: Partial<MapTemplate>): MapTemplate {
  const store = getStore();
  const index = store.templates.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new Error("Preset não encontrado");
  }
  const current = normalizeTemplate(store.templates[index]!);
  const next = normalizeTemplate({ ...current, ...patch, id });
  store.templates[index] = next;
  if (next.drops.length > 0) {
    for (const scrim of store.scrims) {
      if (scrim.templateId === id && scrim.drops.length === 0) {
        scrim.drops = cloneDrops(next.drops);
        scrim.mapImageUrl = next.mapImageUrl || scrim.mapImageUrl;
      }
    }
  }
  persist();
  return next;
}

export function deleteTemplate(id: string): boolean {
  const store = getStore();
  const before = store.templates.length;
  store.templates = store.templates.filter((item) => item.id !== id);
  if (store.templates.length === before) {
    return false;
  }
  if (store.templates.length === 0) {
    store.templates = defaultTemplates();
  }
  persist();
  return true;
}

export function listScrimPresets(): ScrimPreset[] {
  return getStore()
    .scrimPresets.slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export function saveScrimPreset(input: Partial<ScrimPreset> & { name: string }): ScrimPreset {
  const store = getStore();
  const next = normalizeScrimPreset({
    ...input,
    id: input.id || randomUUID(),
    createdAt: input.createdAt || new Date().toISOString(),
  });
  const index = store.scrimPresets.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    store.scrimPresets[index] = next;
  } else {
    store.scrimPresets.push(next);
  }
  persist();
  return next;
}

export function deleteScrimPreset(id: string): boolean {
  const store = getStore();
  const before = store.scrimPresets.length;
  store.scrimPresets = store.scrimPresets.filter((item) => item.id !== id);
  if (store.scrimPresets.length === before) {
    return false;
  }
  persist();
  return true;
}

export function isScrimMode(value: string): value is ScrimMode {
  return value in MODE_SIZE;
}

export function teamCount(scrimId: string): number {
  return new Set(listInvites(scrimId).map((invite) => invite.teamName)).size;
}

export function nextLobbyNumber(guildId?: string): number {
  const numbers = getStore()
    .scrims.filter((scrim) => !guildId || scrim.guildId === guildId)
    .map((scrim) => scrim.discord?.lobbyNumber ?? 0)
    .filter((n) => n > 0);
  return (numbers.length ? Math.max(...numbers) : 0) + 1;
}

export function listScrims(): Scrim[] {
  return getStore().scrims.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getScrim(id: string): Scrim | null {
  const scrim = getStore().scrims.find((item) => item.id === id);
  return scrim ? normalizeScrim(scrim) : null;
}

export function findScrimForChannel(
  guildId: string,
  channelId: string,
  parentId?: string | null,
): Scrim | null {
  const inGuild = listScrims().filter((scrim) => scrim.guildId === guildId && scrim.discord);
  const hit = inGuild.find((scrim) => {
    const discord = scrim.discord!;
    const ids = [
      discord.categoryId,
      discord.registrationId,
      discord.dropmapId,
      discord.codeId,
      discord.chatId,
      discord.leaveId,
      discord.fillId,
      discord.adminId,
    ];
    return ids.includes(channelId) || discord.categoryId === parentId;
  });
  if (hit) {
    return hit;
  }
  return inGuild.length === 1 ? inGuild[0]! : null;
}

export function ensureScrimHasDrops(scrimId: string): Scrim | null {
  const scrim = getScrim(scrimId);
  if (!scrim) {
    return null;
  }
  if (scrim.drops.length > 0) {
    return scrim;
  }
  const template = getTemplate(scrim.templateId);
  if (!template || template.drops.length === 0) {
    return scrim;
  }
  return patchScrim(scrim.id, {
    drops: cloneDrops(template.drops),
    mapImageUrl: template.mapImageUrl || scrim.mapImageUrl,
  });
}

export function listInvites(scrimId: string): Invite[] {
  return getStore().invites.filter((invite) => invite.scrimId === scrimId);
}

export function listInvitesForUser(discordUserId: string): Array<Invite & { scrim: Scrim }> {
  const store = getStore();
  return store.invites
    .filter((invite) => invite.discordUserId === discordUserId)
    .map((invite) => {
      const scrim = store.scrims.find((item) => item.id === invite.scrimId);
      return scrim ? { ...invite, scrim: normalizeScrim(scrim) } : null;
    })
    .filter((row): row is Invite & { scrim: Scrim } => row !== null);
}

export function createScrim(input: {
  name: string;
  mode: ScrimMode;
  maxSlots: number;
  accessRoleIds: string[];
  staffRoleIds: string[];
  windows: PriorityWindow[];
  guildId: string;
  guildName: string;
  templateId: string;
  teamsPerDrop?: number;
  maxContestedDrops?: number;
}): Scrim {
  const template = getTemplate(input.templateId);
  if (!template) {
    throw new Error("Escolha um preset de mapa");
  }
  const store = getStore();
  const scrim: Scrim = {
    id: randomUUID(),
    name: input.name.trim(),
    mode: input.mode,
    maxSlots: input.maxSlots,
    createdAt: new Date().toISOString(),
    accessRoleIds: input.accessRoleIds,
    staffRoleIds: input.staffRoleIds,
    windows: input.windows,
    leaveUntil: "",
    punishHours: 24,
    guildId: input.guildId,
    guildName: input.guildName,
    mapImageUrl: template.mapImageUrl,
    matchCode: "",
    discord: null,
    drops: cloneDrops(template.drops),
    templateId: template.id,
    templateName: template.name,
    dropsOpen: true,
    teamsPerDrop: clampTeamsPerDrop(input.teamsPerDrop),
    maxContestedDrops: clampMaxContestedDrops(
      input.maxContestedDrops ?? template.maxContestedDrops,
    ),
    embeds: defaultEmbeds(),
  };
  store.scrims.push(scrim);
  persist();
  addLog({
    scrimId: scrim.id,
    kind: "scrim",
    summary: `Scrim criada: ${scrim.name}`,
    detail: `${scrim.mode} · ${scrim.maxSlots} times · ${scrim.guildName}`,
  });
  return scrim;
}

export function patchScrim(id: string, patch: Partial<Scrim>): Scrim {
  const store = getStore();
  const index = store.scrims.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new Error("Scrim não encontrada");
  }
  const current = normalizeScrim(store.scrims[index]!);
  const next = { ...current, ...patch, id };
  store.scrims[index] = next;
  persist();
  return next;
}

export function addInvite(input: {
  scrimId: string;
  discordUserId: string;
  displayName: string;
  teamName: string;
  fortniteNick: string;
}): Invite {
  const store = getStore();
  const scrim = store.scrims.find((item) => item.id === input.scrimId);
  if (!scrim) {
    throw new Error("Scrim não encontrada");
  }

  const teamName = input.teamName.trim();
  const fortniteNick = input.fortniteNick.trim() || input.displayName.trim();
  if (!teamName) {
    throw new Error("Informe o nome do time");
  }
  if (!fortniteNick) {
    throw new Error("Informe o nick do Fortnite");
  }
  const now = Date.now();
  if (
    store.blacklist.some(
      (entry) =>
        entry.discordUserId === input.discordUserId && Date.parse(entry.expiresAt) > now,
    )
  ) {
    throw new Error("Esse player está na blacklist da closed e não pode fazer check-in");
  }

  const already = store.invites.find(
    (invite) =>
      invite.scrimId === input.scrimId && invite.discordUserId === input.discordUserId,
  );
  if (already) {
    throw new Error("Esse player já está na lista");
  }

  const teamMembers = store.invites.filter(
    (invite) => invite.scrimId === input.scrimId && invite.teamName === teamName,
  );
  if (teamMembers.length >= MODE_SIZE[scrim.mode]) {
    throw new Error(`Esse time já está completo para ${scrim.mode}`);
  }

  const teams = new Set(
    store.invites
      .filter((invite) => invite.scrimId === input.scrimId)
      .map((invite) => invite.teamName),
  );
  if (!teams.has(teamName) && teams.size >= scrim.maxSlots) {
    throw new Error("A scrim já está no limite de times");
  }

  const invite: Invite = {
    id: randomUUID(),
    scrimId: input.scrimId,
    discordUserId: input.discordUserId,
    displayName: input.displayName,
    teamName,
    createdAt: new Date().toISOString(),
    dropped: false,
    fortniteNick,
    droppedAt: null,
    dropName: null,
  };
  store.invites.push(invite);
  persist();
  addLog({
    scrimId: input.scrimId,
    kind: "checkin",
    summary: `${input.displayName} fez check-in`,
    detail: `Nick ${fortniteNick} · ID ${input.discordUserId} · time ${teamName}`,
  });
  return invite;
}

export function removeInvite(scrimId: string, inviteId: string): boolean {
  const store = getStore();
  const before = store.invites.length;
  store.invites = store.invites.filter(
    (invite) => !(invite.scrimId === scrimId && invite.id === inviteId),
  );
  if (store.invites.length === before) {
    return false;
  }
  persist();
  return true;
}

export function removePlayer(scrimId: string, discordUserId: string): Invite | null {
  const store = getStore();
  const invite = store.invites.find(
    (item) => item.scrimId === scrimId && item.discordUserId === discordUserId,
  );
  if (!invite) {
    return null;
  }
  store.invites = store.invites.filter((item) => item.id !== invite.id);
  persist();
  addLog({
    scrimId,
    kind: "remove",
    summary: `${invite.displayName} saiu da lista`,
    detail: `ID ${invite.discordUserId} · nick ${invite.fortniteNick}`,
  });
  return invite;
}

export function markDropped(
  scrimId: string,
  discordUserId: string,
  dropName?: string,
): Invite | null {
  const store = getStore();
  const invite = store.invites.find(
    (item) => item.scrimId === scrimId && item.discordUserId === discordUserId,
  );
  if (!invite) {
    return null;
  }
  invite.dropped = true;
  invite.droppedAt = invite.droppedAt ?? new Date().toISOString();
  if (dropName) {
    invite.dropName = dropName;
  }
  persist();
  return invite;
}

export function findDropAt(scrimId: string, x: number, y: number, radius = 12): DropSpot | null {
  const scrim = getScrim(scrimId);
  if (!scrim) {
    return null;
  }
  const inside = [...scrim.drops]
    .reverse()
    .find((drop) => pointInPolygon(x, y, drop.vertices));
  if (inside) {
    return inside;
  }
  let best: DropSpot | null = null;
  let bestDist = radius;
  for (const drop of scrim.drops) {
    const dx = drop.x - x;
    const dy = drop.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist <= bestDist) {
      best = drop;
      bestDist = dist;
    }
  }
  return best;
}

export function claimDrop(
  scrimId: string,
  dropId: string,
  teamName: string,
  claimant: { userId: string; displayName: string; avatarUrl: string } | null,
): DropSpot {
  const store = getStore();
  const scrim = store.scrims.find((item) => item.id === scrimId);
  if (!scrim) {
    throw new Error("Scrim não encontrada");
  }
  const drop = scrim.drops.find((item) => item.id === dropId);
  if (!drop) {
    throw new Error("Drop não existe");
  }
  const limit = clampTeamsPerDrop(scrim.teamsPerDrop);
  const nextClaim: DropClaim = {
    teamName,
    userId: claimant?.userId ?? "",
    displayName: claimant?.displayName ?? teamName,
    avatarUrl: claimant?.avatarUrl ?? "",
  };
  const nextById = new Map(
    scrim.drops.map((item) => [
      item.id,
      listDropClaims(item).filter((claim) => claim.teamName !== teamName),
    ]),
  );
  const occupying = nextById.get(drop.id) ?? [];
  const contestCap = clampMaxContestedDrops(scrim.maxContestedDrops);
  if (occupying.length >= limit) {
    throw new Error(
      `Este drop já está no limite (${limit} time${limit === 1 ? "" : "s"}). Escolha outro drop.`,
    );
  }
  if (occupying.length >= 1 && limit > 1 && contestCap < 999) {
    const contestsNow = [...nextById.values()].filter((claims) => claims.length >= 2).length;
    if (occupying.length === 1 && contestsNow >= contestCap) {
      throw new Error(
        `O mapa já tem ${contestCap} disputa${contestCap === 1 ? "" : "s"} (drops com 2 times). Os outros drops ficam com 1 time só.`,
      );
    }
  }
  occupying.push(nextClaim);
  nextById.set(drop.id, occupying);
  for (const item of scrim.drops) {
    applyClaims(item, nextById.get(item.id) ?? []);
  }
  const now = new Date().toISOString();
  for (const invite of store.invites) {
    if (invite.scrimId === scrimId && invite.teamName === teamName) {
      invite.dropped = true;
      invite.dropName = drop.name;
      invite.droppedAt = now;
    }
  }
  persist();
  addLog({
    scrimId,
    kind: "drop",
    summary: `${claimant?.displayName || teamName} marcou ${drop.name}`,
    detail: `Time ${teamName} · drop ${drop.name} · ${listDropClaims(drop).length}/${limit} times`,
  });
  return drop;
}

export function getActiveBan(discordUserId: string): BlacklistEntry | null {
  pruneExpiredBans();
  const now = Date.now();
  return (
    getStore().blacklist.find(
      (entry) => entry.discordUserId === discordUserId && Date.parse(entry.expiresAt) > now,
    ) ?? null
  );
}

export function listBlacklist(): BlacklistEntry[] {
  pruneExpiredBans();
  const now = Date.now();
  return getStore()
    .blacklist.filter((entry) => Date.parse(entry.expiresAt) > now)
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

export function addBlacklist(input: {
  discordUserId: string;
  displayName: string;
  fortniteNick: string;
  reason: string;
  hours: number;
  scrimId: string;
}): BlacklistEntry {
  const store = getStore();
  const now = new Date();
  const entry: BlacklistEntry = {
    id: randomUUID(),
    discordUserId: input.discordUserId,
    displayName: input.displayName,
    fortniteNick: input.fortniteNick,
    reason: input.reason,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.hours * 60 * 60 * 1000).toISOString(),
    scrimId: input.scrimId,
  };
  store.blacklist.push(entry);
  persist();
  addLog({
    scrimId: input.scrimId,
    kind: "blacklist",
    summary: `${input.displayName} entrou na blacklist`,
    detail: `Nick ${input.fortniteNick} · ${input.hours}h · ${input.reason}`,
  });
  return entry;
}

function pruneExpiredBans(): void {
  const store = getStore();
  const now = Date.now();
  const next = store.blacklist.filter((entry) => Date.parse(entry.expiresAt) > now);
  if (next.length !== store.blacklist.length) {
    store.blacklist = next;
    persist();
  }
}

export function deleteScrim(id: string): Scrim | null {
  const store = getStore();
  const scrim = store.scrims.find((item) => item.id === id) ?? null;
  if (!scrim) {
    return null;
  }
  store.scrims = store.scrims.filter((item) => item.id !== id);
  store.invites = store.invites.filter((invite) => invite.scrimId !== id);
  persist();
  addLog({
    scrimId: id,
    kind: "scrim",
    summary: `Scrim apagada: ${scrim.name}`,
    detail: `ID ${id}`,
  });
  return normalizeScrim(scrim);
}
