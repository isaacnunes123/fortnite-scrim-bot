import { FormEvent, useEffect, useState } from "react";
import { api, type DropSpot, type MapTemplate } from "./api";
import { MapBoard } from "./MapBoard";

export function TemplatesPage({ onBack }: { onBack: () => void }) {
  const [templates, setTemplates] = useState<MapTemplate[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [template, setTemplate] = useState<MapTemplate | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  async function loadList(selectId?: string) {
    const data = await api<{ templates: MapTemplate[] }>("/api/templates");
    setTemplates(data.templates);
    const nextId = selectId || activeId || data.templates[0]?.id || "";
    setActiveId(nextId);
    if (nextId) {
      const detail = await api<{ template: MapTemplate }>(`/api/templates/${nextId}`);
      setTemplate(detail.template);
      setDirty(false);
      setSaved(null);
    } else {
      setTemplate(null);
      setDirty(false);
    }
  }

  useEffect(() => {
    loadList().catch((err) => {
      setError(err instanceof Error ? err.message : "Falha ao carregar presets");
    });
  }, []);

  async function openTemplate(id: string) {
    if (dirty && !window.confirm("Há alterações sem salvar. Descartar e abrir outro preset?")) {
      return;
    }
    setActiveId(id);
    setError(null);
    const detail = await api<{ template: MapTemplate }>(`/api/templates/${id}`);
    setTemplate(detail.template);
    setDirty(false);
    setSaved(null);
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const created = await api<{ template: MapTemplate }>("/api/templates", {
        method: "POST",
        body: JSON.stringify({ name: newName || "Novo preset" }),
      });
      setNewName("");
      await loadList(created.template.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar o preset");
    }
  }

  function updateLocal(patch: Partial<MapTemplate>) {
    if (!template) {
      return;
    }
    setTemplate({ ...template, ...patch });
    setDirty(true);
    setSaved(null);
  }

  async function persistTemplate(next: MapTemplate) {
    const data = await api<{ template: MapTemplate }>(`/api/templates/${next.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: next.name,
        drops: next.drops,
      }),
    });
    setTemplate(data.template);
    setTemplates((current) =>
      current.map((item) => (item.id === data.template.id ? data.template : item)),
    );
    setDirty(false);
    setSaved("Preset salvo.");
    return data.template;
  }

  async function saveChanges() {
    if (!template) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await persistTemplate(template);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm("Apagar este preset?")) {
      return;
    }
    setError(null);
    try {
      await api(`/api/templates/${id}`, { method: "DELETE" });
      setActiveId("");
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível apagar o preset");
    }
  }

  function exportJson() {
    if (!template) {
      setError("Abra um preset para exportar.");
      return;
    }
    if (template.drops.length === 0) {
      setError("Não dá para exportar: este preset ainda não tem drops.");
      return;
    }
    const payload = {
      version: 1,
      kind: "build-closed-map-preset",
      name: template.name,
      mapImageUrl: template.mapImageUrl,
      drops: template.drops.map((drop) => ({
        name: drop.name,
        kind: drop.kind,
        x: drop.x,
        y: drop.y,
        vertices: drop.vertices,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const slug = template.name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "preset";
    link.href = url;
    link.download = `${slug}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setError(null);
    setSaved("JSON baixado.");
  }

  async function importJson(file: File) {
    setError(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Arquivo JSON inválido");
      }
      const created = await api<{ template: MapTemplate }>("/api/templates/import", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      await loadList(created.template.id);
      setSaved("Preset importado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível importar o JSON");
    }
  }

  return (
    <div className="preset-layout">
      <aside className="preset-sidebar">
        <button
          className="btn secondary"
          type="button"
          onClick={() => {
            if (dirty && !window.confirm("Há alterações sem salvar. Sair mesmo assim?")) {
              return;
            }
            onBack();
          }}
        >
          Voltar ao painel
        </button>
        <form onSubmit={onCreate}>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Nome do preset"
          />
          <button className="btn" type="submit">
            CREATE NEW TEMPLATE
          </button>
        </form>
        <label className="btn secondary">
          Importar JSON
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                void importJson(file);
              }
            }}
          />
        </label>
        <ul className="preset-list">
          {templates.map((item) => (
            <li key={item.id} className={item.id === activeId ? "active" : ""}>
              <button type="button" onClick={() => openTemplate(item.id)}>
                <strong>{item.name}</strong>
                <span>{item.drops.length} drops</span>
              </button>
              <button className="btn danger" type="button" onClick={() => onDelete(item.id)}>
                Apagar
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="preset-main">
        {error ? <p className="error">{error}</p> : null}
        {template ? (
          <>
            <header className="topbar compact">
              <div>
                <label htmlFor="preset-name">Nome do preset</label>
                <input
                  id="preset-name"
                  value={template.name}
                  onChange={(event) => updateLocal({ name: event.target.value })}
                />
                <p className="muted">
                  Desenhe os drops no mapa (eles são numerados na ordem). Use uma imagem limpa da
                  ilha, sem print da HUD do Fortnite. Nas scrims você só escolhe este preset.
                </p>
                {saved ? <p className="ok-text">{saved}</p> : null}
                {dirty ? <p className="muted">Há alterações sem salvar.</p> : null}
              </div>
              <div className="actions">
                <button
                  className="btn"
                  type="button"
                  onClick={() => void saveChanges()}
                  disabled={saving}
                >
                  {saving ? "Salvando…" : "Salvar preset"}
                </button>
                <button className="btn secondary" type="button" onClick={exportJson}>
                  Exportar JSON
                </button>
              <label className="btn secondary">
                Trocar imagem
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) {
                      return;
                    }
                    const response = await fetch(`/api/templates/${template.id}/map`, {
                      method: "POST",
                      credentials: "include",
                      headers: { "Content-Type": file.type || "image/png" },
                      body: await file.arrayBuffer(),
                    });
                    const payload = (await response.json()) as {
                      template?: MapTemplate;
                      error?: string;
                    };
                    if (!response.ok) {
                      setError(payload.error || "Falha ao enviar mapa");
                      return;
                    }
                    if (payload.template) {
                      setTemplate((current) =>
                        current
                          ? { ...current, mapImageUrl: payload.template!.mapImageUrl }
                          : payload.template!,
                      );
                    }
                  }}
                />
              </label>
              </div>
            </header>
            <MapBoard
              imageUrl={template.mapImageUrl}
              drops={template.drops}
              editor
              onCreate={(drop) => {
                const next: MapTemplate = {
                  ...template,
                  drops: [
                    ...template.drops,
                    {
                      ...drop,
                      id: crypto.randomUUID(),
                      claimedByTeam: null,
                      claimedByUserId: null,
                      claimedByName: null,
                      claimedByAvatarUrl: null,
                      claims: [],
                    },
                  ],
                };
                setTemplate(next);
                setDirty(true);
                setSaving(true);
                persistTemplate(next)
                  .catch((err) => {
                    setError(err instanceof Error ? err.message : "Não foi possível salvar");
                  })
                  .finally(() => setSaving(false));
              }}
              onRemove={(dropId) => {
                const next: MapTemplate = {
                  ...template,
                  drops: template.drops.filter((drop) => drop.id !== dropId),
                };
                setTemplate(next);
                setDirty(true);
                setSaving(true);
                persistTemplate(next)
                  .catch((err) => {
                    setError(err instanceof Error ? err.message : "Não foi possível salvar");
                  })
                  .finally(() => setSaving(false));
              }}
            />
          </>
        ) : (
          <p className="muted">Crie um preset à esquerda para desenhar os drops.</p>
        )}
      </section>
    </div>
  );
}
