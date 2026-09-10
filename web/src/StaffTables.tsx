import { FormEvent, useEffect, useState } from "react";
import {
  api,
  DEFAULT_TABLE_CATEGORY,
  TABLE_CATEGORIES,
  TABLE_CATEGORY_LABEL,
  type PublicLeaderboardRow,
  type PublicTable,
  type ScrimSummary,
  type TableCategory,
} from "./api";

type DraftRow = {
  id: string;
  rank: string;
  players: string;
  games: string;
  eliminations: string;
  wins: string;
  score: string;
};

const MODE_LABEL = {
  solo: "Solo",
  duo: "Duo",
  trio: "Trio",
  squad: "Squad",
} as const;

function newRow(rank: number): DraftRow {
  return {
    id: `new-${rank}-${Math.random().toString(36).slice(2, 8)}`,
    rank: String(rank),
    players: "",
    games: "0",
    eliminations: "0",
    wins: "0",
    score: "0",
  };
}

function rowsFromTable(table: PublicTable | null): DraftRow[] {
  if (!table?.rows.length) {
    return [newRow(1)];
  }
  return table.rows.map((row, index) => ({
    id: row.id || `row-${index}`,
    rank: String(row.rank),
    players: row.players.join(", "),
    games: String(row.games),
    eliminations: String(row.eliminations),
    wins: String(row.wins),
    score: String(row.score),
  }));
}

