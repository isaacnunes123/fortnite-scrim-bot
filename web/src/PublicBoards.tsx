import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type DropSpot,
  type PublicBoardDetail,
  type PublicBoardSummary,
  type PublicLeaderboardRow,
} from "./api";
import { listDropClaims } from "./drops";
import { MapBoard } from "./MapBoard";

const MODE_LABEL = {
  solo: "Solo",
  duo: "Duo",
  trio: "Trio",
  squad: "Squad",
} as const;

type Filter = "all" | "live" | "done";
type DetailTab = "table" | "map";

function boardIdFromPath(pathname: string): string | null {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts[0] !== "tabelas") {
    return null;
  }
  return parts[1] ?? null;
}

function go(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function formatAgo(value: string): string {
  const delta = Date.parse(value) - Date.now();
  if (!Number.isFinite(delta)) {
    return "";
  }
  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  const abs = Math.abs(delta);
  if (abs < 60_000) {
    return rtf.format(Math.round(delta / 1000), "second");
  }
  if (abs < 3_600_000) {
    return rtf.format(Math.round(delta / 60_000), "minute");
  }
  if (abs < 86_400_000) {
    return rtf.format(Math.round(delta / 3_600_000), "hour");
  }
  return rtf.format(Math.round(delta / 86_400_000), "day");
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function PublicBoards() {
  const [path, setPath] = useState(window.location.pathname);
  const boardId = boardIdFromPath(path);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.title = boardId ? "Tabela · BUILD CLOSED" : "Tabelas · BUILD CLOSED";
  }, [boardId]);

  return (
    <div className="shell boards-shell">
      <header className="topbar">
        <a className="brand" href="/tabelas" onClick={(event) => {
          event.preventDefault();
          go("/tabelas");
        }}>
          <img src="/brand/logo.png" alt="" className="brand-logo" />
          <span className="brand-copy">
            <strong>BUILD CLOSED</strong>
            <span>Tabelas · mapas de drop</span>
          </span>
        </a>
        <div className="actions">
          <a className="btn secondary" href="/">
            Painel staff
          </a>
        </div>
      </header>
      {boardId ? <BoardDetail id={boardId} /> : <BoardList />}
    </div>
  );
}

