import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import express, { type Express, type Request, type Response } from "express";
import { clearCookieOptions, env } from "../env.js";
import { discordRedirectUri, isAllowedPublicHost, publicBaseUrl } from "../scrims/links.js";
import { DEFAULT_MAP_URL, persistMapImage, readPersistedMap, resolvePublicMapUrl } from "../scrims/maps.js";
import { usesRemoteStore } from "../scrims/durable.js";
import {
  ensureStore,
  flushStore,
  persistenceMode,
  pullRemoteStore,
  storeRemoteError,
  createTable,
  createTemplate,
  deleteTable,
  deleteTemplate,
  deleteScrim,
  deleteScrimPreset,
  deleteTablesForScrim,
  findScrimForChannel,
  getScrim,
  getTable,
  getTemplate,
  importTemplate,
  listBlacklist,
  listInvites,
  listLogs,
  listScrimPresets,
  listScrims,
  listTables,
  listTemplates,
  MODE_SIZE,
  normalizeDrop,
  patchTable,
  patchTemplate,
  removeBlacklist,
  saveScrimPreset,
  teamCount,
  clampMaxContestedDrops,
  clampTeamsPerDrop,
  createScrim,
  ensureScrimHasDrops,
  findDropAt,
  isScrimMode,
  type PriorityWindow,
  type PublicTable,
} from "../scrims/store.js";
import {
  DiscordProvisionError,
  explainDiscordError,
  fetchDiscordGuildContext,
  provisionLobbyViaRest,
  teardownLobbyViaRest,
} from "../scrims/provisionRest.js";
import { getPublicBoard, listPublicBoards, saveYuniteTournamentId } from "./publicTables.js";
import { listYuniteTournaments, yuniteConfigured } from "../yunite/client.js";
import {
  beginDiscordLogin,
  COOKIE_NAME,
  finishDiscordLogin,
  isBotInternalRequest,
  isStaffSession,
  requireAuth,
} from "./staffAuth.js";
import { DiscordRestError, fetchGuildRoles } from "./discordRest.js";
import { handleDiscordHttpInteraction } from "./discordInteractions.js";
import { processExpiredDropDeadlines, ensureAdminPanel } from "./adminLobby.js";
import { readFreshBotHeartbeat } from "../bot/heartbeat.js";
import { resolveMapAccess } from "./dropAuth.js";
import { applyPlayerDropViaRest } from "./dropRest.js";
import { registerStaffRestRoutes } from "./staffRest.js";

export type BotPresence = "online" | "offline" | "unknown";

export type BotStatusPayload = {
  configured: boolean;
  ready: boolean;
  presence: BotPresence;
  username: string | null;
  id: string | null;
  guildCount: number;
  uptimeMs: number | null;
  source?: "local" | "process" | "heartbeat" | "none";
  botProcessUrlConfigured?: boolean;
  note?: string;
};

export type SiteRouteOptions = {
  botStatus?: () => BotStatusPayload;
};

export function fail(res: Response, error: unknown, fallback: string): void {
  const message = error instanceof Error ? error.message : fallback;
  res.status(400).json({ error: message });
}

async function commitJson(res: Response, status: number, body: unknown): Promise<void> {
  try {
    await flushStore();
  } catch (error) {
    fail(res, error, "Não foi possível gravar no banco");
    return;
  }
  res.status(status).json(body);
}

export function withLiveMap<T extends { mapImageUrl: string }>(item: T): T {
  return { ...item, mapImageUrl: resolvePublicMapUrl(item.mapImageUrl).url };
}

export function tablePayload(body: Record<string, unknown> | undefined): {
  name?: string;
  description?: string;
  mode?: string;
  live?: boolean;
  scrimId?: string;
  kind?: string;
  category?: string;
  yuniteTournamentId?: string;
  rows?: unknown[];
} {
  const kind = String(body?.kind ?? "manual") === "yunite" ? "yunite" : "manual";
  let yuniteTournamentId = String(body?.yuniteTournamentId ?? "").trim();
  if (kind === "yunite") {
    yuniteTournamentId = saveYuniteTournamentId(yuniteTournamentId);
  } else {
    yuniteTournamentId = "";
  }
  return {
    name: body?.name != null ? String(body.name) : undefined,
    description: body?.description != null ? String(body.description) : undefined,
    mode: body?.mode != null ? String(body.mode) : undefined,
    live: body?.live == null ? undefined : Boolean(body.live),
    scrimId: body?.scrimId != null ? String(body.scrimId) : undefined,
    kind,
    category: body?.category != null ? String(body.category) : undefined,
    yuniteTournamentId,
    rows: Array.isArray(body?.rows) ? body.rows : undefined,
  };
}

