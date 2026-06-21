import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowDownRight,
  ArrowUpRight,
  RotateCcw,
  Sparkles,
  Star,
  AlertTriangle,
  ChevronDown,
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
import { getStockData, type StockData } from "@/lib/fmp.functions";
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

  return <StockView data={data} />;
}

function StockView({ data }: { data: StockData }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [inWatch, setInWatch] = useState(false);
  const [savingWatch, setSavingWatch] = useState(false);

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
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-6">
      <Button
        variant="ghost"
        size="sm"
        className="mb-4 -ml-2"
        onClick={() => navigate({ to: "/" })}
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
      </Button>

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-start gap-3">
          {data.logoUrl && (
            <img
              src={data.logoUrl}
              alt={data.companyName}
              className="mt-1 h-10 w-10 rounded-lg border border-border/60 bg-white object-contain p-1 sm:h-12 sm:w-12"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded bg-secondary px-2 py-0.5 font-medium">{data.ticker}</span>
              {data.exchange && <span>{data.exchange}</span>}
            </div>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
              {data.companyName}
            </h1>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="text-3xl font-semibold">{fmtMoney(data.price, data.currency)}</span>
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
                {fmtPct(data.changePercent, 2)}
              </span>
            </div>
          </div>
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

      {/* Intrinsic value */}
      <div className="mt-6 grid gap-4 sm:grid-cols-1">
        <IvCard
          label="Valor Intrínseco"
          iv={ivAdjusted.intrinsicValuePerShare}
          price={data.price}
          currency={data.currency}
        />
      </div>

      {/* Assumptions */}
      <Collapsible defaultOpen className="mt-6">
        <Card className="p-0">
          <CollapsibleTrigger className="flex w-full items-center justify-between p-5 text-left">
            <div>
              <h2 className="text-base font-semibold">Personalizar Pressupostos</h2>
              <p className="text-xs text-muted-foreground">
                Ajuste e veja o valor intrínseco recalculado em tempo real.
              </p>
            </div>
            <ChevronDown className="h-4 w-4 transition-transform data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t border-border/60 p-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Taxa de Desconto (%)" value={discountRate} step={0.1} onChange={setDiscountRate} />
              <Field label="Crescimento FCF Anos 1–5 (%)" value={g1} step={0.1} onChange={setG1} />
              <Field label="Crescimento FCF Anos 6–10 (%)" value={g2} step={0.1} onChange={setG2} />
              <Field label="Crescimento FCF Anos 11–20 (%)" value={g3} step={0.1} onChange={setG3} />
            </div>
            <Button variant="ghost" size="sm" className="mt-4" onClick={reset}>
              <RotateCcw className="mr-2 h-3.5 w-3.5" /> Repor valores originais
            </Button>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Metrics */}
      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Métricas Financeiras
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Metric label="Free Cash Flow" value={fmtCompact(data.freeCashFlow, data.currency)} />
          <Metric label="Operating Cash Flow" value={fmtCompact(data.operatingCashFlow, data.currency)} />
          <Metric label="CAPEX (último ano)" value={fmtCompact(data.capex, data.currency)} />
          <Metric label="CAPEX Médio 4A" value={fmtCompact(data.meanCapex4y, data.currency)} />
          <Metric label="FCF Ajustado" value={fmtCompact(data.fcfAdjusted, data.currency)} />
          <Metric label="Dívida Total" value={fmtCompact(data.totalDebt, data.currency)} />
          <Metric label="Caixa & Equivalentes" value={fmtCompact(data.cash, data.currency)} />
          <Metric label="Ações em Circulação" value={fmtCompact(data.sharesOutstanding, data.currency).replace(/[^\d.,KMBT]/g, "")} />
          <Metric label="P/E" value={data.peRatio != null ? data.peRatio.toFixed(2) : "—"} />
          <Metric label="ROIC" value={data.roic != null ? fmtPct(data.roic * 100, 1) : "—"} />
        </div>
      </section>

      {/* Charts */}
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <ChartCard title="Receita (últimos anos)" data={data.history} dataKey="revenue" currency={data.currency} />
        <ChartCard title="Free Cash Flow (últimos anos)" data={data.history} dataKey="fcf" currency={data.currency} />
      </section>

      {/* Moat (placeholder) */}
      <section className="mt-6">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Sparkles className="h-4 w-4 text-primary" /> Análise de Moat (IA)
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Análise de vantagens competitivas gerada por IA — disponível em breve.
              </p>
            </div>
            <Button disabled variant="secondary">Em breve</Button>
          </div>
        </Card>
      </section>
    </div>
  );
}

