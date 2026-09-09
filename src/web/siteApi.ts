import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import express, { type Express, type Request, type Response } from "express";
import { clearCookieOptions, env } from "../env.js";
import { discordRedirectUri, isAllowedPublicHost, publicBaseUrl } from "../scrims/links.js";
import { persistMapImage, readPersistedMap, resolvePublicMapUrl } from "../scrims/maps.js";
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
  deleteScrimPreset,
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
  type PriorityWindow,
  type PublicTable,
} from "../scrims/store.js";
import { getPublicBoard, listPublicBoards, saveYuniteTournamentId } from "./publicTables.js";
import { listYuniteTournaments, yuniteConfigured } from "../yunite/client.js";
import {
  beginDiscordLogin,
  COOKIE_NAME,
  finishDiscordLogin,
  isStaffSession,
  requireAuth,
} from "./staffAuth.js";
import { DiscordRestError, fetchGuildRoles } from "./discordRest.js";
import { readFreshBotHeartbeat } from "../bot/heartbeat.js";

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

const RAILWAY_DOWN_ERROR =
  "O processo do bot no Railway não está no ar. Sem ele o Discord não cria a categoria (check-in, mapa, código, chat). Abra Railway → Deploy Logs e confira se /health volta JSON com host=bot. BOT_PROCESS_URL deve ser https://….up.railway.app sem barra no final.";

function isCreateScrimPath(req: Request): boolean {
  const path = String(req.path || req.url || "").split("?")[0] ?? "";
  return req.method === "POST" && /^\/api\/scrims\/?$/.test(path);
}

function isRailwayDownPayload(status: number, body: string): boolean {
  return status === 502 || status === 504 || /Application failed to respond/i.test(body);
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

async function proxyToBotProcess(req: Request, res: Response): Promise<boolean> {
  if (!env.botProcessUrl) {
    return false;
  }
  const createScrim = isCreateScrimPath(req);
  try {
    const url = new URL(req.originalUrl || req.url, `${env.botProcessUrl}/`);
    const headers = new Headers();
    if (req.headers.cookie) {
      headers.set("cookie", req.headers.cookie);
    }
    const contentType = req.headers["content-type"];
    if (contentType) {
      headers.set("content-type", contentType);
    }
    if (createScrim) {
      headers.set("x-bot-internal", env.sessionSecret);
    }
    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(createScrim ? 8_000 : 12_000),
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (Buffer.isBuffer(req.body)) {
        init.body = new Uint8Array(req.body);
      } else if (typeof req.body === "string") {
        init.body = req.body;
      } else if (req.body != null) {
        init.body = JSON.stringify(req.body);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
      }
    }
    const upstream = await fetch(url, init);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const text = buffer.toString("utf8");
    if (isRailwayDownPayload(upstream.status, text)) {
      res.status(503).json({ error: RAILWAY_DOWN_ERROR });
      return true;
    }
    res.status(upstream.status);
    const type = upstream.headers.get("content-type");
    if (type) {
      res.setHeader("Content-Type", type);
    }
    res.send(buffer);
    return true;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      res.status(503).json({
        error: createScrim
          ? "O bot no Railway demorou para aceitar a criação. Se o Discord estiver verde, tente de novo em alguns segundos. Se persistir, veja Deploy Logs e /health."
          : RAILWAY_DOWN_ERROR,
      });
      return true;
    }
    return false;
  }
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
  app.use(express.json({ limit: "8mb" }));
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
      bot: {
        ready: bot.ready,
        presence: bot.presence,
        source: bot.source ?? "none",
        username: bot.username,
        note: bot.note ?? null,
      },
    });
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
    const id = String(req.params.id);
    const scrim = getScrim(id);
    if (!scrim) {
      if (await proxyToBotProcess(req, res)) {
        return;
      }
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    if (scrim.provisionStatus === "pending" && !scrim.discord) {
      void kickLobbyProvision(req, scrim.id);
    }
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
}

export async function botUnavailable(req: Request, res: Response): Promise<void> {
  if (await proxyToBotProcess(req, res)) {
    return;
  }
  if (isCreateScrimPath(req)) {
    res.status(503).json({ error: RAILWAY_DOWN_ERROR });
    return;
  }
  res.status(503).json({ error: "Bot Discord offline" });
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
