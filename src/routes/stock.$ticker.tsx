import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  type StockData,
  type StockHistoryResponse,
  type MoatCategoryResult,
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
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" /> Análise de
            Moat (IA)
          </h2>

          {moatQuery.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {moatQuery.data.categories.map((c) => (
                <MoatCategoryCard key={c.category} result={c} />
              ))}
            </div>
          )}
          <p className="mt-4 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
            <Info className="mt-[1px] h-3 w-3 shrink-0" />
            <span>
              Análise gerada por IA com base no conhecimento geral sobre a empresa, sem acesso
              a dados financeiros em tempo real — serve como ponto de partida, não como
              recomendação de investimento.
            </span>
          </p>
        </Card>
      </section>
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
function makeHighlightBar(activeIndex: number | null) {
  return function HighlightBar(props: any) {
    const { x, y, width, height, index } = props;
    if (!Number.isFinite(height) || !Number.isFinite(y)) return null;

    // Recharts can hand us a negative `height` for bars below the zero baseline
    // (negative FCF years) — drawing a <rect> with a negative height renders nothing,
    // so normalize to a positive size and keep y pinned to the bar's actual top edge.
    const absHeight = Math.abs(height);
    const top = height < 0 ? y + height : y;
    const isActive = index === activeIndex;

    return (
      <rect
        x={x}
        y={top}
        width={width}
        height={Math.max(absHeight, 1)}
        rx={6}
        ry={6}
        fill="var(--primary)"
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
              shape={makeHighlightBar(activeIndex) as any}
            />
          </BarChart>
        </ResponsiveContainer>
        )}
      </div>
    </div>
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
