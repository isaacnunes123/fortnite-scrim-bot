import "dotenv/config";


function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

export const env = {
  discordToken: process.env.DISCORD_TOKEN?.trim() ?? "",
  discordClientId: process.env.DISCORD_CLIENT_ID?.trim() ?? "",
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() ?? "",
  discordGuildId: process.env.DISCORD_GUILD_ID?.trim() ?? "",
  adminPassword: required("ADMIN_PASSWORD"),
  adminRoleIds: parseIdList(process.env.ADMIN_ROLE_IDS),
  sessionSecret: required("SESSION_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  isProduction: process.env.NODE_ENV === "production",
  cookieSecure:
    process.env.NODE_ENV === "production" ||
    (process.env.PUBLIC_BASE_URL ?? "").startsWith("https://"),
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
