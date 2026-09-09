export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
    code?: number;
  };
  if (!response.ok) {
    throw new Error(
      data.error || data.message || "Falha na requisição",
    );
  }
  return data;
}

export async function uploadMap(file: File, path = "/api/maps/upload"): Promise<string> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": file.type || "image/png" },
    body: await file.arrayBuffer(),
  });
  const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !data.url) {
    throw new Error(data.error || "Falha ao enviar o mapa");
  }
  return data.url;
}

export type BotStatus = {
  configured: boolean;
  ready: boolean;
  username: string | null;
  id: string | null;
  guildCount: number;
  uptimeMs: number | null;
};

export type DropKind = "poi" | "contested" | "locked";

export type DropVertex = {
  x: number;
  y: number;
};

export type DropClaim = {
  teamName: string;
  userId: string;
  displayName: string;
  avatarUrl: string;
};

export type DropSpot = {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: DropKind;
  vertices: DropVertex[];
  claims?: DropClaim[];
  claimedByTeam: string | null;
  claimedByUserId?: string | null;
  claimedByName?: string | null;
  claimedByAvatarUrl?: string | null;
};

export type PriorityWindow = {
  roleId: string;
  time: string;
  date?: string;
};

export type MapTemplate = {
  id: string;
  name: string;
  mapImageUrl: string;
  drops: DropSpot[];
  createdAt: string;
  maxContestedDrops?: number;
};

export type ScrimPreset = {
  id: string;
  name: string;
  createdAt: string;
  mode: "solo" | "duo" | "trio" | "squad";
  maxSlots: number;
  teamsPerDrop: number;
  maxContestedDrops: number;
  templateId: string;
  accessRoleIds: string[];
  staffRoleIds: string[];
  windows: PriorityWindow[];
  leaveUntil: string;
  punishHours: number;
};

export type DiscordGuild = {
  id: string;
  name: string;
  memberCount: number;
};

export type DiscordRole = {
  id: string;
  name: string;
  color: string;
};

export type ScrimSummary = {
  id: string;
  name: string;
  mode: "solo" | "duo" | "trio" | "squad";
  maxSlots: number;
  createdAt: string;
  teamSize: number;
  inviteCount: number;
  teamCount: number;
  guildName?: string;
};

export type EmbedCopy = {
  title: string;
  description: string;
  color: string;
  footer: string;
};

export type ScrimEmbeds = {
  registration: EmbedCopy;
  dropmapOpen: EmbedCopy;
  dropmapClosed: EmbedCopy;
  leave: EmbedCopy;
  code: EmbedCopy;
};

export type ActivityLog = {
  id: string;
  at: string;
  scrimId: string | null;
  kind: string;
  summary: string;
  detail: string;
};

export type Invite = {
  id: string;
  scrimId: string;
  discordUserId: string;
  displayName: string;
  teamName: string;
  createdAt: string;
  dropped: boolean;
  fortniteNick: string;
  droppedAt?: string | null;
  dropName?: string | null;
  username?: string;
  globalName?: string;
  avatarUrl?: string;
  highestRoleName?: string;
  highestRoleColor?: string;
  roles?: Array<{ name: string; color: string }>;
  inServer?: boolean;
  boosted?: boolean;
  joinedAt?: string | null;
};

export type BlacklistEntry = {
  id: string;
  discordUserId: string;
  displayName: string;
  fortniteNick: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  scrimId: string;
};

export type ScrimDetail = {
  id: string;
  name: string;
  mode: "solo" | "duo" | "trio" | "squad";
  maxSlots: number;
  createdAt: string;
  teamSize: number;
  teamCount: number;
  accessRoleIds: string[];
  staffRoleIds: string[];
  windows: PriorityWindow[];
  leaveUntil: string;
  punishHours: number;
  mapImageUrl: string;
  matchCode: string;
  drops: DropSpot[];
  guildName?: string;
  templateName?: string;
  dropsOpen?: boolean;
  teamsPerDrop?: number;
  maxContestedDrops?: number;
  embeds?: ScrimEmbeds;
  discord: { lobbyNumber: number; fillChatOpen: boolean } | null;
  yuniteTournamentId?: string;
};

export const TABLE_CATEGORIES = [
  "divisao-2",
  "divisao-1-pro",
  "endgame-solo",
  "endgame-duo",
  "endgame-reload",
  "closed",
] as const;

export type TableCategory = (typeof TABLE_CATEGORIES)[number];

export const DEFAULT_TABLE_CATEGORY: TableCategory = "divisao-2";

export const TABLE_CATEGORY_LABEL: Record<TableCategory, string> = {
  "divisao-2": "Divisão 2",
  "divisao-1-pro": "Divisão 1 e Pro",
  "endgame-solo": "Endgame · Solo",
  "endgame-duo": "Endgame · Duo",
  "endgame-reload": "Endgame · Reload",
  closed: "Closed",
};

export type TableDivisionTab = "divisao-2" | "divisao-1-pro" | "endgame" | "closed";
export type EndgameSubTab = "solo" | "duo" | "reload";

export const TABLE_DIVISION_TABS: Array<{ id: TableDivisionTab; label: string }> = [
  { id: "divisao-2", label: "Divisão 2" },
  { id: "divisao-1-pro", label: "Divisão 1 e Pro" },
  { id: "endgame", label: "Endgame" },
];

export const ENDGAME_SUB_TABS: Array<{
  id: EndgameSubTab;
  label: string;
  category: TableCategory;
}> = [
  { id: "solo", label: "Solo", category: "endgame-solo" },
  { id: "duo", label: "Duo", category: "endgame-duo" },
  { id: "reload", label: "Reload", category: "endgame-reload" },
];

export function isTableCategory(value: string | null | undefined): value is TableCategory {
  return TABLE_CATEGORIES.includes(value as TableCategory);
}

export function normalizeTableCategory(value: string | null | undefined): TableCategory {
  return isTableCategory(value) ? value : DEFAULT_TABLE_CATEGORY;
}

export function categoryMatchesTab(
  category: TableCategory,
  tab: TableDivisionTab,
  endgame: EndgameSubTab,
): boolean {
  if (tab === "endgame") {
    return category === ENDGAME_SUB_TABS.find((item) => item.id === endgame)?.category;
  }
  if (tab === "closed") {
    return category === "closed";
  }
  return category === tab;
}

export type PublicBoardSummary = {
  id: string;
  name: string;
  description?: string;
  mode: "solo" | "duo" | "trio" | "squad";
  createdAt: string;
  teamSize: number;
  teamCount: number;
  maxSlots: number;
  claimedDrops: number;
  dropCount: number;
  dropsOpen: boolean;
  live: boolean;
  hasTable: boolean;
  hasMap?: boolean;
  kind?: "scrim" | "table";
  source?: "yunite" | "manual" | "none";
  category?: TableCategory;
};

export type PublicTable = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  mode: "solo" | "duo" | "trio" | "squad";
  live: boolean;
  scrimId: string;
  kind: "yunite" | "manual";
  category: TableCategory;
  yuniteTournamentId: string;
  rows: PublicLeaderboardRow[];
};

export type PublicLeaderboardRow = {
  id?: string;
  rank: number;
  players: string[];
  games: number;
  eliminations: number;
  wins: number;
  score: number;
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
    title?: string;
    rows?: PublicLeaderboardRow[];
    matches?: Array<{ id: string; name: string }>;
    sessionId?: string | null;
  };
};
