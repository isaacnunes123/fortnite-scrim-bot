import { useEffect, useState } from "react";
import type { DropSpot } from "./api";
import { MapBoard } from "./MapBoard";

export function PlayerMap() {
  const path = window.location.pathname.split("/");
  const scrimId = path[2] ?? "";
  const [name, setName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [mapImageUrl, setMapImageUrl] = useState("");
  const [drops, setDrops] = useState<DropSpot[]>([]);
  const [dropped, setDropped] = useState(false);
  const [canClaim, setCanClaim] = useState(false);
  const [dropsOpen, setDropsOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<DropSpot | null>(null);
  const [saving, setSaving] = useState(false);

  async function load(): Promise<"ok" | "login"> {
    const response = await fetch(`/api/public/scrims/${scrimId}/map`, {
      credentials: "include",
    });
    const data = (await response.json()) as {
      error?: string;
      login?: boolean;
      name?: string;
      teamName?: string;
      mapImageUrl?: string;
      drops?: DropSpot[];
      dropped?: boolean;
      canClaim?: boolean;
      dropsOpen?: boolean;
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
    setMapImageUrl(data.mapImageUrl ?? "");
    setDrops(data.drops ?? []);
    setDropped(Boolean(data.dropped));
    setCanClaim(Boolean(data.canClaim));
    setDropsOpen(data.dropsOpen !== false);
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
    setDone(`${drop.name} marcado para ${teamName}.`);
    await load().catch(() => undefined);
  }

  function onPick(drop: DropSpot) {
    if (!canClaim) {
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
  const sorted = [...drops].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <div className="shell player-map">
      <header className="topbar">
        <div className="brand">
          <strong>Marcar drop</strong>
          <span>
            {name} · {teamName}
            {mine ? ` · ${mine.name}` : ""} · {claimed}/{drops.length} ocupados
          </span>
        </div>
        <span className="pill live">Ao vivo</span>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {done ? <p className="ok-text">{done}</p> : null}
      {ready && !dropsOpen ? (
        <p className="muted hint">A staff fechou a marcação. Você ainda vê o mapa ao vivo.</p>
      ) : canClaim ? (
        <p className="muted hint">
          Clique no círculo ou no nome do POI. Pode trocar até a staff fechar.
        </p>
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
          <ul>
            {sorted.map((drop) => {
              const taken = Boolean(drop.claimedByTeam);
              const isMine = drop.claimedByTeam === teamName;
              return (
                <li key={drop.id}>
                  <button
                    type="button"
                    className={`drop-row ${taken ? "taken" : ""} ${isMine ? "mine" : ""}`}
                    disabled={!canClaim || (taken && !isMine)}
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
                        {isMine
                          ? "seu drop"
                          : taken
                            ? drop.claimedByName || drop.claimedByTeam
                            : "livre"}
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
          <div className="card">
            <h3>Confirmar drop</h3>
            <p>
              Marcar <strong>{pending.name}</strong> para <strong>{teamName}</strong>?
              {dropped || mine ? " Isso troca o drop anterior." : ""}
            </p>
            <div className="actions">
              <button className="btn" type="button" disabled={saving} onClick={() => claim(pending)}>
                {saving ? "Marcando…" : "Confirmar"}
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
