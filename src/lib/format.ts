export function fmtMoney(n: number, currency = "USD"): string {
  if (!isFinite(n)) return "—";
  return new Intl.NumberFormat("pt-PT", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(n);
}

export function fmtCompact(n: number, currency = "USD"): string {
  if (!isFinite(n) || n === 0) return "—";
  return new Intl.NumberFormat("pt-PT", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}

export function fmtPct(n: number, digits = 1): string {
  if (!isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function fmtNumber(n: number): string {
  if (!isFinite(n)) return "—";
  return new Intl.NumberFormat("pt-PT", { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

const RECENT_KEY = "vs:recent";
export function pushRecent(t: { ticker: string; name: string }) {
  if (typeof window === "undefined") return;
  try {
    const cur = getRecent().filter((x) => x.ticker !== t.ticker);
    const next = [t, ...cur].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
export function getRecent(): { ticker: string; name: string }[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}
