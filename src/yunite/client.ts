import { env } from "../env.js";

const YUNITE_BASE = "https://yunite.xyz/api/v3";
const CACHE_MS = 15_000;
const TOURNAMENT_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const LIST_KEYS = [
  "leaderboard",
  "entries",
  "standings",
  "ranking",
  "teams",
  "rows",
  "results",
  "data",
  "matches",
  "sessions",
  "games",
  "tournaments",
  "items",
] as const;

const STAT_OBJECT_KEYS = [
  "stats",
  "statistics",
  "totals",
  "summary",
  "result",
  "score",
  "points",
  "scores",
  "values",
] as const;

const SESSION_KEYS = [
  "sessions",
  "matches",
  "games",
  "history",
  "gameResults",
  "matchResults",
  "results",
  "scores",
] as const;

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

function valuesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const vals = Object.values(record);
  if (vals.length > 0 && vals.every((item) => item && typeof item === "object")) {
    return vals;
  }
  return [];
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  for (const key of LIST_KEYS) {
    const found = valuesOf(record[key]);
    if (found.length) {
      return found;
    }
  }
  if (record.data) {
    return asArray(record.data);
  }
  return [];
}

function num(value: unknown, fallback = 0): number {
  const parsed = readNum(value);
  return parsed == null ? fallback : parsed;
}

function readNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().replace(",", ".");
    if (!trimmed) {
      return null;
    }
    const direct = Number(trimmed);
    if (Number.isFinite(direct)) {
      return direct;
    }
    const loose = Number(trimmed.replace(/[^\d.-]/g, ""));
    return Number.isFinite(loose) ? loose : null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  for (const key of ["total", "value", "amount", "sum", "score", "points", "current", "count"]) {
    const nested = readNum(record[key]);
    if (nested != null) {
      return nested;
    }
  }
  return null;
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

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
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

function teamId(record: Record<string, unknown>): string {
  const nestedTeam = asRecord(record.team);
  return (
    text(record.teamId) ||
    text(record.team_id) ||
    text(nestedTeam?.id) ||
    text(nestedTeam?.teamId) ||
    text(record.id) ||
    text(record.uuid)
  );
}

function teamKey(row: Pick<YuniteLeaderboardRow, "players">): string {
  return row.players
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("\n");
}

function hasStatFields(record: Record<string, unknown>): boolean {
  return [
    "games",
    "gamesPlayed",
    "games_played",
    "gameCount",
    "played",
    "eliminations",
    "elims",
    "kills",
    "wins",
    "victoryRoyales",
    "score",
    "points",
    "totalPoints",
    "pr",
    "stats",
    "statistics",
  ].some((key) => record[key] != null);
}

function looksLikeMatchMeta(record: Record<string, unknown>): boolean {
  const names = playerNames(record);
  return Boolean(
    (record.sessionId || record.matchId || (record.name && record.id)) &&
      names.length === 0 &&
      !hasStatFields(record),
  );
}

function scoreRowArray(items: unknown[]): number {
  let score = 0;
  let counted = 0;
  for (const item of items.slice(0, 8)) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    counted += 1;
    if (playerNames(record).length) {
      score += 3;
    }
    if (record.rank != null || record.placement != null || record.position != null) {
      score += 2;
    }
    if (hasStatFields(record)) {
      score += 5;
    }
    if (looksLikeMatchMeta(record)) {
      score -= 6;
    }
  }
  return counted ? score : -1;
}

function pickField(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (record[name] != null) {
      return record[name];
    }
    const snaked = snake(name);
    if (snaked !== name && record[snaked] != null) {
      return record[snaked];
    }
  }
  return undefined;
}

function fromColumns(record: Record<string, unknown>, names: string[]): number | null {
  const columns = [
    ...valuesOf(record.columns),
    ...valuesOf(record.fields),
    ...valuesOf(record.metrics),
  ];
  const aliases = new Set(names.map((name) => name.toLowerCase()));
  for (const name of names) {
    aliases.add(snake(name).toLowerCase());
  }
  for (const column of columns) {
    const item = asRecord(column);
    if (!item) {
      continue;
    }
    const key = (
      text(item.key) ||
      text(item.id) ||
      text(item.name) ||
      text(item.label) ||
      text(item.stat)
    ).toLowerCase();
    if (!key || ![...aliases].some((alias) => key === alias || key.includes(alias))) {
      continue;
    }
    const value = readNum(item.value ?? item.amount ?? item.total ?? item.score ?? item.points);
    if (value != null) {
      return value;
    }
  }
  return null;
}

