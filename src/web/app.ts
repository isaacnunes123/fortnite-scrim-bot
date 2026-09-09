import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBotStatus, getDiscordClient } from "../bot/client.js";
import { getGuild, listBotGuilds, notifyInvite, resolveDiscordPlayer, rosterForScrim } from "../bot/guild.js";
import { subscribe } from "../scrims/live.js";
import { env } from "../env.js";
import { DEFAULT_MAP_URL, resolvePublicMapUrl, savePresetMap, saveUploadedMap, uploadDir } from "../scrims/maps.js";
import {
  beginDiscordLogin,
  finishDiscordLogin,
  isStaffSession,
  resolveMapAccess,
} from "./dropAuth.js";
import { getPublicBoard, listPublicBoards, saveYuniteTournamentId } from "./publicTables.js";
import { listYuniteTournaments, yuniteConfigured } from "../yunite/client.js";
import {
  applyPlayerDrop,
  ensureDropMapEmbed,
  postMatchCode,
  provisionLobby,
  refreshLeaveMessage,
  refreshRegistrationMessage,
  setDropMarkingOpen,
  setFillChatOpen,
  syncLobbyAccess,
  teardownLobby,
} from "../scrims/lobby.js";
import {
  addInvite,
  addLog,
  createScrim,
  createTemplate,
  deleteTemplate,
  getTemplate,
  importTemplate,
  listTemplates,
  clampTeamsPerDrop,
  clampMaxContestedDrops,
  patchTemplate,
  deleteScrim,
  ensureScrimHasDrops,
  findDropAt,
  getActiveBan,
  getScrim,
  isScrimMode,
  listBlacklist,
  listInvites,
  removeBlacklist,
  listLogs,
  listScrimPresets,
  listScrims,
  MODE_SIZE,
  normalizeDrop,
  patchScrim,
  removeInvite,
  saveScrimPreset,
  deleteScrimPreset,
  deleteTable,
  getTable,
  listTables,
  patchTable,
  createTable,
  teamCount,
  type PriorityWindow,
  type PublicTable,
} from "../scrims/store.js";

const COOKIE_NAME = "scrim_session";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await isStaffSession(req))) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }
  next();
}

function fail(res: Response, error: unknown, fallback: string): void {
  const message = error instanceof Error ? error.message : fallback;
  res.status(400).json({ error: message });
}

function withLiveMap<T extends { mapImageUrl: string }>(item: T): T {
  return { ...item, mapImageUrl: resolvePublicMapUrl(item.mapImageUrl).url };
}

function tablePayload(body: Record<string, unknown> | undefined): {
  name?: string;
  description?: string;
  mode?: string;
  live?: boolean;
  scrimId?: string;
  kind?: string;
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
    yuniteTournamentId,
    rows: Array.isArray(body?.rows) ? body.rows : undefined,
  };
}

