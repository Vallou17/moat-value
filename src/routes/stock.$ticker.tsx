import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowDownRight,
  ArrowUpRight,
  RotateCcw,
  Sparkles,
  Calculator,
  BarChart3,
  Info,
  Star,
  AlertTriangle,
  ChevronDown,
  Receipt,
  Banknote,
} from "lucide-react";
import {
  Bar,
  BarChart,
  ComposedChart,
  Line,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getStockData,
  getStockHistory,
  getMoatAnalysis,
  getIndexHistory,
  type StockData,
  type StockHistoryResponse,
  type MoatCategoryResult,
  type Candle,
} from "@/lib/fmp.functions";
import { PriceHistoryChart } from "@/components/PriceHistoryChart";
import { computeDcf, discountPremiumPct } from "@/lib/dcf";
import { fmtMoney, fmtPct, fmtCompact, pushRecent } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/stock/$ticker")({
  component: StockPage,
});

function StockPage() {
  const { ticker } = Route.useParams();
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ["stock", ticker.toUpperCase()],
    queryFn: () => getStockData({ data: { ticker } }),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  // Fetched separately so the slower SEC EDGAR roundtrip for 10y history never delays
  // the price/DCF/metrics above from rendering — charts just show a loading state briefly.
  const historyQuery = useQuery({
    queryKey: ["stock-history", ticker.toUpperCase()],
    queryFn: () => getStockHistory({ data: { ticker } }),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (data) pushRecent({ ticker: data.ticker, name: data.companyName });
  }, [data]);

  if (isLoading) return <StockSkeleton />;

  if (error || !data) {
    const errMessage = (error as Error | undefined)?.message ?? "";
    const isApiKeyMissing = errMessage.toLowerCase().includes("não configurada") || errMessage.toLowerCase().includes("fmp_api_key");
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">
          {isApiKeyMissing ? "Erro de configuração" : `Não foi possível carregar ${ticker}`}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {isApiKeyMissing
            ? "Chave da API FMP não configurada — adicione FMP_API_KEY nas definições do projeto."
            : errMessage || "Ticker não encontrado ou API indisponível."}
        </p>
        <Button className="mt-6" variant="secondary" onClick={() => navigate({ to: "/" })}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Voltar
        </Button>
      </div>
    );
  }

  return <StockView data={data} historyQuery={historyQuery} />;
}

