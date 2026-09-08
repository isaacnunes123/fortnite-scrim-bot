import { useRef, useState } from "react";
import type { DropKind, DropSpot } from "./api";
import {
  centroidOf,
  clickPercent,
  findPlayDrop,
  nearVertex,
  polygonPoints,
  type Vertex,
} from "./geometry";

const DEFAULT_MAP = "/maps/island.png";

export function MapBoard({
  imageUrl,
  drops,
  editor,
  play,
  myTeam,
  onCreate,
  onPick,
  onRemove,
  selectedId,
}: {
  imageUrl: string;
  drops: DropSpot[];
  editor?: boolean;
  play?: boolean;
  myTeam?: string;
  onCreate?: (drop: Omit<DropSpot, "id" | "claimedByTeam">) => void;
  onPick?: (drop: DropSpot) => void;
  onRemove?: (id: string) => void;
  selectedId?: string;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Vertex[]>([]);
  const [pending, setPending] = useState<Vertex[] | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DropKind>("poi");
  const [hoverId, setHoverId] = useState<string | null>(null);

  function pointFromEvent(event: { clientX: number; clientY: number }): Vertex | null {
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) {
      return null;
    }
    return clickPercent(event, box);
  }

  function onBoardClick(event: React.MouseEvent<HTMLDivElement>) {
    const point = pointFromEvent(event);
    if (!point) {
      return;
    }

    if (!editor) {
      const hit = findPlayDrop(point, drops);
      if (hit) {
        onPick?.(hit);
      }
      return;
    }

    if (pending) {
      return;
    }

    const first = draft[0];
    if (first && draft.length >= 3 && nearVertex(point, first)) {
      setPending(draft);
      setName("");
      setKind("poi");
      return;
    }

    setDraft((current) => [...current, point]);
  }

  function savePending() {
    if (!pending || pending.length < 3 || !name.trim()) {
      return;
    }
    const center = centroidOf(pending);
    onCreate?.({
      name: name.trim(),
      kind,
      x: center.x,
      y: center.y,
      vertices: pending,
    });
    setDraft([]);
    setPending(null);
    setName("");
  }

  function cancelDraw() {
    setDraft([]);
    setPending(null);
    setName("");
  }

  function undoLast() {
    setDraft((current) => current.slice(0, -1));
  }

  function finishShape() {
    if (draft.length < 3) {
      return;
    }
    setPending(draft);
    setName("");
    setKind("poi");
  }

  const showCloseHint = editor && !pending && draft.length >= 3;
  const src = imageUrl || DEFAULT_MAP;

  return (
    <div className="map-editor">
      {editor ? (
        <p className="muted">
          Clique no mapa para marcar os cantos do drop. Com 3 pontos ou mais, feche
          clicando no primeiro quadrado branco.
        </p>
      ) : null}

      <div className="map-frame">
        {showCloseHint ? (
          <div className="map-banner">Click first point to close this shape.</div>
        ) : null}
        {pending ? (
          <div className="map-banner">Polígono fechado. Dê um nome a este drop.</div>
        ) : null}
        <div
          ref={boardRef}
          className={`map-board ${play ? "play" : ""}`}
          onClick={onBoardClick}
          onMouseLeave={() => setHoverId(null)}
          onMouseMove={(event) => {
            if (!play) {
              return;
            }
            const point = pointFromEvent(event);
            if (!point) {
              return;
            }
            setHoverId(findPlayDrop(point, drops)?.id ?? null);
          }}
        >
          <img src={src} alt="Mapa da scrim" draggable={false} />
          <svg className="map-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
            {drops.map((drop) =>
              drop.vertices.length >= 3 ? (
                <polygon
                  key={drop.id}
                  points={polygonPoints(drop.vertices)}
                  className={`drop-poly kind-${drop.kind} ${drop.claimedByTeam ? "taken" : "idle"} ${
                    drop.claimedByTeam === myTeam ? "mine" : ""
                  } ${hoverId === drop.id || selectedId === drop.id ? "selected" : ""}`}
                />
              ) : null,
            )}
            {play
              ? drops.map((drop) => (
                  <polygon
                    key={`${drop.id}-hit`}
                    points={polygonPoints(drop.vertices)}
                    className="drop-poly-hit"
                    onMouseEnter={() => setHoverId(drop.id)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPick?.(drop);
                    }}
                  />
                ))
              : null}
            {draft.length >= 2 ? (
              <polyline
                points={polygonPoints(draft)}
                className="draft-line"
              />
            ) : null}
            {draft.length >= 3 ? (
              <polygon points={polygonPoints(draft)} className="draft-fill" />
            ) : null}
            {pending && pending.length >= 3 ? (
              <polygon points={polygonPoints(pending)} className="draft-fill closed" />
            ) : null}
          </svg>
          {drops.map((drop) =>
            drop.claimedByTeam || drop.claimedByAvatarUrl ? (
              <img
                key={`${drop.id}-avatar`}
                className={`drop-face ${drop.claimedByTeam === myTeam ? "mine" : ""}`}
                src={
                  drop.claimedByAvatarUrl ||
                  `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(drop.claimedByUserId || "0") % 5n)}.png`
                }
                alt={drop.claimedByName || drop.claimedByTeam || "Player"}
                referrerPolicy="no-referrer"
                style={{ left: `${drop.x}%`, top: `${drop.y}%` }}
              />
            ) : null,
          )}
          {drops.map((drop) => (
              <button
                key={`${drop.id}-label`}
                type="button"
                className={`drop-pin kind-${drop.kind} ${drop.claimedByTeam ? "taken" : ""} ${
                  drop.claimedByTeam === myTeam ? "mine" : ""
                } ${play ? "clickable" : ""} ${hoverId === drop.id ? "hot" : ""}`}
                style={{ left: `${drop.x}%`, top: `${drop.y}%` }}
                onClick={(event) => {
                  event.stopPropagation();
                  onPick?.(drop);
                }}
              >
                {drop.claimedByAvatarUrl ? (
                  <img
                    className="drop-pin-face"
                    src={drop.claimedByAvatarUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                ) : null}
                <b>{drop.claimedByName || drop.claimedByTeam || drop.name}</b>
                <span>{drop.claimedByTeam ? drop.name : play ? "livre" : drop.name}</span>
              </button>
            ))}
          {draft.map((vertex, index) => (
            <span
              key={`d-${index}`}
              className={`map-handle ${index === 0 ? "first" : ""}`}
              style={{ left: `${vertex.x}%`, top: `${vertex.y}%` }}
            />
          ))}
            {pending?.map((vertex, index) => (
              <span
                key={`p-${index}`}
                className={`map-handle ${index === 0 ? "first" : ""}`}
                style={{ left: `${vertex.x}%`, top: `${vertex.y}%` }}
              />
            ))}
            {editor && draft.length > 0 && !pending ? (
              <div className="map-float">
                <button
                  className="btn"
                  type="button"
                  disabled={draft.length < 3}
                  onClick={(event) => {
                    event.stopPropagation();
                    finishShape();
                  }}
                >
                  Finish
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    undoLast();
                  }}
                >
                  Delete last point
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    cancelDraw();
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : null}
        </div>
      </div>

      {pending ? (
        <div className="drop-name-form">
          <label htmlFor="drop-name">Nome do drop</label>
          <input
            id="drop-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Lifty Lodge"
            autoFocus
          />
          <label htmlFor="drop-kind">Tipo</label>
          <select
            id="drop-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as DropKind)}
          >
            <option value="poi">POI</option>
            <option value="contested">Contestado</option>
            <option value="locked">Bloqueado</option>
          </select>
          <div className="actions">
            <button className="btn" type="button" onClick={savePending} disabled={!name.trim()}>
              Salvar drop
            </button>
            <button className="btn secondary" type="button" onClick={cancelDraw}>
              Descartar
            </button>
          </div>
        </div>
      ) : null}

      {editor && draft.length > 0 && !pending ? (
        <button className="btn secondary" type="button" onClick={cancelDraw}>
          Cancelar desenho
        </button>
      ) : null}

      {editor && drops.length > 0 ? (
        <ul className="drop-list">
          {drops.map((drop) => (
            <li key={drop.id}>
              <span>
                {drop.name} · {drop.kind}
                {drop.claimedByTeam ? ` · ${drop.claimedByTeam}` : ""}
              </span>
              <button className="btn secondary" type="button" onClick={() => onRemove?.(drop.id)}>
                Apagar
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
