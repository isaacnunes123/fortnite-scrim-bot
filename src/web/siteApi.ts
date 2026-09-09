import cookieParser from "cookie-parser";
import express, { type Express, type Request, type Response } from "express";
import { clearCookieOptions, env } from "../env.js";
import { discordRedirectUri, isAllowedPublicHost, publicBaseUrl } from "../scrims/links.js";
import { resolvePublicMapUrl, savePresetMap, saveUploadedMap } from "../scrims/maps.js";
import {
  ensureStore,
  flushStore,
  persistenceMode,
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

export type BotStatusPayload = {
  configured: boolean;
  ready: boolean;
  username: string | null;
  id: string | null;
  guildCount: number;
  uptimeMs: number | null;
  note?: string;
};

export type SiteRouteOptions = {
  botStatus?: () => BotStatusPayload;
};

export function fail(res: Response, error: unknown, fallback: string): void {
  const message = error instanceof Error ? error.message : fallback;
  res.status(400).json({ error: message });
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
    configured: Boolean(env.discordToken),
    ready: false,
    username: null,
    id: null,
    guildCount: 0,
    uptimeMs: null,
    note: "O bot Discord não roda na Vercel. Use um host Node 24/7 (Fly, VPS, etc.).",
  };
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
    const incoming = req as Request & { cookies?: unknown; secret?: string };
    Reflect.deleteProperty(incoming, "cookies");
    incoming.secret = env.sessionSecret;
    next();
  });
  app.use(cookieParser(env.sessionSecret));
  app.use(async (_req, res, next) => {
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
  app.get("/api/health", (_req, res) => {
    const persistence = persistenceMode();
    const warning =
      persistence === "memory"
        ? "Sem DATABASE_URL as tabelas somem a cada cold start. Crie um Neon gratuito e cole DATABASE_URL na Vercel."
        : storeRemoteError();
    res.json({
      ok: true,
      service: "fortnite-scrim-bot",
      host: process.env.VERCEL ? "vercel" : "node",
      persistence,
      warning,
      publicBaseUrl: publicBaseUrl(),
      discordRedirectUri: discordRedirectUri(),
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

  app.get("/api/bot/status", requireAuth, (_req, res) => {
    res.json(options.botStatus?.() ?? offlineBotStatus());
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

  app.post(
    "/api/templates/:id/map",
    requireAuth,
    express.raw({
      type: ["image/png", "image/jpeg", "image/webp", "application/octet-stream"],
      limit: "32mb",
    }),
    (req, res) => {
      const template = getTemplate(String(req.params.id));
      if (!template) {
        res.status(404).json({ error: "Preset não encontrado" });
        return;
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (buffer.length < 32) {
        res.status(400).json({ error: "Arquivo de mapa inválido" });
        return;
      }
      const mime = String(req.headers["content-type"] ?? "image/png");
      try {
        const uploaded = saveUploadedMap(buffer, mime);
        let mapImageUrl = uploaded;
        try {
          mapImageUrl = savePresetMap(template.id, buffer, mime);
        } catch {
          mapImageUrl = uploaded;
        }
        res.json({ template: withLiveMap(patchTemplate(template.id, { mapImageUrl })) });
      } catch {
        res.status(503).json({
          error:
            "Upload de mapa não persiste na Vercel. Use um host 24/7 ou um arquivo já no repositório.",
        });
      }
    },
  );

  app.get("/api/scrims", requireAuth, (_req, res) => {
    const scrims = listScrims().map((scrim) => ({
      ...scrim,
      teamSize: MODE_SIZE[scrim.mode],
      inviteCount: listInvites(scrim.id).length,
      teamCount: teamCount(scrim.id),
    }));
    res.json({ scrims });
  });

  app.get("/api/scrims/:id", requireAuth, (req, res) => {
    const scrim = getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
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

  app.post("/api/tables", requireAuth, (req, res) => {
    try {
      const payload = tablePayload(req.body as Record<string, unknown>);
      const name = String(payload.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "Informe o nome da tabela" });
        return;
      }
      const table = createTable({ ...payload, name });
      res.status(201).json({ table });
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

  app.put("/api/tables/:id", requireAuth, (req, res) => {
    try {
      const payload = tablePayload(req.body as Record<string, unknown>);
      const table = patchTable(String(req.params.id), payload as Partial<PublicTable>);
      res.json({ table });
    } catch (error) {
      fail(res, error, "Não foi possível salvar a tabela");
    }
  });

  app.delete("/api/tables/:id", requireAuth, (req, res) => {
    const table = deleteTable(String(req.params.id));
    if (!table) {
      res.status(404).json({ error: "Tabela não encontrada" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/yunite/tournaments", requireAuth, async (_req, res) => {
    if (!yuniteConfigured()) {
      res.json({ configured: false, tournaments: [] });
      return;
    }
    try {
      const tournaments = await listYuniteTournaments();
      res.json({ configured: true, tournaments });
    } catch (error) {
      fail(res, error, "Não foi possível listar torneios Yunite");
    }
  });

  app.post(
    "/api/maps/upload",
    requireAuth,
    express.raw({
      type: ["image/png", "image/jpeg", "image/webp", "application/octet-stream"],
      limit: "32mb",
    }),
    (req, res) => {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (buffer.length < 32) {
        res.status(400).json({ error: "Arquivo de mapa inválido" });
        return;
      }
      const mime = String(req.headers["content-type"] ?? "image/png");
      try {
        const url = saveUploadedMap(buffer, mime);
        res.json({ url });
      } catch {
        res.status(503).json({
          error: "Upload de mapa não persiste na Vercel. Use um host Node 24/7 para arquivos.",
        });
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

export function botUnavailable(_req: Request, res: Response): void {
  res.status(503).json({
    error:
      "Esta ação precisa do bot Discord em um host Node 24/7 (Fly.io, VPS, etc.). Tabelas e o site público funcionam só com a Vercel.",
  });
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
    const message = error instanceof Error ? error.message : "Erro interno";
    res.status(500).json({ error: message });
  });
  return app;
}

export { flushStore };