function StockView({
  data,
  historyQuery,
}: {
  data: StockData;
  historyQuery: UseQueryResult<StockHistoryResponse>;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [inWatch, setInWatch] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "combined">("overview");
  const [savingWatch, setSavingWatch] = useState(false);

  // Fetched lazily (separate from getStockData) — only needs companyName/sector/industry,
  // which only exist once `data` has loaded. Cached server-side for 30 days per ticker,
  // so this is a near-instant cache hit for any ticker someone has already viewed this month.
  const moatQuery = useQuery({
    queryKey: ["moat-analysis", data.ticker],
    queryFn: () =>
      getMoatAnalysis({
        data: {
          ticker: data.ticker,
          companyName: data.companyName,
          sector: data.sector,
          industry: data.industry,
        },
      }),
    staleTime: 24 * 60 * 60_000,
    retry: 1,
  });

  // Defaults
const defaults = useMemo(
    () => ({
      discountRate: 5,
      g1to5: Math.round(data.baseGrowthRate * 100),
      g6to10: Math.round((data.baseGrowthRate * 100) / 2),
      g11to20: Math.round((data.baseGrowthRate * 100) / 4),
    }),
    [data.baseGrowthRate],
  );

  const [discountRate, setDiscountRate] = useState(defaults.discountRate);
  const [g1, setG1] = useState(defaults.g1to5);
  const [g2, setG2] = useState(defaults.g6to10);
  const [g3, setG3] = useState(defaults.g11to20);

  // reset when ticker (data) changes
  useEffect(() => {
    setDiscountRate(defaults.discountRate);
    setG1(defaults.g1to5);
    setG2(defaults.g6to10);
    setG3(defaults.g11to20);
  }, [defaults]);

  const ivStandard = useMemo(
    () =>
      computeDcf({
        startingFcf: data.freeCashFlow,
        growthRate1to5: g1 / 100,
        growthRate6to10: g2 / 100,
        growthRate11to20: g3 / 100,
        discountRate: discountRate / 100,
        sharesOutstanding: data.sharesOutstanding,
        totalDebt: data.totalDebt,
        cash: data.cash,
      }),
    [data, g1, g2, g3, discountRate],
  );

  const ivAdjusted = useMemo(
    () =>
      computeDcf({
        startingFcf: data.fcfAdjusted,
        growthRate1to5: g1 / 100,
        growthRate6to10: g2 / 100,
        growthRate11to20: g3 / 100,
        discountRate: discountRate / 100,
        sharesOutstanding: data.sharesOutstanding,
        totalDebt: data.totalDebt,
        cash: data.cash,
      }),
    [data, g1, g2, g3, discountRate],
  );

  // watchlist check
  useEffect(() => {
    if (!user) return;
    supabase
      .from("watchlist")
      .select("id")
      .eq("user_id", user.id)
      .eq("ticker", data.ticker)
      .maybeSingle()
      .then(({ data: row }) => setInWatch(!!row));
  }, [user, data.ticker]);

  async function toggleWatch() {
    if (!user) {
      toast.info("Faça login para guardar ações.");
      navigate({ to: "/auth" });
      return;
    }
    setSavingWatch(true);
    if (inWatch) {
      await supabase
        .from("watchlist")
        .delete()
        .eq("user_id", user.id)
        .eq("ticker", data.ticker);
      setInWatch(false);
      toast.success("Removido da watchlist");
    } else {
      const { error } = await supabase.from("watchlist").insert({
        user_id: user.id,
        ticker: data.ticker,
        company_name: data.companyName,
      });
      if (error) toast.error(error.message);
      else {
        setInWatch(true);
        toast.success("Adicionado à watchlist");
      }
    }
    setSavingWatch(false);
  }

  function reset() {
    setDiscountRate(defaults.discountRate);
    setG1(defaults.g1to5);
    setG2(defaults.g6to10);
    setG3(defaults.g11to20);
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-20 pt-4 sm:px-6 sm:pt-6 lg:px-10">
      <Button
        variant="ghost"
        size="sm"
        className="mb-1 -ml-2"
        onClick={() => navigate({ to: "/" })}
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
      </Button>

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex w-full items-start justify-between gap-3 sm:w-auto sm:items-center sm:justify-start sm:gap-4">
          <div className="order-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded bg-secondary px-2 py-0.5 font-medium">{data.ticker}</span>
              {data.exchange && <span>{data.exchange}</span>}
            </div>
            <h1 className="mt-1 text-xl font-bold tracking-tight sm:text-3xl">
              {data.companyName}
            </h1>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="text-2xl font-semibold sm:text-3xl">
                {fmtMoney(data.price, data.currency)}
              </span>
              <span
                className={
                  "flex items-center text-sm font-medium " +
                  (data.changePercent >= 0 ? "text-success" : "text-destructive")
                }
              >
                {data.changePercent >= 0 ? (
                  <ArrowUpRight className="h-4 w-4" />
                ) : (
                  <ArrowDownRight className="h-4 w-4" />
                )}
                {fmtPct(data.changePercent, 1)}
              </span>
            </div>
          </div>
          {data.logoUrl && (
            <img
              src={data.logoUrl}
              alt={data.companyName}
              className="order-2 mt-5 h-16 w-16 shrink-0 rounded-xl border border-border/60 bg-white object-contain p-1.5 sm:order-0 sm:mt-0 sm:h-24 sm:w-24 sm:rounded-2xl sm:p-2 lg:h-28 lg:w-28"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}
        </div>
        <Button variant={inWatch ? "secondary" : "outline"} onClick={toggleWatch} disabled={savingWatch}>
          <Star className={"mr-2 h-4 w-4 " + (inWatch ? "fill-primary text-primary" : "")} />
          {inWatch ? "Na watchlist" : "Adicionar à watchlist"}
        </Button>
      </div>

      {data.warnings.length > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />
          <div>
            {data.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        </div>
      )}

      {/* Intrinsic value (includes collapsible assumptions panel) */}
      <div className="mt-6 grid gap-4 sm:grid-cols-1">
        <IvCard
          label="Valor Intrínseco"
          iv={ivAdjusted.intrinsicValuePerShare}
          price={data.price}
          currency={data.currency}
          discountRate={discountRate}
          g1={g1}
          g2={g2}
          g3={g3}
          onDiscountRateChange={setDiscountRate}
          onG1Change={setG1}
          onG2Change={setG2}
          onG3Change={setG3}
          onReset={reset}
        />
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 border-b border-border/60">
        <button
          type="button"
          onClick={() => setActiveTab("overview")}
          className={
            "border-b-2 px-3 py-2 text-sm font-medium transition-colors " +
            (activeTab === "overview"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground")
          }
        >
          Visão Geral
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("combined")}
          className={
            "border-b-2 px-3 py-2 text-sm font-medium transition-colors " +
            (activeTab === "combined"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground")
          }
        >
          Cotação vs Fundamentais
        </button>
      </div>

      {activeTab === "overview" && (
        <>
      {/* Price history chart */}
      <div className="mt-6">
        <PriceHistoryChart
          symbol={data.ticker}
          currentPrice={data.price}
          currentChangePercent={data.changePercent}
          currency={data.currency}
        />
      </div>

      {/* Metrics */}
      <section className="mt-6">
        <Card className="p-4 sm:p-5">
          <h2 className="mb-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:gap-2 sm:text-sm">
            <BarChart3 className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" /> Métricas e
            Indicadores
          </h2>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-5">
            <MetricGroup title="Avaliação">
              <MetricRow label="Capitalização Bolsista" value={data.marketCap != null ? fmtCompact(data.marketCap, data.currency) : "—"} />
              <MetricRow
                label="P/E (TTM | NTM)"
                value={`${data.peRatio != null ? data.peRatio.toFixed(1) : "—"} | ${
                  data.peNtm != null ? data.peNtm.toFixed(1) : "—"
                }`}
              />
              <MetricRow label="Price to Sales" value={fmtRatio(data.priceToSales)} />
              <MetricRow label="EV to EBITDA" value={fmtRatio(data.evToEBITDA)} />
              <MetricRow label="Price to Book" value={fmtRatio(data.priceToBook)} />
            </MetricGroup>

            <MetricGroup title="Free Cash Flow">
              <MetricRow label="Free Cash Flow" value={fmtCompact(data.freeCashFlow, data.currency)} />
              <MetricRow
                label="FCF Yield"
                value={data.freeCashFlowYield != null ? fmtPct(data.freeCashFlowYield * 100, 1) : "—"}
              />
              <MetricRow
                label="FCF por Ação"
                value={data.freeCashFlowPerShare != null ? fmtMoney(data.freeCashFlowPerShare, data.currency) : "—"}
              />
              <MetricRow label="CAPEX (último ano)" value={fmtCompact(data.capex, data.currency)} />
              <MetricRow label="CAPEX Médio (últimos 4 anos)" value={fmtCompact(data.meanCapex4y, data.currency)} />
            </MetricGroup>

            <MetricGroup title="Margens e Crescimento">
              <MetricRow
                label="Margem de Lucro"
                value={data.netProfitMargin != null ? fmtPct(data.netProfitMargin * 100, 1) : "—"}
              />
              <MetricRow
                label="Margem Operacional"
                value={data.operatingProfitMargin != null ? fmtPct(data.operatingProfitMargin * 100, 1) : "—"}
              />
              <MetricRow
                label="Receita (YoY)"
                value={data.revenueGrowthYoY != null ? fmtPct(data.revenueGrowthYoY * 100, 1) : "—"}
              />
              <MetricRow
                label="Lucro Líquido (YoY)"
                value={data.netIncomeGrowthYoY != null ? fmtPct(data.netIncomeGrowthYoY * 100, 1) : "—"}
              />
            </MetricGroup>

            <MetricGroup title="Balanço">
              <MetricRow label="Caixa & Equivalentes" value={fmtCompact(data.cash, data.currency)} />
              <MetricRow label="Dívida Total" value={fmtCompact(data.totalDebt, data.currency)} />
              <MetricRow label="Dívida Líquida" value={fmtCompact(data.totalDebt - data.cash, data.currency)} />
              <MetricRow
                label="Ações em Circulação"
                value={fmtCompact(data.sharesOutstanding, data.currency).replace(/[^\d.,KMBT]/g, "")}
              />
            </MetricGroup>

            <MetricGroup title="Dividendos">
              <MetricRow
                label="Dividend Yield"
                value={data.dividendYield != null ? fmtPct(data.dividendYield * 100, 1) : "—"}
              />
              <MetricRow
                label="Payout Ratio"
                value={data.dividendPayoutRatio != null ? fmtPct(data.dividendPayoutRatio * 100, 1) : "—"}
              />
            </MetricGroup>
          </div>

          <div className="mt-6 grid gap-4 border-t border-border/60 pt-6 lg:grid-cols-2">
            <ChartCard
              title="Receita"
              icon={Receipt}
              history={historyQuery.data}
              isLoading={historyQuery.isLoading}
              dataKey="revenue"
              currency={data.currency}
            />
            <ChartCard
              title="Free Cash Flow"
              icon={Banknote}
              history={historyQuery.data}
              isLoading={historyQuery.isLoading}
              dataKey="fcf"
              currency={data.currency}
            />
          </div>
        </Card>
      </section>

      {/* Moat (AI analysis) */}
      <section className="mt-6">
        <Card className="p-4 sm:p-5">
          <h2 className="mb-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:gap-2 sm:text-sm">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" /> MOAT da
            empresa - análise gerada por Inteligência Artificial
          </h2>

          {moatQuery.isLoading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg bg-muted/40" />
              ))}
            </div>
          ) : moatQuery.isError || !moatQuery.data ? (
            <p className="text-sm text-muted-foreground">
              Não foi possível gerar a análise de Moat para esta ação. Tenta novamente mais
              tarde.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {moatQuery.data.categories.map((c) => (
                <MoatCategoryCard key={c.category} result={c} />
              ))}
            </div>
          )}
        </Card>
      </section>
        </>
      )}

      {activeTab === "combined" && (
        <div className="mt-6">
          <CombinedChart
            ticker={data.ticker}
            currency={data.currency}
            history={historyQuery.data}
            isHistoryLoading={historyQuery.isLoading}
          />
        </div>
      )}
    </div>
  );
}

