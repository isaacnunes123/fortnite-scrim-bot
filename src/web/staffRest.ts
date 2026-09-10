import express, { type Express, type Request, type Response } from "express";
import { persistMapImage } from "../scrims/maps.js";
import { subscribe } from "../scrims/live.js";
import {
  addInvite,
  addLog,
  ensureScrimHasDrops,
  flushStore,
  getActiveBan,
  getScrim,
  normalizeDrop,
  patchScrim,
  pullRemoteStore,
  removeInvite,
} from "../scrims/store.js";
import { applyPlayerDropViaRest } from "./dropRest.js";
import {
  ensureDropMapEmbedViaRest,
  notifyInviteViaRest,
  postMatchCodeViaRest,
  refreshLeaveMessageViaRest,
  refreshRegistrationMessageViaRest,
  resolveDiscordPlayerViaRest,
  setDropMarkingOpenViaRest,
  setFillChatOpenViaRest,
} from "./lobbyRest.js";
import { saveYuniteTournamentId } from "./publicTables.js";
import { isStaffSession, requireAuth } from "./staffAuth.js";

function fail(res: Response, error: unknown, fallback: string): void {
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

async function loadStaffScrim(req: Request, res: Response) {
  await pullRemoteStore();
  const scrim = getScrim(String(req.params.id));
  if (!scrim) {
    res.status(404).json({ error: "Scrim não encontrada" });
    return null;
  }
  return scrim;
}

export function registerStaffRestRoutes(app: Express): void {
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

  app.post("/api/scrims/:id/code", requireAuth, async (req, res) => {
    const scrim = await loadStaffScrim(req, res);
    if (!scrim) {
      return;
    }
    const matchCode = String(req.body?.code ?? "").trim();
    const updated = patchScrim(scrim.id, { matchCode });
    await postMatchCodeViaRest(updated).catch(() => undefined);
    addLog({
      scrimId: scrim.id,
      kind: "code",
      summary: "Código da partida enviado",
      detail: matchCode,
    });
    await commitJson(res, 200, { scrim: updated });
  });

  app.post("/api/scrims/:id/checkout", requireAuth, async (req, res) => {
    const scrim = await loadStaffScrim(req, res);
    if (!scrim) {
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
    await refreshLeaveMessageViaRest(updated.id).catch(() => undefined);
    addLog({
      scrimId: scrim.id,
      kind: "checkout",
      summary: `Checkout até ${leaveUntil}`,
      detail: `Ban ${punishHours}h`,
    });
    await commitJson(res, 200, { scrim: updated });
  });

  app.post("/api/scrims/:id/yunite", requireAuth, async (req, res) => {
    const scrim = await loadStaffScrim(req, res);
    if (!scrim) {
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
      await commitJson(res, 200, { scrim: updated });
    } catch (error) {
      fail(res, error, "Não foi possível salvar o ID Yunite");
    }
  });

  app.post("/api/scrims/:id/fill/open", requireAuth, async (req, res) => {
    const scrim = await loadStaffScrim(req, res);
    if (!scrim) {
      return;
    }
    await setFillChatOpenViaRest(scrim, Boolean(req.body?.open));
    addLog({
      scrimId: scrim.id,
      kind: "fill",
      summary: req.body?.open ? "Fill liberado" : "Fill bloqueado",
    });
    await commitJson(res, 200, { ok: true });
  });

  app.post("/api/scrims/:id/drops/open", requireAuth, async (req, res) => {
    const scrim = await loadStaffScrim(req, res);
    if (!scrim) {
      return;
    }
    const open = Boolean(req.body?.open);
    const updated = await setDropMarkingOpenViaRest(scrim, open);
    addLog({
      scrimId: scrim.id,
      kind: "map",
      summary: open ? "Marcação de drops liberada" : "Marcação de drops fechada",
    });
    await commitJson(res, 200, { scrim: updated });
  });

  app.put("/api/scrims/:id/embeds", requireAuth, async (req, res) => {
    const scrim = await loadStaffScrim(req, res);
    if (!scrim) {
      return;
    }
    const updated = patchScrim(scrim.id, {
      embeds: {
        ...scrim.embeds,
        ...(req.body?.embeds ?? {}),
      },
    });
    await Promise.all([
      refreshRegistrationMessageViaRest(updated.id).catch(() => undefined),
      refreshLeaveMessageViaRest(updated.id).catch(() => undefined),
      ensureDropMapEmbedViaRest(updated).catch(() => undefined),
    ]);
    addLog({
      scrimId: scrim.id,
      kind: "embed",
      summary: "Embeds do Discord atualizadas",
    });
    await commitJson(res, 200, { scrim: getScrim(updated.id) ?? updated });
  });

  app.post("/api/scrims/:id/drops/assign", requireAuth, async (req, res) => {
    await pullRemoteStore();
    const scrim = ensureScrimHasDrops(String(req.params.id)) ?? getScrim(String(req.params.id));
    if (!scrim) {
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
      const drop = await applyPlayerDropViaRest(scrim.id, discordUserId, dropId, {
        ignoreClosed: true,
      });
      await commitJson(res, 200, { drop });
    } catch (error) {
      fail(res, error, "Não foi possível marcar o drop");
    }
  });

  app.put("/api/scrims/:id/drops", requireAuth, async (req, res) => {
    const scrim = await loadStaffScrim(req, res);
    if (!scrim) {
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
    await commitJson(res, 200, { scrim: updated });
  });

  app.post(
    "/api/scrims/:id/map",
    requireAuth,
    express.raw({
      type: ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/octet-stream"],
      limit: "8mb",
    }),
    async (req, res) => {
      const scrim = await loadStaffScrim(req, res);
      if (!scrim) {
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
        await commitJson(res, 200, { scrim: patchScrim(scrim.id, { mapImageUrl }) });
      } catch (error) {
        fail(res, error, "Não foi possível gravar a imagem do mapa");
      }
    },
  );

  app.post("/api/scrims/:id/invites", requireAuth, async (req, res) => {
    const scrim = await loadStaffScrim(req, res);
    if (!scrim) {
      return;
    }
    try {
      const player = await resolveDiscordPlayerViaRest(
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
      const dmSent = await notifyInviteViaRest({
        discordUserId: player.id,
        scrimName: scrim.name,
        teamName: invite.teamName,
        mode: scrim.mode,
      });
      await commitJson(res, 201, { invite, dmSent });
    } catch (error) {
      fail(res, error, "Não foi possível convidar");
    }
  });

  app.delete("/api/scrims/:id/invites/:inviteId", requireAuth, async (req, res) => {
    await pullRemoteStore();
    if (!removeInvite(String(req.params.id), String(req.params.inviteId))) {
      res.status(404).json({ error: "Convite não encontrado" });
      return;
    }
    await commitJson(res, 200, { ok: true });
  });
}