export function parseWindows(raw: unknown): PriorityWindow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item) => {
    const row = item as PriorityWindow & { at?: string };
    const at = String(row.at ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) {
      const [date, time] = at.split("T");
      return {
        roleId: String(row.roleId ?? "").trim(),
        date: (date ?? "").slice(0, 10),
        time: (time ?? "").slice(0, 5),
      };
    }
    return {
      roleId: String(row.roleId ?? "").trim(),
      time: String(row.time ?? "").trim().slice(0, 5),
      date: String(row.date ?? "").trim().slice(0, 10),
    };
  });
}

export function offlineBotStatus(): BotStatusPayload {
  return {
    configured: false,
    ready: false,
    presence: "unknown",
    username: null,
    id: null,
    guildCount: 0,
    uptimeMs: null,
    source: "none",
    botProcessUrlConfigured: Boolean(env.botProcessUrl),
  };
}

function withPresence(
  status: Omit<BotStatusPayload, "presence"> & { presence?: BotPresence },
  presence: BotPresence,
  source: NonNullable<BotStatusPayload["source"]>,
  note?: string,
): BotStatusPayload {
    return {
    ...status,
    presence,
    ready: presence === "online",
    source,
    botProcessUrlConfigured: Boolean(env.botProcessUrl),
    note,
  };
}

function asBotStatusPayload(value: unknown): BotStatusPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const ready = Boolean(record.ready);
  const presence =
    record.presence === "online" || record.presence === "offline" || record.presence === "unknown"
      ? record.presence
      : ready
        ? "online"
        : "offline";
  return {
    configured: Boolean(record.configured ?? record.ready),
    ready,
    presence,
    username: typeof record.username === "string" ? record.username : null,
    id: typeof record.id === "string" ? record.id : null,
    guildCount: Number(record.guildCount) || 0,
    uptimeMs: record.uptimeMs == null ? null : Number(record.uptimeMs) || null,
  };
}

type ProcessProbe =
  | { kind: "ready" | "down"; status: BotStatusPayload }
  | { kind: "unset" }
  | { kind: "unreachable" };

