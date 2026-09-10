import { env } from "../env.js";
import { DEFAULT_MAP_URL, resolvePublicMapUrl } from "../scrims/maps.js";
import {
  ensureScrimHasDrops,
  getScrim,
  getTable,
  listDropClaims,
  listScrims,
  listTables,
  MODE_SIZE,
  normalizeTableCategory,
  teamCount,
  type DropSpot,
  type LeaderboardRow,
  type PublicTable,
  type Scrim,
  type TableCategory,
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
  description: string;
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
  hasMap: boolean;
  kind: "scrim" | "table";
  source: "yunite" | "manual" | "none";
  category: TableCategory;
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

function inPublicGuild(scrim: Scrim): boolean {
  return !env.discordGuildId || scrim.guildId === env.discordGuildId || !scrim.guildId;
}

function emptyYunite(sessionId?: string): PublicBoardDetail["yunite"] {
  return {
    configured: yuniteConfigured(),
    linked: false,
    error: null,
    title: "",
    rows: [],
    matches: [],
    sessionId: sessionId?.trim() || null,
  };
}

async function loadYunite(
  tournamentId: string,
  sessionId?: string,
  missingMessage = "A staff ainda não vinculou o torneio Yunite nesta scrim.",
): Promise<PublicBoardDetail["yunite"]> {
  const yunite = emptyYunite(sessionId);
  const id = tournamentId.trim();
  yunite.linked = Boolean(id);
  if (!id) {
    yunite.error = missingMessage;
    return yunite;
  }
  if (!yunite.configured) {
    yunite.error = "A chave da API Yunite ainda não está configurada no servidor.";
    return yunite;
  }
  try {
    const board = await fetchYuniteBoard(id, sessionId);
    yunite.title = board.title;
    yunite.rows = board.rows;
    yunite.matches = board.matches;
    yunite.sessionId = board.sessionId;
  } catch (error) {
    yunite.error =
      error instanceof Error ? error.message : "Não foi possível carregar a tabela Yunite.";
  }
  return yunite;
}

function mapFields(scrim: Scrim | null): Pick<
  PublicBoardDetail,
  "mapImageUrl" | "drops" | "teamsPerDrop" | "maxContestedDrops" | "claimedDrops" | "dropCount" | "hasMap"
> {
  if (!scrim) {
    return {
      mapImageUrl: DEFAULT_MAP_URL,
      drops: [],
      teamsPerDrop: 1,
      maxContestedDrops: 0,
      claimedDrops: 0,
      dropCount: 0,
      hasMap: false,
    };
  }
  const resolved = resolvePublicMapUrl(scrim.mapImageUrl);
  return {
    mapImageUrl: resolved.url || DEFAULT_MAP_URL,
    drops: publicDrops(scrim.drops),
    teamsPerDrop: scrim.teamsPerDrop,
    maxContestedDrops: scrim.maxContestedDrops,
    claimedDrops: claimedDropCount(scrim.drops),
    dropCount: scrim.drops.length,
    hasMap: scrim.drops.length > 0,
  };
}

export function summarizeBoard(scrim: Scrim): PublicBoardSummary {
  const drops = scrim.drops;
  return {
    id: scrim.id,
    name: scrim.name,
    description: "",
    mode: scrim.mode,
    createdAt: scrim.createdAt,
    teamSize: MODE_SIZE[scrim.mode],
    teamCount: teamCount(scrim.id),
    maxSlots: scrim.maxSlots,
    claimedDrops: claimedDropCount(drops),
    dropCount: drops.length,
    dropsOpen: scrim.dropsOpen,
    live: scrim.dropsOpen !== false,
    hasTable: Boolean(scrim.yuniteTournamentId),
    hasMap: drops.length > 0,
    kind: "scrim",
    source: scrim.yuniteTournamentId ? "yunite" : "none",
    category: "closed",
  };
}

export function summarizeTable(table: PublicTable, scrim: Scrim | null): PublicBoardSummary {
  const map = mapFields(scrim);
  const rowCount = table.kind === "manual" ? table.rows.length : scrim ? teamCount(scrim.id) : 0;
  return {
    id: table.id,
    name: table.name,
    description: table.description,
    mode: scrim?.mode ?? table.mode,
    createdAt: table.createdAt,
    teamSize: MODE_SIZE[scrim?.mode ?? table.mode],
    teamCount: rowCount,
    maxSlots: scrim?.maxSlots ?? Math.max(rowCount, 1),
    claimedDrops: map.claimedDrops,
    dropCount: map.dropCount,
    dropsOpen: scrim ? scrim.dropsOpen : table.live,
    live: table.live,
    hasTable: table.kind === "manual" ? table.rows.length > 0 : Boolean(table.yuniteTournamentId),
    hasMap: map.hasMap,
    kind: "table",
    source: table.kind,
    category: normalizeTableCategory(table.category),
  };
}

function linkedScrim(table: PublicTable): Scrim | null {
  if (!table.scrimId) {
    return null;
  }
  const found = getScrim(table.scrimId);
  if (!found) {
    return null;
  }
  return ensureScrimHasDrops(found.id) ?? found;
}

export function listPublicBoards(): PublicBoardSummary[] {
  const tables = listTables();
  const linkedIds = new Set(tables.map((table) => table.scrimId).filter(Boolean));
  const fromTables = tables.map((table) => summarizeTable(table, linkedScrim(table)));
  const fromScrims = listScrims()
    .filter((scrim) => inPublicGuild(scrim) && !linkedIds.has(scrim.id))
    .map((scrim) => summarizeBoard(ensureScrimHasDrops(scrim.id) ?? scrim));
  return [...fromTables, ...fromScrims].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function publicRows(rows: LeaderboardRow[]): YuniteBoardPayload["rows"] {
  return rows.map((row) => ({
    rank: row.rank,
    players: row.players,
    games: row.games,
    eliminations: row.eliminations,
    wins: row.wins,
    score: row.score,
  }));
}

export async function getPublicBoard(
  id: string,
  sessionId?: string,
): Promise<PublicBoardDetail | null> {
  const table = getTable(id);
  if (table) {
    const scrim = linkedScrim(table);
    const summary = summarizeTable(table, scrim);
    const map = mapFields(scrim);
    const yunite =
      table.kind === "manual"
        ? {
            ...emptyYunite(),
            configured: true,
            linked: table.rows.length > 0,
            title: table.name,
            rows: publicRows(table.rows),
          }
        : await loadYunite(
            table.yuniteTournamentId,
            sessionId,
            "A staff ainda não vinculou o torneio Yunite nesta tabela.",
          );
    return {
      ...summary,
      ...map,
      yunite,
    };
  }

  const found = getScrim(id);
  if (!found) {
    return null;
  }
  const scrim = ensureScrimHasDrops(found.id) ?? found;
  const summary = summarizeBoard(scrim);
  const map = mapFields(scrim);
  return {
    ...summary,
    ...map,
    yunite: await loadYunite(scrim.yuniteTournamentId, sessionId),
  };
}

export function saveYuniteTournamentId(raw: string): string {
  return parseYuniteTournamentId(raw);
}