function IvCard({
  label,
  iv,
  price,
  currency,
}: {
  label: string;
  iv: number;
  price: number;
  currency: string;
}) {
  const dp = discountPremiumPct(price, iv); // negative = undervalued, positive = overvalued
  const discount = dp < 0;
  const valid = isFinite(iv) && iv > 0;

  // Map dp (%) to a 0..1 gauge position. Clamp at +/-60% so extreme cases don't break the needle.
  const clamped = Math.max(-60, Math.min(60, dp));
  const gaugeT = (clamped + 60) / 120; // 0 = far undervalued, 1 = far overvalued

  return (
    <Card className="p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>

      {valid ? (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-10 gap-y-1 text-center">
            <div>
              <div className="text-xs text-muted-foreground">Valor Intrínseco</div>
              <div className="text-xl font-bold sm:text-2xl">{fmtMoney(iv, currency)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Cotação Atual</div>
              <div className="text-xl font-bold sm:text-2xl">{fmtMoney(price, currency)}</div>
            </div>
          </div>

          <Gauge t={gaugeT} />

          <div
            className={
              "mx-auto -mt-2 w-fit rounded-full px-3 py-1 text-center text-sm font-semibold " +
              (discount ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive")
            }
          >
            {Math.abs(dp).toFixed(1)}% {discount ? "abaixo" : "acima"} do valor intrínseco
          </div>
        </>
      ) : (
        <div className="mt-2 text-3xl font-bold">—</div>
      )}
    </Card>
  );
}

// Semi-circular gauge, 5 colored zones from undervalued (green) to overvalued (red),
// with a needle pointing at position t (0..1).
function Gauge({ t }: { t: number }) {
  const cx = 150;
  const cy = 140;
  const r = 110;
  const zones = [
    "#2E8B3D", // strongly undervalued
    "#8FC76B", // mildly undervalued
    "#F2C744", // fair value
    "#EF9F3C", // mildly overvalued
    "#D9483D", // strongly overvalued
  ];
  const zoneAngle = 180 / zones.length;

  const polarToXY = (angleDeg: number, radius: number) => {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx - radius * Math.cos(rad), y: cy - radius * Math.sin(rad) };
  };

  const arcPath = (startDeg: number, endDeg: number, radius: number) => {
    const p1 = polarToXY(startDeg, radius);
    const p2 = polarToXY(endDeg, radius);
    return `M ${p1.x} ${p1.y} A ${radius} ${radius} 0 0 1 ${p2.x} ${p2.y}`;
  };

  // needle: t=0 -> 180deg (left/undervalued), t=1 -> 0deg (right/overvalued)
  const needleAngle = 180 - t * 180;
  const needleTip = polarToXY(needleAngle, r - 22);
  const needleBase1 = polarToXY(needleAngle + 90, 6);
  const needleBase2 = polarToXY(needleAngle - 90, 6);

  return (
    <svg viewBox="0 0 300 165" className="mx-auto w-full max-w-[300px]">
      {zones.map((color, i) => {
        const start = 180 - i * zoneAngle;
        const end = 180 - (i + 1) * zoneAngle;
        return (
          <path
            key={i}
            d={arcPath(start, end, r)}
            stroke={color}
            strokeWidth={26}
            fill="none"
            strokeLinecap="butt"
          />
        );
      })}
      {/* needle */}
      <polygon
        points={`${needleTip.x},${needleTip.y} ${needleBase1.x},${needleBase1.y} ${needleBase2.x},${needleBase2.y}`}
        fill="var(--foreground)"
      />
      <circle cx={cx} cy={cy} r={8} fill="var(--foreground)" />
      <text x={cx - r + 8} y={cy + 22} fontSize="11" fill="var(--muted-foreground)" textAnchor="start">
        Subavaliada
      </text>
      <text x={cx + r - 8} y={cy + 22} fontSize="11" fill="var(--muted-foreground)" textAnchor="end">
        Sobreavaliada
      </text>
    </svg>
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </Card>
  );
}

function ChartCard({
  title,
  data,
  dataKey,
  currency,
}: {
  title: string;
  data: { year: number; revenue: number; fcf: number }[];
  dataKey: "revenue" | "fcf";
  currency: string;
}) {
  return (
    <Card className="p-4">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="year" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickFormatter={(v) => fmtCompact(v, currency).replace(/[A-Z$€]/g, "")}
              width={48}
            />
            <Tooltip
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(v: number) => fmtCompact(v, currency)}
            />
            <Bar dataKey={dataKey} fill="var(--primary)" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function StockSkeleton() {
  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-6">
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
