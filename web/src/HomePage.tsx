import { useEffect, useState } from "react";
import { api, type PublicBoardSummary } from "./api";

const MODE_LABEL = {
  solo: "Solo",
  duo: "Duo",
  trio: "Trio",
  squad: "Squad",
} as const;

const STATS = [
  { label: "Membros", value: "190k", detail: "na comunidade BUILD" },
  { label: "Scrims", value: "Todo dia", detail: "treino fechado na grade" },
  { label: "Ativos no dia", value: "~1k", detail: "pessoas no servidor" },
  { label: "História", value: "Desde o começo", detail: "um dos primeiros servidores de scrim" },
] as const;

export function HomePage() {
  const [boards, setBoards] = useState<PublicBoardSummary[]>([]);

  useEffect(() => {
    document.title = "BUILD CLOSED";
    api<{ boards: PublicBoardSummary[] }>("/api/public/tabelas")
      .then((data) => setBoards((data.boards ?? []).slice(0, 3)))
      .catch(() => setBoards([]));
  }, []);

  return (
    <div className="shell boards-shell home-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <img src="/brand/logo.png" alt="" className="brand-logo" />
          <span className="brand-copy">
            <strong>BUILD CLOSED</strong>
            <span>Scrims fechadas · Fortnite</span>
          </span>
        </a>
        <div className="actions">
          <a className="btn secondary" href="/tabelas">
            Tabelas
          </a>
          <a className="btn secondary" href="/painel">
            Painel staff
          </a>
        </div>
      </header>

      <section className="boards-hero home-hero">
        <p className="boards-kicker">Fortnite · treino competitivo</p>
        <h1>BUILD CLOSED</h1>
        <p className="muted home-lead">
          Um dos primeiros e mais antigos servidores de scrim de Fortnite. Scrims todos os dias,
          ranking público e mapa de drop — sem login.
        </p>
        <div className="home-cta">
          <a className="btn" href="/tabelas">
            Ver tabelas
          </a>
          <a className="btn secondary" href="https://discord.gg/buildscrims" target="_blank" rel="noreferrer">
            Entrar no Discord
          </a>
        </div>
      </section>

      <section className="grid home-stats">
        {STATS.map((item) => (
          <article className="stat" key={item.label}>
            <label>{item.label}</label>
            <b>{item.value}</b>
            <span className="muted">{item.detail}</span>
          </article>
        ))}
      </section>

      {boards.length > 0 ? (
        <section className="home-boards">
          <div className="boards-table-head">
            <h2>Tabelas recentes</h2>
            <a className="btn secondary" href="/tabelas">
              Ver todas
            </a>
          </div>
          <ul className="boards-grid">
            {boards.map((board) => (
              <li key={board.id}>
                <a className="board-card" href={`/tabelas/${board.id}`}>
                  <div className="board-card-top">
                    <span className={`pill ${board.live ? "live" : "off"}`}>
                      {board.live ? "Ao vivo" : "Encerrada"}
                    </span>
                    <span className="muted">{MODE_LABEL[board.mode]}</span>
                  </div>
                  <h2>{board.name}</h2>
                  <p>
                    {board.source === "manual"
                      ? "Tabela manual"
                      : board.source === "yunite"
                        ? "Tabela Yunite"
                        : "Lobby"}
                  </p>
                  <span className="board-card-cta">Abrir</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