function payloadRows(rows: DraftRow[]): PublicLeaderboardRow[] {
  return rows
    .filter((row) => row.players.trim())
    .map((row, index) => ({
      id: row.id.startsWith("new-") ? undefined : row.id,
      rank: Number(row.rank) || index + 1,
      players: row.players
        .split(/[,·|/;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      games: Number(row.games) || 0,
      eliminations: Number(row.eliminations) || 0,
      wins: Number(row.wins) || 0,
      score: Number(row.score) || 0,
    }));
}

export function StaffTables({ onBack }: { onBack: () => void }) {
  const [tables, setTables] = useState<PublicTable[]>([]);
  const [scrims, setScrims] = useState<ScrimSummary[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<PublicTable["mode"]>("trio");
  const [live, setLive] = useState(true);
  const [scrimId, setScrimId] = useState("");
  const [kind, setKind] = useState<PublicTable["kind"]>("manual");
  const [category, setCategory] = useState<TableCategory>(DEFAULT_TABLE_CATEGORY);
  const [yuniteId, setYuniteId] = useState("");
  const [yuniteTournaments, setYuniteTournaments] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [yuniteConfigured, setYuniteConfigured] = useState(true);
  const [yuniteStatus, setYuniteStatus] = useState<string | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([newRow(1)]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function resetForm() {
    setEditingId(null);
    setName("");
    setDescription("");
    setMode("trio");
    setLive(true);
    setScrimId("");
    setKind("manual");
    setCategory(DEFAULT_TABLE_CATEGORY);
    setYuniteId("");
    setRows([newRow(1)]);
  }

  function fill(table: PublicTable) {
    setEditingId(table.id);
    setName(table.name);
    setDescription(table.description);
    setMode(table.mode);
    setLive(table.live);
    setScrimId(table.scrimId);
    setKind(table.kind);
    setCategory(table.category ?? DEFAULT_TABLE_CATEGORY);
    setYuniteId(table.yuniteTournamentId);
    setRows(rowsFromTable(table));
  }

  async function load() {
    const [list, scrimList] = await Promise.all([
      api<{ tables: PublicTable[] }>("/api/tables"),
      api<{ scrims: ScrimSummary[] }>("/api/scrims"),
    ]);
    setTables(list.tables ?? []);
    setScrims(scrimList.scrims ?? []);
  }

  useEffect(() => {
    load().catch((err) => {
      setError(err instanceof Error ? err.message : "Falha ao carregar tabelas");
    });
    api<{
      configured?: boolean;
      tournaments: Array<{ id: string; name: string }>;
      error?: string | null;
    }>("/api/yunite/tournaments")
      .then((data) => {
        setYuniteConfigured(data.configured !== false);
        setYuniteTournaments(data.tournaments ?? []);
        setYuniteStatus(data.error ?? null);
      })
      .catch((err) => {
        setYuniteConfigured(false);
        setYuniteTournaments([]);
        setYuniteStatus(err instanceof Error ? err.message : "Não foi possível listar torneios Yunite");
      });
  }, []);

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const body = {
      name,
      description,
      mode,
      live,
      scrimId,
      kind,
      category,
      yuniteTournamentId: yuniteId,
      rows: kind === "manual" ? payloadRows(rows) : [],
    };
    if (kind === "yunite" && !yuniteId.trim()) {
      setSaving(false);
      setError("Cole o ID ou o link do torneio Yunite, ou escolha um na lista.");
      return;
    }
    try {
      const result = editingId
        ? await api<{ table: PublicTable }>(`/api/tables/${editingId}`, {
            method: "PUT",
            body: JSON.stringify(body),
          })
        : await api<{ table: PublicTable }>("/api/tables", {
            method: "POST",
            body: JSON.stringify(body),
          });
      await load();
      fill(result.table);
      setNotice(
        editingId
          ? "Tabela salva. Já aparece em /tabelas."
          : result.table.kind === "manual"
            ? "Tabela manual criada. Já aparece em /tabelas. Pode continuar editando as linhas."
            : "Tabela Yunite criada. A colocação entra sozinha em /tabelas.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar a tabela");
    } finally {
      setSaving(false);
    }
  }

  async function onDeleteTable(id: string, name: string) {
    if (!window.confirm(`Apagar a tabela “${name}” do site?`)) {
      return;
    }
    setError(null);
    try {
      await api(`/api/tables/${id}`, { method: "DELETE" });
      if (editingId === id) {
        resetForm();
      }
      setNotice("Tabela apagada.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível apagar");
    }
  }

  async function onDelete() {
    if (!editingId) {
      return;
    }
    await onDeleteTable(editingId, name || "esta tabela");
  }

  function updateRow(id: string, patch: Partial<DraftRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return (
    <section className="staff-tables">
      <div className="topbar compact">
        <div>
          <button className="btn secondary" type="button" onClick={onBack}>
            Voltar
          </button>
          <h2 style={{ margin: "16px 0 4px" }}>Tabelas públicas</h2>
          <p className="muted">
            Crie uma <strong>tabela manual</strong> (rank, players e pontos) ou puxe um torneio
            Yunite. Escolha a divisão para ela aparecer na aba certa em /tabelas. Tabelas Closed
            ficam em /closed, com a identidade BUILD CLOSED. Opcional: vincular uma scrim só
            para o mapa de drop.
          </p>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok-text">{notice}</p> : null}

      <div className="split">
        <form className="card" onSubmit={onSave}>
          <h3 style={{ marginTop: 0 }}>
            {editingId ? "Editar tabela" : "Adicionar tabela"}
          </h3>

          <div className="kind-toggle" role="group" aria-label="Tipo da tabela">
            <button
              type="button"
              className={`boards-chip ${kind === "manual" ? "on" : ""}`}
              aria-pressed={kind === "manual"}
              onClick={() => setKind("manual")}
            >
              Tabela manual
            </button>
            <button
              type="button"
              className={`boards-chip ${kind === "yunite" ? "on" : ""}`}
              aria-pressed={kind === "yunite"}
              onClick={() => setKind("yunite")}
            >
              Yunite
            </button>
          </div>

          <label htmlFor="table-name">Nome</label>
          <input
            id="table-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex.: Closed trio terça"
            required
          />

          <label htmlFor="table-desc">Descrição (opcional)</label>
          <input
            id="table-desc"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Divisão, horário, observação…"
          />

          <label htmlFor="table-mode">Modo</label>
          <select
            id="table-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as PublicTable["mode"])}
          >
            {Object.entries(MODE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <label htmlFor="table-category">Divisão</label>
          <select
            id="table-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as TableCategory)}
          >
            {TABLE_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {TABLE_CATEGORY_LABEL[value]}
              </option>
            ))}
          </select>

          <label htmlFor="table-scrim">Scrim vinculada (mapa de drop)</label>
          <select
            id="table-scrim"
            value={scrimId}
            onChange={(event) => setScrimId(event.target.value)}
          >
            <option value="">Nenhuma — só a tabela</option>
            {scrims.map((scrim) => (
              <option key={scrim.id} value={scrim.id}>
                {scrim.name}
              </option>
            ))}
          </select>

          <label className="check-line">
            <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
            Ao vivo na listagem pública
          </label>

          {kind === "yunite" ? (
            <>
              <label htmlFor="table-yunite">ID ou link do torneio Yunite</label>
              <p className="muted">
                Escolha na lista ou cole o UUID / o link <code>yunite.xyz/leaderboard</code>. A
                colocação atualiza sozinha no público.
              </p>
              {!yuniteConfigured ? (
                <p className="error">
                  A chave da API Yunite ainda não está na Vercel. Defina{" "}
                  <code>YUNITE_API_KEY</code> nas variáveis do projeto para listar torneios e
                  puxar a colocação.
                </p>
              ) : yuniteStatus ? (
                <p className={yuniteStatus.startsWith("Nenhum") ? "muted" : "error"}>{yuniteStatus}</p>
              ) : null}
              <select
                id="table-yunite-pick"
                value={yuniteTournaments.some((item) => item.id === yuniteId) ? yuniteId : ""}
                onChange={(event) => setYuniteId(event.target.value)}
                disabled={!yuniteTournaments.length}
              >
                <option value="">
                  {yuniteTournaments.length ? "Selecionar torneio…" : "Nenhum torneio na lista"}
                </option>
                {yuniteTournaments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <input
                id="table-yunite"
                value={yuniteId}
                onChange={(event) => setYuniteId(event.target.value)}
                placeholder="uuid ou https://yunite.xyz/leaderboard/…"
                autoComplete="off"
              />
            </>
          ) : (
            <div className="manual-rows">
              <div className="boards-table-head">
                <h3>Colocação manual</h3>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => setRows((current) => [...current, newRow(current.length + 1)])}
                >
                  Adicionar linha
                </button>
              </div>
              <p className="muted">
                Rank, time/players, partidas, elims, wins e pontos — as mesmas colunas da tabela
                Yunite.
              </p>
              <div className="boards-table-wrap">
                <table className="boards-table staff-rows">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Time / players</th>
                      <th>Partidas</th>
                      <th>Elims</th>
                      <th>W</th>
                      <th>Pontos</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <input
                            aria-label="Rank"
                            value={row.rank}
                            onChange={(event) => updateRow(row.id, { rank: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            aria-label="Players"
                            value={row.players}
                            onChange={(event) => updateRow(row.id, { players: event.target.value })}
                            placeholder="nick1, nick2"
                          />
                        </td>
                        <td>
                          <input
                            aria-label="Partidas"
                            value={row.games}
                            onChange={(event) => updateRow(row.id, { games: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            aria-label="Elims"
                            value={row.eliminations}
                            onChange={(event) =>
                              updateRow(row.id, { eliminations: event.target.value })
                            }
                          />
                        </td>
                        <td>
                          <input
                            aria-label="Wins"
                            value={row.wins}
                            onChange={(event) => updateRow(row.id, { wins: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            aria-label="Pontos"
                            value={row.score}
                            onChange={(event) => updateRow(row.id, { score: event.target.value })}
                          />
                        </td>
                        <td>
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={() =>
                              setRows((current) =>
                                current.length <= 1
                                  ? [newRow(1)]
                                  : current.filter((item) => item.id !== row.id),
                              )
                            }
                          >
                            Remover
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="actions form-actions" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={saving}>
              {saving ? "Salvando…" : "Salvar tabela"}
            </button>
            {editingId ? (
              <>
                <a className="btn secondary" href={`/tabelas/${editingId}`}>
                  Ver página pública
                </a>
                <button className="btn secondary" type="button" onClick={resetForm}>
                  Nova tabela
                </button>
                <button className="btn danger" type="button" onClick={() => void onDelete()}>
                  Apagar
                </button>
              </>
            ) : null}
          </div>
        </form>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Tabelas criadas</h3>
          {tables.length === 0 ? (
            <p className="muted">Nenhuma ainda. Use Adicionar tabela ao lado.</p>
          ) : (
            <ul className="scrim-list">
              {tables.map((table) => (
                <li key={table.id} className="table-manage-row">
                  <button type="button" onClick={() => fill(table)}>
                    <strong>{table.name}</strong>
                    <span>
                      {table.kind === "manual" ? "Tabela manual" : "Yunite"} ·{" "}
                      {TABLE_CATEGORY_LABEL[table.category ?? DEFAULT_TABLE_CATEGORY]} ·{" "}
                      {MODE_LABEL[table.mode]}
                      {table.kind === "manual" ? ` · ${table.rows.length} linhas` : ""}
                    </span>
                  </button>
                  <button
                    className="btn danger"
                    type="button"
                    onClick={() => void onDeleteTable(table.id, table.name)}
                  >
                    Remover
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
