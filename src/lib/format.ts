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
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  let value: number;
  let suffix: string;
  if (abs >= 1e12) {
    value = abs / 1e12;
    suffix = "T";
  } else if (abs >= 1e9) {
    value = abs / 1e9;
    suffix = "B";
  } else if (abs >= 1e6) {
    value = abs / 1e6;
    suffix = "M";
  } else if (abs >= 1e3) {
    value = abs / 1e3;
    suffix = "K";
  } else {
    value = abs;
    suffix = "";
  }
  const formatted = value.toLocaleString("pt-PT", { maximumFractionDigits: 2 });
  return `${sign}${symbol}${formatted}${suffix}`;
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
