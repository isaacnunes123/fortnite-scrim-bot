import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  api,
  type BotStatus,
  type DiscordGuild,
  type DiscordRole,
  type DropSpot,
  type BlacklistEntry,
  type Invite,
  type MapTemplate,
  type PriorityWindow,
  type ScrimDetail,
  type ScrimSummary,
} from "./api";
import { MapBoard } from "./MapBoard";
import { TemplatesPage } from "./Templates";

type AuthState = {
  checking: boolean;
  authenticated: boolean;
  discordLogin: boolean;
  passwordLogin: boolean;
};

type View = { page: "home" } | { page: "scrim"; id: string } | { page: "presets" };

function formatUptime(ms: number | null): string {
  if (ms == null) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({
    checking: true,
    authenticated: false,
    discordLogin: false,
    passwordLogin: true,
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>({ page: "home" });
  const [scrims, setScrims] = useState<ScrimSummary[]>([]);

  async function refreshSession() {
    const me = await api<{
      authenticated: boolean;
      discordLogin?: boolean;
      passwordLogin?: boolean;
    }>("/api/auth/me");
    setAuth({
      checking: false,
      authenticated: me.authenticated,
      discordLogin: Boolean(me.discordLogin),
      passwordLogin: me.passwordLogin !== false,
    });
    if (me.authenticated) {
      const bot = await api<BotStatus>("/api/bot/status");
      setStatus(bot);
      const list = await api<{ scrims: ScrimSummary[] }>("/api/scrims");
      setScrims(list.scrims);
    }
  }

  useEffect(() => {
    refreshSession().catch(() => {
      setAuth({ checking: false, authenticated: false, discordLogin: false, passwordLogin: true });
    });
  }, []);

  async function onLogin(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      await refreshSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível entrar");
    } finally {
      setLoading(false);
    }
  }

  async function onLogout() {
    await api("/api/auth/logout", { method: "POST" });
    setStatus(null);
    setScrims([]);
    setView({ page: "home" });
    setAuth({
      checking: false,
      authenticated: false,
      discordLogin: auth.discordLogin,
      passwordLogin: auth.passwordLogin,
    });
  }

  if (auth.checking) {
    return (
      <div className="login">
        <p>Carregando painel…</p>
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="login">
        <div className="card">
          <div className="login-mark" aria-hidden="true" />
          <h1>Scrim Hub</h1>
          <p>Painel do bot de torneios fechados para treinos no Fortnite.</p>
          {error ? <p className="error">{error}</p> : null}
          {auth.discordLogin ? (
            <>
              <p className="muted">Só entra quem tem o cargo liberado no Discord.</p>
              <a className="btn" href="/api/auth/discord?next=admin">
                Entrar com Discord
              </a>
            </>
          ) : (
            <form onSubmit={onLogin}>
              <label htmlFor="password">Senha do painel</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button className="btn" type="submit" disabled={loading}>
                {loading ? "Entrando…" : "Entrar"}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  const online = Boolean(status?.ready);

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand linkish" type="button" onClick={() => setView({ page: "home" })}>
          <strong>Scrim Hub</strong>
          <span>Torneios fechados · Fortnite</span>
        </button>
        <div className="actions">
          <button className="btn secondary" type="button" onClick={() => setView({ page: "presets" })}>
            Presets de mapa
          </button>
          <span className={`pill ${online ? "ok" : "off"}`}>
            {online ? "Bot online" : "Bot offline"}
          </span>
          <button className="btn secondary" type="button" onClick={onLogout}>
            Sair
          </button>
        </div>
      </header>

      {view.page === "home" ? (
        <Home
          status={status}
          scrims={scrims}
          onCreated={refreshSession}
          onOpen={(id) => setView({ page: "scrim", id })}
        />
      ) : view.page === "presets" ? (
        <TemplatesPage onBack={() => setView({ page: "home" })} />
      ) : (
        <ScrimPage
          id={view.id}
          onBack={async () => {
            await refreshSession();
            setView({ page: "home" });
          }}
        />
      )}
    </div>
  );
}

function Home({
  status,
  scrims,
  onCreated,
  onOpen,
}: {
  status: BotStatus | null;
  scrims: ScrimSummary[];
  onCreated: () => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState("trio");
  const [maxSlots, setMaxSlots] = useState(20);
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([]);
  const [templates, setTemplates] = useState<MapTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [guilds, setGuilds] = useState<DiscordGuild[]>([]);
  const [guildId, setGuildId] = useState("");
  const [accessRoleIds, setAccessRoleIds] = useState<string[]>([]);
  const [staffRoleIds, setStaffRoleIds] = useState<string[]>([]);
  const [windows, setWindows] = useState<PriorityWindow[]>([
    { roleId: "", time: "21:50" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ guilds: DiscordGuild[] }>("/api/discord/guilds")
      .then((data) => {
        setGuilds(data.guilds);
        if (data.guilds[0] && !guildId) {
          setGuildId(data.guilds[0].id);
        }
      })
      .catch(() => undefined);
    api<{ templates: MapTemplate[] }>("/api/templates")
      .then((data) => {
        setTemplates(data.templates);
        if (data.templates[0]) {
          setTemplateId(data.templates[0].id);
        }
      })
      .catch(() => undefined);
    api<{ blacklist: BlacklistEntry[] }>("/api/blacklist")
      .then((data) => setBlacklist(data.blacklist))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!guildId) {
      setRoles([]);
      return;
    }
    setAccessRoleIds([]);
    setStaffRoleIds([]);
    api<{ roles: DiscordRole[] }>(`/api/discord/roles?guildId=${encodeURIComponent(guildId)}`)
      .then((data) => setRoles(data.roles))
      .catch(() => setRoles([]));
  }, [guildId]);

  function toggle(list: string[], id: string, set: (next: string[]) => void) {
    set(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await api<{ scrim: ScrimSummary }>("/api/scrims", {
        method: "POST",
        body: JSON.stringify({
          name,
          mode,
          maxSlots,
          guildId,
          accessRoleIds,
          staffRoleIds,
          windows,
          templateId,
        }),
      });
      setName("");
      await onCreated();
      onOpen(created.scrim.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="grid">
        <article className="stat">
          <label>Bot</label>
          <b>{status?.username ?? "Não conectado"}</b>
        </article>
        <article className="stat">
          <label>Servidores</label>
          <b>{status?.guildCount ?? 0}</b>
        </article>
        <article className="stat">
          <label>Uptime</label>
          <b>{formatUptime(status?.uptimeMs ?? null)}</b>
        </article>
        <article className="stat">
          <label>Scrims</label>
          <b>{scrims.length}</b>
        </article>
      </section>

      <section className="split">
        <form className="card" onSubmit={onCreate}>
          <h2 style={{ marginTop: 0 }}>Nova scrim</h2>
          <p className="muted">
            O bot cria a categoria no Discord: registro, drop, code, chat, saída, fill e admin.
            O horário de checkout é definido depois, no painel da scrim.
          </p>
          {error ? <p className="error">{error}</p> : null}
          <label htmlFor="guild">Servidor</label>
          <select
            id="guild"
            value={guildId}
            onChange={(event) => setGuildId(event.target.value)}
            required
          >
            <option value="">Selecione o servidor</option>
            {guilds.map((guild) => (
              <option key={guild.id} value={guild.id}>
                {guild.name}
              </option>
            ))}
          </select>
          <label htmlFor="name">Nome</label>
          <input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="scrim closed duo divisão 2"
            required
          />
          <label htmlFor="mode">Modo</label>
          <select id="mode" value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="solo">Solo</option>
            <option value="duo">Duo</option>
            <option value="trio">Trio</option>
            <option value="squad">Squad</option>
          </select>
          <label htmlFor="slots">Limite de times</label>
          <input
            id="slots"
            type="number"
            min={1}
            max={100}
            value={maxSlots}
            onChange={(event) => setMaxSlots(Number(event.target.value))}
            required
          />
          <p className="muted">Cargos da divisão (veem o check-in)</p>
          <div className="role-list">
            {roles.map((role) => (
              <label key={role.id} className="role-item">
                <input
                  type="checkbox"
                  checked={accessRoleIds.includes(role.id)}
                  onChange={() => toggle(accessRoleIds, role.id, setAccessRoleIds)}
                />
                {role.name}
              </label>
            ))}
          </div>
          <p className="muted">Cargos de staff (admin + aprovar fill)</p>
          <div className="role-list">
            {roles.map((role) => (
              <label key={`s-${role.id}`} className="role-item">
                <input
                  type="checkbox"
                  checked={staffRoleIds.includes(role.id)}
                  onChange={() => toggle(staffRoleIds, role.id, setStaffRoleIds)}
                />
                {role.name}
              </label>
            ))}
          </div>
          <p className="muted">Horários de prioridade (horário de Brasília)</p>
          {windows.map((window, index) => (
            <div className="window-row" key={`${window.roleId}-${index}`}>
              <select
                value={window.roleId}
                onChange={(event) => {
                  const next = [...windows];
                  next[index] = { ...window, roleId: event.target.value };
                  setWindows(next);
                }}
              >
                <option value="">Sem prioridade</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
              <input
                type="time"
                value={window.time}
                onChange={(event) => {
                  const next = [...windows];
                  next[index] = { ...window, time: event.target.value };
                  setWindows(next);
                }}
                required
              />
            </div>
          ))}
          <button
            className="btn secondary"
            type="button"
            onClick={() => setWindows([...windows, { roleId: "", time: "21:55" }])}
          >
            + horário
          </button>
          <label htmlFor="template">Preset de mapa</label>
          <select
            id="template"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            required
          >
            <option value="">Selecione o preset</option>
            {templates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.drops.length} drops)
              </option>
            ))}
          </select>
          <p className="muted">Os drops vêm prontos do preset. Edite-os em Presets de mapa.</p>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? "Criando no Discord…" : "Criar scrim no Discord"}
          </button>
        </form>

        <div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Listas</h2>
          {scrims.length === 0 ? (
            <p className="muted">Nenhuma scrim ainda. Crie a primeira ao lado.</p>
          ) : (
            <ul className="scrim-list">
              {scrims.map((scrim) => (
                <li key={scrim.id}>
                  <button type="button" onClick={() => onOpen(scrim.id)}>
                    <strong>{scrim.name}</strong>
                    <span>
                      {scrim.mode} · {scrim.guildName ? `${scrim.guildName} · ` : ""}
                      {scrim.teamCount}/{scrim.maxSlots} times · {scrim.inviteCount} players
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Blacklist da closed</h2>
          <p className="muted">
            Quem saiu depois do horário. Check-in bloqueado até acabar a punição.
          </p>
          {blacklist.length === 0 ? (
            <p className="muted">Ninguém na blacklist agora.</p>
          ) : (
            <ul className="scrim-list">
              {blacklist.map((entry) => (
                <li key={entry.id}>
                  <strong>
                    {entry.fortniteNick} · {entry.displayName}
                  </strong>
                  <span>
                    ID {entry.discordUserId} · até{" "}
                    {new Date(entry.expiresAt).toLocaleString("pt-BR", {
                      timeZone: "America/Sao_Paulo",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        </div>
      </section>
    </>
  );
}

function ScrimPage({ id, onBack }: { id: string; onBack: () => void }) {
  const [scrim, setScrim] = useState<ScrimDetail | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [teamName, setTeamName] = useState("");
  const [player, setPlayer] = useState("");
  const [fortniteNick, setFortniteNick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState("");
  const [drops, setDrops] = useState<DropSpot[]>([]);
  const [leaveUntil, setLeaveUntil] = useState("");
  const [punishHours, setPunishHours] = useState(24);

  async function load() {
    const data = await api<{ scrim: ScrimDetail; invites: Invite[] }>(`/api/scrims/${id}`);
    setScrim(data.scrim);
    setInvites(data.invites);
    setDrops(data.scrim.drops ?? []);
    setCode(data.scrim.matchCode ?? "");
    setLeaveUntil(data.scrim.leaveUntil ?? "");
    setPunishHours(data.scrim.punishHours ?? 24);
  }

  useEffect(() => {
    load().catch((err) => {
      setError(err instanceof Error ? err.message : "Falha ao carregar");
    });
  }, [id]);

  const teams = useMemo(() => {
    const grouped = new Map<string, Invite[]>();
    for (const invite of invites) {
      const list = grouped.get(invite.teamName) ?? [];
      list.push(invite);
      grouped.set(invite.teamName, list);
    }
    return [...grouped.entries()];
  }, [invites]);

  async function onInvite(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ dmSent: boolean }>(`/api/scrims/${id}/invites`, {
        method: "POST",
        body: JSON.stringify({ teamName, player, fortniteNick }),
      });
      setPlayer("");
      setFortniteNick("");
      setNotice(
        result.dmSent
          ? "Player adicionado e avisado no privado."
          : "Player adicionado. Não deu para mandar DM (privadas fechadas).",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível convidar");
    } finally {
      setSaving(false);
    }
  }

  async function onRemove(inviteId: string) {
    await api(`/api/scrims/${id}/invites/${inviteId}`, { method: "DELETE" });
    await load();
  }

  async function onDelete() {
    if (!window.confirm("Apagar esta scrim e todos os convites?")) {
      return;
    }
    await api(`/api/scrims/${id}`, { method: "DELETE" });
    onBack();
  }

  if (!scrim) {
    return <p className="muted">Carregando lista…</p>;
  }

  return (
    <section className="card">
      <div className="topbar compact">
        <div>
          <button className="btn secondary" type="button" onClick={onBack}>
            Voltar
          </button>
          <h2 style={{ margin: "16px 0 4px" }}>{scrim.name}</h2>
          <p className="muted">
            {scrim.mode} · {scrim.teamSize} por time · {scrim.teamCount}/{scrim.maxSlots} times
            {scrim.discord ? ` · lobby ${scrim.discord.lobbyNumber}` : ""}
            {scrim.leaveUntil
              ? ` · checkout ${scrim.leaveUntil} · ban ${scrim.punishHours}h`
              : " · checkout ainda não definido"}
          </p>
        </div>
        <button className="btn danger" type="button" onClick={onDelete}>
          Apagar scrim
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok-text">{notice}</p> : null}

      <form
        className="invite-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setNotice(null);
          try {
            await api(`/api/scrims/${id}/checkout`, {
              method: "POST",
              body: JSON.stringify({ leaveUntil, punishHours }),
            });
            setNotice(
              `Checkout definido: saída livre até ${leaveUntil}. Depois disso, ban de ${punishHours}h.`,
            );
            await load();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Não foi possível salvar o checkout");
          }
        }}
      >
        <label htmlFor="leaveUntil">Checkout (saída livre até, horário de Brasília)</label>
        <input
          id="leaveUntil"
          type="time"
          value={leaveUntil}
          onChange={(event) => setLeaveUntil(event.target.value)}
          required
        />
        <label htmlFor="punishHours">Ban da closed se sair depois (horas)</label>
        <input
          id="punishHours"
          type="number"
          min={1}
          max={720}
          value={punishHours}
          onChange={(event) => setPunishHours(Number(event.target.value))}
          required
        />
        <button className="btn" type="submit">
          Definir checkout
        </button>
      </form>

      <form
        className="invite-form"
        onSubmit={async (event) => {
          event.preventDefault();
          await api(`/api/scrims/${id}/code`, {
            method: "POST",
            body: JSON.stringify({ code }),
          });
          setNotice("Código postado no canal de code.");
        }}
      >
        <label htmlFor="code">Código da partida</label>
        <input id="code" value={code} onChange={(event) => setCode(event.target.value)} />
        <button className="btn" type="submit">
          Enviar código
        </button>
        <button
          className="btn secondary"
          type="button"
          onClick={async () => {
            await api(`/api/scrims/${id}/fill/open`, {
              method: "POST",
              body: JSON.stringify({ open: true }),
            });
            setNotice("Fill liberado: players podem pedir vaga.");
          }}
        >
          Liberar pedidos de fill
        </button>
        <button
          className="btn secondary"
          type="button"
          onClick={async () => {
            const open = !scrim.dropsOpen;
            await api(`/api/scrims/${id}/drops/open`, {
              method: "POST",
              body: JSON.stringify({ open }),
            });
            setNotice(
              open
                ? "Marcação de drops liberada."
                : "Marcação de drops fechada. Players ainda veem o mapa.",
            );
            await load();
          }}
        >
          {scrim.dropsOpen ? "Parar marcação de drops" : "Liberar marcação de drops"}
        </button>
      </form>

      <h3>Mapa de drops</h3>
      <p className="muted">
        Preset {scrim.templateName || "fixo"} — os players só marcam. Edite as áreas em
        Presets de mapa.
      </p>
      <MapBoard imageUrl={scrim.mapImageUrl || "/maps/island.png"} drops={drops} />

      <form className="invite-form" onSubmit={onInvite}>
        <label htmlFor="team">Nome do time</label>
        <input
          id="team"
          value={teamName}
          onChange={(event) => setTeamName(event.target.value)}
          placeholder="Ex.: Wave"
          required
        />
        <label htmlFor="epic">Nick do Fortnite</label>
        <input
          id="epic"
          value={fortniteNick}
          onChange={(event) => setFortniteNick(event.target.value)}
          placeholder="NickEpic"
          required
        />
        <label htmlFor="player">Player (ID do Discord, @ ou nick no servidor)</label>
        <input
          id="player"
          value={player}
          onChange={(event) => setPlayer(event.target.value)}
          placeholder="123456789012345678"
          required
        />
        <button className="btn" type="submit" disabled={saving}>
          {saving ? "Convidando…" : "Adicionar à lista"}
        </button>
      </form>

      <h3>Check-ins</h3>
      <p className="muted">
        Discord, foto, ID, nick (apelido / Fortnite), horário de check-in e cargo mais alto no
        servidor. {invites.filter((item) => item.dropped).length}/{invites.length} já marcaram drop.
      </p>
      {invites.length === 0 ? (
        <p className="muted">Nenhum check-in ainda.</p>
      ) : (
        <ul className="roster">
          {invites
            .slice()
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((member) => (
              <li key={member.id}>
                {member.avatarUrl ? (
                  <img src={member.avatarUrl} alt="" className="roster-face" />
                ) : (
                  <span className="roster-face empty" />
                )}
                <div className="roster-body">
                  <strong>
                    {member.displayName}{" "}
                    <span className="muted">@{member.username || member.displayName}</span>
                  </strong>
                  <span>
                    Nick Fortnite: <b>{member.fortniteNick || member.displayName}</b>
                  </span>
                  <span>
                    ID <code>{member.discordUserId}</code> · check-in{" "}
                    {new Date(member.createdAt).toLocaleString("pt-BR", {
                      timeZone: "America/Sao_Paulo",
                    })}
                    {member.dropped ? " · drop ok" : " · sem drop"}
                  </span>
                </div>
                <span
                  className="roster-role"
                  style={{ borderColor: member.highestRoleColor || "#6b7280" }}
                >
                  {member.highestRoleName || "—"}
                </span>
                <button className="btn secondary" type="button" onClick={() => onRemove(member.id)}>
                  Tirar
                </button>
              </li>
            ))}
        </ul>
      )}

      {teams.length === 0 ? null : (
        <div className="teams">
          {teams.map(([name, members]) => (
            <article key={name} className="team">
              <h3>
                {name}{" "}
                <span>
                  {members.length}/{scrim.teamSize}
                </span>
              </h3>
              <ul>
                {members.map((member) => (
                  <li key={member.id}>
                    <span>
                      {member.displayName} · {member.fortniteNick}{" "}
                      <code>{member.discordUserId}</code>
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
