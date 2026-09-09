import { loadBotHeartbeat, saveBotHeartbeat, usesRemoteStore } from "../scrims/durable.js";

export type HeartbeatStatus = {
  configured: boolean;
  ready: boolean;
  username: string | null;
  id: string | null;
  guildCount: number;
  uptimeMs: number | null;
};

const STALE_MS = 90_000;

export function startBotHeartbeat(readStatus: () => HeartbeatStatus): void {
  stopBotHeartbeat();
  heartbeatTimer = setInterval(() => {
    pulseBotHeartbeat(readStatus());
  }, 20_000);
  heartbeatTimer.unref?.();
}

export function stopBotHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function pulseBotHeartbeat(status: HeartbeatStatus): void {
  if (!usesRemoteStore()) {
    return;
  }
  void saveBotHeartbeat(status).catch((error) => {
    console.error("[bot] heartbeat:", error);
  });
}

export async function readFreshBotHeartbeat(): Promise<HeartbeatStatus | null> {
  const row = await loadBotHeartbeat();
  if (!row) {
    return null;
  }
  const age = Date.now() - Date.parse(row.updatedAt);
  if (!Number.isFinite(age) || age > STALE_MS) {
    return null;
  }
  const payload = asBotStatus(row.payload);
  return payload?.ready ? payload : null;
}

function asBotStatus(value: unknown): HeartbeatStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    configured: Boolean(record.configured),
    ready: Boolean(record.ready),
    username: typeof record.username === "string" ? record.username : null,
    id: typeof record.id === "string" ? record.id : null,
    guildCount: Number(record.guildCount) || 0,
    uptimeMs: record.uptimeMs == null ? null : Number(record.uptimeMs) || null,
  };
}

let heartbeatTimer: NodeJS.Timeout | null = null;
