import { dropMapUrl } from "./links.js";
import { applyEmbedVars, teamCount, type EmbedCopy, type Scrim } from "./store.js";
import { formatLeaveUntil, formatWindowWhen } from "./time.js";

export type DiscordEmbedPayload = {
  title: string;
  description: string;
  color: number;
  footer?: { text: string };
  url?: string;
};

export type DiscordButtonPayload = {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
};

export type DiscordActionRowPayload = {
  type: 1;
  components: DiscordButtonPayload[];
};

export type DiscordMessagePayload = {
  content?: string;
  embeds?: DiscordEmbedPayload[];
  components?: DiscordActionRowPayload[];
};

export function parseEmbedColor(hex: string, fallback: number): number {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(value) ? value : fallback;
}

export function scrimEmbedVars(scrim: Scrim, extra: Record<string, string> = {}): Record<string, string> {
  return {
    name: scrim.name,
    teams: String(teamCount(scrim.id)),
    max: String(scrim.maxSlots),
    windows: extra.windows ?? "",
    url: dropMapUrl(scrim.id),
    leaveUntil: formatLeaveUntil(scrim.leaveUntil) || "ainda não definido",
    punishHours: String(scrim.punishHours),
    code: scrim.matchCode || "—",
    ...extra,
  };
}

export function registrationWindowLines(scrim: Scrim): string {
  return scrim.windows
    .map((window) => {
      const when = formatWindowWhen(window);
      if (!window.roleId) {
        return `Quem **não** tem cargo de prioridade faz check-in em **${when}**`;
      }
      return `<@&${window.roleId}> faz check-in em **${when}**`;
    })
    .join("\n");
}

export function embedPayload(
  copy: EmbedCopy,
  vars: Record<string, string>,
  fallbackColor: number,
  extra: { url?: string } = {},
): DiscordEmbedPayload {
  const footer = applyEmbedVars(copy.footer, vars).slice(0, 2048);
  const payload: DiscordEmbedPayload = {
    color: parseEmbedColor(copy.color, fallbackColor),
    title: applyEmbedVars(copy.title, vars).slice(0, 256) || "Scrim",
    description: applyEmbedVars(copy.description, vars).slice(0, 4096) || "—",
  };
  if (footer) {
    payload.footer = { text: footer };
  }
  if (extra.url) {
    payload.url = extra.url;
  }
  return payload;
}

function row(buttons: DiscordButtonPayload[]): DiscordActionRowPayload {
  return { type: 1, components: buttons };
}

export function registrationMessagePayload(scrim: Scrim): DiscordMessagePayload {
  return {
    embeds: [
      embedPayload(
        scrim.embeds.registration,
        scrimEmbedVars(scrim, { windows: registrationWindowLines(scrim) }),
        0x3ee0a2,
      ),
    ],
    components: [
      row([
        {
          type: 2,
          style: 1,
          custom_id: `reg:${scrim.id}`,
          label: "Registrar",
        },
      ]),
    ],
  };
}

export function leaveMessagePayload(scrim: Scrim): DiscordMessagePayload {
  return {
    embeds: [embedPayload(scrim.embeds.leave, scrimEmbedVars(scrim), 0xff5c5c)],
    components: [
      row([
        {
          type: 2,
          style: 4,
          custom_id: `leave:${scrim.id}`,
          label: "Sair da scrim",
        },
      ]),
    ],
  };
}

export function dropMapMessagePayload(scrim: Scrim): DiscordMessagePayload {
  const url = dropMapUrl(scrim.id);
  const open = scrim.dropsOpen !== false;
  const copy = open ? scrim.embeds.dropmapOpen : scrim.embeds.dropmapClosed;
  return {
    embeds: [embedPayload(copy, scrimEmbedVars(scrim), open ? 0x3b82f6 : 0x111111, { url })],
    components: [
      row([
        {
          type: 2,
          style: 5,
          label: open ? "Abrir mapa e marcar drop" : "Ver mapa ao vivo",
          url,
        },
      ]),
    ],
  };
}

export function fillMessagePayload(scrim: Scrim, open = false): DiscordMessagePayload {
  return {
    embeds: [
      {
        color: 0xf5c542,
        title: "Segunda chance",
        description:
          "Este canal aparece quando a lista fecha. Fica bloqueado até um staff liberar os pedidos.",
      },
    ],
    components: [
      row([
        {
          type: 2,
          style: 2,
          custom_id: `fill:${scrim.id}`,
          label: "Pedir vaga",
          disabled: !open,
        },
      ]),
    ],
  };
}

export function adminMessagePayload(scrimId: string, locked = false): DiscordMessagePayload {
  return {
    embeds: [
      {
        color: 0x1a1418,
        title: "Controle da lobby",
        description:
          "Avisos, lock do chat, finalizar (apaga canais e **mantém** mapa/tabela no site) ou excluir tudo (canais + site).",
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            custom_id: `nagdrop:${scrimId}`,
            label: "Avisar sem drop",
          },
          {
            type: 2,
            style: 1,
            custom_id: `nagcode:${scrimId}`,
            label: "Avisar código",
          },
          {
            type: 2,
            style: 2,
            custom_id: `lockchat:${scrimId}`,
            label: locked ? "Unlock chat" : "Lock chat",
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            custom_id: `finish:${scrimId}`,
            label: "Finalizar scrim",
          },
          {
            type: 2,
            style: 4,
            custom_id: `kill:${scrimId}`,
            label: "Excluir scrim",
          },
        ],
      },
    ],
  };
}

export function lobbyChannelNames(lobbyNumber: number, scrimName: string) {
  const prefix = `lobby-${lobbyNumber}`;
  return {
    prefix,
    category: `${prefix} ${scrimName}`.slice(0, 100),
    registeredRole: `${prefix}-in`,
    confirmedRole: `${prefix}-ready`,
    registration: `${prefix}-registration`,
    dropmap: `${prefix}-dropmap`,
    code: `${prefix}-code`,
    chat: `${prefix}-chat`,
    leave: `${prefix}-getting-off`,
    fill: `${prefix}-fill-requests`,
    admin: `${prefix}-admin`,
  };
}
