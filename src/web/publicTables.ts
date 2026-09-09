import { env } from "../env.js";
import { DEFAULT_MAP_URL, resolvePublicMapUrl } from "../scrims/maps.js";
import {
  ensureScrimHasDrops,
  getScrim,
  listDropClaims,
  listScrims,
  MODE_SIZE,
  teamCount,
  type DropSpot,
  type Scrim,
} from "../scrims/store.js";
import {
  fetchYuniteBoard,
  parseYuniteTournamentId,
  yuniteConfigured,
  type YuniteBoardPayload,
} from "../yunite/client.js";

export type PublicBoardSummary = {
  id: string;
  name: string;
  mode: Scrim["mode"];
  createdAt: string;
  teamSize: number;
  teamCount: number;
  maxSlots: number;
  claimedDrops: number;
  dropCount: number;
  dropsOpen: boolean;
  live: boolean;
  hasTable: boolean;
};

export type PublicBoardDetail = PublicBoardSummary & {
  mapImageUrl: string;
  drops: DropSpot[];
  teamsPerDrop: number;
  maxContestedDrops: number;
  yunite: {
    configured: boolean;
    linked: boolean;
    error: string | null;
  } & Partial<YuniteBoardPayload>;
};

function publicDrops(drops: DropSpot[]): DropSpot[] {
  return drops.map((drop) => ({
    ...drop,
    claimedByUserId: null,
    claims: listDropClaims(drop).map((claim) => ({
      ...claim,
      userId: "",
    })),
  }));
}

function claimedDropCount(drops: DropSpot[]): number {
  return drops.filter((drop) => listDropClaims(drop).length > 0).length;
}

export function summarizeBoard(scrim: Scrim): PublicBoardSummary {
  return {
    id: scrim.id,
    name: scrim.name,
    mode: scrim.mode,
    createdAt: scrim.createdAt,
    teamSize: MODE_SIZE[scrim.mode],
    teamCount: teamCount(scrim.id),
    maxSlots: scrim.maxSlots,
    claimedDrops: claimedDropCount(scrim.drops),
    dropCount: scrim.drops.length,
    dropsOpen: scrim.dropsOpen,
    live: scrim.dropsOpen !== false,
    hasTable: Boolean(scrim.yuniteTournamentId),
  };
}

export function listPublicBoards(): PublicBoardSummary[] {
  return listScrims()
    .filter((scrim) => !env.discordGuildId || scrim.guildId === env.discordGuildId || !scrim.guildId)
    .map((scrim) => summarizeBoard(ensureScrimHasDrops(scrim.id) ?? scrim));
}

export async function getPublicBoard(
  id: string,
  sessionId?: string,
): Promise<PublicBoardDetail | null> {
  const found = getScrim(id);
  if (!found) {
    return null;
  }
  const scrim = ensureScrimHasDrops(found.id) ?? found;
  const summary = summarizeBoard(scrim);
  const tournamentId = scrim.yuniteTournamentId.trim();
  const yunite: PublicBoardDetail["yunite"] = {
    configured: yuniteConfigured(),
    linked: Boolean(tournamentId),
    error: null,
    title: "",
    rows: [],
    matches: [],
    sessionId: sessionId?.trim() || null,
  };

  if (!tournamentId) {
    yunite.error = "A staff ainda não vinculou o torneio Yunite nesta scrim.";
  } else if (!yunite.configured) {
    yunite.error = "A chave da API Yunite ainda não está configurada no servidor.";
  } else {
    try {
      const board = await fetchYuniteBoard(tournamentId, sessionId);
      yunite.title = board.title;
      yunite.rows = board.rows;
      yunite.matches = board.matches;
      yunite.sessionId = board.sessionId;
    } catch (error) {
      yunite.error =
        error instanceof Error ? error.message : "Não foi possível carregar a tabela Yunite.";
    }
  }

  const resolved = resolvePublicMapUrl(scrim.mapImageUrl);
  return {
    ...summary,
    mapImageUrl: resolved.url || DEFAULT_MAP_URL,
    drops: publicDrops(scrim.drops),
    teamsPerDrop: scrim.teamsPerDrop,
    maxContestedDrops: scrim.maxContestedDrops,
    yunite,
  };
}

export function saveYuniteTournamentId(raw: string): string {
  return parseYuniteTournamentId(raw);
}