function MoatCategoryCard({ result }: { result: MoatCategoryResult }) {
  const pct = (result.score / 10) * 100;
  const color =
    result.score >= 8
      ? "#2E8B3D"
      : result.score >= 6
        ? "#8FC76B"
        : result.score >= 4
          ? "#F2C744"
          : result.score >= 2
            ? "#EF9F3C"
            : "#D9483D";

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold leading-snug">{result.category}</div>
        <div className="shrink-0 text-sm font-bold" style={{ color }}>
          {result.score}/10
        </div>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <p className="mt-2 text-xs leading-snug text-muted-foreground">{result.explanation}</p>
    </div>
  );
}

const ZONE_LABELS = ["Muito subavaliada", "Subavaliada", "Justo valor", "Sobreavaliada", "Muito sobreavaliada"];

function IvCard({
  label,
  iv,
  price,
  currency,
  discountRate,
  g1,
  g2,
  g3,
  onDiscountRateChange,
  onG1Change,
  onG2Change,
  onG3Change,
  onReset,
}: {
  label: string;
  iv: number;
  price: number;
  currency: string;
  discountRate: number;
  g1: number;
  g2: number;
  g3: number;
  onDiscountRateChange: (n: number) => void;
  onG1Change: (n: number) => void;
  onG2Change: (n: number) => void;
  onG3Change: (n: number) => void;
  onReset: () => void;
}) {
  const dp = discountPremiumPct(price, iv); // negative = undervalued, positive = overvalued
  const discount = dp < 0;
  const valid = isFinite(iv) && iv > 0;

  // Map dp (%) to a 0..1 gauge position. Clamp at +/-60% so extreme cases don't break the needle.
  const clamped = Math.max(-60, Math.min(60, dp));
  const gaugeT = (clamped + 60) / 120; // 0 = far undervalued (left), 1 = far overvalued (right)

  const zoneColors = ["#2E8B3D", "#8FC76B", "#F2C744", "#EF9F3C", "#D9483D"];
  const zoneIndex = Math.min(4, Math.floor(gaugeT * 5));
  const zoneColor = zoneColors[zoneIndex];
  const zoneLabel = ZONE_LABELS[zoneIndex];

  return (
    <Card
      className="overflow-hidden px-5 pb-5 pt-3 sm:pt-5"
      style={
        valid
          ? { background: `linear-gradient(135deg, ${zoneColor}14, transparent 65%)` }
          : undefined
      }
    >
      <h2 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:gap-2 sm:text-sm">
        <Calculator className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" /> {label}
      </h2>

      {valid ? (
        <>
          <div className="mt-5 flex flex-col items-center gap-4 sm:mt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-center sm:text-left">
              <div className="text-2xl font-bold sm:text-5xl">{fmtMoney(iv, currency)}</div>
              <div
                className="mt-2 whitespace-nowrap text-xs font-semibold sm:text-base"
                style={{ color: zoneColor }}
              >
                Cotação atual {Math.abs(dp).toFixed(1)}% {discount ? "abaixo" : "acima"} do valor
                intrínseco
              </div>
              <div className="mt-2 flex items-start gap-1.5 text-left text-[11px] leading-snug text-muted-foreground sm:text-xs">
                <Info className="mt-[1px] h-3 w-3 shrink-0" />
                <span>
                  Valor intrínseco calculado através de algoritmo próprio derivado do método
                  Discounted Cash Flow
                </span>
              </div>
            </div>
            <div className="flex flex-col items-center">
              <Gauge t={gaugeT} color={zoneColor} />
              <div
                className="mt-2 rounded-full px-3 py-1 text-sm font-bold"
                style={{ color: zoneColor, backgroundColor: `${zoneColor}22` }}
              >
                {zoneLabel}
              </div>
            </div>
          </div>


          <Collapsible className="mt-4">
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-card/40 px-4 py-3 text-left">
              <div>
                <div className="text-sm font-semibold">Personalizar Pressupostos</div>
                <p className="text-xs text-muted-foreground">
                  Ajusta os pressupostos e recalcula o valor intrínseco.
                </p>
              </div>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="rounded-b-lg border border-t-0 border-border/60 bg-card/40 p-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Taxa de Desconto (%)" value={discountRate} step={0.1} onChange={onDiscountRateChange} />
                <Field label="Crescimento do Free Cash Flow nos anos 1–5 (%)" value={g1} step={0.1} onChange={onG1Change} />
                <Field label="Crescimento do Free Cash Flow nos anos 6–10 (%)" value={g2} step={0.1} onChange={onG2Change} />
                <Field label="Crescimento do Free Cash Flow nos anos 11–20 (%)" value={g3} step={0.1} onChange={onG3Change} />
              </div>
              <Button variant="ghost" size="sm" className="mt-4" onClick={onReset}>
                <RotateCcw className="mr-2 h-3.5 w-3.5" /> Repor valores originais
              </Button>
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <div className="mt-2 text-3xl font-bold">—</div>
      )}
    </Card>
  );
}

