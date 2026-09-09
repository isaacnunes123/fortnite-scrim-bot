import type { DropClaim, DropSpot } from "./api";

export function listDropClaims(drop: DropSpot): DropClaim[] {
  if (Array.isArray(drop.claims) && drop.claims.length > 0) {
    return drop.claims;
  }
  if (drop.claimedByTeam) {
    return [
      {
        teamName: drop.claimedByTeam,
        userId: drop.claimedByUserId ?? "",
        displayName: drop.claimedByName ?? drop.claimedByTeam,
        avatarUrl: drop.claimedByAvatarUrl ?? "",
      },
    ];
  }
  return [];
}

export function teamOnDrop(drop: DropSpot, teamName: string): boolean {
  return Boolean(teamName) && listDropClaims(drop).some((claim) => claim.teamName === teamName);
}

export function contestedDropCount(drops: DropSpot[]): number {
  return drops.filter((drop) => listDropClaims(drop).length >= 2).length;
}

export function dropIsFull(
  drop: DropSpot,
  limit: number,
  teamName?: string,
  allDrops: DropSpot[] = [],
  maxContestedDrops = 999,
): boolean {
  const claims = listDropClaims(drop);
  if (teamName && claims.some((claim) => claim.teamName === teamName)) {
    return false;
  }
  if (claims.length >= Math.max(1, limit)) {
    return true;
  }
  if (claims.length >= 1 && limit > 1 && maxContestedDrops < 999) {
    const alreadyContested = claims.length >= 2;
    if (!alreadyContested && contestedDropCount(allDrops) >= maxContestedDrops) {
      return true;
    }
  }
  return false;
}
