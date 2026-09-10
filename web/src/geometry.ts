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

function boxPad(size: number): number {
  return Math.min(size * 0.16, Math.max(0.12, size * 0.09));
}

/** Retângulo interno do drop (bbox com padding) para foto/nick. */
export function claimSlot(vertices: Vertex[]): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const box = polygonBox(vertices);
  const padX = boxPad(box.width);
  const padY = boxPad(box.height);
  return {
    left: box.minX + padX,
    top: box.minY + padY,
    width: Math.max(0.4, box.width - padX * 2),
    height: Math.max(0.4, box.height - padY * 2),
  };
}

/** Empilha 2+ claims se o bbox for mais alto que largo (ou quadrado). */
export function claimLayout(vertices: Vertex[], count: number): "stack" | "row" {
  if (count <= 1) {
    return "row";
  }
  const slot = claimSlot(vertices);
  return slot.height >= slot.width ? "stack" : "row";
}

/** Centro de cada claim: 1 no meio; 2+ em coluna se alto, senão em faixas quadradas. */
export function claimAnchor(vertices: Vertex[], index: number, count: number): Vertex {
  const slot = claimSlot(vertices);
  const n = Math.max(1, count);
  if (n <= 1) {
    return {
      x: slot.left + slot.width * 0.5,
      y: slot.top + slot.height * 0.46,
    };
  }
  if (claimLayout(vertices, n) === "stack") {
    const row = slot.height / n;
    return {
      x: slot.left + slot.width * 0.5,
      y: slot.top + row * (index + 0.5),
    };
  }
  const col = slot.width / n;
  const square = Math.min(col, slot.height);
  return {
    x: slot.left + col * (index + 0.5),
    y: slot.top + (slot.height - square) / 2 + square * 0.46,
  };
}

/** Diâmetro da face em % da largura do mapa, limitado ao slot. */
export function markerScale(vertices: Vertex[], count = 1): number {
  const slot = claimSlot(vertices);
  const n = Math.max(1, count);
  if (n <= 1) {
    const fromW = slot.width * 0.58;
    const fromH = slot.height * 0.52;
    return Math.min(3.45, Math.max(1.18, Math.min(fromW, fromH)));
  }
  if (claimLayout(vertices, n) === "stack") {
    const fromW = slot.width * 0.56;
    const fromH = (slot.height / n) * 0.5;
    return Math.min(3.45, Math.max(1.05, Math.min(fromW, fromH)));
  }
  const square = Math.min(slot.width / n, slot.height);
  return Math.min(3.45, Math.max(1.05, square * 0.52));
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
