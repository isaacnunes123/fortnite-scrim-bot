export type Vertex = {
  x: number;
  y: number;
};

export function centroidOf(vertices: Vertex[]): Vertex {
  if (vertices.length === 0) {
    return { x: 50, y: 50 };
  }
  const total = vertices.reduce(
    (sum, vertex) => ({ x: sum.x + vertex.x, y: sum.y + vertex.y }),
    { x: 0, y: 0 },
  );
  return {
    x: total.x / vertices.length,
    y: total.y / vertices.length,
  };
}

export function pointInPolygon(x: number, y: number, vertices: Vertex[]): boolean {
  if (vertices.length < 3) {
    return false;
  }
  let inside = false;
  for (let index = 0, prev = vertices.length - 1; index < vertices.length; prev = index++) {
    const current = vertices[index]!;
    const last = vertices[prev]!;
    const crosses =
      current.y > y !== last.y > y &&
      x < ((last.x - current.x) * (y - current.y)) / (last.y - current.y) + current.x;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}

export function nearVertex(point: Vertex, target: Vertex, threshold = 1.6): boolean {
  const dx = point.x - target.x;
  const dy = point.y - target.y;
  return dx * dx + dy * dy <= threshold * threshold;
}

export function polygonPoints(vertices: Vertex[]): string {
  return vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(" ");
}

export function polygonBox(vertices: Vertex[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  if (vertices.length === 0) {
    return { minX: 48, minY: 48, maxX: 52, maxY: 52, width: 4, height: 4 };
  }
  const xs = vertices.map((vertex) => vertex.x);
  const ys = vertices.map((vertex) => vertex.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: Math.max(0.8, maxX - minX), height: Math.max(0.8, maxY - minY) };
}

/** Âncora da foto/nick por dentro do polígono, não no centro solto do pin. */
export function claimAnchor(vertices: Vertex[], index: number, count: number): Vertex {
  const box = polygonBox(vertices);
  const insetX = Math.min(box.width * 0.22, Math.max(0.6, box.width * 0.12));
  const insetY = Math.min(box.height * 0.28, Math.max(0.7, box.height * 0.16));
  const left = box.minX + insetX;
  const right = box.maxX - insetX;
  const top = box.minY + insetY;
  const bottom = box.maxY - insetY;
  const mid = centroidOf(vertices);
  const cx = Math.min(right, Math.max(left, mid.x));
  const cy = Math.min(bottom - box.height * 0.08, Math.max(top + box.height * 0.06, mid.y));
  if (count <= 1) {
    return { x: cx, y: cy };
  }
  const span = Math.max(0.4, right - left);
  const t = index / Math.max(1, count - 1);
  return {
    x: left + span * t,
    y: cy,
  };
}

export function markerScale(vertices: Vertex[]): number {
  const box = polygonBox(vertices);
  return Math.min(1, Math.max(0.42, Math.min(box.width / 9, box.height / 8)));
}

export function clickPercent(
  event: { clientX: number; clientY: number },
  box: DOMRect,
): Vertex {
  return {
    x: Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100)),
    y: Math.min(100, Math.max(0, ((event.clientY - box.top) / box.height) * 100)),
  };
}

export function distance(a: Vertex, b: Vertex): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function findPlayDrop<T extends { x: number; y: number; vertices: Vertex[] }>(
  point: Vertex,
  drops: T[],
  radius = 14,
): T | null {
  const inside = [...drops]
    .reverse()
    .find((drop) => pointInPolygon(point.x, point.y, drop.vertices));
  if (inside) {
    return inside;
  }
  let best: T | null = null;
  let bestDist = radius;
  for (const drop of drops) {
    const dist = distance(point, { x: drop.x, y: drop.y });
    if (dist <= bestDist) {
      best = drop;
      bestDist = dist;
    }
  }
  return best;
}
