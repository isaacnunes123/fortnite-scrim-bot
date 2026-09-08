import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  type ActivityLog,
  type ScrimEmbeds,
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

function formatWhen(value: string): string {
  return new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function useLiveReload(onTick: () => void) {
  const tick = useRef(onTick);
  tick.current = onTick;
  useEffect(() => {
    const run = () => {
      void tick.current();
    };
    const source = new EventSource("/api/stream");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type === "ping") {
          return;
        }
        run();
      } catch {
        run();
      }
    };
    const timer = window.setInterval(run, 4000);
    return () => {
      source.close();
      window.clearInterval(timer);
    };
  }, []);
}

function ActivityFeed({
  logs,
  full,
  onToggle,
}: {
  logs: ActivityLog[];
  full: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="log-panel">
      <header>
        <h3>Log ao vivo</h3>
        <button className="btn secondary" type="button" onClick={onToggle}>
          {full ? "Visão simples" : "Visão completa"}
        </button>
      </header>
      {logs.length === 0 ? (
        <p className="muted">Nada ainda. Check-in, drops e ações da staff aparecem aqui.</p>
      ) : (
        <ul>
          {logs.map((item) => (
            <li key={item.id}>
              <span className={`log-kind ${item.kind}`}>{item.kind}</span>
              <div>
                <strong>{item.summary}</strong>
                {full ? <p>{item.detail}</p> : null}
                <em>{formatWhen(item.at)}</em>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

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
          <img src="/brand/banner.jpg" alt="BUILD CLOSED" className="login-banner" />
          <img src="/brand/logo.png" alt="" className="login-logo" />
          <h1>BUILD CLOSED</h1>
          <p>Painel de scrims fechadas. Treino no Fortnite.</p>
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
          <img src="/brand/logo.png" alt="" className="brand-logo" />
          <span className="brand-copy">
            <strong>BUILD CLOSED</strong>
            <span>Scrims fechadas · Fortnite</span>
          </span>
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
  const [teamsPerDrop, setTeamsPerDrop] = useState(1);
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
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [logFull, setLogFull] = useState(false);

  async function loadLogs() {
    const feed = await api<{ logs: ActivityLog[] }>("/api/logs").catch(() => ({ logs: [] }));
    setLogs(feed.logs ?? []);
    await onCreated().catch(() => undefined);
  }

  useLiveReload(() => {
    void loadLogs();
  });

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
    if (!Number.isInteger(teamsPerDrop) || teamsPerDrop < 1 || teamsPerDrop > 20) {
      setError("Times por drop precisa ser um número de 1 a 20.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await api<{ scrim: ScrimSummary }>("/api/scrims", {
        method: "POST",
        body: JSON.stringify({
          name,
          mode,
          maxSlots,
          teamsPerDrop,
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
          <label htmlFor="teams-per-drop">Times por drop</label>
          <input
            id="teams-per-drop"
            type="number"
            min={1}
            max={20}
            value={teamsPerDrop}
            onChange={(event) => setTeamsPerDrop(Number(event.target.value))}
            required
          />
          <p className="muted">
            Se for 2, só 2 times podem ficar no mesmo drop. O terceiro recebe erro e não entra.
          </p>
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
          <span className="pill live">Painel ao vivo</span>
          <ActivityFeed logs={logs} full={logFull} onToggle={() => setLogFull((value) => !value)} />
        </div>
        <div className="card" style={{ marginTop: 16 }}>
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
  const [assignUserId, setAssignUserId] = useState("");
  const [assignDropId, setAssignDropId] = useState("");
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [logFull, setLogFull] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "drop" | "pending">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [embeds, setEmbeds] = useState<ScrimEmbeds | null>(null);

  async function load() {
    const [data, feed] = await Promise.all([
      api<{ scrim: ScrimDetail; invites: Invite[] }>(`/api/scrims/${id}`),
      api<{ logs: ActivityLog[] }>(`/api/logs?scrim=${encodeURIComponent(id)}`),
    ]);
    setScrim(data.scrim);
    setInvites(data.invites);
    setDrops(data.scrim.drops ?? []);
    setCode(data.scrim.matchCode ?? "");
    setLeaveUntil(data.scrim.leaveUntil ?? "");
    setPunishHours(data.scrim.punishHours ?? 24);
    if (data.scrim.embeds) {
      setEmbeds(data.scrim.embeds);
    }
    setLogs(feed.logs ?? []);
  }

  useLiveReload(() => {
    void load().catch(() => undefined);
  });

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

  const visibleInvites = useMemo(() => {
    const q = query.trim().toLowerCase();
    return invites
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .filter((item) => {
        if (filter === "drop" && !item.dropped) {
          return false;
        }
        if (filter === "pending" && item.dropped) {
          return false;
        }
        if (!q) {
          return true;
        }
        return [
          item.displayName,
          item.username,
          item.fortniteNick,
          item.discordUserId,
          item.dropName,
          item.highestRoleName,
        ]
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
  }, [invites, query, filter]);

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
    setError(null);
    try {
      await api(`/api/scrims/${id}/invites/${inviteId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível remover o player");
    }
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
            {` · ${scrim.teamsPerDrop ?? 1} time(s) por drop`}
            {scrim.discord ? ` · lobby ${scrim.discord.lobbyNumber}` : ""}
            {scrim.leaveUntil
              ? ` · checkout ${scrim.leaveUntil} · ban ${scrim.punishHours}h`
              : " · checkout ainda não definido"}
          </p>
        </div>
        <div className="actions">
          <span className="pill live">Ao vivo</span>
          <button className="btn danger" type="button" onClick={onDelete}>
            Apagar scrim
          </button>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok-text">{notice}</p> : null}

      <ActivityFeed logs={logs} full={logFull} onToggle={() => setLogFull((value) => !value)} />

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
          setError(null);
          setNotice(null);
          try {
            await api(`/api/scrims/${id}/code`, {
              method: "POST",
              body: JSON.stringify({ code }),
            });
            setNotice("Código postado no canal de code.");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Não foi possível enviar o código");
          }
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
            setError(null);
            try {
              await api(`/api/scrims/${id}/fill/open`, {
                method: "POST",
                body: JSON.stringify({ open: true }),
              });
              setNotice("Fill liberado: players podem pedir vaga.");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Não foi possível liberar o fill");
            }
          }}
        >
          Liberar pedidos de fill
        </button>
        <button
          className="btn secondary"
          type="button"
          onClick={async () => {
            setError(null);
            try {
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
            } catch (err) {
              setError(err instanceof Error ? err.message : "Não foi possível alterar a marcação");
            }
          }}
        >
          {scrim.dropsOpen ? "Parar marcação de drops" : "Liberar marcação de drops"}
        </button>
      </form>

      {embeds ? (
        <form
          className="embed-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              await api(`/api/scrims/${id}/embeds`, {
                method: "PUT",
                body: JSON.stringify({ embeds }),
              });
              setNotice("Embeds salvas e atualizadas no Discord.");
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Não foi possível salvar as embeds");
            }
          }}
        >
          <h3>Embeds do Discord</h3>
          <p className="muted">
            Variáveis: {"{name}"} {"{teams}"} {"{max}"} {"{windows}"} {"{url}"} {"{leaveUntil}"}{" "}
            {"{punishHours}"} {"{code}"}
          </p>
          {(
            [
              ["registration", "Check-in"],
              ["dropmapOpen", "Mapa aberto"],
              ["dropmapClosed", "Mapa fechado"],
              ["leave", "Getting-off"],
              ["code", "Código"],
            ] as Array<[keyof ScrimEmbeds, string]>
          ).map(([key, label]) => (
            <fieldset key={key}>
              <legend>{label}</legend>
              <label>
                Título
                <input
                  value={embeds[key].title}
                  onChange={(event) =>
                    setEmbeds({
                      ...embeds,
                      [key]: { ...embeds[key], title: event.target.value },
                    })
                  }
                />
              </label>
              <label>
                Texto
                <textarea
                  rows={5}
                  value={embeds[key].description}
                  onChange={(event) =>
                    setEmbeds({
                      ...embeds,
                      [key]: { ...embeds[key], description: event.target.value },
                    })
                  }
                />
              </label>
              <div className="embed-meta">
                <label>
                  Cor
                  <input
                    type="color"
                    value={embeds[key].color.startsWith("#") ? embeds[key].color : "#3b82f6"}
                    onChange={(event) =>
                      setEmbeds({
                        ...embeds,
                        [key]: { ...embeds[key], color: event.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  Rodapé
                  <input
                    value={embeds[key].footer}
                    onChange={(event) =>
                      setEmbeds({
                        ...embeds,
                        [key]: { ...embeds[key], footer: event.target.value },
                      })
                    }
                  />
                </label>
              </div>
            </fieldset>
          ))}
          <button className="btn" type="submit">
            Salvar e atualizar no Discord
          </button>
        </form>
      ) : null}

      <h3>Mapa de drops</h3>
      <p className="muted">
        Preset {scrim.templateName || "fixo"} — os players marcam sozinhos ou você atribui abaixo.
        {drops.length === 0
          ? " Este mapa ainda não tem drops: salve o preset e recarregue esta página."
          : ""}
      </p>
      <MapBoard
        imageUrl={scrim.mapImageUrl || "/maps/island.png"}
        drops={drops}
        occupancyLimit={scrim.teamsPerDrop ?? 1}
      />

      <form
        className="invite-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setNotice(null);
          try {
            await api(`/api/scrims/${id}/drops/assign`, {
              method: "POST",
              body: JSON.stringify({
                discordUserId: assignUserId,
                dropId: assignDropId,
              }),
            });
            setNotice("Drop marcado para o player. Código e getting-off já devem ter liberado.");
            await load();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Não foi possível marcar o drop");
          }
        }}
      >
        <label htmlFor="assign-player">Marcar drop manualmente</label>
        <select
          id="assign-player"
          value={assignUserId}
          onChange={(event) => setAssignUserId(event.target.value)}
          required
        >
          <option value="">Player (check-in)</option>
          {invites.map((member) => (
            <option key={member.id} value={member.discordUserId}>
              {member.displayName} · {member.fortniteNick || member.displayName}
            </option>
          ))}
        </select>
        <select
          id="assign-drop"
          value={assignDropId}
          onChange={(event) => setAssignDropId(event.target.value)}
          required
        >
          <option value="">Drop</option>
          {drops.map((drop) => {
            const count = drop.claims?.length
              ? drop.claims.length
              : drop.claimedByTeam
                ? 1
                : 0;
            const limit = scrim.teamsPerDrop ?? 1;
            return (
              <option key={drop.id} value={drop.id}>
                Drop {drop.name} · {count}/{limit}
                {count >= limit ? " · cheio" : ""}
                {drop.claimedByTeam && count === 1 ? ` · ${drop.claimedByTeam}` : ""}
              </option>
            );
          })}
        </select>
        <button className="btn" type="submit" disabled={drops.length === 0 || invites.length === 0}>
          Atribuir drop
        </button>
      </form>

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
        {invites.filter((item) => item.dropped).length}/{invites.length} com drop. Clique no card
        para ver cargos, horários e copiar o ID.
      </p>
      <div className="roster-tools">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar nick, ID, cargo, drop…"
        />
        <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
          <option value="all">Todos</option>
          <option value="pending">Sem drop</option>
          <option value="drop">Com drop</option>
        </select>
      </div>
      {visibleInvites.length === 0 ? (
        <p className="muted">Nenhum check-in neste filtro.</p>
      ) : (
        <ul className="roster">
          {visibleInvites.map((member) => (
            <li key={member.id} className={member.dropped ? "has-drop" : "no-drop"}>
              <button
                type="button"
                className="roster-main"
                onClick={() => setOpenId(openId === member.id ? null : member.id)}
              >
                {member.avatarUrl ? (
                    <img src={member.avatarUrl} alt="" className="roster-face" referrerPolicy="no-referrer" />
                ) : (
                  <span className="roster-face empty" />
                )}
                <div className="roster-body">
                  <strong>
                    {member.displayName}{" "}
                    <span className="muted">@{member.username || member.displayName}</span>
                  </strong>
                  <span>
                    Fortnite: <b>{member.fortniteNick || member.displayName}</b>
                    {member.globalName ? ` · global ${member.globalName}` : ""}
                  </span>
                  <span>
                    Check-in {formatWhen(member.createdAt)}
                    {member.dropped
                      ? ` · drop ${member.dropName || "ok"}${member.droppedAt ? ` às ${formatWhen(member.droppedAt)}` : ""}`
                      : " · sem drop"}
                    {member.inServer === false ? " · fora do servidor" : ""}
                    {member.boosted ? " · boost" : ""}
                  </span>
                </div>
                <span
                  className="roster-role"
                  style={{ borderColor: member.highestRoleColor || "#6b7280" }}
                >
                  {member.highestRoleName || "—"}
                </span>
              </button>
              <button className="btn secondary" type="button" onClick={() => onRemove(member.id)}>
                Tirar
              </button>
              {openId === member.id ? (
                <div className="roster-details">
                  <p>
                    ID Discord <code>{member.discordUserId}</code>{" "}
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(member.discordUserId)}
                    >
                      Copiar ID
                    </button>
                  </p>
                  <p>Time: {member.teamName}</p>
                  {member.joinedAt ? <p>Entrou no servidor: {formatWhen(member.joinedAt)}</p> : null}
                  <p>
                    Cargos:{" "}
                    {(member.roles ?? []).length
                      ? member.roles!.map((role) => role.name).join(", ")
                      : member.highestRoleName}
                  </p>
                </div>
              ) : null}
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