function statSources(record: Record<string, unknown>): Record<string, unknown>[] {
  const sources = [record];
  for (const key of STAT_OBJECT_KEYS) {
    const nested = asRecord(record[key]);
    if (nested) {
      sources.push(nested);
    }
  }
  return sources;
}

function pickStat(record: Record<string, unknown>, names: string[]): number {
  for (const source of statSources(record)) {
    const value = readNum(pickField(source, names));
    if (value != null) {
      return value;
    }
    const column = fromColumns(source, names);
    if (column != null) {
      return column;
    }
  }
  return 0;
}

function isWin(record: Record<string, unknown>): boolean {
  if (record.victoryRoyale === true || record.victory === true || record.won === true || record.win === true) {
    return true;
  }
  return readNum(record.placement ?? record.place) === 1;
}

function sessionEntries(record: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const key of SESSION_KEYS) {
    const value = record[key];
    if (typeof value === "number" || typeof value === "string") {
      continue;
    }
    for (const item of valuesOf(value)) {
      const nested = asRecord(item);
      if (!nested) {
        continue;
      }
      if (looksLikeMatchMeta(nested) && !hasStatFields(nested)) {
        continue;
      }
      if (
        hasStatFields(nested) ||
        nested.placement != null ||
        nested.place != null ||
        nested.eliminations != null ||
        nested.elims != null ||
        nested.points != null ||
        nested.score != null ||
        nested.victoryRoyale != null ||
        nested.won != null
      ) {
        out.push(nested);
      }
    }
  }
  return out;
}

function sumSessions(record: Record<string, unknown>): Pick<
  YuniteLeaderboardRow,
  "games" | "eliminations" | "wins" | "score"
> {
  const sessions = sessionEntries(record);
  if (!sessions.length) {
    return { games: 0, eliminations: 0, wins: 0, score: 0 };
  }
  let games = 0;
  let eliminations = 0;
  let wins = 0;
  let score = 0;
  for (const session of sessions) {
    const sessionGames = Math.max(0, Math.round(pickStat(session, ["games", "gamesPlayed", "played", "matches"])));
    games += sessionGames || 1;
    eliminations += Math.max(0, Math.round(pickStat(session, ["eliminations", "elims", "kills", "elimCount"])));
    const sessionWins = Math.max(0, Math.round(pickStat(session, ["wins", "victoryRoyales", "crowns"])));
    wins += sessionWins || (isWin(session) ? 1 : 0);
    score += pickStat(session, ["score", "points", "totalPoints", "pr"]);
  }
  return { games, eliminations, wins, score };
}

function overlayRow(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    ...base,
    stats: asRecord(base.stats) ?? asRecord(extra.stats) ?? extra.stats ?? asRecord(extra),
    sessions: base.sessions ?? extra.sessions,
    matches: typeof base.matches === "number" ? base.matches : (base.matches ?? extra.matches),
    games: base.games ?? extra.games,
    gamesPlayed: base.gamesPlayed ?? extra.gamesPlayed,
    eliminations: base.eliminations ?? extra.eliminations,
    elims: base.elims ?? extra.elims,
    wins: base.wins ?? extra.wins,
    score: base.score ?? extra.score,
    points: base.points ?? extra.points,
    players: base.players ?? extra.players,
    members: base.members ?? extra.members,
    team: base.team ?? extra.team,
    rank: base.rank ?? extra.rank,
    placement: base.placement ?? extra.placement,
  };
}

function hydrateRows(primary: unknown[], extras: unknown[]): unknown[] {
  if (!extras.length) {
    return primary;
  }
  const byId = new Map<string, Record<string, unknown>>();
  const byPlayers = new Map<string, Record<string, unknown>>();
  for (const item of extras) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const id = teamId(record);
    if (id) {
      byId.set(id, record);
    }
    const key = teamKey({ players: playerNames(record) });
    if (key) {
      byPlayers.set(key, record);
    }
  }
  return primary.map((item) => {
    const record = asRecord(item) ?? {};
    const extra =
      (teamId(record) ? byId.get(teamId(record)) : undefined) ||
      byPlayers.get(teamKey({ players: playerNames(record) }));
    return extra ? overlayRow(record, extra) : record;
  });
}

function collectRowArrays(payload: unknown): unknown[][] {
  const arrays: unknown[][] = [];
  if (Array.isArray(payload)) {
    arrays.push(payload);
  }
  const record = asRecord(payload);
  if (!record) {
    return arrays;
  }
  for (const key of LIST_KEYS) {
    const found = valuesOf(record[key]);
    if (found.length) {
      arrays.push(found);
    }
  }
  const data = asRecord(record.data);
  if (data) {
    for (const key of LIST_KEYS) {
      const found = valuesOf(data[key]);
      if (found.length) {
        arrays.push(found);
      }
    }
  }
  return arrays;
}