// Interactive horizontal-style semicircular gauge with 5 colored zones (undervalued -> overvalued)
// and a needle pointing at position t (0 = far left/undervalued, 1 = far right/overvalued).
// Hovering a zone brightens it and shows a floating tooltip with that zone's category name.
function Gauge({ t, color }: { t: number; color: string }) {
  const W = 220;
  const H = 120;
  const cx = W / 2;
  const cy = 105;
  const r = 84;
  const strokeW = 18;
  const zones = ["#2E8B3D", "#8FC76B", "#F2C744", "#EF9F3C", "#D9483D"];
  const zoneSpan = 180 / zones.length;
  const [hovered, setHovered] = useState<number | null>(null);

  // angle 180 = left, angle 0 = right, sweeping over the top
  const toXY = (angleDeg: number, radius: number) => {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + radius * Math.cos(rad), y: cy - radius * Math.sin(rad) };
  };

  const arcPath = (startDeg: number, endDeg: number, radius: number) => {
    const p1 = toXY(startDeg, radius);
    const p2 = toXY(endDeg, radius);
    return `M ${p1.x} ${p1.y} A ${radius} ${radius} 0 0 1 ${p2.x} ${p2.y}`;
  };

  const needleAngle = 180 - t * 180; // t=0 -> 180 (left), t=1 -> 0 (right)
  const tip = toXY(needleAngle, r - 16);
  const base1 = toXY(needleAngle + 90, 5);
  const base2 = toXY(needleAngle - 90, 5);

  // Lighten a hex color for the hover highlight effect.
  function lighten(hex: string, amount: number) {
    const n = parseInt(hex.slice(1), 16);
    const r0 = (n >> 16) & 255;
    const g0 = (n >> 8) & 255;
    const b0 = n & 255;
    const mix = (c: number) => Math.round(c + (255 - c) * amount);
    return `rgb(${mix(r0)}, ${mix(g0)}, ${mix(b0)})`;
  }

  // Tooltip anchor point along the arc (percentage-based x, so we can clamp it within the card).
  const tooltipAnchor =
    hovered !== null ? toXY(180 - (hovered + 0.5) * zoneSpan, r + 26) : null;
  // Convert SVG x (0..W) to a 0..100% position, then clamp so the tooltip box (≈110px wide)
  // never spills past the gauge's own bounding box.
  const tooltipPctRaw = tooltipAnchor ? (tooltipAnchor.x / W) * 100 : 50;
  const tooltipPct = Math.max(18, Math.min(82, tooltipPctRaw));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-[220px] overflow-visible">
        {zones.map((c, i) => {
          const start = 180 - i * zoneSpan;
          const end = 180 - (i + 1) * zoneSpan;
          const isHovered = hovered === i;
          return (
            <path
              key={i}
              d={arcPath(start, end, r)}
              stroke={isHovered ? lighten(c, 0.35) : c}
              strokeWidth={isHovered ? strokeW + 4 : strokeW}
              fill="none"
              className="cursor-pointer transition-all duration-150"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            />
          );
        })}
        <polygon
          points={`${tip.x},${tip.y} ${base1.x},${base1.y} ${base2.x},${base2.y}`}
          fill={color}
        />
        <circle cx={cx} cy={cy} r={6} fill={color} />
      </svg>
      {hovered !== null && tooltipAnchor && (
        <div
          className="pointer-events-none absolute z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs font-semibold text-popover-foreground shadow-lg ring-1 ring-border"
          style={{
            left: `${tooltipPct}%`,
            top: tooltipAnchor.y,
            transform: "translate(-50%, -50%)",
          }}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: zones[hovered] }}
          />
          {ZONE_LABELS[hovered]}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        step={step}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? 0 : parseFloat(v));
        }}
      />
    </div>
  );
}

function MetricGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function fmtRatio(n: number | null): string {
  return n != null ? `${n.toFixed(1)}` : "—";
}

// Custom bar shape: the bar under the cursor gets brightened instead of the default
// Recharts grey "cursor" rectangle behind the whole category. Mirrors the hover treatment
// used on the intrinsic-value Gauge, where the highlight lives on the shape itself.
function makeHighlightBar(activeIndex: number | null, gradientId: string, fixedWidth?: number) {
  return function HighlightBar(props: any) {
    const { x, y, width, height, index } = props;
    if (!Number.isFinite(height) || !Number.isFinite(y)) return null;

    // Recharts can hand us a negative `height` for bars below the zero baseline
    // (negative FCF years) — drawing a <rect> with a negative height renders nothing,
    // so normalize to a positive size and keep y pinned to the bar's actual top edge.
    const absHeight = Math.abs(height);
    const top = height < 0 ? y + height : y;
    const isActive = index === activeIndex;

    // When the chart's x-axis has far more category slots than bars (e.g. daily price
    // points but only ~40 quarterly bars), Recharts' auto-computed `width` shrinks to a
    // sliver. `fixedWidth` overrides that with an explicit pixel width, re-centered on
    // the bar's original x position so it still lines up with its data point.
    const barWidth = fixedWidth ?? width;
    const barX = fixedWidth != null ? x + width / 2 - fixedWidth / 2 : x;

    return (
      <rect
        x={barX}
        y={top}
        width={barWidth}
        height={Math.max(absHeight, 1)}
        rx={6}
        ry={6}
        fill={`url(#${gradientId})`}
        opacity={isActive ? 1 : 0.75}
        style={{ transition: "opacity 120ms ease" }}
      />
    );
  };
}

type Granularity = "annual" | "quarterly";

