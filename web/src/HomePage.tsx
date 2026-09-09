import { useEffect, useState } from "react";
import { api, normalizeTableCategory, type PublicBoardSummary } from "./api";
import { BANNER_ROXO, SiteHeader, useBrandTheme } from "./brand";

const MODE_LABEL = {
  solo: "Solo",
  duo: "Duo",
  trio: "Trio",
  squad: "Squad",
} as const;

const STATS = [
  { label: "Membros", value: "190k", detail: "na comunidade BUILD" },
  { label: "Scrims", value: "Todo dia", detail: "treino competitivo na grade" },
  { label: "Ativos no dia", value: "~1k", detail: "pessoas no servidor" },
  { label: "História", value: "Desde o começo", detail: "um dos primeiros servidores de scrim" },
] as const;

export function HomePage() {
  const [boards, setBoards] = useState<PublicBoardSummary[]>([]);
  useBrandTheme("scrims");

  useEffect(() => {
    api<{ boards: PublicBoardSummary[] }>("/api/public/tabelas")
      .then((data) =>
        setBoards(
          (data.boards ?? [])
            .filter((board) => normalizeTableCategory(board.category) !== "closed")
            .slice(0, 3),
        ),
      )
      .catch(() => setBoards([]));
  }, []);

  return (
    <div className="shell boards-shell home-shell home-page">
      <div className="home-constrain">
        <SiteHeader brand="scrims" current="home" />
      </div>

      <section className="scrims-hero">
        <div
          className="scrims-hero-bg"
          style={{ backgroundImage: `url("${BANNER_ROXO}")` }}
          aria-hidden
        />
        <div className="home-constrain scrims-hero-inner">
          <div className="scrims-hero-copy">
            <p className="boards-kicker">Fortnite · treino competitivo</p>
            <h1>BUILD SCRIMS</h1>
            <p className="scrims-slogan">
              Venha jogar no <em>melhor server</em> de scrims do Brasil!
            </p>
            <p className="muted home-lead">
              Comunidade de scrims de Fortnite todos os dias. Tabelas, drops e o melhor server de
              treino competitivo do Brasil.
            </p>
            <div className="home-cta">
              <a className="btn" href="/tabelas">
                Ver tabelas
              </a>
              <a className="btn secondary" href="/closed">
                Closed
              </a>
              <a
                className="btn secondary"
                href="https://discord.gg/buildscrims"
                target="_blank"
                rel="noreferrer"
              >
                Entrar no Discord
              </a>
            </div>
          </div>
        </div>
      </section>

      <div className="home-constrain">
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
    </div>
  );
}