function leaderboardEntries(payload: unknown): unknown[] {
  const arrays = collectRowArrays(payload)
    .map((items) => ({ items, score: scoreRowArray(items) }))
    .sort((a, b) => b.score - a.score);
  const best = arrays[0];
  if (!best || best.score <= 0) {
    return asArray(payload);
  }
  const extras = arrays.slice(1).flatMap((entry) => entry.items);
  return hydrateRows(best.items, extras);
}

function normalizeRow(entry: unknown, index: number): YuniteLeaderboardRow {
  const record = asRecord(entry) ?? {};
  const nested = sumSessions(record);
  const games = Math.max(
    0,
    Math.round(pickStat(record, ["games", "gamesPlayed", "gameCount", "played", "matches", "sessionCount"]) || nested.games),
  );
  const eliminations = Math.max(
    0,
    Math.round(pickStat(record, ["eliminations", "elims", "kills", "elimCount", "totalEliminations"]) || nested.eliminations),
  );
  const wins = Math.max(
    0,
    Math.round(pickStat(record, ["wins", "victoryRoyales", "crowns", "victoryCount"]) || nested.wins),
  );
  const score = pickStat(record, ["score", "points", "totalPoints", "totalScore", "pr"]) || nested.score;
  return {
    rank: Math.max(1, Math.round(num(record.rank ?? record.placement ?? record.position, index + 1))),
    players: playerNames(record),
    games,
    eliminations,
    wins,
    score,
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

function rowHasStats(row: YuniteLeaderboardRow): boolean {
  return row.games > 0 || row.eliminations > 0 || row.wins > 0 || row.score !== 0;
}

function rankByScore(rows: YuniteLeaderboardRow[]): YuniteLeaderboardRow[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        b.score - a.score || b.eliminations - a.eliminations || b.wins - a.wins || b.games - a.games || a.rank - b.rank,
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function aggregateMatchRows(
  baseRows: YuniteLeaderboardRow[],
  matchPayloads: unknown[],
): YuniteLeaderboardRow[] {
  const totals = new Map<string, YuniteLeaderboardRow>();

  const add = (row: YuniteLeaderboardRow, played: boolean) => {
    const key = teamKey(row);
    if (!key) {
      return;
    }
    const games = played ? Math.max(row.games, 1) : row.games;
    const current = totals.get(key);
    if (!current) {
      totals.set(key, { ...row, games });
      return;
    }
    current.games += games;
    current.eliminations += row.eliminations;
    current.wins += row.wins;
    current.score += row.score;
    if (row.players.length > current.players.length) {
      current.players = row.players;
    }
  };

  for (const payload of matchPayloads) {
    leaderboardEntries(payload)
      .map(normalizeRow)
      .filter((row) => row.players.length)
      .forEach((row) => add(row, true));
  }

  if (!totals.size) {
    return baseRows;
  }

  const used = new Set<string>();
  const merged = (baseRows.length ? baseRows : [...totals.values()]).map((row) => {
    const key = teamKey(row);
    const extra = totals.get(key);
    if (extra) {
      used.add(key);
      return {
        ...row,
        games: extra.games,
        eliminations: extra.eliminations,
        wins: extra.wins,
        score: extra.score,
      };
    }
    return row;
  });
  for (const [key, row] of totals) {
    if (!used.has(key)) {
      merged.push(row);
    }
  }
  return rankByScore(merged.filter((row) => row.players.length));
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
    let rows = leaderboardEntries(boardRaw)
      .map(normalizeRow)
      .filter((row) => row.players.length)
      .sort((a, b) => a.rank - b.rank || b.score - a.score);
    const matches = asArray(matchesRaw).map(normalizeMatch);
    if (!session && matches.length > 0 && (rows.length === 0 || rows.every((row) => !rowHasStats(row)))) {
      const matchPayloads = await Promise.all(
        matches.map((match) =>
          yuniteGet(`/guild/${guildId}/tournaments/${id}/matches/${encodeURIComponent(match.id)}`).catch(() => null),
        ),
      );
      rows = aggregateMatchRows(
        rows,
        matchPayloads.filter((payload) => payload != null),
      );
    }
    return {
      title,
      rows,
      matches,
      sessionId: session || null,
    };
  });
}
