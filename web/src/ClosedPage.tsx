import { useEffect, useState } from "react";
import { api, normalizeTableCategory, type PublicBoardSummary } from "./api";
import { SiteHeader, useBrandTheme } from "./brand";

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

export function ClosedPage() {
  const [boards, setBoards] = useState<PublicBoardSummary[]>([]);
  useBrandTheme("closed");

  useEffect(() => {
    api<{ boards: PublicBoardSummary[] }>("/api/public/tabelas")
      .then((data) =>
        setBoards(
          (data.boards ?? []).filter((board) => normalizeTableCategory(board.category) === "closed"),
        ),
      )
      .catch(() => setBoards([]));
  }, []);

  return (
    <div className="shell boards-shell home-shell">
      <SiteHeader brand="closed" current="closed" />

      <section className="boards-hero home-hero closed-hero">
        <span className="hero-watermark">BUILD CLOSED</span>
        <p className="boards-kicker">Fortnite · treino competitivo</p>
        <h1>BUILD CLOSED</h1>
        <p className="muted home-lead">
          Um dos primeiros e mais antigos servidores de scrim de Fortnite. Scrims todos os dias,
          numa comunidade que acompanha o competitivo desde o começo.
        </p>
        <div className="home-cta">
          <a className="btn" href="/tabelas?div=closed">
            Ver tabelas Closed
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

      <section className="home-boards">
        <div className="boards-table-head">
          <h2>Tabelas Closed</h2>
          <a className="btn secondary" href="/tabelas?div=closed">
            Ver todas
          </a>
        </div>
        {boards.length === 0 ? (
          <p className="muted">
            Nenhuma tabela Closed ainda. Quando a staff publicar na aba Closed, ela aparece aqui.
          </p>
        ) : (
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
        )}
      </section>
    </div>
  );
}
