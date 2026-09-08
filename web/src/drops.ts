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

export function dropIsFull(drop: DropSpot, limit: number, teamName?: string): boolean {
  const claims = listDropClaims(drop);
  if (teamName && claims.some((claim) => claim.teamName === teamName)) {
    return false;
  }
  return claims.length >= Math.max(1, limit);
}