function ChartCard({
  title,
  icon: TitleIcon,
  history,
  isLoading,
  dataKey,
  currency,
}: {
  title: string;
  icon: typeof Receipt;
  history: StockHistoryResponse | undefined;
  isLoading?: boolean;
  dataKey: "revenue" | "fcf";
  currency: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [granularity, setGranularity] = useState<Granularity>("annual");
  const seriesName = dataKey === "revenue" ? "Receita" : "FCF";
  const rawId = useId();
  const gradientId = `bar-gradient-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;

  const hasQuarterly = (history?.quarterly?.length ?? 0) > 0;
  // Fall back to annual if quarterly was requested but isn't available for this ticker
  // (e.g. non-US filers that don't report 10-Qs to the SEC) rather than show an empty chart.
  const effectiveGranularity: Granularity = granularity === "quarterly" && hasQuarterly ? "quarterly" : "annual";

  const chartData = useMemo(() => {
    if (!history) return [];
    if (effectiveGranularity === "quarterly") {
      return history.quarterly.map((q) => ({
        label: `T${q.quarter} ${String(q.year).slice(2)}`,
        revenue: q.revenue,
        fcf: q.fcf,
      }));
    }
    return history.annual.map((a) => ({
      label: String(a.year),
      revenue: a.revenue,
      fcf: a.fcf,
    }));
  }, [history, effectiveGranularity]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1.5 sm:px-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <TitleIcon className="h-4 w-4 shrink-0 text-primary" />
          {title}
        </div>
        <div className="flex gap-1">
          <Button
            variant={effectiveGranularity === "annual" ? "secondary" : "ghost"}
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setGranularity("annual")}
          >
            Anual
          </Button>
          <Button
            variant={effectiveGranularity === "quarterly" ? "secondary" : "ghost"}
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={!hasQuarterly}
            title={hasQuarterly ? undefined : "Dados trimestrais indisponíveis para esta ação"}
            onClick={() => setGranularity("quarterly")}
          >
            Trimestral
          </Button>
        </div>
      </div>
      <div className="h-56">
        {isLoading || !history ? (
          <div className="h-full w-full animate-pulse rounded bg-muted/40" />
        ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            onMouseMove={(state: any) => {
              if (state?.isTooltipActive && typeof state.activeTooltipIndex === "number") {
                setActiveIndex(state.activeTooltipIndex);
              } else {
                setActiveIndex(null);
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#B794F4" />
                <stop offset="100%" stopColor="#4F46E5" />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickFormatter={(v) => fmtCompact(v, currency).replace(/[A-Z$€]/g, "")}
              tickLine={false}
              width={48}
            />
            <Tooltip
              cursor={false}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--popover-foreground)",
              }}
              labelStyle={{ color: "var(--popover-foreground)" }}
              itemStyle={{ color: "var(--popover-foreground)" }}
              formatter={(v: number) => [fmtCompact(v, currency), seriesName]}
            />
            <Bar
              dataKey={dataKey}
              name={seriesName}
              isAnimationActive={false}
              shape={makeHighlightBar(activeIndex, gradientId) as any}
            />
          </BarChart>
        </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

type CombinedIndicator = "revenue" | "fcf" | "epsDiluted" | "peTTM";

const COMBINED_INDICATOR_LABELS: Record<CombinedIndicator, string> = {
  revenue: "Receita",
  fcf: "Free Cash Flow",
  epsDiluted: "EPS Diluído",
  peTTM: "P/E TTM",
};

// Which calendar quarter (1-4) a given ISO date falls into.
function quarterOfDate(dateStr: string): number {
  const month = Number(dateStr.slice(5, 7));
  return Math.ceil(month / 3);
}

// Closing price on the LAST trading day of a given calendar quarter/year — this mirrors
// how FMP (and TTM ratios generally) compute a "current" P/E: price at a specific point in
// time divided by trailing EPS, not an average price over the period. Using an average here
// previously caused the combined-chart P/E to diverge from the P/E shown in the "Métricas e
// Indicadores" card by several points even when the underlying EPS numbers roughly agreed.
function closePriceAtQuarterEnd(candles: Candle[], year: number, quarter: number): number | null {
  const inQuarter = candles.filter(
    (c) => Number(c.date.slice(0, 4)) === year && quarterOfDate(c.date) === quarter,
  );
  if (inQuarter.length === 0) return null;
  // candles are chronologically sorted (see getIndexHistory), so the last match is the
  // most recent trading day within that quarter.
  return inQuarter[inQuarter.length - 1].close;
}

function CombinedChart({
  ticker,
  currency,
  history,
  isHistoryLoading,
}: {
  ticker: string;
  currency: string;
  history: StockHistoryResponse | undefined;
  isHistoryLoading?: boolean;
}) {
  const [indicator, setIndicator] = useState<CombinedIndicator>("revenue");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const rawId = useId();
  const gradientId = `combined-bar-gradient-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;

  const priceQuery = useQuery<Candle[]>({
    queryKey: ["combined-price-history", ticker],
    queryFn: () => getIndexHistory({ data: { symbol: ticker, range: "10A" } }),
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
  });

  const isLoading = isHistoryLoading || priceQuery.isLoading;
  const priceCandles = priceQuery.data;

  // "year-quarter" keys (e.g. "2025-3") present in the visible price range, in
  // chronological order — the quarterly indicator chart only makes sense for periods we
  // also have price data for.
  const quartersInRange = useMemo(() => {
    if (!priceCandles || priceCandles.length === 0) return [];
    const seen = new Set<string>();
    const out: { year: number; quarter: number; key: string }[] = [];
    for (const c of priceCandles) {
      const year = Number(c.date.slice(0, 4));
      const quarter = quarterOfDate(c.date);
      const key = `${year}-${quarter}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ year, quarter, key });
      }
    }
    return out;
  }, [priceCandles]);

  const quarterlyByKey = useMemo(() => {
    const map = new Map<
      string,
      { revenue: number; fcf: number; epsDiluted: number | null; netIncome: number | null; sharesOutstanding: number | null }
    >();
    for (const q of history?.quarterly ?? []) map.set(`${q.year}-${q.quarter}`, q);
    return map;
  }, [history]);

  // Trailing-twelve-months P/E ending in a given quarter: trailing net income (summed
  // from that quarter and the 3 preceding ones), divided by the latest known share count.
  // This is the ONLY path used (see epsTtmEndingAt below) — we deliberately never sum 4
  // quarters of isolated diluted EPS directly, even when all 4 are present. Net income is
  // immune to stock splits (a split changes EPS and share count but not net income itself),
  // whereas a single pre-split isolated EPS fact slipping through — which has happened in
  // EDGAR's data for split-heavy filers like Netflix (10-for-1 split) — silently corrupts a
  // direct EPS sum by the split ratio, without necessarily tripping the outlier filter below
  // (that filter only guards the *shares* lookup, not a direct EPS sum). Net income, being a
  // cumulative flow like revenue, can be reconstructed from YTD filings the same way revenue
  // is, giving much more complete and much more reliable trailing-twelve-months coverage.
  // All quarters with data, sorted chronologically — used to search for the nearest quarter
  // with "implied shares" data when filling P/E TTM gaps (see epsTtmEndingAt below). Built
  // from the full quarterly history, not just quartersInRange, so we can look slightly
  // outside the visible 10y price window if needed (e.g. the quarter right before it).
  const sortedQuarterKeys = useMemo(() => {
    const keys = Array.from(quarterlyByKey.keys());
    return keys.sort((a, b) => {
      const [ay, aq] = a.split("-").map(Number);
      const [by, bq] = b.split("-").map(Number);
      return ay !== by ? ay - by : aq - bq;
    });
  }, [quarterlyByKey]);

  // "Implied" diluted share count for a quarter: netIncome ÷ that same quarter's reported
  // EPS. Because both numbers come from the same filing, this is always on the correct,
  // current share basis — unlike a raw shares-outstanding fact, which can be stale or, more
  // importantly, can straddle a stock split (Netflix did a 10-for-1 split, for example,
  // which would otherwise silently inflate P/E by ~10x for periods reported pre-split).
  const impliedSharesByQuarter = useMemo(() => {
    const raw = new Map<string, number>();
    for (const [key, q] of quarterlyByKey) {
      if (q.netIncome != null && q.epsDiluted != null && q.epsDiluted !== 0) {
        const implied = q.netIncome / q.epsDiluted;
        if (implied > 0) raw.set(key, implied);
      }
    }
    // A stock split changes EPS and share count but NOT net income — if a filer's EDGAR
    // history has even one quarter where the isolated EPS fact wasn't restated for a later
    // split (this happens in practice; confirmed for Netflix's 10-for-1 split), that single
    // quarter's implied share count comes out ~10x off from every other quarter's, which
    // would otherwise corrupt the "nearest available" lookup used for filling P/E gaps.
    // We filter those out via a simple median-based outlier check rather than trying to
    // detect the exact split date and ratio, which EDGAR doesn't cleanly expose.
    const values = Array.from(raw.values()).sort((a, b) => a - b);
    if (values.length < 3) return raw;
    const median = values[Math.floor(values.length / 2)];
    const out = new Map<string, number>();
    for (const [key, val] of raw) {
      if (val > median / 3 && val < median * 3) out.set(key, val);
    }
    return out;
  }, [quarterlyByKey]);

  // Nearest quarter (by chronological distance) to `key` that has implied-shares data —
  // used as the share-count basis when a quarter itself lacks an isolated EPS fact.
  function nearestImpliedShares(key: string): number | null {
    const idx = sortedQuarterKeys.indexOf(key);
    if (idx === -1) return impliedSharesByQuarter.size > 0 ? impliedSharesByQuarter.values().next().value : null;
    for (let dist = 0; dist < sortedQuarterKeys.length; dist++) {
      const before = sortedQuarterKeys[idx - dist];
      const after = sortedQuarterKeys[idx + dist];
      if (before != null && impliedSharesByQuarter.has(before)) return impliedSharesByQuarter.get(before)!;
      if (after != null && impliedSharesByQuarter.has(after)) return impliedSharesByQuarter.get(after)!;
      if (before == null && after == null) break;
    }
    return null;
  }

  // Trailing-twelve-months EPS ending in a given quarter, ALWAYS via trailing net income ÷
  // implied share count from the nearest reliable quarter. We previously also tried summing
  // 4 isolated diluted-EPS facts directly whenever all 4 were present, on the assumption that
  // "the filer reported it, so it's correct". In practice that path was what let Netflix's
  // P/E TTM come out far too low: at least one of those 4 isolated EPS facts was not
  // split-adjusted, and summing doesn't catch that the way the median-based outlier filter
  // on *implied shares* does. Net income is never affected by a split, so routing everything
  // through net-income ÷ implied-shares removes that entire failure mode — at the cost of
  // being a slightly different methodology than a raw EPS sum, but a consistent and
  // split-safe one.
  function epsTtmEndingAt(year: number, quarter: number): number | null {
    const quarterKeys: string[] = [];
    let y = year;
    let q = quarter;
    for (let i = 0; i < 4; i++) {
      quarterKeys.push(`${y}-${q}`);
      q -= 1;
      if (q === 0) {
        q = 4;
        y -= 1;
      }
    }

    let netIncomeSum = 0;
    for (const k of quarterKeys) {
      const ni = quarterlyByKey.get(k)?.netIncome;
      if (ni == null) return null;
      netIncomeSum += ni;
    }
    const shares = nearestImpliedShares(quarterKeys[0]);
    if (shares == null || shares <= 0) return null;
    return netIncomeSum / shares;
  }

  const indicatorByQuarter = useMemo(() => {
    const out = new Map<string, number | null>();
    for (const { year, quarter, key } of quartersInRange) {
      const q = quarterlyByKey.get(key);
      if (indicator === "peTTM") {
        const epsTtm = epsTtmEndingAt(year, quarter);
        const endPrice = priceCandles ? closePriceAtQuarterEnd(priceCandles, year, quarter) : null;
        out.set(key, epsTtm != null && epsTtm > 0 && endPrice != null ? endPrice / epsTtm : null);
      } else if (indicator === "epsDiluted") {
        out.set(key, q?.epsDiluted ?? null);
      } else {
        out.set(key, q ? q[indicator] : null);
      }
    }
    return out;
  }, [quartersInRange, quarterlyByKey, indicator, priceCandles]);

  // How many quarters in the visible range actually have a value for this indicator —
  // shown to the user when it's 0, so "no data" is distinguishable from "still loading"
  // or a silent bug, instead of just rendering an empty chart with no explanation.
  const quartersWithData = useMemo(
    () => Array.from(indicatorByQuarter.values()).filter((v) => v != null).length,
    [indicatorByQuarter],
  );

  const priceBase = priceCandles && priceCandles.length > 0 ? priceCandles[0].close : null;
  const priceLatest = priceCandles && priceCandles.length > 0 ? priceCandles[priceCandles.length - 1].close : null;

  // Quarter-end price for the most recent quarter and the same quarter one year earlier —
  // used for the price's year-over-year ("homólogo") comparison in the summary box, mirroring
  // how the indicator's YoY comparison works. Uses the same quarter-end convention as the
  // P/E TTM calculation above, rather than an average, for consistency.
  const priceYoy = useMemo(() => {
    if (!priceCandles || quartersInRange.length === 0) return null;
    const latest = quartersInRange[quartersInRange.length - 1];
    const yearAgo = quartersInRange.find((q) => q.year === latest.year - 1 && q.quarter === latest.quarter);
    if (!yearAgo) return null;
    const latestEnd = closePriceAtQuarterEnd(priceCandles, latest.year, latest.quarter);
    const yearAgoEnd = closePriceAtQuarterEnd(priceCandles, yearAgo.year, yearAgo.quarter);
    if (latestEnd == null || yearAgoEnd == null || yearAgoEnd === 0) return null;
    return ((latestEnd - yearAgoEnd) / Math.abs(yearAgoEnd)) * 100;
  }, [priceCandles, quartersInRange]);

  // Indicator's year-over-year change: most recent quarter with data vs. the same calendar
  // quarter one year earlier (e.g. Q3 2025 vs Q3 2024) — comparing like-for-like quarters
  // rather than consecutive ones, since most fundamentals are seasonal.
  const indicatorYoy = useMemo(() => {
    const withData = quartersInRange.filter((q) => indicatorByQuarter.get(q.key) != null);
    if (withData.length === 0) return null;
    const latest = withData[withData.length - 1];
    const latestVal = indicatorByQuarter.get(latest.key);
    const yearAgoKey = `${latest.year - 1}-${latest.quarter}`;
    const yearAgoVal = indicatorByQuarter.get(yearAgoKey);
    if (latestVal == null || yearAgoVal == null || yearAgoVal === 0) return null;
    return ((latestVal - yearAgoVal) / Math.abs(yearAgoVal)) * 100;
  }, [quartersInRange, indicatorByQuarter]);

  const priceFullPeriodPct = priceBase != null && priceLatest != null && priceBase !== 0 ? ((priceLatest - priceBase) / priceBase) * 100 : null;

  const indicatorFullPeriodPct = useMemo(() => {
    const withData = quartersInRange.filter((q) => indicatorByQuarter.get(q.key) != null);
    if (withData.length < 1) return null;
    const first = indicatorByQuarter.get(withData[0].key);
    const last = indicatorByQuarter.get(withData[withData.length - 1].key);
    if (first == null || last == null || first === 0) return null;
    return ((last - first) / Math.abs(first)) * 100;
  }, [quartersInRange, indicatorByQuarter]);

  // One row per trading day: price as a continuous absolute line, indicator held at its
  // quarter's value only on the last trading day of that quarter (rendered as bars).
  const chartData = useMemo(() => {
    if (!priceCandles || priceCandles.length === 0) return [];
    const lastDayOfQuarter = new Map<string, string>();
    for (const c of priceCandles) {
      const key = `${c.date.slice(0, 4)}-${quarterOfDate(c.date)}`;
      lastDayOfQuarter.set(key, c.date); // candles are chronological, so this ends up as the last one
    }
    return priceCandles.map((c) => {
      const key = `${c.date.slice(0, 4)}-${quarterOfDate(c.date)}`;
      const isQuarterEnd = lastDayOfQuarter.get(key) === c.date;
      return {
        date: c.date,
        price: c.close,
        // Only set on the quarter's last trading day, so the <Bar> renders one bar per
        // quarter instead of a bar repeated across every day.
        indicatorBarValue: isQuarterEnd ? indicatorByQuarter.get(key) ?? null : null,
        // Set on every day of the quarter, so hovering anywhere in that quarter (not just
        // its last day) still shows the indicator's value and % change in the tooltip.
        indicatorTooltipValue: indicatorByQuarter.get(key) ?? null,
        quarterKey: key,
      };
    });
  }, [priceCandles, indicatorByQuarter]);

  // % change of the indicator from the first quarter with data to each subsequent quarter —
  // shown in the tooltip alongside the absolute value.
  const indicatorPctFromStart = useMemo(() => {
    const out = new Map<string, number | null>();
    const firstValue = quartersInRange.map((q) => indicatorByQuarter.get(q.key)).find((v) => v != null);
    for (const { key } of quartersInRange) {
      const v = indicatorByQuarter.get(key);
      out.set(
        key,
        v != null && firstValue != null && firstValue !== 0 ? ((v - firstValue) / Math.abs(firstValue)) * 100 : null,
      );
    }
    return out;
  }, [quartersInRange, indicatorByQuarter]);

  // One tick per calendar year, instead of letting Recharts auto-space ticks by pixel
  // density (which was placing 2+ ticks inside the same year and repeating year labels).
  const xTicks = useMemo(() => {
    if (!priceCandles || priceCandles.length === 0) return [];
    const seen = new Set<string>();
    const ticks: string[] = [];
    for (const c of priceCandles) {
      const y = c.date.slice(0, 4);
      if (!seen.has(y)) {
        seen.add(y);
        ticks.push(c.date);
      }
    }
    return ticks;
  }, [priceCandles]);

  function formatIndicatorValue(v: number): string {
    if (indicator === "peTTM") return `${v.toFixed(1)}x`;
    if (indicator === "epsDiluted") return fmtMoney(v, currency);
    return fmtCompact(v, currency);
  }

  function PctBadge({ pct }: { pct: number | null }) {
    if (pct == null) return <span className="text-muted-foreground">—</span>;
    const up = pct >= 0;
    return (
      <span className={up ? "text-success" : "text-destructive"}>
        {up ? "+" : ""}
        {pct.toFixed(1)}%
      </span>
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:text-sm">
          <BarChart3 className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" /> Cotação vs
          Fundamentais
        </h2>
        <div className="flex flex-wrap gap-1">
          {(["revenue", "fcf", "epsDiluted", "peTTM"] as CombinedIndicator[]).map((opt) => (
            <Button
              key={opt}
              variant={indicator === opt ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setIndicator(opt)}
            >
              {COMBINED_INDICATOR_LABELS[opt]}
            </Button>
          ))}
        </div>
      </div>

      {/* TEMPORARY DIAGNOSTIC — remove once P/E TTM sourcing is confirmed working correctly. */}
      {history?.quarterly && (
        <div className="mb-3 rounded-md border border-dashed border-amber-500/60 bg-amber-500/10 px-3 py-2 text-[11px] font-mono">
          <div>
            [DEBUG] trimestres totais: {history.quarterly.length} | c/ netIncome:{" "}
            {history.quarterly.filter((q) => q.netIncome != null).length} | c/ sharesOutstanding:{" "}
            {history.quarterly.filter((q) => q.sharesOutstanding != null).length} | c/ epsDiluted:{" "}
            {history.quarterly.filter((q) => q.epsDiluted != null).length}
          </div>
          <div className="mt-1">
            todos: {JSON.stringify(history.quarterly.map((q) => ({
              y: q.year,
              q: q.quarter,
              ni: q.netIncome,
              sh: q.sharesOutstanding,
              eps: q.epsDiluted,
            })))}
          </div>
        </div>
      )}

      {!isLoading && chartData.length > 0 && (
        <div className="mb-4 grid grid-cols-1 gap-2 rounded-lg border border-border/60 bg-card/40 p-3 text-xs sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Variação da Cotação - 10 anos / último ano</span>
            <span className="font-medium">
              <PctBadge pct={priceFullPeriodPct} /> <span className="text-muted-foreground">/</span>{" "}
              <PctBadge pct={priceYoy} />
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              Variação {COMBINED_INDICATOR_LABELS[indicator]} - 10 anos / último ano
            </span>
            <span className="font-medium">
              <PctBadge pct={indicatorFullPeriodPct} /> <span className="text-muted-foreground">/</span>{" "}
              <PctBadge pct={indicatorYoy} />
            </span>
          </div>
        </div>
      )}

      <div className="h-72 sm:h-96">
        {isLoading ? (
          <div className="h-full w-full animate-pulse rounded bg-muted/40" />
        ) : chartData.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Dados de cotação indisponíveis para esta ação
          </div>
        ) : quartersWithData === 0 ? (
          <div className="grid h-full place-items-center px-4 text-center text-sm text-muted-foreground">
            Não há dados trimestrais de "{COMBINED_INDICATOR_LABELS[indicator]}" disponíveis
            para esta ação.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              onMouseMove={(state: any) => {
                if (state?.isTooltipActive && typeof state.activeTooltipIndex === "number") {
                  setActiveIndex(state.activeTooltipIndex);
                } else {
                  setActiveIndex(null);
                }
              }}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#B794F4" />
                  <stop offset="100%" stopColor="#4F46E5" />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickFormatter={(d) => String(d).slice(0, 4)}
                ticks={xTicks}
                tickLine={false}
                minTickGap={20}
              />
              <YAxis
                yAxisId="price"
                orientation="left"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickFormatter={(v) => fmtCompact(Number(v), currency).replace(/[A-Z$€]/g, "")}
                tickLine={false}
                width={48}
              />
              <YAxis
                yAxisId="indicator"
                orientation="right"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickFormatter={(v) =>
                  indicator === "peTTM"
                    ? `${Number(v).toFixed(0)}x`
                    : fmtCompact(Number(v), currency).replace(/[A-Z$€]/g, "")
                }
                tickLine={false}
                width={56}
              />
              <Tooltip
                cursor={false}
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "var(--popover-foreground)",
                }}
                labelStyle={{ color: "var(--popover-foreground)" }}
                itemStyle={{ color: "var(--popover-foreground)" }}
                labelFormatter={(d) => String(d)}
                formatter={(value: number, name: string, item: any) => {
                  if (name === "Cotação") {
                    const pct = priceBase ? ((value - priceBase) / priceBase) * 100 : null;
                    const pctStr = pct != null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)` : "";
                    return [`${fmtMoney(value, currency)}${pctStr}`, name];
                  }
                  if (value == null) return null;
                  const key = String(item?.payload?.quarterKey ?? "");
                  const pct = indicatorPctFromStart.get(key);
                  const pctStr = pct != null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)` : "";
                  return [`${formatIndicatorValue(value)}${pctStr}`, COMBINED_INDICATOR_LABELS[indicator]];
                }}
              />
              <Bar
                yAxisId="indicator"
                dataKey="indicatorBarValue"
                name={COMBINED_INDICATOR_LABELS[indicator]}
                legendType="none"
                isAnimationActive={false}
                shape={makeHighlightBar(activeIndex, gradientId, 18) as any}
              />
              {/* Invisible line carrying the indicator's value on every day of its quarter
                  (not just the quarter's last day, where the bar itself sits) — this is
                  what lets the tooltip show the indicator's value/variation no matter which
                  day within that quarter the user is hovering over. */}
              <Line
                yAxisId="indicator"
                type="stepAfter"
                dataKey="indicatorTooltipValue"
                name={COMBINED_INDICATOR_LABELS[indicator]}
                stroke="transparent"
                strokeWidth={0}
                dot={false}
                activeDot={false}
                legendType="none"
                connectNulls
                isAnimationActive={false}
              />
              <Line
                yAxisId="price"
                type="monotone"
                dataKey="price"
                name="Cotação"
                stroke="#F2C744"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
        Linha roxa: cotação ({currency}, eixo esquerdo, diária). Barras:{" "}
        {COMBINED_INDICATOR_LABELS[indicator]} ({indicator === "peTTM" ? "x" : currency}, eixo
        direito, trimestral). "Homólogo" compara o último trimestre com o mesmo trimestre do
        ano anterior. Passa o rato sobre o gráfico para ver o valor e a variação % desde o
        início do período.
      </p>
    </Card>
  );
}

function StockSkeleton() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-20 pt-6 sm:px-6 lg:px-10">
      <Skeleton className="h-6 w-20" />
      <Skeleton className="mt-4 h-8 w-2/3" />
      <Skeleton className="mt-2 h-8 w-40" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <Skeleton className="mt-6 h-40" />
      <Skeleton className="mt-6 h-40" />
    </div>
  );
}
