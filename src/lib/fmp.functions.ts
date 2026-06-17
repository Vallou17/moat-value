// FMP API proxy — keeps the API key server-side.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const BASE = "https://financialmodelingprep.com/api/v3";
const STABLE = "https://financialmodelingprep.com/stable";

function key() {
  const k = process.env.FMP_API_KEY ?? process.env.VITE_FMP_API_KEY;
  if (!k) throw new Error("Chave da API FMP não configurada — adicione FMP_API_KEY nas definições do projeto");
  return k;
}

async function fmpUrl<T = unknown>(url: string, label: string): Promise<T> {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}apikey=${key()}`);
  if (res.status === 403) {
    throw new Error(
      `Acesso negado pela FMP (403) em ${label}. A chave pode ser inválida ou o seu plano FMP não inclui este endpoint.`,
    );
  }
  if (res.status === 401) throw new Error("Chave FMP inválida (401).");
  if (!res.ok) throw new Error(`FMP ${res.status}: ${label}`);
  return (await res.json()) as T;
}

async function fmp<T = unknown>(path: string): Promise<T> {
  return fmpUrl<T>(`${BASE}${path}`, path);
}

export const searchStocks = createServerFn({ method: "GET" })
  .inputValidator((d: { query: string }) => z.object({ query: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    type R = { symbol: string; name: string; exchangeShortName?: string; exchange?: string; currency?: string }[];
    // Try the stable endpoint first (current FMP plans); fall back to v3.
    let out: R = [];
    try {
      out = await fmpUrl<R>(
        `${STABLE}/search-symbol?query=${encodeURIComponent(data.query)}&limit=10`,
        "search-symbol",
      );
    } catch {
      out = await fmp<R>(`/search?query=${encodeURIComponent(data.query)}&limit=10`);
    }
    return out.map((r) => ({
      ticker: r.symbol,
      name: r.name,
      exchange: r.exchangeShortName ?? r.exchange ?? "",
      currency: r.currency ?? "USD",
    }));
  });

export type StockData = {
  ticker: string;
  companyName: string;
  exchange: string;
  currency: string;
  price: number;
  changePercent: number;
  // financials
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
  baseGrowthRate: number; // decimal (0.10 = 10%)
  // historicals (oldest -> newest, last 5)
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
        fmp<any[]>(`/quote/${t}`),
        fmp<any[]>(`/profile/${t}`),
        fmp<any[]>(`/income-statement/${t}?limit=5`),
        fmp<any[]>(`/cash-flow-statement/${t}?limit=5`),
        fmp<any[]>(`/balance-sheet-statement/${t}?limit=1`),
        fmp<any[]>(`/key-metrics/${t}?limit=1`).catch(() => []),
        fmp<any[]>(`/analyst-estimates/${t}`).catch(() => []),
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

    const totalDebt =
      Number(balance0.shortTermDebt ?? 0) + Number(balance0.longTermDebt ?? 0) ||
      Number(balance0.totalDebt ?? 0);
    const cashBs = Number(
      balance0.cashAndShortTermInvestments ?? balance0.cashAndCashEquivalents ?? 0,
    );

    const sharesOutstanding =
      Number(quote.sharesOutstanding) ||
      Number(keyMetricsArr?.[0]?.sharesOutstanding) ||
      Number(profile.mktCap && quote.price ? profile.mktCap / quote.price : 0);

    if (!sharesOutstanding) throw new Error("Número de ações indisponível");

    // Growth rate from analyst estimates: avg of next ~5y revenue growth
    let baseGrowthRate = 0;
    if (Array.isArray(estimatesArr) && estimatesArr.length) {
      const currentYear = new Date().getFullYear();
      const future = estimatesArr
        .filter((e) => {
          const y = Number(String(e.date ?? "").slice(0, 4));
          return y >= currentYear && y <= currentYear + 5 && e.estimatedRevenueAvg;
        })
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (future.length >= 2) {
        const rates: number[] = [];
        for (let i = 1; i < future.length; i++) {
          const prev = Number(future[i - 1].estimatedRevenueAvg);
          const curr = Number(future[i].estimatedRevenueAvg);
          if (prev > 0 && curr > 0) rates.push(curr / prev - 1);
        }
        if (rates.length) baseGrowthRate = rates.reduce((a, b) => a + b, 0) / rates.length;
      }
    }
    if (!baseGrowthRate || !isFinite(baseGrowthRate)) {
      // fallback: historical revenue CAGR from income statements
      if (incomeArr.length >= 2) {
        const oldest = Number(incomeArr[incomeArr.length - 1].revenue);
        const newest = Number(incomeArr[0].revenue);
        const years = incomeArr.length - 1;
        if (oldest > 0 && newest > 0)
          baseGrowthRate = Math.pow(newest / oldest, 1 / years) - 1;
      }
    }
    if (!baseGrowthRate || !isFinite(baseGrowthRate)) {
      baseGrowthRate = 0;
      warnings.push("Estimativas de crescimento indisponíveis — defina manualmente.");
    }
    // sanity cap
    baseGrowthRate = Math.max(-0.2, Math.min(0.4, baseGrowthRate));

    if (freeCashFlow < 0)
      warnings.push("FCF negativo — o cálculo pode não ser fiável.");

    // history (oldest -> newest)
    const history = incomeArr
      .slice()
      .reverse()
      .map((inc, i) => {
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
