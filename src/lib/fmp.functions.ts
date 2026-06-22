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

// Twelve Data free tier: 800 requests/day, 8/min. Up to 5000 daily candles per call
// (~20 years). We cache each symbol's full history in Supabase for 24h so a single
// Twelve Data call per symbol per day covers every visitor.
const TD_SYMBOL_MAP: Record<string, string> = {
  "^GSPC": "SPX",
  "^IXIC": "IXIC",
  "^DJI": "DJI",
  "^RUT": "RUT",
};

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
  if (json?.status === "error" || !Array.isArray(json?.values)) return null;
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
    // Alpha Vantage failed (rate-limited or symbol unsupported) — serve stale cache if we have any.
    return row ? (row.candles as Candle[]) : null;
  }
 
  await supabaseAdmin
    .from("price_history_cache")
    .upsert({ symbol, candles: fresh, updated_at: new Date().toISOString() }, { onConflict: "symbol" });
 
  return fresh;
}
 
export const getIndexHistory = createServerFn({ method: "GET" })
  .inputValidator((d: { symbol: string; range: "1M" | "1A" | "3A" | "5A" }) =>
    z
      .object({
        symbol: z.string().min(1),
        range: z.enum(["1M", "1A", "3A", "5A"]),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<Candle[]> => {
    const days = data.range === "1M" ? 31 : data.range === "1A" ? 366 : data.range === "3A" ? 366 * 3 : 366 * 5;
    const cutoff = Date.now() - days * 86400_000;
 
    // FMP free/Starter plan only guarantees ~5 years, so for 3A/5A we prefer the
    // Alpha Vantage + Supabase cache path (20+ years, no extra cost) and fall back to FMP.
    let all: Candle[] | null = null;
    if (data.range === "3A" || data.range === "5A") {
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
 
    const [quoteArr, profileArr, incomeArr, cashArr, balanceArr, keyMetricsArr, estimatesArr] =
      await Promise.all([
        fmp<any[]>(`/quote?symbol=${t}`),
        fmp<any[]>(`/profile?symbol=${t}`),
        fmp<any[]>(`/income-statement?symbol=${t}&limit=5`),
        fmp<any[]>(`/cash-flow-statement?symbol=${t}&limit=5`),
        fmp<any[]>(`/balance-sheet-statement?symbol=${t}&limit=1`),
        fmp<any[]>(`/key-metrics?symbol=${t}&limit=1`).catch(() => []),
        fmp<any[]>(`/analyst-estimates?symbol=${t}&period=annual`).catch(() => []),
      ]);
 
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
    const totalDebt =
      typeof rawTotalDebt === "number" && rawTotalDebt > 0
        ? rawTotalDebt
        : typeof rawTotalDebt === "string" && Number(rawTotalDebt) > 0
          ? Number(rawTotalDebt)
          : Number(balance0.shortTermDebt ?? 0) + Number(balance0.longTermDebt ?? 0);
    console.log("[ValueScope DEBUG] totalDebt source:", {
      rawTotalDebt,
      shortTermDebt: balance0.shortTermDebt,
      longTermDebt: balance0.longTermDebt,
      finalTotalDebt: totalDebt,
    });
    const cashBs = Number(
      balance0.cashAndShortTermInvestments ?? balance0.cashAndCashEquivalents ?? 0,
    );
 
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
 
    const history = incomeArr
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
