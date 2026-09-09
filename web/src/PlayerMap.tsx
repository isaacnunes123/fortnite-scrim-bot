import { useEffect, useState } from "react";
import type { DropSpot } from "./api";
import { dropIsFull, listDropClaims, teamOnDrop } from "./drops";
import { MapBoard } from "./MapBoard";
import { useBrandTheme } from "./brand";

export function PlayerMap() {
  useBrandTheme("scrims", "Mapa · BUILD SCRIMS");
  const path = window.location.pathname.split("/");
  const scrimId = path[2] ?? "";
  const [name, setName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [fortniteNick, setFortniteNick] = useState("");
  const [mapImageUrl, setMapImageUrl] = useState("");
  const [drops, setDrops] = useState<DropSpot[]>([]);
  const [dropped, setDropped] = useState(false);
  const [canClaim, setCanClaim] = useState(false);
  const [dropsOpen, setDropsOpen] = useState(true);
  const [teamsPerDrop, setTeamsPerDrop] = useState(1);
  const [maxContestedDrops, setMaxContestedDrops] = useState(999);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<DropSpot | null>(null);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(false);

  async function load(): Promise<"ok" | "login"> {
    const response = await fetch(`/api/public/scrims/${scrimId}/map`, {
      credentials: "include",
    });
    const data = (await response.json()) as {
      error?: string;
      login?: boolean;
      name?: string;
      teamName?: string;
      fortniteNick?: string;
      mapImageUrl?: string;
      drops?: DropSpot[];
      dropped?: boolean;
      canClaim?: boolean;
      dropsOpen?: boolean;
      teamsPerDrop?: number;
      maxContestedDrops?: number;
      steps?: string[];
    };
    if (response.status === 401 && data.login) {
      window.location.assign(`/api/auth/discord?scrim=${encodeURIComponent(scrimId)}`);
      return "login";
    }
    if (!response.ok) {
      throw new Error(playerMapError(data.error));
    }
    setName(data.name ?? "");
    setTeamName(data.teamName ?? "");
    setFortniteNick(data.fortniteNick ?? data.teamName ?? "");
    setMapImageUrl(data.mapImageUrl ?? "");
    setDrops(data.drops ?? []);
    setDropped(Boolean(data.dropped));
    setCanClaim(Boolean(data.canClaim));
    setDropsOpen(data.dropsOpen !== false);
    setTeamsPerDrop(Math.max(1, Number(data.teamsPerDrop) || 1));
    setMaxContestedDrops(Number(data.maxContestedDrops) || 999);
    setSteps(data.steps ?? []);
    setReady(true);
    return "ok";
  }

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    (async () => {
      try {
        const result = await load();
        if (cancelled || result === "login") {
          return;
        }
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Sem acesso ao mapa");
        }
      }
      if (cancelled) {
        return;
      }
      timer = window.setInterval(() => {
        load()
          .then((result) => {
            if (result === "ok") {
              setError(null);
            }
          })
          .catch(() => undefined);
      }, 2000);
    })();
    return () => {
      cancelled = true;
      if (timer) {
        window.clearInterval(timer);
      }
    };
  }, [scrimId]);

  async function claim(drop: DropSpot) {
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/public/scrims/${scrimId}/drop`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dropId: drop.id }),
    });
    const data = await response.json();
    setSaving(false);
    if (!response.ok) {
      setError(dataError(data));
      return;
    }
    setPending(null);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 900);
    setDone(`${drop.name} marcado. No Discord já devem aparecer código e getting-off.`);
    await load().catch(() => undefined);
  }

  function onPick(drop: DropSpot) {
    if (!canClaim) {
      setError(
        dropsOpen
          ? "Você não pode marcar drop neste mapa."
          : "A staff fechou a marcação de drops.",
      );
      return;
    }
    if (teamOnDrop(drop, teamName)) {
      setDone(`Você já está em ${drop.name}.`);
      setError(null);
      return;
    }
    if (dropIsFull(drop, teamsPerDrop, teamName, drops, maxContestedDrops)) {
      const contests = drops.filter((item) => listDropClaims(item).length >= 2).length;
      setError(
        listDropClaims(drop).length >= teamsPerDrop
          ? `O drop ${drop.name} já está cheio (${teamsPerDrop} time${teamsPerDrop === 1 ? "" : "s"}).`
          : `O mapa já usou as ${maxContestedDrops} disputa${maxContestedDrops === 1 ? "" : "s"} (${contests}/${maxContestedDrops} drops com 2 times). Escolha um drop vazio.`,
      );
      return;
    }
    setError(null);
    setPending(drop);
  }

  const mine = drops.find((drop) => teamOnDrop(drop, teamName));
  const claimed = drops.filter((drop) => listDropClaims(drop).length > 0).length;
  const free = drops.filter((drop) => !dropIsFull(drop, teamsPerDrop, teamName, drops, maxContestedDrops)).length;
  const sorted = [...drops].sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));

  return (
    <div className={`shell player-map ${flash ? "just-claimed" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <img src="/brand/logo.png" alt="" className="brand-logo" />
          <span className="brand-copy">
            <strong>BUILD SCRIMS</strong>
            <span>
              {name ? `${name} · ` : ""}
              {fortniteNick || teamName || "Mapa"}
              {mine ? ` · drop ${mine.name}` : ""}
            </span>
          </span>
        </div>
        <span className="pill live">{claimed}/{drops.length}</span>
      </header>

      <section className="map-brief desktop-only">
        <article>
          <label>Seu nick</label>
          <b>{fortniteNick || teamName}</b>
        </article>
        <article>
          <label>Drops livres</label>
          <b>{free}</b>
        </article>
        <article>
          <label>Status</label>
          <b>{mine ? mine.name : dropsOpen ? "Escolha no mapa" : "Marcação fechada"}</b>
        </article>
      </section>

      {error ? <p className="error">{error}</p> : null}
      {ready && drops.length === 0 ? (
        <p className="error">
          Este mapa ainda não tem drops. A staff precisa desenhar e salvar o preset, depois abrir
          de novo esta página.
        </p>
      ) : null}
      {done ? <p className="ok-text">{done}</p> : null}
      {ready && !dropsOpen ? (
        <p className="muted hint desktop-only">A staff fechou a marcação. O mapa continua ao vivo.</p>
      ) : canClaim ? (
        <ol className="map-steps desktop-only">
          {(steps.length ? steps : [
            "Clique na área iluminada ou no número do drop.",
            "Confirme o drop.",
            "Depois o Discord libera código e getting-off.",
          ]).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : (
        <p className="muted hint desktop-only">Você está vendo o mapa ao vivo, sem marcar.</p>
      )}

      {!ready ? (
        error ? null : <p className="muted hint">Abrindo mapa…</p>
      ) : (
      <div className="player-layout">
        <div className="card map-card">
          <MapBoard
            imageUrl={mapImageUrl || "/maps/island.png"}
            drops={drops}
            play
            myTeam={teamName}
            occupancyLimit={teamsPerDrop}
            maxContestedDrops={maxContestedDrops}
            compact
            onPick={onPick}
            onMiss={() =>
              setError(
                canClaim
                  ? "Clique em um drop do mapa para marcar."
                  : dropsOpen
                    ? "Você não pode marcar drop neste mapa."
                    : "A staff fechou a marcação de drops.",
              )
            }
            selectedId={pending?.id ?? mine?.id}
          />
        </div>
        <aside className="card drop-side desktop-only">
          <h3>Drops</h3>
        <p className="muted">Clique no drop para confirmar. Avatares aparecem ao vivo.</p>
          <ul>
            {sorted.map((drop) => {
              const claims = listDropClaims(drop);
              const isMine = teamOnDrop(drop, teamName);
              const full = dropIsFull(drop, teamsPerDrop, teamName, drops, maxContestedDrops);
              return (
                <li key={drop.id}>
                  <button
                    type="button"
                    className={`drop-row ${claims.length ? "taken" : ""} ${isMine ? "mine" : ""}`}
                    onClick={() => onPick(drop)}
                  >
                    {claims[0]?.avatarUrl ? (
                      <img src={claims[0].avatarUrl} alt="" className="drop-row-face" />
                    ) : (
                      <span className="drop-row-face empty" />
                    )}
                    <span>
                      <strong>Drop {drop.name}</strong>
                      <em>
                        {isMine
                          ? "seu drop"
                          : full
                            ? `cheio (${claims.length}/${teamsPerDrop})`
                            : claims.length
                              ? `${claims.map((claim) => claim.displayName || claim.teamName).join(" · ")} · ${claims.length}/${teamsPerDrop}`
                              : `livre · 0/${teamsPerDrop}`}
                      </em>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
      )}

      {pending ? (
        <div className="confirm-scrim" role="dialog" aria-modal="true">
          <div className="card confirm-pop">
            <h3>Confirmar drop {pending.name}</h3>
            <p>
              Marcar para <strong>{fortniteNick || teamName}</strong>?
              {dropped || mine ? " Isso troca o drop anterior." : " Depois disso o Discord libera código e getting-off."}
            </p>
            <div className="actions">
              <button className="btn" type="button" disabled={saving} onClick={() => claim(pending)}>
                {saving ? "Marcando…" : "Confirmar drop"}
              </button>
              <button className="btn secondary" type="button" onClick={() => setPending(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isInfraError(message: string): boolean {
  return /Railway|BOT_PROCESS_URL|slash command|gateway|Interactions Endpoint/i.test(message);
}

function playerMapError(message?: string): string {
  const text = (message || "").trim();
  if (!text || isInfraError(text)) {
    return "Não foi possível abrir o mapa. Entre de novo com o Discord e tente outra vez.";
  }
  return text;
}

function dataError(data: { error?: string }): string {
  return playerMapError(data.error || "Falha");
}
