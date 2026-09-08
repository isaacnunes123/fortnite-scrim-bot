import { useEffect, useState } from "react";
import type { DropSpot } from "./api";
import { MapBoard } from "./MapBoard";

export function PlayerMap() {
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
      steps?: string[];
    };
    if (response.status === 401 && data.login) {
      window.location.assign(`/api/auth/discord?scrim=${encodeURIComponent(scrimId)}`);
      return "login";
    }
    if (!response.ok) {
      throw new Error(data.error || "Sem acesso ao mapa");
    }
    setName(data.name ?? "");
    setTeamName(data.teamName ?? "");
    setFortniteNick(data.fortniteNick ?? data.teamName ?? "");
    setMapImageUrl(data.mapImageUrl ?? "");
    setDrops(data.drops ?? []);
    setDropped(Boolean(data.dropped));
    setCanClaim(Boolean(data.canClaim));
    setDropsOpen(data.dropsOpen !== false);
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
        timer = window.setInterval(() => {
          load().catch(() => undefined);
        }, 2000);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Sem acesso ao mapa");
        }
      }
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
      return;
    }
    if (drop.kind === "locked") {
      setError(`${drop.name} está bloqueado nesta scrim.`);
      return;
    }
    if (drop.claimedByTeam && drop.claimedByTeam !== teamName) {
      setError(`${drop.name} já foi pego por ${drop.claimedByTeam}.`);
      return;
    }
    if (drop.claimedByTeam === teamName) {
      setDone(`Você já está em ${drop.name}.`);
      return;
    }
    setError(null);
    setPending(drop);
  }

  const mine = drops.find((drop) => drop.claimedByTeam === teamName);
  const claimed = drops.filter((drop) => drop.claimedByTeam).length;
  const free = drops.filter((drop) => !drop.claimedByTeam && drop.kind !== "locked").length;
  const sorted = [...drops].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <div className={`shell player-map ${flash ? "just-claimed" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <strong>Marcar drop</strong>
          <span>
            {name} · nick {fortniteNick}
            {mine ? ` · drop ${mine.name}` : " · ainda sem drop"}
          </span>
        </div>
        <span className="pill live">Ao vivo · {claimed}/{drops.length}</span>
      </header>

      <section className="map-brief">
        <article>
          <label>Seu nick</label>
          <b>{fortniteNick || teamName}</b>
        </article>
        <article>
          <label>POIs livres</label>
          <b>{free}</b>
        </article>
        <article>
          <label>Status</label>
          <b>{mine ? mine.name : dropsOpen ? "Escolha no mapa" : "Marcação fechada"}</b>
        </article>
      </section>

      {ready && drops.length === 0 ? (
        <p className="error">
          Este mapa ainda não tem POIs. A staff precisa desenhar e salvar o preset, depois abrir
          de novo esta página.
        </p>
      ) : null}
      {done ? <p className="ok-text">{done}</p> : null}
      {ready && !dropsOpen ? (
        <p className="muted hint">A staff fechou a marcação. O mapa continua ao vivo.</p>
      ) : canClaim ? (
        <ol className="map-steps">
          {(steps.length ? steps : [
            "Clique na área iluminada ou no nome do POI.",
            "Confirme o drop.",
            "Depois o Discord libera código e getting-off.",
          ]).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : (
        <p className="muted hint">Você está vendo o mapa ao vivo, sem marcar.</p>
      )}

      <div className="player-layout">
        <div className="card map-card">
          <MapBoard
            imageUrl={mapImageUrl || "/maps/island.png"}
            drops={drops}
            play
            myTeam={teamName}
            onPick={canClaim ? onPick : undefined}
            selectedId={pending?.id ?? mine?.id}
          />
        </div>
        <aside className="card drop-side">
          <h3>POIs</h3>
          <p className="muted">Clique para confirmar. Avatares aparecem ao vivo.</p>
          <ul>
            {sorted.map((drop) => {
              const taken = Boolean(drop.claimedByTeam);
              const isMine = drop.claimedByTeam === teamName;
              return (
                <li key={drop.id}>
                  <button
                    type="button"
                    className={`drop-row ${taken ? "taken" : ""} ${isMine ? "mine" : ""}`}
                    disabled={!canClaim || (taken && !isMine) || drop.kind === "locked"}
                    onClick={() => onPick(drop)}
                  >
                    {drop.claimedByAvatarUrl ? (
                      <img src={drop.claimedByAvatarUrl} alt="" className="drop-row-face" />
                    ) : (
                      <span className="drop-row-face empty" />
                    )}
                    <span>
                      <strong>{drop.name}</strong>
                      <em>
                        {drop.kind === "locked"
                          ? "bloqueado"
                          : isMine
                            ? "seu drop"
                            : taken
                              ? drop.claimedByName || drop.claimedByTeam
                              : "livre — clicar"}
                      </em>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>

      {pending ? (
        <div className="confirm-scrim" role="dialog" aria-modal="true">
          <div className="card confirm-pop">
            <h3>Confirmar {pending.name}</h3>
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

function dataError(data: { error?: string }): string {
  return data.error || "Falha";
}
