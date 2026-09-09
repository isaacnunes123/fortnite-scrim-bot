import { useEffect, type ReactNode } from "react";

export type BrandId = "scrims" | "closed";

export const BANNER_ROXO = "/banners/Banner_Roxo.webp";

export const BRAND = {
  scrims: {
    name: "BUILD SCRIMS",
    tagline: "Scrims · Fortnite",
    title: "BUILD SCRIMS",
  },
  closed: {
    name: "BUILD CLOSED",
    tagline: "Scrims fechadas · Fortnite",
    title: "BUILD CLOSED",
  },
} as const;

export function useBrandTheme(brand: BrandId, title?: string) {
  useEffect(() => {
    document.documentElement.dataset.brand = brand;
    document.title = title ?? BRAND[brand].title;
    return () => {
      document.documentElement.dataset.brand = "scrims";
    };
  }, [brand, title]);
}

type SiteHeaderProps = {
  brand: BrandId;
  current?: "home" | "tabelas" | "closed" | "staff";
  extra?: ReactNode;
};

export function SiteHeader({ brand, current, extra }: SiteHeaderProps) {
  const copy = BRAND[brand];
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <img src="/brand/logo.png" alt="" className="brand-logo" />
        <span className="brand-copy">
          <strong>{copy.name}</strong>
          <span>{copy.tagline}</span>
        </span>
      </a>
      <nav className="actions" aria-label="Principal">
        <a className="btn secondary" href="/tabelas" aria-current={current === "tabelas" ? "page" : undefined}>
          Tabelas
        </a>
        <a className="btn secondary" href="/closed" aria-current={current === "closed" ? "page" : undefined}>
          Closed
        </a>
        <a className="btn secondary" href="/painel" aria-current={current === "staff" ? "page" : undefined}>
          Painel staff
        </a>
        {extra}
      </nav>
    </header>
  );
}
