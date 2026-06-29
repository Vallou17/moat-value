// build-version: 2026-06-18-v2
// FMP API proxy — keeps the API key server-side.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
 
const BASE = "https://financialmodelingprep.com/stable";
 
function key() {
  const k = process.env.FMP_API_KEY ?? process.env.VITE_FMP_API_KEY;
  if (!k) throw new Error("Chave FMP_API_KEY não configurada no servidor.");
  return k;
}
 
async function fmp<T = unknown>(path: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE}${path}${sep}apikey=${key()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FMP ${res.status} em ${path.split("?")[0]}${body ? `: ${body.slice(0, 120)}` : ""}`);
  }
  const json = await res.json();
  if (json && typeof json === "object" && !Array.isArray(json) && "Error Message" in json) {
    throw new Error(`FMP: ${(json as any)["Error Message"]}`);
  }
  return json as T;
}
 
export const searchStocks = createServerFn({ method: "GET" })
  .inputValidator((d: { query: string }) => z.object({ query: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    type R = { symbol: string; name: string; exchangeShortName?: string; exchange?: string; currency?: string }[];
    const q = data.query.trim();
    const qU = q.toUpperCase();
    const [bySymbol, byName] = await Promise.all([
      fmp<R>(`/search-symbol?query=${encodeURIComponent(q)}&limit=10`).catch(() => [] as R),
      fmp<R>(`/search-name?query=${encodeURIComponent(q)}&limit=10`).catch(() => [] as R),
    ]);
    const seen = new Set<string>();
    const merged = [...bySymbol, ...byName]
      .filter((r) => {
        if (!r?.symbol) return false;
        if (seen.has(r.symbol)) return false;
        seen.add(r.symbol);
        return true;
      })
      .map((r) => ({
        ticker: r.symbol,
        name: r.name,
        exchange: r.exchangeShortName ?? r.exchange ?? "",
        currency: r.currency ?? "USD",
      }));
    merged.sort((a, b) => {
      const ax = a.ticker.toUpperCase() === qU ? 0 : 1;
      const bx = b.ticker.toUpperCase() === qU ? 0 : 1;
      return ax - bx;
    });
    return merged.slice(0, 10);
  });
 
// ---------- Market snapshot (ticker strip) ----------
export type MarketQuote = {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
};
 
const SNAPSHOT_SYMBOLS: { symbol: string; name: string }[] = [
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^IXIC", name: "NASDAQ" },
  { symbol: "^DJI", name: "Dow Jones" },
  { symbol: "^RUT", name: "Russell 2000" },
  { symbol: "EURUSD", name: "EUR/USD" },
];
 
export const getMarketSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<MarketQuote[]> => {
    const results = await Promise.all(
      SNAPSHOT_SYMBOLS.map(async ({ symbol, name }) => {
        try {
          const arr = await fmp<any[]>(`/quote?symbol=${encodeURIComponent(symbol)}`);
          const q = arr?.[0];
          if (!q) return null;
          return {
            symbol,
            name,
            price: Number(q.price ?? 0),
            changePercent: Number(q.changePercentage ?? q.changesPercentage ?? 0),
          };
        } catch {
          return null;
        }
      }),
    );
    return results.filter((r): r is MarketQuote => r !== null);
  },
);
 
// ---------- Index history (candlestick) ----------
export type Candle = { date: string; open: number; high: number; low: number; close: number };

function tdKey() {
  const k = process.env.TWELVE_DATA_API_KEY;
  if (!k) return null;
  return k;
}

// Twelve Data symbol mapping — our FMP-style "^" index symbols don't exist on Twelve Data.
const TD_SYMBOL_MAP: Record<string, string> = {
  "^GSPC": "SPX",
  "^IXIC": "IXIC",
  "^DJI": "DJI",
  "^RUT": "RUT",
};

// Twelve Data's free (Basic) plan returns full daily history since listing for equities/indices
// (no artificial "5 years" cap like FMP Starter, no "compact=100 points" cap like Alpha Vantage
// free tier). Limit is 800 requests/day, so we still cache in Supabase for 24h.
async function fetchFromTwelveData(symbol: string): Promise<Candle[] | null> {
  const key = tdKey();
  if (!key) return null;
  const tdSymbol = TD_SYMBOL_MAP[symbol] ?? symbol.replace(/^\^/, "");
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    tdSymbol,
  )}&interval=1day&outputsize=5000&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.status === "error" || !Array.isArray(json.values)) return null;
  return json.values
    .map((v: any) => ({
      date: String(v.datetime),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
    }))
    .sort((a: Candle, b: Candle) => a.date.localeCompare(b.date));
}

async function getCachedLongHistory(symbol: string): Promise<Candle[] | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin
    .from("price_history_cache")
    .select("candles, updated_at")
    .eq("symbol", symbol)
    .maybeSingle();

  const isFresh = row && Date.now() - new Date(row.updated_at).getTime() < 24 * 60 * 60_000;
  if (isFresh) return row.candles as Candle[];

  const fresh = await fetchFromTwelveData(symbol);
  if (!fresh || fresh.length === 0) {
    // Twelve Data failed (rate-limited or symbol unsupported) — serve stale cache if we have any.
    return row ? (row.candles as Candle[]) : null;
  }

  await supabaseAdmin
    .from("price_history_cache")
    .upsert({ symbol, candles: fresh, updated_at: new Date().toISOString() }, { onConflict: "symbol" });

  return fresh;
}
 
export const getIndexHistory = createServerFn({ method: "GET" })
  .inputValidator((d: { symbol: string; range: "1M" | "1A" | "3A" | "5A" | "10A" }) =>
    z
      .object({
        symbol: z.string().min(1),
        range: z.enum(["1M", "1A", "3A", "5A", "10A"]),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<Candle[]> => {
    const days =
      data.range === "1M"
        ? 31
        : data.range === "1A"
          ? 366
          : data.range === "3A"
            ? 366 * 3
            : data.range === "5A"
              ? 366 * 5
              : 366 * 10;
    const cutoff = Date.now() - days * 86400_000;

    // FMP free/Starter plan only guarantees ~5 years, so for 3A/5A/10A we prefer the
    // Twelve Data + Supabase cache path (full history since listing, no extra cost) and
    // fall back to FMP if that's unavailable.
    let all: Candle[] | null = null;
    if (data.range === "3A" || data.range === "5A" || data.range === "10A") {
      all = await getCachedLongHistory(data.symbol);
    }
    if (!all || all.length === 0) {
      const raw = await fmp<any[]>(
        `/historical-price-eod/full?symbol=${encodeURIComponent(data.symbol)}`,
      );
      all = (raw ?? [])
        .map((r) => ({
          date: String(r.date),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
        }))
        .reverse();
    }

    return all.filter((r) => new Date(r.date).getTime() >= cutoff);
  });
 
// ---------- Market news (Yahoo Finance RSS — FMP news endpoint restricted, Google News blocks article links) ----------
export type NewsItem = { title: string; source: string; url: string; publishedAt: string };
 
export const getMarketNews = createServerFn({ method: "GET" }).handler(
  async (): Promise<NewsItem[]> => {
const parseRss = (xml: string): NewsItem[] => {
      const items: NewsItem[] = [];
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      const tag = (block: string, name: string) => {
        const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
        return m ? m[1].replace(/<!\[CDATA\[(.*?)\]\]>/s, "$1").trim() : "";
      };
      let m;
      while ((m = itemRe.exec(xml))) {
        const block = m[1];
        const title = tag(block, "title");
        const link = tag(block, "link");
        const pub = tag(block, "pubDate");
        const source = tag(block, "source") || "Yahoo Finance";
        const pubMs = new Date(pub).getTime();
        if (!title || !link || !isFinite(pubMs)) continue;
        if (Date.now() - pubMs > 4 * 24 * 60 * 60 * 1000) continue;
        items.push({ title, source, url: link, publishedAt: pub });
      }
      items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      return items.slice(0, 5);
    };
 
    const sources = [
      "https://finance.yahoo.com/news/rssindex",
      "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    ];
 
    for (const src of sources) {
      try {
        const res = await fetch(src, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) continue;
        const xml = await res.text();
        const items = parseRss(xml);
        if (items.length) return items;
      } catch {
        // try next source
      }
    }
    return [];
  },
);
 
// ---------- Stock fundamentals cache (7 days) ----------
// Income statement, cash flow, balance sheet, key metrics, profile and analyst estimates
// only change quarterly at most. Caching them for 7 days means cost scales with unique
// tickers viewed per week, not with visitor count — the same Apple page can be viewed
// 100,000 times in a week and only cost ~6 FMP calls total instead of 600,000.
type RawFundamentals = {
  quoteArr: any[];
  profileArr: any[];
  incomeArr: any[];
  cashArr: any[];
  balanceArr: any[];
  keyMetricsArr: any[];
  estimatesArr: any[];
  ratiosArr: any[];
};

const FUNDAMENTALS_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days

async function fetchFundamentalsFromFmp(ticker: string): Promise<RawFundamentals> {
  const [profileArr, incomeArr, cashArr, balanceArr, keyMetricsArr, estimatesArr, ratiosArr] =
    await Promise.all([
      fmp<any[]>(`/profile?symbol=${ticker}`),
      fmp<any[]>(`/income-statement?symbol=${ticker}&limit=5`),
      fmp<any[]>(`/cash-flow-statement?symbol=${ticker}&limit=5`),
      fmp<any[]>(`/balance-sheet-statement?symbol=${ticker}&limit=1`),
      fmp<any[]>(`/key-metrics?symbol=${ticker}&limit=1`).catch(() => []),
      fmp<any[]>(`/analyst-estimates?symbol=${ticker}&period=annual`).catch(() => []),
      fmp<any[]>(`/ratios?symbol=${ticker}&limit=1`).catch(() => []),
    ]);
  // quote is fetched separately (always fresh) — store an empty array here, caller fills it in.
  return { quoteArr: [], profileArr, incomeArr, cashArr, balanceArr, keyMetricsArr, estimatesArr, ratiosArr };
}

async function getCachedFundamentals(ticker: string): Promise<RawFundamentals> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin
    .from("stock_fundamentals_cache")
    .select("payload, updated_at")
    .eq("ticker", ticker)
    .maybeSingle();

  const isFresh = row && Date.now() - new Date(row.updated_at).getTime() < FUNDAMENTALS_TTL_MS;
  if (isFresh) return row.payload as RawFundamentals;

  try {
    const fresh = await fetchFundamentalsFromFmp(ticker);
    await supabaseAdmin
      .from("stock_fundamentals_cache")
      .upsert(
        { ticker, payload: fresh, updated_at: new Date().toISOString() },
        { onConflict: "ticker" },
      );
    return fresh;
  } catch (err) {
    // FMP failed (rate-limited, network issue) — serve stale cache if we have any, since
    // fundamentals barely change week to week and a stale view beats a broken page.
    if (row) return row.payload as RawFundamentals;
    throw err;
  }
}


// ---------- SEC EDGAR (free, official, no API key, 10+ years of history) ----------
// Used only to extend the Revenue/FCF history chart beyond the ~5 years FMP's plan allows.
// All other figures (current FCF, debt, cash, shares, growth estimates) still come from FMP.
const EDGAR_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days — annual filings barely change
const EDGAR_HEADERS = { "User-Agent": "ValueScope contact@valuescope.app" };

let tickerToCikCache: Record<string, string> | null = null;
let tickerToCikPromise: Promise<Record<string, string>> | null = null;
async function getCikForTicker(ticker: string): Promise<string | null> {
  if (!tickerToCikCache) {
    // Share the in-flight request so concurrent callers (history + balance snapshot, which
    // now run in parallel) don't each trigger their own fetch of this large file.
    if (!tickerToCikPromise) {
      tickerToCikPromise = (async () => {
        const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
          headers: EDGAR_HEADERS,
        });
        if (!res.ok) return {};
        const json = await res.json();
        const map: Record<string, string> = {};
        for (const row of Object.values(json) as any[]) {
          if (row?.ticker)
            map[String(row.ticker).toUpperCase()] = String(row.cik_str).padStart(10, "0");
        }
        return map;
      })();
    }
    tickerToCikCache = await tickerToCikPromise;
  }
  return tickerToCikCache[ticker.toUpperCase()] ?? null;
}

// Different companies tag the same line item with different XBRL concepts — try each in order.
const REVENUE_TAGS = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
];
const OPERATING_CF_TAGS = ["NetCashProvidedByUsedInOperatingActivities"];
const CAPEX_TAGS = [
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "PaymentsToAcquireProductiveAssets", // Amazon (and a few others) use this since FY2016
  "PaymentsForCapitalImprovements",
];

async function fetchEdgarConcept(cik: string, tags: string[]): Promise<Map<number, number>> {
  // Returns a map of period-year -> value, using the first tag that has data for each year.
  const out = new Map<number, { val: number; filed: string }>();
  for (const tag of tags) {
    try {
      const res = await fetch(
        `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`,
        { headers: EDGAR_HEADERS },
      );
      if (!res.ok) continue;
      const json = await res.json();
      const usd = json?.units?.USD;
      if (!Array.isArray(usd)) continue;
      for (const entry of usd) {
        // Only full-year 10-K figures (skip quarterly 10-Qs).
        // IMPORTANT: the `fy` field is the *filing's* fiscal year label, not necessarily the
        // year the figure covers — a 10-K commonly repeats prior-year comparatives under the
        // same `fy`. The period's `end` date is the reliable way to know which year a duration
        // fact actually belongs to.
        if (entry.form !== "10-K" || entry.fp !== "FY") continue;
        const end = String(entry.end ?? "");
        const year = Number(end.slice(0, 4));
        if (!year) continue;
        const filed = String(entry.filed ?? "");
        const existing = out.get(year);
        // Companies sometimes restate prior years in later filings — keep the most recently
        // filed value for each year rather than just the first one encountered.
        if (!existing || filed > existing.filed) {
          out.set(year, { val: Number(entry.val), filed });
        }
      }
    } catch {
      // try next tag
    }
  }
  const simple = new Map<number, number>();
  for (const [year, { val }] of out) simple.set(year, val);
  return simple;
}

// ---------- Quarterly EDGAR parsing ----------
// 10-Q "duration" facts (Revenue, Operating Cash Flow, CAPEX) are commonly reported
// year-to-date rather than as an isolated quarter — e.g. a company's Q3 10-Q often
// discloses revenue for the trailing 9 months, not just the 3 months of Q3. The `fp`
// field ("Q1"/"Q2"/"Q3"/"FY") is filer-supplied and not a reliable signal of which shape
// a given fact has, and is sometimes missing on older filings. The robust signal is the
// fact's own reported duration: end-date minus start-date.
const DAY_MS = 86_400_000;
function durationDays(start: string, end: string): number {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!isFinite(s) || !isFinite(e)) return NaN;
  return Math.round((e - s) / DAY_MS);
}

type AccumPeriod = "Q" | "H1" | "9M" | "FY";

// One fiscal year's worth of duration buckets, keyed by what the fact actually covers.
// "Q" entries are keyed further by which quarter (1-4) once we know start month.
type YearBuckets = {
  q?: Map<number, { val: number; filed: string }>; // isolated quarter -> quarter number
  h1?: { val: number; filed: string };
  ninemonths?: { val: number; filed: string };
  fy?: { val: number; filed: string };
};

// Classify a single fact by its real duration and file it under the fiscal year its
// `end` date falls in. Quarter number is inferred from how many quarters separate
// `start` from the most recent fiscal-year start we've seen for this concept — but since
// we don't always know the fiscal year boundary up front, we instead key isolated quarters
// by their `end` month distance from `start`, then sort/assign Q1..Q4 per year afterward
// based on chronological order within that year.
function classifyFact(entry: any): { year: number; kind: AccumPeriod; val: number; filed: string; end: string; start: string } | null {
  const start = String(entry.start ?? "");
  const end = String(entry.end ?? "");
  if (!start || !end) return null; // instant facts or malformed — skip
  const days = durationDays(start, end);
  if (!isFinite(days)) return null;
  const year = Number(end.slice(0, 4));
  if (!year) return null;
  const filed = String(entry.filed ?? "");
  const val = Number(entry.val);
  if (!isFinite(val)) return null;

  // Only accept facts from 10-Q or 10-K — skip 8-Ks, S-1s, amendments' duplicate contexts, etc.
  if (entry.form !== "10-Q" && entry.form !== "10-K") return null;

  if (days >= 60 && days <= 120) return { year, kind: "Q", val, filed, end, start };
  if (days >= 150 && days <= 210) return { year, kind: "H1", val, filed, end, start };
  if (days >= 240 && days <= 300) return { year, kind: "9M", val, filed, end, start };
  if (days >= 340 && days <= 390 && entry.form === "10-K") return { year, kind: "FY", val, filed, end, start };
  return null; // unrecognized duration (stub period, odd fiscal change) — skip rather than guess
}

export type QuarterPoint = { year: number; quarter: 1 | 2 | 3 | 4; revenue: number; fcf: number };

// Builds per-quarter Revenue/OperatingCF/CAPEX maps for one XBRL concept across all its tags,
// keeping the most-recently-filed value whenever a period is reported more than once
// (restatements), exactly like the annual fetchEdgarConcept does.
async function fetchEdgarConceptByPeriod(cik: string, tags: string[]) {
  // year -> bucket of accumulated/isolated facts
  const years = new Map<number, YearBuckets>();
  // Track isolated quarters separately with their start date so we can later sort them
  // chronologically within a fiscal year (quarter 1..4) without relying on `fp`.
  const isolatedByYear = new Map<number, { start: string; end: string; val: number; filed: string }[]>();

  for (const tag of tags) {
    try {
      const res = await fetch(
        `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`,
        { headers: EDGAR_HEADERS },
      );
      if (!res.ok) continue;
      const json = await res.json();
      const usd = json?.units?.USD;
      if (!Array.isArray(usd)) continue;

      for (const entry of usd) {
        const c = classifyFact(entry);
        if (!c) continue;
        if (c.kind === "Q") {
          const list = isolatedByYear.get(c.year) ?? [];
          list.push({ start: c.start, end: c.end, val: c.val, filed: c.filed });
          isolatedByYear.set(c.year, list);
          continue;
        }
        const bucket = years.get(c.year) ?? {};
        const key = c.kind === "H1" ? "h1" : c.kind === "9M" ? "ninemonths" : "fy";
        const existing = bucket[key];
        if (!existing || c.filed > existing.filed) {
          bucket[key] = { val: c.val, filed: c.filed };
        }
        years.set(c.year, bucket);
      }
    } catch {
      // try next tag
    }
  }

  // De-duplicate isolated quarters (restatements) by (start,end) window, keep latest filed.
  const dedupedIsolated = new Map<number, Map<string, { start: string; end: string; val: number; filed: string }>>();
  for (const [year, list] of isolatedByYear) {
    const byWindow = new Map<string, { start: string; end: string; val: number; filed: string }>();
    for (const item of list) {
      const k = `${item.start}|${item.end}`;
      const existing = byWindow.get(k);
      if (!existing || item.filed > existing.filed) byWindow.set(k, item);
    }
    dedupedIsolated.set(year, byWindow);
    years.set(year, years.get(year) ?? {});
  }

  return { years, dedupedIsolated };
}

// Reconstructs Q1..Q4 isolated values for one fiscal year from whatever combination of
// isolated-quarter and accumulated (H1/9M/FY) facts is available. Returns null for any
// quarter we can't derive — callers should treat null as "no data" rather than guess.
function reconstructQuarters(
  year: number,
  bucket: YearBuckets,
  isolated: Map<string, { start: string; end: string; val: number; filed: string }> | undefined,
): (number | null)[] {
  // Sort isolated quarters chronologically by start date — this is how we assign them to
  // Q1..Q4 without depending on the filer-supplied `fp` label.
  const sortedIsolated = Array.from(isolated?.values() ?? []).sort((a, b) =>
    a.start.localeCompare(b.start),
  );
  const q: (number | null)[] = [null, null, null, null];
  sortedIsolated.slice(0, 4).forEach((item, i) => {
    q[i] = item.val;
  });

  const h1 = bucket.h1?.val ?? null;
  const ninemonths = bucket.ninemonths?.val ?? null;
  const fy = bucket.fy?.val ?? null;

  // Q1: prefer isolated; otherwise unknown (H1/9M alone can't isolate Q1).
  // Q2 = H1 - Q1, when both are known.
  if (q[1] == null && h1 != null && q[0] != null) q[1] = h1 - q[0];
  // Q3 = 9M - H1 (best), else 9M - Q1 - Q2 if H1 itself wasn't reported separately.
  if (q[2] == null && ninemonths != null) {
    if (h1 != null) q[2] = ninemonths - h1;
    else if (q[0] != null && q[1] != null) q[2] = ninemonths - q[0] - q[1];
  }
  // Q4 = FY - 9M (best), else FY - H1 - Q3, else FY - Q1 - Q2 - Q3.
  if (q[3] == null && fy != null) {
    if (ninemonths != null) q[3] = fy - ninemonths;
    else if (h1 != null && q[2] != null) q[3] = fy - h1 - q[2];
    else if (q[0] != null && q[1] != null && q[2] != null) q[3] = fy - q[0] - q[1] - q[2];
  }

  return q;
}

// Balance sheet items (debt, cash) are point-in-time "instant" facts, not period totals.
// We want the single most recent reported value, from any filing (10-K or 10-Q).
async function fetchEdgarLatestInstant(cik: string, tags: string[]): Promise<number | null> {
  for (const tag of tags) {
    try {
      const res = await fetch(
        `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`,
        { headers: EDGAR_HEADERS },
      );
      if (!res.ok) continue;
      const json = await res.json();
      const usd = json?.units?.USD;
      if (!Array.isArray(usd) || usd.length === 0) continue;
      const sorted = usd.slice().sort((a: any, b: any) => String(b.end).localeCompare(String(a.end)));
      const latest = sorted[0];
      if (latest && latest.val != null) return Number(latest.val);
    } catch {
      // try next tag
    }
  }
  return null;
}

// Annual counterpart of fetchEdgarLatestInstant — for balance-sheet "instant" facts
// (no `start`, just `end`), returns one value per fiscal year: the value as reported at
// that year's fiscal year-end (the 10-K balance-sheet date), not a mid-year snapshot.

const LONG_TERM_DEBT_TAGS = ["LongTermDebtNoncurrent", "LongTermDebt"];
const SHORT_TERM_DEBT_TAGS = [
  "LongTermDebtCurrent",
  "ShortTermBorrowings",
  "DebtCurrent",
];
const CASH_TAGS = [
  "CashAndCashEquivalentsAtCarryingValue",
  "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
];
const SHARES_OUTSTANDING_TAGS = ["CommonStockSharesOutstanding"];

type EdgarBalanceSnapshot = {
  totalDebt: number | null;
  cash: number | null;
  sharesOutstanding: number | null;
};

async function fetchEdgarBalanceSnapshot(ticker: string): Promise<EdgarBalanceSnapshot | null> {
  const cik = await getCikForTicker(ticker);
  if (!cik) return null;
  const [longTermDebt, shortTermDebt, cash, shares] = await Promise.all([
    fetchEdgarLatestInstant(cik, LONG_TERM_DEBT_TAGS),
    fetchEdgarLatestInstant(cik, SHORT_TERM_DEBT_TAGS),
    fetchEdgarLatestInstant(cik, CASH_TAGS),
    fetchEdgarLatestInstant(cik, SHARES_OUTSTANDING_TAGS),
  ]);
  const totalDebt =
    longTermDebt != null || shortTermDebt != null ? (longTermDebt ?? 0) + (shortTermDebt ?? 0) : null;
  return { totalDebt, cash, sharesOutstanding: shares };
}

type EdgarHistory = { year: number; revenue: number; fcf: number }[];

async function fetchEdgarHistoryFresh(ticker: string): Promise<EdgarHistory | null> {
  const cik = await getCikForTicker(ticker);
  if (!cik) return null;
  const [revenue, opCf, capex] = await Promise.all([
    fetchEdgarConcept(cik, REVENUE_TAGS),
    fetchEdgarConcept(cik, OPERATING_CF_TAGS),
    fetchEdgarConcept(cik, CAPEX_TAGS),
  ]);
  if (revenue.size === 0) return null;
  // If we found revenue but no CAPEX at all, none of our known tags matched this filer's
  // taxonomy — silently treating missing CAPEX as 0 would inflate FCF (= OperatingCF - 0).
  // Safer to bail out and let the caller fall back to FMP's pre-calculated FCF instead.
  if (capex.size === 0) return null;

  const years = Array.from(revenue.keys()).sort((a, b) => a - b);
  const last10 = years.slice(-10);
  return last10.map((year) => {
    const op = opCf.get(year) ?? 0;
    const cap = Math.abs(capex.get(year) ?? 0);
    return { year, revenue: revenue.get(year) ?? 0, fcf: op - cap };
  });
}

// Quarterly counterpart of fetchEdgarHistoryFresh. EDGAR's 10-Q coverage is shallower than
// 10-K coverage (companies only have to keep quarterly XBRL for as long as the SEC's
// retention/their own filing history goes back, typically a handful of years vs 10-K's
// decade+), so this naturally returns fewer periods than the annual series — that's expected,
// not a bug, and the caller/UI should treat "less history available" as the normal case here.
async function fetchEdgarHistoryQuarterlyFresh(ticker: string): Promise<QuarterPoint[] | null> {
  const cik = await getCikForTicker(ticker);
  if (!cik) return null;

  const [revenueParts, opCfParts, capexParts] = await Promise.all([
    fetchEdgarConceptByPeriod(cik, REVENUE_TAGS),
    fetchEdgarConceptByPeriod(cik, OPERATING_CF_TAGS),
    fetchEdgarConceptByPeriod(cik, CAPEX_TAGS),
  ]);

  const allYears = new Set<number>([
    ...revenueParts.years.keys(),
    ...revenueParts.dedupedIsolated.keys(),
  ]);
  if (allYears.size === 0) return null;

  const out: QuarterPoint[] = [];
  for (const year of Array.from(allYears).sort((a, b) => a - b)) {
    const revQ = reconstructQuarters(
      year,
      revenueParts.years.get(year) ?? {},
      revenueParts.dedupedIsolated.get(year),
    );
    const opQ = reconstructQuarters(
      year,
      opCfParts.years.get(year) ?? {},
      opCfParts.dedupedIsolated.get(year),
    );
    const capQ = reconstructQuarters(
      year,
      capexParts.years.get(year) ?? {},
      capexParts.dedupedIsolated.get(year),
    );

    for (let i = 0; i < 4; i++) {
      const rev = revQ[i];
      const op = opQ[i];
      const cap = capQ[i];
      // Skip a quarter entirely if we couldn't derive revenue — a chart point with no
      // revenue isn't useful even if FCF happened to be derivable.
      if (rev == null) continue;
      const fcf = op != null ? op - Math.abs(cap ?? 0) : 0;
      out.push({ year, quarter: (i + 1) as 1 | 2 | 3 | 4, revenue: rev, fcf });
    }
  }

  // Keep only the most recent ~40 quarters (10 years) to match the annual series' window
  // and avoid handing the client an unbounded list for long-listed companies.
  return out.slice(-40);
}

type CachedEdgarHistory = { annual: EdgarHistory; quarterly: QuarterPoint[] };

async function getCachedEdgarHistory(ticker: string): Promise<CachedEdgarHistory | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin
    .from("edgar_history_cache")
    .select("history, updated_at")
    .eq("ticker", ticker)
    .maybeSingle();

  // Older cache rows predate the {annual, quarterly} shape (they stored a bare array).
  // Treat those as a miss so they get recomputed once into the new shape — cheap since
  // EDGAR is free, and this only happens once per ticker after the rollout.
  const cached = row?.history as CachedEdgarHistory | EdgarHistory | undefined;
  const isNewShape =
    cached && typeof cached === "object" && !Array.isArray(cached) && "annual" in cached;

  const isFresh = row && Date.now() - new Date(row.updated_at).getTime() < EDGAR_TTL_MS;
  if (isFresh && isNewShape) return cached as CachedEdgarHistory;

  try {
    const [annual, quarterly] = await Promise.all([
      fetchEdgarHistoryFresh(ticker),
      fetchEdgarHistoryQuarterlyFresh(ticker).catch(() => null),
    ]);
    if (annual && annual.length > 0) {
      const fresh: CachedEdgarHistory = { annual, quarterly: quarterly ?? [] };
      await supabaseAdmin
        .from("edgar_history_cache")
        .upsert(
          { ticker, history: fresh, updated_at: new Date().toISOString() },
          { onConflict: "ticker" },
        );
      return fresh;
    }
    // Fresh fetch failed but we have an old-shape or stale row — salvage what we can.
    if (isNewShape) return cached as CachedEdgarHistory;
    if (cached && Array.isArray(cached)) return { annual: cached, quarterly: [] };
    return null;
  } catch {
    if (isNewShape) return cached as CachedEdgarHistory;
    if (cached && Array.isArray(cached)) return { annual: cached, quarterly: [] };
    return null;
  }
}


export type StockData = {
  ticker: string;
  companyName: string;
  exchange: string;
  currency: string;
  price: number;
  changePercent: number;
  logoUrl: string | null;
  freeCashFlow: number;
  operatingCashFlow: number;
  capex: number;
  meanCapex4y: number;
  fcfAdjusted: number;
  totalDebt: number;
  cash: number;
  sharesOutstanding: number;
  peRatio: number | null;
  peNtm: number | null;
  roic: number | null;
  baseGrowthRate: number;
  history: { year: number; revenue: number; fcf: number }[];
  warnings: string[];
  // Valuation
  marketCap: number | null;
  priceToSales: number | null;
  evToEBITDA: number | null;
  priceToBook: number | null;
  // Cash Flow
  freeCashFlowYield: number | null;
  freeCashFlowPerShare: number | null;
  // Margins & Growth
  netProfitMargin: number | null;
  operatingProfitMargin: number | null;
  revenueGrowthYoY: number | null;
  netIncomeGrowthYoY: number | null;
  // Dividend
  dividendYield: number | null;
  dividendPayoutRatio: number | null;
};
 
export const getStockData = createServerFn({ method: "GET" })
  .inputValidator((d: { ticker: string }) =>
    z.object({ ticker: z.string().min(1).max(15) }).parse(d),
  )
  .handler(async ({ data }): Promise<StockData> => {
    const t = data.ticker.toUpperCase();
    const warnings: string[] = [];

    const [quoteArr, fundamentals, edgarBalance] = await Promise.all([
      fmp<any[]>(`/quote?symbol=${t}`), // always fresh — price changes constantly
      getCachedFundamentals(t), // cached up to 7 days — income/cashflow/balance/profile/estimates
      fetchEdgarBalanceSnapshot(t).catch(() => null), // free EDGAR debt/cash — affects the DCF, needed now
      // Note: the 10-year revenue/FCF history chart is fetched separately via getStockHistory()
      // so the slower SEC EDGAR roundtrip never blocks the main page (price, DCF, metrics).
    ]);
    const { profileArr, incomeArr, cashArr, balanceArr, keyMetricsArr, estimatesArr, ratiosArr } = fundamentals;
 
    if (!quoteArr?.length) throw new Error("Ticker não encontrado");
    const quote = quoteArr[0];
    const profile = profileArr?.[0] ?? {};
    const cash0 = cashArr?.[0];
    const balance0 = balanceArr?.[0];
    if (!cash0 || !balance0) throw new Error("Dados financeiros indisponíveis");
 
    const freeCashFlow = Number(cash0.freeCashFlow ?? 0);
    const operatingCashFlow = Number(cash0.operatingCashFlow ?? 0);
    const capex = Math.abs(Number(cash0.capitalExpenditure ?? 0));
    const last4 = cashArr.slice(0, 4);
    const meanCapex4y =
      last4.length > 0
        ? last4.reduce((s, c) => s + Math.abs(Number(c.capitalExpenditure ?? 0)), 0) / last4.length
        : capex;
    const fcfAdjusted = operatingCashFlow - meanCapex4y;
 
const rawTotalDebt = balance0.totalDebt;
    const fmpTotalDebt =
      typeof rawTotalDebt === "number" && rawTotalDebt > 0
        ? rawTotalDebt
        : typeof rawTotalDebt === "string" && Number(rawTotalDebt) > 0
          ? Number(rawTotalDebt)
          : Number(balance0.shortTermDebt ?? 0) + Number(balance0.longTermDebt ?? 0);
    const fmpCashBs = Number(
      balance0.cashAndShortTermInvestments ?? balance0.cashAndCashEquivalents ?? 0,
    );

    // Prefer SEC EDGAR for debt/cash when available — it's the free, official, primary source
    // and avoids relying on FMP's pre-aggregated totalDebt field (which we've seen be
    // inconsistent in the past). Falls back to FMP's figures for non-US filers or on failure.
    const totalDebt = edgarBalance?.totalDebt ?? fmpTotalDebt;
    const cashBs = edgarBalance?.cash ?? fmpCashBs;

    const sharesOutstanding =
      Number(quote.marketCap && quote.price ? quote.marketCap / quote.price : 0) ||
      Number(profile.mktCap && quote.price ? profile.mktCap / quote.price : 0) ||
      Number(keyMetricsArr?.[0]?.sharesOutstanding) ||
      Number(quote.sharesOutstanding);

    if (!sharesOutstanding) throw new Error("Número de ações indisponível");
 
   // Growth rate from analyst estimates: avg of next ~5y EPS growth
    // (Finviz/Zacks/GF "5-year growth rate" is typically EPS-based, not revenue-based)
    let baseGrowthRate = 0;
    const epsEst = (e: any) =>
      Number(e.epsAvg ?? e.estimatedEpsAvg ?? 0);
    const revEst = (e: any) =>
      Number(e.revenueAvg ?? e.estimatedRevenueAvg ?? e.revenueHigh ?? 0);
    if (Array.isArray(estimatesArr) && estimatesArr.length) {
      const currentYear = new Date().getFullYear();
      const future = estimatesArr
        .filter((e) => {
          const y = Number(String(e.date ?? "").slice(0, 4));
          return y >= currentYear && y <= currentYear + 5;
        })
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
 
      const futureEps = future.filter((e) => epsEst(e) > 0);
      if (futureEps.length >= 2) {
        const rates: number[] = [];
        for (let i = 1; i < futureEps.length; i++) {
          const prev = epsEst(futureEps[i - 1]);
          const curr = epsEst(futureEps[i]);
          if (prev > 0 && curr > 0) rates.push(curr / prev - 1);
        }
        if (rates.length) baseGrowthRate = rates.reduce((a, b) => a + b, 0) / rates.length;
      }
      if (!baseGrowthRate || !isFinite(baseGrowthRate)) {
        const futureRev = future.filter((e) => revEst(e) > 0);
        if (futureRev.length >= 2) {
          const rates: number[] = [];
          for (let i = 1; i < futureRev.length; i++) {
            const prev = revEst(futureRev[i - 1]);
            const curr = revEst(futureRev[i]);
            if (prev > 0 && curr > 0) rates.push(curr / prev - 1);
          }
          if (rates.length) baseGrowthRate = rates.reduce((a, b) => a + b, 0) / rates.length;
        }
      }
    }

    // PE NTM (next twelve months) — current price divided by the next fiscal year's
    // estimated EPS, using the same analyst estimates already fetched for the growth rate.
    let peNtm: number | null = null;
    if (Array.isArray(estimatesArr) && estimatesArr.length) {
      const currentYear = new Date().getFullYear();
      const nextYearEstimates = estimatesArr
        .filter((e: any) => {
          const y = Number(String(e.date ?? "").slice(0, 4));
          return y >= currentYear && epsEst(e) > 0;
        })
        .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
      const nextEps = nextYearEstimates[0] ? epsEst(nextYearEstimates[0]) : 0;
      if (nextEps > 0 && quote.price) {
        peNtm = Number(quote.price) / nextEps;
      }
    }

    if (freeCashFlow < 0)
      warnings.push("FCF negativo — o cálculo pode não ser fiável.");
 
    const fmpHistory = incomeArr
      .slice()
      .reverse()
      .map((inc) => {
        const year = Number(String(inc.date ?? "").slice(0, 4)) || 0;
        const matchingCash = cashArr.find((c) => String(c.date).slice(0, 4) === String(year));
        return {
          year,
          revenue: Number(inc.revenue ?? 0),
          fcf: Number(matchingCash?.freeCashFlow ?? 0),
        };
      })
      .filter((h) => h.year > 0);

    // Use SEC EDGAR if it has more years than FMP's plan provides (typically true for US
    // filers); falls back to FMP's ~5 years for non-US tickers or if EDGAR fails.
    const history = fmpHistory;
 
    const ratios0 = ratiosArr?.[0] ?? {};
    const km0 = keyMetricsArr?.[0] ?? {};

    // YoY growth from the two most recent annual income statements (incomeArr is newest-first).
    const revenueGrowthYoY =
      incomeArr.length >= 2 && Number(incomeArr[1].revenue) > 0
        ? (Number(incomeArr[0].revenue) - Number(incomeArr[1].revenue)) / Number(incomeArr[1].revenue)
        : null;
    const netIncomeGrowthYoY =
      incomeArr.length >= 2 && Number(incomeArr[1].netIncome) !== 0
        ? (Number(incomeArr[0].netIncome) - Number(incomeArr[1].netIncome)) /
          Math.abs(Number(incomeArr[1].netIncome))
        : null;

    return {
      ticker: t,
      companyName: profile.companyName ?? quote.name ?? t,
      exchange: profile.exchangeShortName ?? quote.exchange ?? "",
      currency: profile.currency ?? "USD",
      price: Number(quote.price ?? 0),
      changePercent: Number(quote.changePercentage ?? quote.changesPercentage ?? 0),
      logoUrl: profile.image || null,
      freeCashFlow,
      operatingCashFlow,
      capex,
      meanCapex4y,
      fcfAdjusted,
      totalDebt,
      cash: cashBs,
      sharesOutstanding,
      peRatio: ratios0.priceToEarningsRatio != null ? Number(ratios0.priceToEarningsRatio) : null,
      peNtm,
      roic: km0.roic != null ? Number(km0.roic) : null,
      baseGrowthRate,
      history,
      warnings,
      marketCap: km0.marketCap != null ? Number(km0.marketCap) : (quote.marketCap ?? null),
      priceToSales: ratios0.priceToSalesRatio != null ? Number(ratios0.priceToSalesRatio) : null,
      evToEBITDA: km0.evToEBITDA != null ? Number(km0.evToEBITDA) : null,
      priceToBook: ratios0.priceToBookRatio != null ? Number(ratios0.priceToBookRatio) : null,
      freeCashFlowYield: km0.freeCashFlowYield != null ? Number(km0.freeCashFlowYield) : null,
      freeCashFlowPerShare:
        ratios0.freeCashFlowPerShare != null ? Number(ratios0.freeCashFlowPerShare) : null,
      netProfitMargin: ratios0.netProfitMargin != null ? Number(ratios0.netProfitMargin) : null,
      operatingProfitMargin:
        ratios0.operatingProfitMargin != null ? Number(ratios0.operatingProfitMargin) : null,
      revenueGrowthYoY,
      netIncomeGrowthYoY,
      dividendYield: ratios0.dividendYield != null ? Number(ratios0.dividendYield) : null,
      dividendPayoutRatio:
        ratios0.dividendPayoutRatio != null ? Number(ratios0.dividendPayoutRatio) : null,
    };
  });

// ---------- Stock history (lazy-loaded, separate from getStockData) ----------
// Fetched on-demand by the chart component after the main page has already rendered,
// so the slower SEC EDGAR roundtrip never delays price/DCF/metrics from showing up.
//
// `quarterly` comes exclusively from SEC EDGAR. FMP's quarterly income-statement/cash-flow
// endpoints exist but are capped by the same `limit=5` plan restriction that affects the
// annual endpoints — at most ~1 year of quarters, not enough for a useful chart — so there's
// no FMP fallback for the quarterly series the way there is for annual. Companies that don't
// file 10-Qs with the SEC (non-US filers) will simply get an empty `quarterly` array; the UI
// should treat that as "quarterly view unavailable for this ticker", not as an error.
export type StockHistoryResponse = {
  annual: { year: number; revenue: number; fcf: number }[];
  quarterly: QuarterPoint[];
};

export const getStockHistory = createServerFn({ method: "GET" })
  .inputValidator((d: { ticker: string }) =>
    z.object({ ticker: z.string().min(1).max(15) }).parse(d),
  )
  .handler(async ({ data }): Promise<StockHistoryResponse> => {
    const t = data.ticker.toUpperCase();

    const [fundamentals, edgarHistory] = await Promise.all([
      getCachedFundamentals(t), // same 7-day cache getStockData uses — no extra FMP cost
      getCachedEdgarHistory(t).catch(() => null),
    ]);
    const { incomeArr, cashArr } = fundamentals;

    const fmpAnnual = incomeArr
      .slice()
      .reverse()
      .map((inc: any) => {
        const year = Number(String(inc.date ?? "").slice(0, 4)) || 0;
        const matchingCash = cashArr.find((c: any) => String(c.date).slice(0, 4) === String(year));
        return {
          year,
          revenue: Number(inc.revenue ?? 0),
          fcf: Number(matchingCash?.freeCashFlow ?? 0),
        };
      })
      .filter((h) => h.year > 0);

    // Prefer SEC EDGAR's annual series when it covers more years than FMP's plan allows.
    const edgarAnnual = edgarHistory?.annual ?? null;
    const annual = edgarAnnual && edgarAnnual.length > fmpAnnual.length ? edgarAnnual : fmpAnnual;

    return { annual, quarterly: edgarHistory?.quarterly ?? [] };
  });
