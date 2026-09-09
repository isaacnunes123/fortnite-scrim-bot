import "dotenv/config";


export const env = {
  discordToken: process.env.DISCORD_TOKEN?.trim() ?? "",
  discordClientId: process.env.DISCORD_CLIENT_ID?.trim() ?? "",
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() ?? "",
  discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || "862771292389900308",
  adminRoleIds: parseIdList(process.env.ADMIN_ROLE_IDS),
  sessionSecret: process.env.SESSION_SECRET?.trim() || "dev-session-secret",
  port: Number(process.env.PORT ?? 3000),
  isProduction: process.env.NODE_ENV === "production",
  cookieSecure:
    process.env.NODE_ENV === "production" ||
    (process.env.PUBLIC_BASE_URL ?? "").startsWith("https://") ||
    (process.env.DISCORD_REDIRECT_URI ?? "").startsWith("https://"),
  yuniteApiKey: process.env.YUNITE_API_KEY?.trim() ?? "",
};

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true as const,
    signed: true as const,
    sameSite: "lax" as const,
    secure: env.cookieSecure,
    path: "/",
    maxAge,
  };
}

export const clearCookieOptions = {
  path: "/",
  httpOnly: true,
  signed: true,
  sameSite: "lax" as const,
  secure: env.cookieSecure,
};

function parseIdList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[,;\n]+/)
    .map((item) => item.replace(/[<@&>'"\s]/g, "").trim())
    .filter((id) => /^\d{17,20}$/.test(id));
}