function parseWindows(raw: unknown): PriorityWindow[] {
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

export async function createWebApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));
  app.use(cookieParser(env.sessionSecret));
  app.use("/uploads", express.static(uploadDir));
  app.use("/preset-files", express.static(path.join(process.cwd(), "presets", "maps")));
  app.use("/maps", express.static(path.join(process.cwd(), "web", "public", "maps")));
  app.use("/maps", express.static(path.join(process.cwd(), "dist", "public", "maps")));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "fortnite-scrim-bot" });
  });

  app.get("/api/stream", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).end();
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event: { type: string }) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: "hello" });
    const off = subscribe((event) => send(event));
    const ping = setInterval(() => send({ type: "ping" }), 15000);
    req.on("close", () => {
      clearInterval(ping);
      off();
    });
  });

  app.get("/api/logs", requireAuth, (req, res) => {
    const scrimId = String(req.query.scrim ?? "").trim();
    res.json({ logs: listLogs(scrimId || undefined, 120) });
  });

  app.get("/api/auth/me", async (req, res) => {
    res.json({
      authenticated: await isStaffSession(req),
      discordLogin: env.adminRoleIds.length > 0,
      passwordLogin: env.adminRoleIds.length === 0,
    });
  });

  app.post("/api/auth/login", (req, res) => {
    if (env.adminRoleIds.length > 0) {
      res.status(403).json({ error: "Entre com Discord. O painel só libera cargos configurados." });
      return;
    }
    const password = String(req.body?.password ?? "");
    if (password !== env.adminPassword) {
      res.status(401).json({ error: "Senha incorreta" });
      return;
    }
    res.cookie(COOKIE_NAME, "admin", {
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      secure: env.cookieSecure,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
  });

  app.get("/api/auth/discord", (req, res) => {
    beginDiscordLogin(req, res);
  });

  app.get("/api/auth/discord/callback", async (req, res) => {
    await finishDiscordLogin(req, res);
  });

  app.get("/api/bot/status", requireAuth, (_req, res) => {
    res.json(getBotStatus());
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
      addLog({
        scrimId: null,
        kind: "preset",
        summary: `Preset de mapa importado: ${template.name}`,
        detail: resolved.missing
          ? `${template.drops.length} drops. A imagem do JSON (${originalUrl || "vazia"}) não está neste servidor. Use Trocar imagem.`
          : `${template.drops.length} drops. Imagem: ${resolved.url}`,
      });
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
      const uploaded = saveUploadedMap(buffer, mime);
      let mapImageUrl = uploaded;
      try {
        mapImageUrl = savePresetMap(template.id, buffer, mime);
      } catch {
        mapImageUrl = uploaded;
      }
      res.json({ template: withLiveMap(patchTemplate(template.id, { mapImageUrl })) });
    },
  );

  app.get("/api/discord/guilds", requireAuth, (_req, res) => {
    const client = getDiscordClient();
    if (!client?.isReady()) {
      res.status(503).json({ error: "Bot offline" });
      return;
    }
    res.json({ guilds: listBotGuilds(client) });
  });

  app.get("/api/discord/roles", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    if (!client?.isReady()) {
      res.status(503).json({ error: "Bot offline" });
      return;
    }
    const guild = getGuild(client);
    if (!guild) {
      res.json({ roles: [] });
      return;
    }
    await guild.roles.fetch().catch(() => undefined);
    const roles = [...guild.roles.cache.values()]
      .filter((role) => role.id !== guild.id && !role.managed)
      .sort((a, b) => b.position - a.position)
      .map((role) => ({ id: role.id, name: role.name, color: role.hexColor }));
    res.json({ roles });
  });

  app.get("/api/scrims", requireAuth, (_req, res) => {
    const scrims = listScrims().map((scrim) => ({
      ...scrim,
      teamSize: MODE_SIZE[scrim.mode],
      inviteCount: listInvites(scrim.id).length,
      teamCount: teamCount(scrim.id),
    }));
    res.json({ scrims });
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

  app.post("/api/scrims", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    if (!client?.isReady()) {
      res.status(503).json({ error: "Bot offline" });
      return;
    }
    const name = String(req.body?.name ?? "").trim();
    const mode = String(req.body?.mode ?? "");
    const maxSlots = Number(req.body?.maxSlots);
    const accessRoleIds = Array.isArray(req.body?.accessRoleIds)
      ? req.body.accessRoleIds.map(String)
      : [];
    const staffRoleIds = Array.isArray(req.body?.staffRoleIds)
      ? req.body.staffRoleIds.map(String)
      : [];
    const windows = parseWindows(req.body?.windows);
    const templateId = String(req.body?.templateId ?? "").trim();
    const teamsPerDrop = clampTeamsPerDrop(req.body?.teamsPerDrop);
    const maxContestedDrops = clampMaxContestedDrops(req.body?.maxContestedDrops);
    const clientGuild = getGuild(client);
    if (!clientGuild) {
      res.status(400).json({
        error: `O bot precisa estar no servidor ${env.discordGuildId}.`,
      });
      return;
    }
    if (!name) {
      res.status(400).json({ error: "Informe o nome da scrim" });
      return;
    }
    if (!isScrimMode(mode)) {
      res.status(400).json({ error: "Modo inválido" });
      return;
    }
    if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 100) {
      res.status(400).json({ error: "Limite de times inválido" });
      return;
    }
    if (accessRoleIds.length === 0) {
      res.status(400).json({ error: "Escolha os cargos da divisão (quem vê o check-in)" });
      return;
    }
    if (staffRoleIds.length === 0) {
      res.status(400).json({ error: "Escolha pelo menos um cargo de staff" });
      return;
    }
    if (
      windows.length === 0 ||
      windows.some((window) => !/^\d{2}:\d{2}$/.test(window.time) || !/^\d{4}-\d{2}-\d{2}$/.test(window.date))
    ) {
      res.status(400).json({ error: "Em cada linha de check-in, escolha a data e o horário (Brasília)." });
      return;
    }
    if (!getTemplate(templateId)) {
      res.status(400).json({ error: "Escolha um preset de mapa" });
      return;
    }
    try {
      const created = createScrim({
        name,
        mode,
        maxSlots,
        accessRoleIds,
        staffRoleIds,
        windows,
        guildId: clientGuild.id,
        guildName: clientGuild.name,
        templateId,
        teamsPerDrop,
        maxContestedDrops,
      });
      const scrim = await provisionLobby(client, created);
      res.status(201).json({ scrim });
    } catch (error) {
      fail(res, error, "Não foi possível criar a categoria no Discord");
    }
  });

  app.get("/api/scrims/:id", requireAuth, async (req, res) => {
    const scrim = ensureScrimHasDrops(String(req.params.id)) ?? getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    const client = getDiscordClient();
    if (client?.isReady() && scrim.discord) {
      await syncLobbyAccess(client, scrim).catch(() => undefined);
    }
    const invites = listInvites(scrim.id);
    const roster =
      client?.isReady() && scrim.guildId
        ? await rosterForScrim(client, scrim.guildId, invites)
        : invites.map((invite) => ({
            ...invite,
            username: invite.displayName,
            avatarUrl: "",
            highestRoleName: "—",
            highestRoleColor: "#6b7280",
          }));
    res.json({
      scrim: withLiveMap({
        ...scrim,
        teamSize: MODE_SIZE[scrim.mode],
        teamCount: teamCount(scrim.id),
      }),
      invites: roster,
    });
  });

  app.post("/api/scrims/:id/code", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    const scrim = getScrim(String(req.params.id));
    if (!client?.isReady() || !scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    const matchCode = String(req.body?.code ?? "").trim();
    const updated = patchScrim(scrim.id, { matchCode });
    await postMatchCode(client, updated);
    addLog({
      scrimId: scrim.id,
      kind: "code",
      summary: "Código da partida enviado",
      detail: matchCode,
    });
    res.json({ scrim: updated });
  });

  app.post("/api/scrims/:id/checkout", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    const scrim = getScrim(String(req.params.id));
    if (!client?.isReady() || !scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    const leaveUntil = String(req.body?.leaveUntil ?? "").trim();
    const punishHours = Number(req.body?.punishHours ?? scrim.punishHours ?? 24);
    const okTime = /^\d{2}:\d{2}$/.test(leaveUntil);
    const okDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(leaveUntil);
    if (!okTime && !okDate) {
      res.status(400).json({ error: "Informe a data e o horário do checkout (Brasília)." });
      return;
    }
    if (!Number.isInteger(punishHours) || punishHours < 1 || punishHours > 720) {
      res.status(400).json({ error: "Informe as horas de ban da closed (1 a 720)" });
      return;
    }
    const updated = patchScrim(scrim.id, { leaveUntil, punishHours });
    await refreshLeaveMessage(client, updated.id);
    addLog({
      scrimId: scrim.id,
      kind: "checkout",
      summary: `Checkout até ${leaveUntil}`,
      detail: `Ban ${punishHours}h`,
    });
    res.json({ scrim: updated });
  });

  app.post("/api/scrims/:id/yunite", requireAuth, (req, res) => {
    const scrim = getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    try {
      const yuniteTournamentId = saveYuniteTournamentId(
        String(req.body?.yuniteTournamentId ?? ""),
      );
      const updated = patchScrim(scrim.id, { yuniteTournamentId });
      addLog({
        scrimId: scrim.id,
        kind: "yunite",
        summary: yuniteTournamentId
          ? `Torneio Yunite vinculado: ${yuniteTournamentId}`
          : "Torneio Yunite desvinculado",
      });
      res.json({ scrim: updated });
    } catch (error) {
      fail(res, error, "Não foi possível salvar o ID Yunite");
    }
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

  app.post("/api/scrims/:id/fill/open", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    const scrim = getScrim(String(req.params.id));
    if (!client?.isReady() || !scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    await setFillChatOpen(client, scrim, Boolean(req.body?.open));
    addLog({
      scrimId: scrim.id,
      kind: "fill",
      summary: req.body?.open ? "Fill liberado" : "Fill bloqueado",
    });
    res.json({ ok: true });
  });

  app.post("/api/scrims/:id/drops/open", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    const scrim = getScrim(String(req.params.id));
    if (!client?.isReady() || !scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    const open = Boolean(req.body?.open);
    const updated = await setDropMarkingOpen(client, scrim, open);
    addLog({
      scrimId: scrim.id,
      kind: "map",
      summary: open ? "Marcação de drops liberada" : "Marcação de drops fechada",
    });
    res.json({ scrim: updated });
  });

  app.put("/api/scrims/:id/embeds", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    const scrim = getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    const updated = patchScrim(scrim.id, {
      embeds: {
        ...scrim.embeds,
        ...(req.body?.embeds ?? {}),
      },
    });
    if (client?.isReady()) {
      await refreshRegistrationMessage(client, updated.id).catch(() => undefined);
      await refreshLeaveMessage(client, updated.id).catch(() => undefined);
      await ensureDropMapEmbed(client, updated).catch(() => undefined);
    }
    addLog({
      scrimId: scrim.id,
      kind: "embed",
      summary: "Embeds do Discord atualizadas",
    });
    res.json({ scrim: updated });
  });

  app.post("/api/scrims/:id/drops/assign", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    const scrim = ensureScrimHasDrops(String(req.params.id));
    if (!client?.isReady() || !scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    const dropId = String(req.body?.dropId ?? "").trim();
    const discordUserId = String(req.body?.discordUserId ?? "").trim();
    if (!dropId || !discordUserId) {
      res.status(400).json({ error: "Escolha o player e o drop" });
      return;
    }
    try {
      const drop = await applyPlayerDrop(client, scrim.id, discordUserId, dropId, {
        ignoreClosed: true,
      });
      res.json({ drop });
    } catch (error) {
      fail(res, error, "Não foi possível marcar o drop");
    }
  });

  app.put("/api/scrims/:id/drops", requireAuth, (req, res) => {
    const scrim = getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    if (!Array.isArray(req.body?.drops)) {
      res.status(400).json({ error: "Drops inválidos" });
      return;
    }
    const drops = req.body.drops.map((item: Partial<import("../scrims/store.js").DropSpot>) =>
      normalizeDrop(item),
    );
    const updated = patchScrim(scrim.id, { drops });
    res.json({ scrim: updated });
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
      const url = saveUploadedMap(buffer, mime);
      res.json({ url });
    },
  );

  app.post(
    "/api/scrims/:id/map",
    requireAuth,
    express.raw({
      type: ["image/png", "image/jpeg", "image/webp", "application/octet-stream"],
      limit: "32mb",
    }),
    (req, res) => {
      const scrim = getScrim(String(req.params.id));
      if (!scrim) {
        res.status(404).json({ error: "Scrim não encontrada" });
        return;
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (buffer.length < 32) {
        res.status(400).json({ error: "Arquivo de mapa inválido" });
        return;
      }
      const mime = String(req.headers["content-type"] ?? "image/png");
      const mapImageUrl = saveUploadedMap(buffer, mime);
      res.json({ scrim: patchScrim(scrim.id, { mapImageUrl }) });
    },
  );

  app.delete("/api/scrims/:id", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    const removed = deleteScrim(String(req.params.id));
    if (!removed) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    if (client?.isReady()) {
      await teardownLobby(client, removed);
    }
    res.json({ ok: true });
  });

  app.post("/api/scrims/:id/invites", requireAuth, async (req, res) => {
    const client = getDiscordClient();
    if (!client?.isReady()) {
      res.status(503).json({ error: "Bot offline" });
      return;
    }
    const scrim = getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    try {
      const player = await resolveDiscordPlayer(
        client,
        String(req.body?.player ?? ""),
        scrim.guildId,
      );
      if (getActiveBan(player.id)) {
        res.status(400).json({ error: "Esse player está na blacklist da closed" });
        return;
      }
      const invite = addInvite({
        scrimId: scrim.id,
        discordUserId: player.id,
        displayName: player.displayName,
        teamName: String(req.body?.teamName ?? ""),
        fortniteNick: String(req.body?.fortniteNick ?? ""),
        ignoreCooldown: true,
      });
      const dmSent = await notifyInvite(client, {
        discordUserId: player.id,
        scrimName: scrim.name,
        teamName: invite.teamName,
        mode: scrim.mode,
      });
      res.status(201).json({ invite, dmSent });
    } catch (error) {
      fail(res, error, "Não foi possível convidar");
    }
  });

  app.delete("/api/scrims/:id/invites/:inviteId", requireAuth, (req, res) => {
    if (!removeInvite(String(req.params.id), String(req.params.inviteId))) {
      res.status(404).json({ error: "Convite não encontrado" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/public/tabelas", (_req, res) => {
    res.json({ boards: listPublicBoards() });
  });

  app.get("/api/public/tabelas/:id", async (req, res) => {
    try {
      const board = await getPublicBoard(
        String(req.params.id),
        String(req.query.session ?? ""),
      );
      if (!board) {
        res.status(404).json({ error: "Scrim não encontrada" });
        return;
      }
      res.json({ board });
    } catch (error) {
      fail(res, error, "Não foi possível carregar a tabela");
    }
  });

  app.get("/api/public/scrims/:id/map", async (req, res) => {
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
              "Clique no retângulo do drop no mapa.",
              "Confirme. Se o drop já tiver 1 time, o segundo vira disputa (quando ainda houver disputa livre no mapa).",
              "Depois o Discord libera código e getting-off.",
            ],
    });
  });

  app.post("/api/public/scrims/:id/drop", async (req, res) => {
    const client = getDiscordClient();
    const scrim = getScrim(String(req.params.id));
    if (!client?.isReady() || !scrim) {
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
    if (!dropId && req.body?.x != null && req.body?.y != null) {
      dropId = findDropAt(live.id, Number(req.body.x), Number(req.body.y))?.id ?? "";
    }
    if (!dropId) {
      res.status(400).json({ error: "Clique dentro de um drop" });
      return;
    }
    try {
      const drop = await applyPlayerDrop(client, scrim.id, access.access.userId, dropId);
      res.json({ drop });
    } catch (error) {
      fail(res, error, "Não foi possível marcar o drop");
    }
  });

  const publicDir = path.resolve(__dirname, "../public");
  const builtUi = fs.existsSync(path.join(publicDir, "index.html"));

  if (builtUi) {
    app.use(express.static(publicDir));
    app.get(/.*/, (req, res) => {
      if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/maps") ||
        req.path.startsWith("/uploads") ||
        req.path.startsWith("/preset-files") ||
        req.path.startsWith("/brand")
      ) {
        res.status(404).json({ error: "Arquivo não encontrado" });
        return;
      }
      res.sendFile(path.join(publicDir, "index.html"));
    });
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: path.resolve(process.cwd(), "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    app.use(async (req, res, next) => {
      if (req.path.startsWith("/api")) {
        next();
        return;
      }
      try {
        const indexPath = path.resolve(process.cwd(), "web/index.html");
        const html = await vite.transformIndexHtml(
          req.originalUrl,
          fs.readFileSync(indexPath, "utf-8"),
        );
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (error) {
        next(error);
      }
    });
  }

  return app;
}
