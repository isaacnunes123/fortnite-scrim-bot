import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { DropSpot } from "./api";
import { listDropClaims, teamOnDrop } from "./drops";
import {
  centroidOf,
  clickPercent,
  findPlayDrop,
  nearVertex,
  polygonPoints,
  type Vertex,
} from "./geometry";

const DEFAULT_MAP = "/maps/island.png";
const MIN_ZOOM = 1;
const MAX_ZOOM = 10;

function nextDropName(drops: DropSpot[]): string {
  let max = 0;
  for (const drop of drops) {
    const n = Number.parseInt(String(drop.name).trim(), 10);
    if (Number.isInteger(n) && n > max) {
      max = n;
    }
  }
  return String(max + 1);
}

export function MapBoard({
  imageUrl,
  drops,
  editor,
  play,
  myTeam,
  onCreate,
  onPick,
  onMiss,
  onRemove,
  selectedId,
  occupancyLimit = 1,
  compact,
}: {
  imageUrl: string;
  drops: DropSpot[];
  editor?: boolean;
  play?: boolean;
  myTeam?: string;
  occupancyLimit?: number;
  compact?: boolean;
  onCreate?: (drop: Omit<DropSpot, "id" | "claimedByTeam">) => void;
  onPick?: (drop: DropSpot) => void;
  onMiss?: () => void;
  onRemove?: (id: string) => void;
  selectedId?: string;
}) {
  const src = imageUrl || DEFAULT_MAP;
  const viewportRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const mapImageRef = useRef<HTMLImageElement | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const maxZoomRef = useRef(MAX_ZOOM);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<Vertex[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  function syncViewLimits() {
    const image = mapImageRef.current;
    const viewport = viewportRef.current;
    if (!image?.naturalWidth || !viewport?.clientWidth) {
      return;
    }
    if (window.innerWidth > 720) {
      viewport.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
    } else {
      viewport.style.aspectRatio = "unset";
    }
    maxZoomRef.current = MAX_ZOOM;
    if (zoomRef.current > MAX_ZOOM) {
      setView(MAX_ZOOM, panRef.current);
    }
  }

  useEffect(() => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      mapImageRef.current = image;
      syncViewLimits();
      window.setTimeout(() => fitPhoneIfNeeded(), 40);
    };
    image.src = src;
    return () => {
      image.onload = null;
    };
  }, [src]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const ro = new ResizeObserver(() => syncViewLimits());
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [src]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const onWheelNative = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const box = viewport.getBoundingClientRect();
      const cx = event.clientX - box.left;
      const cy = event.clientY - box.top;
      const current = zoomRef.current;
      const contentX = (cx - panRef.current.x) / current;
      const contentY = (cy - panRef.current.y) / current;
      const clamped = Math.min(maxZoomRef.current, Math.max(MIN_ZOOM, current * factor));
      const nextPan =
        clamped <= MIN_ZOOM + 0.001
          ? { x: 0, y: 0 }
          : { x: cx - contentX * clamped, y: cy - contentY * clamped };
      zoomRef.current = clamped;
      panRef.current = nextPan;
      setZoom(clamped);
      setPan(nextPan);
    };
    viewport.addEventListener("wheel", onWheelNative, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheelNative);
  }, []);

  function setView(nextZoom: number, nextPan: { x: number; y: number }) {
    const clamped = Math.min(maxZoomRef.current, Math.max(MIN_ZOOM, nextZoom));
    const panValue = clamped <= MIN_ZOOM + 0.001 ? { x: 0, y: 0 } : nextPan;
    zoomRef.current = clamped;
    panRef.current = panValue;
    setZoom(clamped);
    setPan(panValue);
  }

  function zoomAt(nextZoom: number, clientX: number, clientY: number) {
    const box = viewportRef.current?.getBoundingClientRect();
    if (!box) {
      setView(nextZoom, panRef.current);
      return;
    }
    const cx = clientX - box.left;
    const cy = clientY - box.top;
    const current = zoomRef.current;
    const contentX = (cx - panRef.current.x) / current;
    const contentY = (cy - panRef.current.y) / current;
    const clamped = Math.min(maxZoomRef.current, Math.max(MIN_ZOOM, nextZoom));
    setView(clamped, { x: cx - contentX * clamped, y: cy - contentY * clamped });
  }

  function zoomBy(factor: number) {
    const box = viewportRef.current?.getBoundingClientRect();
    if (!box) {
      setView(zoomRef.current * factor, panRef.current);
      return;
    }
    zoomAt(zoomRef.current * factor, box.left + box.width / 2, box.top + box.height / 2);
  }

  function fitPhoneIfNeeded() {
    const viewport = viewportRef.current;
    const image = mapImageRef.current;
    if (!viewport || !image?.naturalWidth || window.innerWidth > 720) {
      return;
    }
    const fill =
      (viewport.clientHeight / Math.max(1, viewport.clientWidth)) *
      (image.naturalWidth / image.naturalHeight);
    setView(Math.min(maxZoomRef.current, Math.max(1, fill * 0.96)), { x: 0, y: 0 });
  }

  function pointFromEvent(event: { clientX: number; clientY: number }): Vertex | null {
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) {
      return null;
    }
    return clickPercent(event, box);
  }

  function handleClick(event: { clientX: number; clientY: number }) {
    const point = pointFromEvent(event);
    if (!point) {
      return;
    }

    if (!editor) {
      const hit = findPlayDrop(point, drops);
      if (hit) {
        onPick?.(hit);
      } else {
        onMiss?.();
      }
      return;
    }

    const first = draft[0];
    if (first && draft.length >= 3 && nearVertex(point, first)) {
      commitShape(draft);
      return;
    }

    setDraft((current) => [...current, point]);
  }

  function commitShape(vertices: Vertex[]) {
    if (vertices.length < 3) {
      return;
    }
    const center = centroidOf(vertices);
    onCreate?.({
      name: nextDropName(drops),
      kind: "poi",
      x: center.x,
      y: center.y,
      vertices,
      claims: [],
    });
    setDraft([]);
  }

  function cancelDraw() {
    setDraft([]);
  }

  function undoLast() {
    setDraft((current) => current.slice(0, -1));
  }

  function finishShape() {
    commitShape(draft);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointersRef.current.size >= 2) {
      const points = [...pointersRef.current.values()];
      const a = points[0]!;
      const b = points[1]!;
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom: zoomRef.current,
      };
      dragRef.current = null;
      return;
    }
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
      moved: false,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinchRef.current && pointersRef.current.size >= 2) {
      const points = [...pointersRef.current.values()];
      const a = points[0]!;
      const b = points[1]!;
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      zoomAt(
        pinchRef.current.zoom * (dist / pinchRef.current.dist),
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
      );
      return;
    }
    if (play) {
      const point = pointFromEvent(event);
      setHoverId(point ? findPlayDrop(point, drops)?.id ?? null : null);
    }
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 8) {
      drag.moved = true;
    }
    if (drag.moved) {
      setView(zoomRef.current, { x: drag.panX + dx, y: drag.panY + dy });
    }
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) {
      const pinched = Boolean(pinchRef.current);
      pinchRef.current = null;
      if (pinched) {
        dragRef.current = null;
        return;
      }
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved) {
      return;
    }
    handleClick(event);
  }

  const showCloseHint = editor && draft.length >= 3;

  return (
    <div className="map-editor">
      {editor ? (
        <p className="muted">
          Clique no mapa para marcar os cantos do drop. Com 3 pontos ou mais, feche
          clicando no primeiro quadrado branco. O drop recebe o próximo número automaticamente.
        </p>
      ) : null}

      <div className={`map-zoom-bar ${compact ? "compact" : ""}`}>
        <button className="btn secondary" type="button" onClick={() => zoomBy(1 / 1.2)}>
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button className="btn secondary" type="button" onClick={() => zoomBy(1.2)}>
          +
        </button>
        <button
          className="btn secondary"
          type="button"
          onClick={() => {
            if (window.innerWidth <= 720) {
              fitPhoneIfNeeded();
            } else {
              setView(1, { x: 0, y: 0 });
            }
          }}
        >
          Resetar
        </button>
        <span className="muted zoom-hint-desktop">
          Roda do mouse para ampliar. Arraste para mover.
        </span>
        <span className="muted zoom-hint-mobile">Dois dedos para zoom. Arraste para mover.</span>
      </div>

      <div className="map-frame">
        {showCloseHint ? (
          <div className="map-banner">Clique no primeiro ponto para fechar este drop.</div>
        ) : null}
        <div
          ref={viewportRef}
          className={`map-viewport ${editor ? "editing" : ""} ${compact ? "fill-height" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={(event) => {
            pointersRef.current.delete(event.pointerId);
            pinchRef.current = null;
            dragRef.current = null;
          }}
          onMouseLeave={() => setHoverId(null)}
        >
          <div
            className="map-stage"
            style={{
              width: `${zoom * 100}%`,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
            }}
          >
            <div
              ref={boardRef}
              className={`map-board ${play ? "play" : ""}`}
              style={{ ["--map-zoom" as string]: String(zoom) }}
            >
              <img
                className="map-art"
                src={src}
                alt=""
                draggable={false}
                decoding="async"
              />
              <svg className="map-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
                {drops.map((drop) =>
                  drop.vertices.length >= 3 ? (
                    <polygon
                      key={drop.id}
                      points={polygonPoints(drop.vertices)}
                      className={`drop-poly ${listDropClaims(drop).length ? "taken" : "idle"} ${
                        teamOnDrop(drop, myTeam ?? "") ? "mine" : ""
                      } ${listDropClaims(drop).length >= occupancyLimit ? "full" : ""} ${
                        hoverId === drop.id || selectedId === drop.id ? "selected" : ""
                      }`}
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
                      />
                    ))
                  : null}
                {draft.length >= 2 ? (
                  <polyline points={polygonPoints(draft)} className="draft-line" />
                ) : null}
                {draft.length >= 3 ? (
                  <polygon points={polygonPoints(draft)} className="draft-fill" />
                ) : null}
              </svg>
              {drops.map((drop) => {
                const claims = listDropClaims(drop);
                const mine = teamOnDrop(drop, myTeam ?? "");
                const full = claims.length >= occupancyLimit;
                return (
                  <div key={`${drop.id}-markers`} className="drop-layer">
                    {claims.length > 0 ? (
                      <div
                        className={`drop-markers ${mine ? "mine" : ""}`}
                        style={{ left: `${drop.x}%`, top: `${drop.y}%` }}
                      >
                        {claims.map((claim, index) => (
                          <div key={`${drop.id}-${claim.teamName}-${index}`} className="drop-marker">
                            <img
                              className="drop-marker-face"
                              src={
                                claim.avatarUrl ||
                                `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(claim.userId || "0") % 5n)}.png`
                              }
                              alt=""
                              referrerPolicy="no-referrer"
                            />
                            <b className="drop-marker-name">
                              {(claim.displayName || claim.teamName || "Drop").trim()}
                            </b>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className={`drop-pin ${claims.length ? "taken" : ""} ${mine ? "mine" : ""} ${
                        full ? "full" : ""
                      } ${play ? "clickable" : ""} ${hoverId === drop.id ? "hot" : ""} ${
                        claims.length ? "has-claims" : ""
                      }`}
                      style={{ left: `${drop.x}%`, top: `${drop.y}%` }}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onPick?.(drop);
                      }}
                    >
                      <b>{drop.name}</b>
                    </button>
                  </div>
                );
              })}
              {draft.map((vertex, index) => (
                <span
                  key={`d-${index}`}
                  className={`map-handle ${index === 0 ? "first" : ""}`}
                  style={{ left: `${vertex.x}%`, top: `${vertex.y}%` }}
                />
              ))}
            </div>
          </div>
          {editor && draft.length > 0 ? (
            <div className="map-float">
              <button
                className="btn"
                type="button"
                disabled={draft.length < 3}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  finishShape();
                }}
              >
                Fechar drop
              </button>
              <button
                className="btn secondary"
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  undoLast();
                }}
              >
                Apagar último ponto
              </button>
              <button
                className="btn secondary"
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  cancelDraw();
                }}
              >
                Cancelar
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {editor && draft.length > 0 ? (
        <button className="btn secondary" type="button" onClick={cancelDraw}>
          Cancelar desenho
        </button>
      ) : null}

      {editor && drops.length > 0 ? (
        <ul className="drop-list">
          {drops.map((drop) => (
            <li key={drop.id}>
              <span>Drop {drop.name}</span>
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
