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
};

const FUNDAMENTALS_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days

async function fetchFundamentalsFromFmp(ticker: string): Promise<RawFundamentals> {
  const [profileArr, incomeArr, cashArr, balanceArr, keyMetricsArr, estimatesArr] =
    await Promise.all([
      fmp<any[]>(`/profile?symbol=${ticker}`),
      fmp<any[]>(`/income-statement?symbol=${ticker}&limit=5`),
      fmp<any[]>(`/cash-flow-statement?symbol=${ticker}&limit=5`),
      fmp<any[]>(`/balance-sheet-statement?symbol=${ticker}&limit=1`),
      fmp<any[]>(`/key-metrics?symbol=${ticker}&limit=1`).catch(() => []),
      fmp<any[]>(`/analyst-estimates?symbol=${ticker}&period=annual`).catch(() => []),
    ]);
  // quote is fetched separately (always fresh) — store an empty array here, caller fills it in.
  return { quoteArr: [], profileArr, incomeArr, cashArr, balanceArr, keyMetricsArr, estimatesArr };
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
async function getCikForTicker(ticker: string): Promise<string | null> {
  if (!tickerToCikCache) {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: EDGAR_HEADERS,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const map: Record<string, string> = {};
    for (const row of Object.values(json) as any[]) {
      if (row?.ticker) map[String(row.ticker).toUpperCase()] = String(row.cik_str).padStart(10, "0");
    }
    tickerToCikCache = map;
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
  "PaymentsForCapitalImprovements",
];

async function fetchEdgarConcept(cik: string, tags: string[]): Promise<Map<number, number>> {
  // Returns a map of fiscal year -> value, using the first tag that has data for each year.
  const out = new Map<number, number>();
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
        // Only full-year 10-K figures, one per fiscal year (skip quarterly 10-Qs).
        if (entry.form !== "10-K" || entry.fp !== "FY") continue;
        const fy = Number(entry.fy);
        if (!fy) continue;
        if (!out.has(fy)) out.set(fy, Number(entry.val));
      }
    } catch {
      // try next tag
    }
  }
  return out;
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

  const years = Array.from(revenue.keys()).sort((a, b) => a - b);
  const last10 = years.slice(-10);
  return last10.map((year) => {
    const op = opCf.get(year) ?? 0;
    const cap = Math.abs(capex.get(year) ?? 0);
    return { year, revenue: revenue.get(year) ?? 0, fcf: op - cap };
  });
}

async function getCachedEdgarHistory(ticker: string): Promise<EdgarHistory | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin
    .from("edgar_history_cache")
    .select("history, updated_at")
    .eq("ticker", ticker)
    .maybeSingle();

  const isFresh = row && Date.now() - new Date(row.updated_at).getTime() < EDGAR_TTL_MS;
  if (isFresh) return row.history as EdgarHistory;

  try {
    const fresh = await fetchEdgarHistoryFresh(ticker);
    if (fresh && fresh.length > 0) {
      await supabaseAdmin
        .from("edgar_history_cache")
        .upsert(
          { ticker, history: fresh, updated_at: new Date().toISOString() },
          { onConflict: "ticker" },
        );
      return fresh;
    }
    return row ? (row.history as EdgarHistory) : null;
  } catch {
    return row ? (row.history as EdgarHistory) : null;
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
  roic: number | null;
  baseGrowthRate: number;
  history: { year: number; revenue: number; fcf: number }[];
  warnings: string[];
};
 
export const getStockData = createServerFn({ method: "GET" })
  .inputValidator((d: { ticker: string }) =>
    z.object({ ticker: z.string().min(1).max(15) }).parse(d),
  )
  .handler(async ({ data }): Promise<StockData> => {
    const t = data.ticker.toUpperCase();
    const warnings: string[] = [];

    const [quoteArr, fundamentals] = await Promise.all([
      fmp<any[]>(`/quote?symbol=${t}`), // always fresh — price changes constantly
      getCachedFundamentals(t), // cached up to 7 days — income/cashflow/balance/profile/estimates
    ]);
    const { profileArr, incomeArr, cashArr, balanceArr, keyMetricsArr, estimatesArr } = fundamentals;
 
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
    const edgarBalance = await fetchEdgarBalanceSnapshot(t).catch(() => null);
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

    // Try SEC EDGAR first for up to 10 years of free, official history (US filers only).
    // Falls back to the ~5 years FMP's current plan provides for non-US tickers or if EDGAR fails.
    const edgarHistory = await getCachedEdgarHistory(t).catch(() => null);
    const history = edgarHistory && edgarHistory.length > fmpHistory.length ? edgarHistory : fmpHistory;
 
    return {
      ticker: t,
      companyName: profile.companyName ?? quote.name ?? t,
      exchange: profile.exchangeShortName ?? quote.exchange ?? "",
      currency: profile.currency ?? "USD",
      price: Number(quote.price ?? 0),
      changePercent: Number(quote.changesPercentage ?? 0),
      logoUrl: profile.image || null,
      freeCashFlow,
      operatingCashFlow,
      capex,
      meanCapex4y,
      fcfAdjusted,
      totalDebt,
      cash: cashBs,
      sharesOutstanding,
      peRatio: quote.pe != null ? Number(quote.pe) : null,
      roic: keyMetricsArr?.[0]?.roic != null ? Number(keyMetricsArr[0].roic) : null,
      baseGrowthRate,
      history,
      warnings,
    };
  });