async function probeBotProcess(): Promise<ProcessProbe> {
  if (!env.botProcessUrl) {
    return { kind: "unset" };
  }
  try {
    const response = await fetch(`${env.botProcessUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { kind: "unreachable" };
    }
    const status = asBotStatusPayload(await response.json());
    if (!status) {
      return { kind: "unreachable" };
    }
    return { kind: status.ready ? "ready" : "down", status };
  } catch {
    return { kind: "unreachable" };
  }
}

async function resolveBotStatus(local?: BotStatusPayload): Promise<BotStatusPayload> {
  if (local?.ready) {
    return withPresence(local, "online", "local");
  }
  const probe = await probeBotProcess();
  if (probe.kind === "ready") {
    return withPresence(probe.status, "online", "process");
  }
  const beat = await readFreshBotHeartbeat();
  if (beat?.ready) {
    return withPresence(beat, "online", "heartbeat");
  }
  if (probe.kind === "down") {
    return withPresence(
      probe.status,
      "offline",
      "process",
      "O processo do bot respondeu, mas o Discord não está conectado. Nos Deploy Logs do Railway procure por Logged in / DISCORD_TOKEN.",
    );
  }
  if (beat && !beat.ready) {
    return withPresence(
      beat,
      "offline",
      "heartbeat",
      "O host do bot está no ar, mas o gateway do Discord não. Veja DISCORD_TOKEN e os logs Logged in no Railway.",
    );
  }
  const base = local ?? offlineBotStatus();
  if (probe.kind === "unset") {
    return withPresence(
      { ...base, configured: false, ready: false },
      "unknown",
      "none",
      "A Vercel não enxerga o Railway. Se o ícone do bot estiver verde no Discord, ele está no ar. Na Vercel defina BOT_PROCESS_URL=https://SEU-SERVICO.up.railway.app (sem barra no final). URL *.railway.internal não funciona daqui.",
    );
  }
  return withPresence(
    { ...base, configured: Boolean(env.botProcessUrl), ready: false },
    "unknown",
    "none",
    "BOT_PROCESS_URL não respondeu. No Railway: Settings → Networking → Generate Domain, depois cole https://….up.railway.app na Vercel (sem barra no final).",
  );
}

const lastProvisionKick = new Map<string, number>();

async function kickLobbyProvision(req: Request, scrimId: string): Promise<void> {
  if (!env.botProcessUrl) {
    return;
  }
  const now = Date.now();
  if ((lastProvisionKick.get(scrimId) ?? 0) > now - 4000) {
    return;
  }
  lastProvisionKick.set(scrimId, now);
  const headers = new Headers({
    "content-type": "application/json",
    "x-bot-internal": env.sessionSecret,
  });
  if (req.headers.cookie) {
    headers.set("cookie", req.headers.cookie);
  }
  await fetch(`${env.botProcessUrl}/api/scrims/${encodeURIComponent(scrimId)}/provision`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(4000),
  }).catch(() => undefined);
}

async function canManageScrims(req: Request): Promise<boolean> {
  return (await isStaffSession(req)) || isBotInternalRequest(req);
}

function provisionHttpStatus(error: unknown): number {
  if (error instanceof DiscordRestError) {
    return error.status >= 400 && error.status < 600 ? error.status : 502;
  }
  if (error instanceof DiscordProvisionError) {
    return error.status >= 400 && error.status < 600 ? error.status : 400;
  }
  return 400;
}

type ParsedCreateScrim =
  | {
      name: string;
      mode: import("../scrims/store.js").ScrimMode;
      maxSlots: number;
      accessRoleIds: string[];
      staffRoleIds: string[];
      windows: PriorityWindow[];
      templateId: string;
      teamsPerDrop: number;
      maxContestedDrops: number;
    }
  | { error: string };

function parseCreateScrimBody(body: Record<string, unknown> | undefined): ParsedCreateScrim {
  const name = String(body?.name ?? "").trim();
  const mode = String(body?.mode ?? "");
  const maxSlots = Number(body?.maxSlots);
  const accessRoleIds = Array.isArray(body?.accessRoleIds) ? body.accessRoleIds.map(String) : [];
  const staffRoleIds = Array.isArray(body?.staffRoleIds) ? body.staffRoleIds.map(String) : [];
  const windows = parseWindows(body?.windows);
  const templateId = String(body?.templateId ?? "").trim();
  if (!name) {
    return { error: "Informe o nome da scrim" };
  }
  if (!isScrimMode(mode)) {
    return { error: "Modo inválido" };
  }
  if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 100) {
    return { error: "Limite de times inválido" };
  }
  if (accessRoleIds.length === 0) {
    return { error: "Escolha os cargos da divisão (quem vê o check-in)" };
  }
  if (staffRoleIds.length === 0) {
    return { error: "Escolha pelo menos um cargo de staff" };
  }
  if (
    windows.length === 0 ||
    windows.some((window) => !/^\d{2}:\d{2}$/.test(window.time) || !/^\d{4}-\d{2}-\d{2}$/.test(window.date))
  ) {
    return { error: "Em cada linha de check-in, escolha a data e o horário (Brasília)." };
  }
  if (!getTemplate(templateId)) {
    return { error: "Escolha um preset de mapa" };
  }
  return {
    name,
    mode,
    maxSlots,
    accessRoleIds,
    staffRoleIds,
    windows,
    templateId,
    teamsPerDrop: clampTeamsPerDrop(body?.teamsPerDrop),
    maxContestedDrops: clampMaxContestedDrops(body?.maxContestedDrops),
  };
}

function scrimCreatePayload(scrim: import("../scrims/store.js").Scrim) {
  return withLiveMap({
    ...scrim,
    teamSize: MODE_SIZE[scrim.mode],
    teamCount: teamCount(scrim.id),
  });
}

export function setupExpress(app: Express): void {
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const origin = String(req.headers.origin ?? "").trim().replace(/\/$/, "");
    if (origin && isAllowedPublicHost(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(
    express.json({
      limit: "8mb",
      verify: (req, _res, buf) => {
        const url = String(req.url ?? "");
        if (url.includes("/api/discord/interactions")) {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        }
      },
    }),
  );
  app.use((req, _res, next) => {
    const incoming = req as Request & { body?: unknown };
    if (typeof incoming.body === "string" && incoming.body.trim().startsWith("{")) {
      try {
        incoming.body = JSON.parse(incoming.body) as Record<string, unknown>;
      } catch {
        // keep the raw string; routes will fail with a 400
      }
    }
    next();
  });
  app.use((req, _res, next) => {
    const incoming = req as Request & { cookies?: unknown; secret?: string };
    Reflect.deleteProperty(incoming, "cookies");
    incoming.secret = env.sessionSecret;
    next();
  });
  app.use(cookieParser(env.sessionSecret));
  app.use(async (req, res, next) => {
    if (req.path === "/health" || (req.path === "/" && req.method === "GET")) {
      next();
      return;
    }
    try {
      await ensureStore();
      next();
    } catch (error) {
      next(error);
    }
  });
  if (!process.env.VERCEL) {
    app.use((_req, res, next) => {
      res.on("finish", () => {
        void flushStore().catch((error) => {
          console.error("[store] flush:", error);
        });
      });
      next();
    });
  }
}

export function registerSiteRoutes(app: Express, options: SiteRouteOptions = {}): void {
  app.get("/api/health", async (_req, res) => {
    const persistence = persistenceMode();
    const warning =
      persistence === "memory"
        ? "Sem DATABASE_URL as tabelas somem a cada cold start. Crie um Neon gratuito e cole DATABASE_URL na Vercel."
        : storeRemoteError();
    const bot = await resolveBotStatus(options.botStatus?.());
    res.json({
      ok: true,
      service: "fortnite-scrim-bot",
      host: process.env.VERCEL ? "vercel" : "node",
      persistence,
      warning,
      yuniteConfigured: yuniteConfigured(),
      publicBaseUrl: publicBaseUrl(),
      discordRedirectUri: discordRedirectUri(),
      botProcessUrlConfigured: Boolean(env.botProcessUrl),
      heartbeatStore: usesRemoteStore(),
      discordPublicKeyConfigured: Boolean(env.discordPublicKey),
      discordInteractionsUrl: `${publicBaseUrl()}/api/discord/interactions`,
      bot: {
        ready: bot.ready,
        presence: bot.presence,
        source: bot.source ?? "none",
        username: bot.username,
        note: bot.note ?? null,
      },
    });
  });

  app.get("/api/internal/scrims/:id", async (req, res) => {
    const auth = String(req.headers.authorization ?? "");
    if (auth !== `Bearer ${env.sessionSecret}`) {
      res.status(401).json({ error: "Não autorizado" });
      return;
    }
    await pullRemoteStore();
    const id = String(req.params.id);
    const channelId = String(req.query.channelId ?? "").trim();
    const parentId = String(req.query.parentId ?? "").trim() || null;
    let scrim = getScrim(id);
    if (!scrim && channelId) {
      scrim = findScrimForChannel(env.discordGuildId, channelId, parentId);
    }
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    res.json({ scrim });
  });

  app.get("/api/discord/interactions", (_req, res) => {
    res.json({
      ok: true,
      service: "discord-interactions",
      hint: "Discord envia POST aqui. No Developer Portal → General Information, cole Interactions Endpoint URL e DISCORD_PUBLIC_KEY (Public Key).",
      endpointUrl: `${publicBaseUrl()}/api/discord/interactions`,
      publicKeyConfigured: Boolean(env.discordPublicKey),
    });
  });

  app.post("/api/discord/interactions", async (req, res) => {
    const incoming = req as Request & { rawBody?: Buffer };
    const raw =
      incoming.rawBody ??
      (Buffer.isBuffer(req.body) ? req.body : null) ??
      (typeof req.body === "string" ? Buffer.from(req.body) : null);
    if (!raw) {
      res.status(401).json({ error: "invalid request signature" });
      return;
    }
    const result = await handleDiscordHttpInteraction(req.headers, raw);
    res.status(result.status).json(result.body);
  });

  app.get("/api/auth/me", async (req, res) => {
    res.json({
      authenticated: await isStaffSession(req),
      discordLogin: true,
    });
  });

  app.post("/api/auth/login", (_req, res) => {
    res.status(403).json({
      error: "Login por senha foi desativado. Entre com Discord. Só quem tem o cargo de admin no servidor entra no painel.",
    });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, clearCookieOptions);
    res.json({ ok: true });
  });

  app.get("/api/auth/discord", (req, res) => {
    beginDiscordLogin(req, res);
  });

  app.get("/api/auth/discord/callback", async (req, res) => {
    await finishDiscordLogin(req, res);
  });

  app.get("/api/bot/status", requireAuth, async (_req, res) => {
    res.json(await resolveBotStatus(options.botStatus?.()));
  });

  app.get("/api/discord/roles", requireAuth, async (_req, res) => {
    try {
      res.json({ roles: await fetchGuildRoles() });
    } catch (error) {
      const status = error instanceof DiscordRestError ? error.status : 502;
      const message =
        error instanceof Error ? error.message : "Não foi possível listar os cargos do Discord";
      res.status(status >= 400 && status < 600 ? status : 502).json({ error: message, roles: [] });
    }
  });

  app.get("/api/logs", requireAuth, (req, res) => {
    const scrimId = String(req.query.scrim ?? "").trim();
    res.json({ logs: listLogs(scrimId || undefined, 120) });
  });

  app.get("/api/templates", requireAuth, (_req, res) => {
    res.json({ templates: listTemplates().map(withLiveMap) });
  });

  app.post("/api/templates", requireAuth, (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "Informe o nome do preset" });
      return;
    }
    res.status(201).json({ template: createTemplate(name) });
  });

  app.post("/api/templates/import", requireAuth, (req, res) => {
    try {
      const originalUrl = String(req.body?.mapImageUrl ?? "").trim();
      const resolved = resolvePublicMapUrl(originalUrl);
      const template = importTemplate({ ...req.body, mapImageUrl: resolved.url });
      res.status(201).json({
        template: withLiveMap(template),
        warning: resolved.missing
          ? `Os ${template.drops.length} drops vieram certos. A foto do JSON era um arquivo antigo de upload que não existe mais aqui. Clique em Trocar imagem e manda o PNG/JPG da ilha de novo.`
          : null,
      });
    } catch (error) {
      fail(res, error, "Não foi possível importar o preset");
    }
  });

  app.get("/api/templates/:id", requireAuth, (req, res) => {
    const template = getTemplate(String(req.params.id));
    if (!template) {
      res.status(404).json({ error: "Preset não encontrado" });
      return;
    }
    res.json({ template: withLiveMap(template) });
  });

  app.put("/api/templates/:id", requireAuth, (req, res) => {
    try {
      const drops = Array.isArray(req.body?.drops)
        ? req.body.drops.map((item: object) =>
            normalizeDrop({
              ...(item as object),
              claimedByTeam: null,
              claimedByUserId: null,
              claimedByName: null,
              claimedByAvatarUrl: null,
              claims: [],
            }),
          )
        : undefined;
      const patch: Partial<import("../scrims/store.js").MapTemplate> = {};
      if (req.body?.name) {
        patch.name = String(req.body.name);
      }
      if (drops) {
        patch.drops = drops;
      }
      if (req.body?.maxContestedDrops != null) {
        patch.maxContestedDrops = clampMaxContestedDrops(req.body.maxContestedDrops);
      }
      const template = patchTemplate(String(req.params.id), patch);
      res.json({ template: withLiveMap(template) });
    } catch (error) {
      fail(res, error, "Não foi possível salvar o preset");
    }
  });

  app.delete("/api/templates/:id", requireAuth, (req, res) => {
    if (!deleteTemplate(String(req.params.id))) {
      res.status(404).json({ error: "Preset não encontrado" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/scrim-presets", requireAuth, (_req, res) => {
    res.json({ presets: listScrimPresets() });
  });

  app.post("/api/scrim-presets", requireAuth, (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "Dê um nome para este preset de scrim" });
      return;
    }
    try {
      res.status(201).json({
        preset: saveScrimPreset({
          id: String(req.body?.id ?? "").trim() || undefined,
          name,
          mode: req.body?.mode,
          maxSlots: req.body?.maxSlots,
          teamsPerDrop: req.body?.teamsPerDrop,
          maxContestedDrops: req.body?.maxContestedDrops,
          templateId: String(req.body?.templateId ?? ""),
          accessRoleIds: Array.isArray(req.body?.accessRoleIds) ? req.body.accessRoleIds : [],
          staffRoleIds: Array.isArray(req.body?.staffRoleIds) ? req.body.staffRoleIds : [],
          windows: parseWindows(req.body?.windows),
          leaveUntil: String(req.body?.leaveUntil ?? ""),
          punishHours: req.body?.punishHours,
        }),
      });
    } catch (error) {
      fail(res, error, "Não foi possível salvar o preset de scrim");
    }
  });

  app.delete("/api/scrim-presets/:id", requireAuth, (req, res) => {
    if (!deleteScrimPreset(String(req.params.id))) {
      res.status(404).json({ error: "Preset de scrim não encontrado" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/map-images/:id", async (req, res) => {
    const image = await readPersistedMap(String(req.params.id ?? ""));
    if (!image) {
      res.status(404).json({ error: "Imagem do mapa não encontrada" });
      return;
    }
    res.setHeader("Content-Type", image.mime);
    res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
    res.send(image.buffer);
  });

  app.post(
    "/api/templates/:id/map",
    requireAuth,
    express.raw({
      type: ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/octet-stream"],
      limit: "8mb",
    }),
    async (req, res) => {
      const template = getTemplate(String(req.params.id));
      if (!template) {
        res.status(404).json({ error: "Preset não encontrado" });
        return;
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (buffer.length < 32) {
        res.status(400).json({
          error:
            "Arquivo de mapa inválido ou vazio. Na Vercel o limite é ~4 MB — use JPG se o PNG for pesado.",
        });
        return;
      }
      const mime = String(req.headers["content-type"] ?? "image/png");
      try {
        const mapImageUrl = await persistMapImage({
          id: `tpl-${template.id}`,
          buffer,
          mime,
          fileStem: template.id,
        });
        const updated = patchTemplate(template.id, { mapImageUrl });
        await commitJson(res, 200, { template: withLiveMap(updated) });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Não foi possível gravar a imagem do mapa";
        res.status(503).json({ error: message });
      }
    },
  );

  app.get("/api/scrims", requireAuth, async (_req, res) => {
    await pullRemoteStore();
    const scrims = listScrims().map((scrim) => ({
      ...scrim,
      teamSize: MODE_SIZE[scrim.mode],
      inviteCount: listInvites(scrim.id).length,
      teamCount: teamCount(scrim.id),
    }));
    res.json({ scrims });
  });

  app.get("/api/scrims/:id", requireAuth, async (req, res) => {
    await pullRemoteStore();
    await processExpiredDropDeadlines().catch(() => undefined);
    const id = String(req.params.id);
    const scrim = ensureScrimHasDrops(id) ?? getScrim(id);
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    if (scrim.provisionStatus === "pending" && !scrim.discord) {
      void kickLobbyProvision(req, scrim.id);
    }
    void ensureAdminPanel(scrim).catch(() => undefined);
    const invites = listInvites(scrim.id);
    res.json({
      scrim: withLiveMap({
        ...scrim,
        teamSize: MODE_SIZE[scrim.mode],
        teamCount: teamCount(scrim.id),
      }),
      invites: invites.map((invite) => ({
        ...invite,
        username: invite.displayName,
        avatarUrl: "",
        highestRoleName: "—",
        highestRoleColor: "#6b7280",
      })),
    });
  });

  app.post("/api/scrims", async (req, res) => {
    if (!(await canManageScrims(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    const parsed = parseCreateScrimBody(req.body as Record<string, unknown> | undefined);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const guild = await fetchDiscordGuildContext();
      const created = createScrim({
        name: parsed.name,
        mode: parsed.mode,
        maxSlots: parsed.maxSlots,
        accessRoleIds: parsed.accessRoleIds,
        staffRoleIds: parsed.staffRoleIds,
        windows: parsed.windows,
        guildId: guild.guildId,
        guildName: guild.guildName,
        templateId: parsed.templateId,
        teamsPerDrop: parsed.teamsPerDrop,
        maxContestedDrops: parsed.maxContestedDrops,
      });
      await flushStore();
      const ready = await provisionLobbyViaRest(created);
      void kickLobbyProvision(req, ready.id);
      await commitJson(res, 201, { scrim: scrimCreatePayload(ready), accepted: true });
    } catch (error) {
      res.status(provisionHttpStatus(error)).json({ error: explainDiscordError(error) });
    }
  });

  app.post("/api/scrims/:id/provision", async (req, res) => {
    if (!(await canManageScrims(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    await pullRemoteStore();
    const scrim = getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    if (scrim.discord && scrim.provisionStatus === "ready") {
      res.status(200).json({ scrim: scrimCreatePayload(scrim), accepted: true });
      return;
    }
    try {
      const ready = await provisionLobbyViaRest(scrim);
      void kickLobbyProvision(req, ready.id);
      await commitJson(res, 200, { scrim: scrimCreatePayload(ready), accepted: true });
    } catch (error) {
      res.status(provisionHttpStatus(error)).json({
        error: explainDiscordError(error),
        scrim: getScrim(scrim.id),
      });
    }
  });

  app.delete("/api/scrims/:id", async (req, res) => {
    if (!(await canManageScrims(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    await pullRemoteStore();
    const id = String(req.params.id);
    const scrim = getScrim(id);
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    try {
      await teardownLobbyViaRest(scrim);
      deleteTablesForScrim(id);
      const removed = deleteScrim(id);
      if (!removed) {
        res.status(404).json({ error: "Scrim não encontrada" });
        return;
      }
      await commitJson(res, 200, { ok: true });
    } catch (error) {
      res.status(provisionHttpStatus(error)).json({
        error: explainDiscordError(error, "Não foi possível apagar a scrim no Discord"),
      });
    }
  });

  app.get("/api/blacklist", requireAuth, (_req, res) => {
    res.json({ blacklist: listBlacklist() });
  });

  app.delete("/api/blacklist/:id", requireAuth, (req, res) => {
    const entry = removeBlacklist(String(req.params.id));
    if (!entry) {
      res.status(404).json({ error: "Entrada não encontrada" });
      return;
    }
    res.json({ ok: true, entry });
  });

  app.get("/api/tables", requireAuth, (_req, res) => {
    res.json({ tables: listTables() });
  });

  app.post("/api/tables", requireAuth, async (req, res) => {
    try {
      const payload = tablePayload(req.body as Record<string, unknown>);
      const name = String(payload.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "Informe o nome da tabela" });
        return;
      }
      if (payload.kind === "yunite" && !payload.yuniteTournamentId) {
        res.status(400).json({
          error: "Cole o ID ou o link do torneio Yunite, ou escolha um na lista.",
        });
        return;
      }
      const table = createTable({ ...payload, name });
      await commitJson(res, 201, { table });
    } catch (error) {
      fail(res, error, "Não foi possível criar a tabela");
    }
  });

  app.get("/api/tables/:id", requireAuth, (req, res) => {
    const table = getTable(String(req.params.id));
    if (!table) {
      res.status(404).json({ error: "Tabela não encontrada" });
      return;
    }
    res.json({ table });
  });

  app.put("/api/tables/:id", requireAuth, async (req, res) => {
    try {
      const payload = tablePayload(req.body as Record<string, unknown>);
      if (payload.kind === "yunite" && !payload.yuniteTournamentId) {
        res.status(400).json({
          error: "Cole o ID ou o link do torneio Yunite, ou escolha um na lista.",
        });
        return;
      }
      const table = patchTable(String(req.params.id), payload as Partial<PublicTable>);
      await commitJson(res, 200, { table });
    } catch (error) {
      fail(res, error, "Não foi possível salvar a tabela");
    }
  });

  app.delete("/api/tables/:id", requireAuth, async (req, res) => {
    const table = deleteTable(String(req.params.id));
    if (!table) {
      res.status(404).json({ error: "Tabela não encontrada" });
      return;
    }
    await commitJson(res, 200, { ok: true });
  });

  app.get("/api/yunite/tournaments", requireAuth, async (_req, res) => {
    if (!yuniteConfigured()) {
      res.json({
        configured: false,
        tournaments: [],
        error:
          "A chave da API Yunite ainda não está na Vercel. Defina YUNITE_API_KEY nas variáveis do projeto para listar torneios e puxar a colocação.",
      });
      return;
    }
    try {
      const tournaments = await listYuniteTournaments();
      res.json({
        configured: true,
        tournaments,
        error:
          tournaments.length > 0
            ? null
            : "Nenhum torneio Yunite neste servidor. Cole o UUID ou o link yunite.xyz/leaderboard.",
      });
    } catch (error) {
      res.json({
        configured: true,
        tournaments: [],
        error: error instanceof Error ? error.message : "Não foi possível listar torneios Yunite",
      });
    }
  });

  app.post(
    "/api/maps/upload",
    requireAuth,
    express.raw({
      type: ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/octet-stream"],
      limit: "8mb",
    }),
    async (req, res) => {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (buffer.length < 32) {
        res.status(400).json({
          error:
            "Arquivo de mapa inválido ou vazio. Na Vercel o limite é ~4 MB — use JPG se o PNG for pesado.",
        });
        return;
      }
      const mime = String(req.headers["content-type"] ?? "image/png");
      try {
        const url = await persistMapImage({
          id: `upl-${randomUUID()}`,
          buffer,
          mime,
        });
        res.json({ url });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Não foi possível gravar a imagem do mapa";
        res.status(503).json({ error: message });
      }
    },
  );

  app.get("/api/public/scrims/:id/map", async (req, res) => {
    await pullRemoteStore({ minIntervalMs: 1500 });
    await processExpiredDropDeadlines().catch(() => undefined);
    const scrim = getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada", login: false });
      return;
    }
    const live = ensureScrimHasDrops(scrim.id) ?? scrim;
    const access = await resolveMapAccess(req, live);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error, login: Boolean(access.login) });
      return;
    }
    res.json({
      name: live.name,
      mapImageUrl: resolvePublicMapUrl(live.mapImageUrl).url || DEFAULT_MAP_URL,
      drops: live.drops,
      teamName: access.access.teamName,
      dropped: access.access.dropped,
      canClaim: access.access.canClaim,
      dropsOpen: live.dropsOpen,
      teamsPerDrop: live.teamsPerDrop,
      maxContestedDrops: live.maxContestedDrops,
      fortniteNick: access.access.fortniteNick,
      steps: access.access.isStaff
        ? []
        : access.access.dropped
          ? [
              "Drop confirmado.",
              "No Discord você já deve ver o canal de código e o getting-off.",
            ]
          : [
              "Você tem 3 minutos para marcar e confirmar o drop.",
              "Clique no retângulo do drop no mapa.",
              "Confirme. Depois o Discord libera código e getting-off.",
            ],
    });
  });

  app.post("/api/public/scrims/:id/drop", async (req, res) => {
    await pullRemoteStore();
    const scrim = getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    const live = ensureScrimHasDrops(scrim.id) ?? scrim;
    const access = await resolveMapAccess(req, live);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error, login: Boolean(access.login) });
      return;
    }
    if (!access.access.canClaim) {
      res.status(403).json({
        error: live.dropsOpen
          ? "Você não pode marcar drop."
          : "A staff fechou a marcação de drops.",
      });
      return;
    }
    if (live.drops.length === 0) {
      res.status(400).json({
        error: "Este mapa ainda não tem drops. A staff precisa salvar o preset de mapa.",
      });
      return;
    }
    let dropId = String(req.body?.dropId ?? "");
    const dropName = String(req.body?.dropName ?? "").trim();
    if (!dropId && req.body?.x != null && req.body?.y != null) {
      dropId = findDropAt(live.id, Number(req.body.x), Number(req.body.y))?.id ?? "";
    }
    if (!dropId && dropName) {
      dropId = live.drops.find((item) => item.name.trim() === dropName)?.id ?? dropName;
    }
    if (!dropId) {
      res.status(400).json({ error: "Clique dentro de um drop" });
      return;
    }
    try {
      const drop = await applyPlayerDropViaRest(scrim.id, access.access.userId, dropId);
      await commitJson(res, 200, { drop });
    } catch (error) {
      fail(res, error, "Não foi possível marcar o drop");
    }
  });

  app.get("/api/public/tabelas", (_req, res) => {
    res.json({ boards: listPublicBoards() });
  });

  app.get("/api/public/tabelas/:id", async (req, res) => {
    try {
      const board = await getPublicBoard(String(req.params.id), String(req.query.session ?? ""));
      if (!board) {
        res.status(404).json({ error: "Scrim não encontrada" });
        return;
      }
      res.json({ board });
    } catch (error) {
      fail(res, error, "Não foi possível carregar a tabela");
    }
  });

  registerStaffRestRoutes(app);
}

export async function botUnavailable(_req: Request, res: Response): Promise<void> {
  res.status(404).json({ error: "Rota não encontrada" });
}

export function createSiteApp(): Express {
  const app = express();
  setupExpress(app);
  registerSiteRoutes(app);
  app.use("/api", botUnavailable);
  app.use((error: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const payload = error as { type?: string; status?: number };
    if (payload?.type === "entity.too.large" || payload?.status === 413) {
      res.status(413).json({
        error: "A imagem é grande demais (máx. ~4 MB na Vercel). Envie um JPG ou um PNG mais leve.",
      });
      return;
    }
    const message = error instanceof Error ? error.message : "Erro interno";
    res.status(500).json({ error: message });
  });
  return app;
}

export { flushStore };