function BoardList() {
  const [boards, setBoards] = useState<PublicBoardSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [mode, setMode] = useState<"all" | PublicBoardSummary["mode"]>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    api<{ boards: PublicBoardSummary[] }>("/api/public/tabelas")
      .then((data) => setBoards(data.boards ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : "Falha ao carregar"));
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return boards.filter((board) => {
      if (filter === "live" && !board.live) {
        return false;
      }
      if (filter === "done" && board.live) {
        return false;
      }
      if (mode !== "all" && board.mode !== mode) {
        return false;
      }
      if (!q) {
        return true;
      }
      return board.name.toLowerCase().includes(q);
    });
  }, [boards, filter, mode, query]);

  return (
    <section className="boards-home">
      <div className="boards-hero">
        <p className="boards-kicker">Rankings ao vivo</p>
        <h1>Tabelas</h1>
        <p className="muted">
          Colocação das scrims (Yunite) e o mapa de drop de cada lobby. Sem login.
        </p>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="boards-toolbar">
        <div className="boards-chips">
          {(
            [
              ["all", "Todas"],
              ["live", "Ao vivo"],
              ["done", "Encerradas"],
            ] as Array<[Filter, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`boards-chip ${filter === value ? "on" : ""}`}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
          {(["solo", "duo", "trio", "squad"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`boards-chip ${mode === value ? "on" : ""}`}
              onClick={() => setMode((current) => (current === value ? "all" : value))}
            >
              {MODE_LABEL[value]}
            </button>
          ))}
        </div>
        <input
          className="boards-search"
          placeholder="Buscar scrim"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {visible.length === 0 ? (
        <p className="muted">Nenhuma scrim pública ainda. Quando a staff abrir um lobby, ela aparece aqui.</p>
      ) : (
        <ul className="boards-grid">
          {visible.map((board) => (
            <li key={board.id}>
              <button type="button" className="board-card" onClick={() => go(`/tabelas/${board.id}`)}>
                <div className="board-card-top">
                  <span className={`pill ${board.live ? "live" : "off"}`}>
                    {board.live ? "Ao vivo" : "Encerrada"}
                  </span>
                  <span className="muted">{formatAgo(board.createdAt)}</span>
                </div>
                <h2>
                  {board.name}{" "}
                  <span>
                    [{new Date(board.createdAt).toLocaleDateString("pt-BR", {
                      timeZone: "America/Sao_Paulo",
                      day: "2-digit",
                      month: "2-digit",
                    })}]
                  </span>
                </h2>
                <p>
                  {MODE_LABEL[board.mode]} · {board.teamCount}/{board.maxSlots} times
                  {board.hasTable ? " · tabela Yunite" : ""}
                </p>
                <p className="board-card-meta">
                  Mapa {board.claimedDrops}/{board.dropCount || 0} drops
                </p>
                <span className="board-card-cta">Ver tabela</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BoardDetail({ id }: { id: string }) {
  const [board, setBoard] = useState<PublicBoardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("table");
  const [sessionId, setSessionId] = useState("");
  const sessionRef = useRef("");
  sessionRef.current = sessionId;

  async function load(nextSession = sessionRef.current) {
    const data = await api<{ board: PublicBoardDetail }>(
      `/api/public/tabelas/${encodeURIComponent(id)}${
        nextSession ? `?session=${encodeURIComponent(nextSession)}` : ""
      }`,
    );
    setBoard(data.board);
  }

  useEffect(() => {
    let timer = 0;
    load("").catch((err) => {
      setError(err instanceof Error ? err.message : "Falha ao carregar");
    });
    timer = window.setInterval(() => {
      load(sessionRef.current).catch(() => undefined);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [id]);

  if (error && !board) {
    return (
      <section className="card">
        <button className="btn secondary" type="button" onClick={() => go("/tabelas")}>
          Voltar
        </button>
        <p className="error">{error}</p>
      </section>
    );
  }

  if (!board) {
    return <p className="muted">Carregando tabela…</p>;
  }

  const rows = board.yunite.rows ?? [];
  const matches = board.yunite.matches ?? [];
  const yuniteTitle = board.yunite.title?.trim();

  return (
    <section className="boards-detail">
      <div className="boards-detail-head">
        <button className="btn secondary" type="button" onClick={() => go("/tabelas")}>
          Voltar
        </button>
        <div>
          <p className="boards-kicker">{yuniteTitle || "Scrim"}</p>
          <h1>{board.name}</h1>
          <p className="muted">
            {MODE_LABEL[board.mode]} · {board.teamCount}/{board.maxSlots} times ·{" "}
            {formatWhen(board.createdAt)}
          </p>
        </div>
        <span className={`pill ${board.live ? "live" : "off"}`}>
          {board.live ? "Ao vivo" : "Encerrada"}
        </span>
      </div>

      <div className="boards-tabs">
        <button
          type="button"
          className={`boards-chip ${tab === "table" ? "on" : ""}`}
          onClick={() => setTab("table")}
        >
          Tabela
        </button>
        <button
          type="button"
          className={`boards-chip ${tab === "map" ? "on" : ""}`}
          onClick={() => setTab("map")}
        >
          Mapa de drop
        </button>
      </div>

      <div className={`boards-split ${tab}`}>
        <div className="card boards-table-card">
          <div className="boards-table-head">
            <h2>Colocação</h2>
            {matches.length > 0 ? (
              <select
                value={sessionId}
                onChange={(event) => {
                  const next = event.target.value;
                  setSessionId(next);
                  load(next).catch((err) => {
                    setError(err instanceof Error ? err.message : "Falha ao carregar partida");
                  });
                }}
              >
                <option value="">Geral</option>
                {matches.map((match) => (
                  <option key={match.id} value={match.id}>
                    {match.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {board.yunite.error ? <p className="muted">{board.yunite.error}</p> : null}
          {!board.yunite.error && rows.length === 0 ? (
            <p className="muted">A tabela ainda não tem linhas. Assim que o Yunite pontuar, aparece aqui.</p>
          ) : rows.length > 0 ? (
            <div className="boards-table-wrap">
              <table className="boards-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Players</th>
                    <th>Partidas</th>
                    <th>Elims</th>
                    <th>W</th>
                    <th>Pontos</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <LeaderboardRowView key={`${row.rank}-${row.players.join(",")}`} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <div className="card boards-map-card">
          <div className="boards-table-head">
            <h2>Mapa de drop</h2>
            <span className="muted">
              {board.claimedDrops}/{board.dropCount} marcados
            </span>
          </div>
          <p className="muted">Somente leitura. Players marcam no link do Discord.</p>
          <MapBoard
            imageUrl={board.mapImageUrl || "/maps/island.png"}
            drops={board.drops}
            occupancyLimit={board.teamsPerDrop}
            maxContestedDrops={board.maxContestedDrops}
            compact
          />
          <ul className="boards-drop-list">
            {board.drops
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
              .map((drop) => (
                <DropLine key={drop.id} drop={drop} />
              ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function LeaderboardRowView({ row }: { row: PublicLeaderboardRow }) {
  const medal = row.rank === 1 ? "gold" : row.rank === 2 ? "silver" : row.rank === 3 ? "bronze" : "";
  return (
    <tr className={medal ? `medal-${medal}` : undefined}>
      <td>#{row.rank}</td>
      <td>{row.players.length ? row.players.join(" · ") : "—"}</td>
      <td>{row.games}</td>
      <td>{row.eliminations}</td>
      <td>{row.wins}</td>
      <td>{formatScore(row.score)}</td>
    </tr>
  );
}

function DropLine({ drop }: { drop: DropSpot }) {
  const claims = listDropClaims(drop);
  return (
    <li>
      <strong>{drop.name}</strong>
      <span>
        {claims.length
          ? claims.map((claim) => claim.displayName || claim.teamName).join(" · ")
          : "Livre"}
      </span>
    </li>
  );
}
