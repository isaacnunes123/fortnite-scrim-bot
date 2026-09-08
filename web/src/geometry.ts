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
