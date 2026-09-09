import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBotStatus, getDiscordClient } from "../bot/client.js";
import { listBotGuilds, notifyInvite, resolveDiscordPlayer, rosterForScrim } from "../bot/guild.js";
import { subscribe } from "../scrims/live.js";
import {
  persistMapImage,
  uploadDir,
} from "../scrims/maps.js";
import { saveYuniteTournamentId } from "./publicTables.js";
import { isStaffSession } from "./staffAuth.js";
import {
  fail,
  registerSiteRoutes,
  setupExpress,
  withLiveMap,
} from "./siteApi.js";
import {
  addInvite,
  addLog,
  ensureScrimHasDrops,
  flushStore,
  getActiveBan,
  getScrim,
  listInvites,
  MODE_SIZE,
  normalizeDrop,
  patchScrim,
  removeInvite,
  teamCount,
} from "../scrims/store.js";
import {
  applyPlayerDrop,
  ensureDropMapEmbed,
  postMatchCode,
  refreshLeaveMessage,
  refreshRegistrationMessage,
  setDropMarkingOpen,
  setFillChatOpen,
  syncLobbyAccess,
} from "../scrims/lobby.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function registerBotHealth(app: express.Express, host: "bot" | "node" = "bot"): void {
  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "fortnite-scrim-bot",
      host,
      ...getBotStatus(),
    });
  });
  if (host === "bot") {
    app.get("/", (_req, res) => {
      res.status(200).json({
        ok: true,
        service: "fortnite-scrim-bot",
        host: "bot",
        hint: "/health",
      });
    });
  }
}

export async function createWebApp(options: { serveUi?: boolean; app?: express.Express } = {}) {
  const app = options.app ?? express();
  const host = options.serveUi === false ? "bot" : "node";
  if (!options.app) {
    registerBotHealth(app, host);
  }
  setupExpress(app);
  app.use("/uploads", express.static(uploadDir));
  app.use("/preset-files", express.static(path.join(process.cwd(), "presets", "maps")));
  app.use("/maps", express.static(path.join(process.cwd(), "web", "public", "maps")));
  app.use("/maps", express.static(path.join(process.cwd(), "dist", "public", "maps")));

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

  app.get("/api/discord/guilds", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    const client = getDiscordClient();
    if (!client?.isReady()) {
      res.status(503).json({ error: "Bot Discord offline" });
      return;
    }
    res.json({ guilds: listBotGuilds(client) });
  });

  app.get("/api/scrims/:id", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
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

  registerSiteRoutes(app, { botStatus: getBotStatus });

  app.post("/api/scrims/:id/code", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
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

  app.post("/api/scrims/:id/checkout", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
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

  app.post("/api/scrims/:id/yunite", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    const scrim = getScrim(String(req.params.id));
    if (!scrim) {
      res.status(404).json({ error: "Scrim não encontrada" });
      return;
    }
    try {
      const yuniteTournamentId = saveYuniteTournamentId(String(req.body?.yuniteTournamentId ?? ""));
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

  app.post("/api/scrims/:id/fill/open", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
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

  app.post("/api/scrims/:id/drops/open", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
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

  app.put("/api/scrims/:id/embeds", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
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

  app.post("/api/scrims/:id/drops/assign", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
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

  app.put("/api/scrims/:id/drops", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
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
    "/api/scrims/:id/map",
    express.raw({
      type: ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/octet-stream"],
      limit: "32mb",
    }),
    async (req, res) => {
      if (!(await isStaffSession(req))) {
        res.status(401).json({ error: "Não autenticado" });
        return;
      }
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
      try {
        const mapImageUrl = await persistMapImage({
          id: `scrim-${scrim.id}`,
          buffer,
          mime,
        });
        res.json({ scrim: patchScrim(scrim.id, { mapImageUrl }) });
      } catch (error) {
        fail(res, error, "Não foi possível gravar a imagem do mapa");
      }
    },
  );

  app.post("/api/scrims/:id/invites", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    const client = getDiscordClient();
    if (!client?.isReady()) {
      res.status(503).json({ error: "Bot Discord offline" });
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

  app.delete("/api/scrims/:id/invites/:inviteId", async (req, res) => {
    if (!(await isStaffSession(req))) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    if (!removeInvite(String(req.params.id), String(req.params.inviteId))) {
      res.status(404).json({ error: "Convite não encontrado" });
      return;
    }
    res.json({ ok: true });
  });

  if (process.env.VERCEL || options.serveUi === false) {
    return app;
  }

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
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[web] UI não compilada — sem Vite em produção (HTTP /health segue).");
    return app;
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
