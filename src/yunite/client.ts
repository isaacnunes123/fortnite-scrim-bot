import { env } from "../env.js";

const YUNITE_BASE = "https://yunite.xyz/api/v3";
const CACHE_MS = 15_000;
const TOURNAMENT_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

type CacheEntry<T> = { at: number; value: T };

const cache = new Map<string, CacheEntry<unknown>>();

export type YuniteLeaderboardRow = {
  rank: number;
  players: string[];
  games: number;
  eliminations: number;
  wins: number;
  score: number;
};

export type YuniteMatch = {
  id: string;
  name: string;
};

export type YuniteTournamentSummary = {
  id: string;
  name: string;
};

export type YuniteBoardPayload = {
  title: string;
  rows: YuniteLeaderboardRow[];
  matches: YuniteMatch[];
  sessionId: string | null;
};

export function yuniteConfigured(): boolean {
  return Boolean(env.yuniteApiKey);
}

export function parseYuniteTournamentId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  const fromPath = value.match(/leaderboard\/([0-9a-f-]{36})/i)?.[1];
  if (fromPath) {
    return fromPath;
  }
  const uuid = value.match(TOURNAMENT_ID)?.[0];
  if (uuid) {
    return uuid;
  }
  if (/^[A-Za-z0-9._-]{6,80}$/.test(value)) {
    return value;
  }
  throw new Error("ID de torneio Yunite inválido. Cole o UUID ou o link da tabela.");
}

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return Promise.resolve(hit.value);
  }
  return load().then((value) => {
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  for (const key of [
    "leaderboard",
    "entries",
    "teams",
    "rows",
    "results",
    "data",
    "matches",
    "sessions",
    "games",
    "tournaments",
    "items",
  ]) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }
  if (record.data) {
    return asArray(record.data);
  }
  return [];
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function playerNames(entry: Record<string, unknown>): string[] {
  const nested = [entry.players, entry.members, entry.team, entry.users, entry.names];
  const names: string[] = [];
  for (const item of nested) {
    if (typeof item === "string" && item.trim()) {
      names.push(item.trim());
      continue;
    }
    if (Array.isArray(item)) {
      for (const player of item) {
        if (typeof player === "string" && player.trim()) {
          names.push(player.trim());
          continue;
        }
        const record = asRecord(player);
        if (!record) {
          continue;
        }
        const name =
          text(record.epicName) ||
          text(record.name) ||
          text(record.username) ||
          text(record.displayName) ||
          text(record.ign) ||
          text(record.tag);
        if (name) {
          names.push(name);
        }
      }
    }
    const record = asRecord(item);
    if (record) {
      names.push(...playerNames(record));
    }
  }
  const single =
    text(entry.epicName) ||
    text(entry.player) ||
    text(entry.name) ||
    text(entry.teamName) ||
    text(entry.tag);
  if (names.length === 0 && single) {
    names.push(single);
  }
  return [...new Set(names.filter(Boolean))];
}

function normalizeRow(entry: unknown, index: number): YuniteLeaderboardRow {
  const record = asRecord(entry) ?? {};
  return {
    rank: Math.max(1, Math.round(num(record.rank ?? record.placement ?? record.position, index + 1))),
    players: playerNames(record),
    games: Math.max(0, Math.round(num(record.games ?? record.gamesPlayed ?? record.matches))),
    eliminations: Math.max(
      0,
      Math.round(num(record.eliminations ?? record.elims ?? record.kills ?? record.eliminationsAverage)),
    ),
    wins: Math.max(0, Math.round(num(record.wins ?? record.victoryRoyales ?? record.crowns))),
    score: num(record.score ?? record.points ?? record.totalPoints ?? record.pr),
  };
}

function normalizeMatch(entry: unknown, index: number): YuniteMatch {
  const record = asRecord(entry) ?? {};
  const id =
    text(record.sessionId) ||
    text(record.id) ||
    text(record.matchId) ||
    text(record.uuid) ||
    String(index + 1);
  const name =
    text(record.name) ||
    text(record.title) ||
    text(record.label) ||
    (index === 0 ? "Partida 1" : `Partida ${index + 1}`);
  return { id, name };
}

function normalizeTournament(entry: unknown): YuniteTournamentSummary | null {
  const record = asRecord(entry);
  if (!record) {
    return null;
  }
  const id = text(record.id) || text(record.tournamentId) || text(record.uuid);
  if (!id) {
    return null;
  }
  return {
    id,
    name: text(record.name) || text(record.title) || id,
  };
}

async function yuniteGet(path: string): Promise<unknown> {
  if (!env.yuniteApiKey) {
    throw new Error("YUNITE_API_KEY ainda não está configurada no servidor.");
  }
  const response = await fetch(`${YUNITE_BASE}${path}`, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Y-Api-Token": env.yuniteApiKey,
    },
    signal: AbortSignal.timeout(12_000),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const record = asRecord(payload);
    const message =
      text(record?.error) ||
      text(record?.message) ||
      text(record?.detail) ||
      `Yunite respondeu ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export async function listYuniteTournaments(): Promise<YuniteTournamentSummary[]> {
  const guildId = env.discordGuildId;
  return cached(`tournaments:${guildId}`, async () => {
    const payload = await yuniteGet(`/guild/${guildId}/tournaments`);
    return asArray(payload)
      .map(normalizeTournament)
      .filter((item): item is YuniteTournamentSummary => Boolean(item));
  });
}

export async function fetchYuniteBoard(
  tournamentId: string,
  sessionId?: string,
): Promise<YuniteBoardPayload> {
  const guildId = env.discordGuildId;
  const id = parseYuniteTournamentId(tournamentId);
  if (!id) {
    throw new Error("Informe o ID do torneio Yunite.");
  }
  const session = sessionId?.trim() || "";
  return cached(`board:${id}:${session}`, async () => {
    const leaderboardPath = session
      ? `/guild/${guildId}/tournaments/${id}/matches/${encodeURIComponent(session)}`
      : `/guild/${guildId}/tournaments/${id}/leaderboard`;
    const [boardRaw, matchesRaw, tournamentRaw] = await Promise.all([
      yuniteGet(leaderboardPath),
      yuniteGet(`/guild/${guildId}/tournaments/${id}/matches`).catch(() => []),
      yuniteGet(`/guild/${guildId}/tournaments/${id}`).catch(() => null),
    ]);
    const tournament = asRecord(tournamentRaw);
    const title =
      text(tournament?.name) ||
      text(tournament?.title) ||
      text(asRecord(boardRaw)?.name) ||
      text(asRecord(boardRaw)?.title) ||
      "";
    const rows = asArray(boardRaw)
      .map(normalizeRow)
      .sort((a, b) => a.rank - b.rank || b.score - a.score);
    const matches = asArray(matchesRaw).map(normalizeMatch);
    return {
      title,
      rows,
      matches,
      sessionId: session || null,
    };
  });
}
