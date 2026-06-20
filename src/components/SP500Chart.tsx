import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
} from "recharts";
import { ArrowDown, ArrowUp, LineChart } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getMarketSnapshot, getIndexHistory, type Candle } from "@/lib/fmp.functions";

type Range = "1M" | "1A" | "3A" | "5A";
const RANGES: Range[] = ["1M", "1A", "3A", "5A"];

const MONTHS_PT = [
  "Jan.", "Fev.", "Mar.", "Abr.", "Mai.", "Jun.",
  "Jul.", "Ago.", "Set.", "Out.", "Nov.", "Dez.",
];

// "2026-06-15" -> for 1M: "01 Jun." | for 1A/3A/5A (weekly candles): "15 Jun."
function formatAxisDate(dateStr: string, range: Range): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const month = MONTHS_PT[d.getMonth()];
  const day = String(d.getDate()).padStart(2, "0");
  if (range === "1M") return `${day} ${month}`;
  return `${day} ${month}`;
}

// ISO week key, e.g. "2026-W25" — weeks run Monday to Sunday.
function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Aggregate daily candles into one candle per ISO week (Mon–Sun).
// open = first trading day's open, close = last trading day's close,
// high/low = extremes across the week. Date = the week's first trading day (for labels).
function aggregateWeekly(daily: Candle[]): Candle[] {
  const byWeek = new Map<string, Candle[]>();
  for (const c of daily) {
    const key = isoWeekKey(new Date(c.date));
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key)!.push(c);
  }
  const weeks = Array.from(byWeek.keys()).sort();
  return weeks.map((key) => {
    const group = byWeek.get(key)!.slice().sort((a, b) => a.date.localeCompare(b.date));
    const open = group[0].open;
    const close = group[group.length - 1].close;
    const high = Math.max(...group.map((c) => c.high));
    const low = Math.min(...group.map((c) => c.low));
    return { date: group[0].date, open, close, high, low };
  });
}

// Pick every Nth tick value from a sorted list of dates, always including the first and last.
function sampledTicks(dates: string[], step: number): string[] {
  if (dates.length === 0) return [];
  const picked: string[] = [];
  for (let i = 0; i < dates.length; i += step) picked.push(dates[i]);
  if (picked[picked.length - 1] !== dates[dates.length - 1]) {
    picked.push(dates[dates.length - 1]);
  }
  return picked;
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("pt-PT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// Custom candlestick shape. Recharts passes the bar's own pixel rect:
//   props.y = scale(payload.high), props.y+props.height = scale(domainMin)
// We invert that to project any price → pixel y.
function makeCandlestick(domain: [number, number] | undefined) {
  return function Candlestick(props: any) {
    const { x, y, width, height, payload } = props;
    if (!payload || !domain || height <= 0) return null;
    const { open, close, high, low } = payload as Candle;
    const [domainMin] = domain;
    const denom = high - domainMin;
    if (denom <= 0) return null;
    const pxPerUnit = height / denom;
    const project = (v: number) => y + (high - v) * pxPerUnit;
    const up = close >= open;
    const color = up ? "var(--success)" : "var(--destructive)";
    const yHigh = project(high);
    const yLow = project(low);
    const yOpen = project(open);
    const yClose = project(close);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    const cx = x + width / 2;
    const bodyW = Math.max(1, width * 0.7);
    return (
      <g>
        <line x1={cx} x2={cx} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1} />
        <rect
          x={cx - bodyW / 2}
          y={bodyTop}
          width={bodyW}
          height={bodyH}
          fill={color}
          stroke={color}
        />
      </g>
    );
  };
}

function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const c = payload[0].payload as Candle;
  const up = c.close >= c.open;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{c.date}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
        <span>Abertura</span><span className="text-right text-foreground">{fmtNum(c.open)}</span>
        <span>Máximo</span><span className="text-right text-foreground">{fmtNum(c.high)}</span>
        <span>Mínimo</span><span className="text-right text-foreground">{fmtNum(c.low)}</span>
        <span>Fecho</span>
        <span className={`text-right ${up ? "text-success" : "text-destructive"}`}>
          {fmtNum(c.close)}
        </span>
      </div>
    </div>
  );
}

export function SP500Chart() {
  const [range, setRange] = useState<Range>("1A");

  const snapshot = useQuery({
    queryKey: ["market-snapshot"],
    queryFn: () => getMarketSnapshot(),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
  const sp = snapshot.data?.find((q) => q.symbol === "^GSPC");

  const history = useQuery({
    queryKey: ["index-history", "^GSPC", range],
    queryFn: () => getIndexHistory({ data: { symbol: "^GSPC", range } }),
    staleTime: 5 * 60_000,
  });

  const chartData = useMemo<Candle[]>(() => {
    const d = history.data;
    if (!d || d.length === 0) return [];
    return range === "1M" ? d : aggregateWeekly(d);
  }, [history.data, range]);

  const xTicks = useMemo(() => {
    const dates = chartData.map((c) => c.date);
    if (range === "1M") return sampledTicks(dates, 5); // every ~5 days
    if (range === "1A") return sampledTicks(dates, 4); // every ~4 weeks (~monthly)
    if (range === "3A") return sampledTicks(dates, 12); // every ~12 weeks (~quarterly)
    return sampledTicks(dates, 20); // 5A: every ~20 weeks
  }, [chartData, range]);

  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (chartData.length === 0) return undefined;
    let lo = Infinity, hi = -Infinity;
    for (const c of chartData) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    const pad = (hi - lo) * 0.05;
    return [Math.floor(lo - pad), Math.ceil(hi + pad)];
  }, [chartData]);

  // % change from the first to the last candle in the selected period.
  const periodVariation = useMemo(() => {
    if (chartData.length < 2) return null;
    const first = chartData[0].open;
    const last = chartData[chartData.length - 1].close;
    if (!first) return null;
    return ((last - first) / first) * 100;
  }, [chartData]);

  const RANGE_LABELS: Record<Range, string> = {
    "1M": "no último mês",
    "1A": "no último ano",
    "3A": "nos últimos 3 anos",
    "5A": "nos últimos 5 anos",
  };

  const up = (sp?.changePercent ?? 0) >= 0;

  return (
    <Card className="flex h-full flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <LineChart className="h-4 w-4 text-primary" /> Evolução do mercado (S&amp;P 500)
          </h2>
          {sp ? (
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <span className="text-2xl font-bold">{fmtNum(sp.price)}</span>
              <span
                className={`inline-flex items-center gap-0.5 text-sm font-medium ${
                  up ? "text-success" : "text-destructive"
                }`}
              >
                {up ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                {(sp.changePercent >= 0 ? "+" : "") + sp.changePercent.toFixed(2)}% hoje
              </span>
              {periodVariation !== null && (
                <span
                  className={`inline-flex items-center gap-0.5 text-sm font-medium ${
                    periodVariation >= 0 ? "text-success" : "text-destructive"
                  }`}
                >
                  {periodVariation >= 0 ? (
                    <ArrowUp className="h-3.5 w-3.5" />
                  ) : (
                    <ArrowDown className="h-3.5 w-3.5" />
                  )}
                  {(periodVariation >= 0 ? "+" : "") + periodVariation.toFixed(2)}%{" "}
                  {RANGE_LABELS[range]}
                </span>
              )}
            </div>
          ) : (
            <div className="mt-1 h-7 w-32 animate-pulse rounded bg-muted" />
          )}
        </div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <Button
              key={r}
              variant={range === r ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      </div>

      <div className="h-[360px] w-full">
        {history.isLoading ? (
          <div className="h-full w-full animate-pulse rounded bg-muted/40" />
        ) : history.isError || chartData.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Dados de mercado indisponíveis
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickFormatter={(d) => formatAxisDate(String(d), range)}
                ticks={xTicks}
                minTickGap={20}
              />
              <YAxis
                domain={yDomain ?? ["auto", "auto"]}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickFormatter={(v) => `${Math.round(Number(v)).toLocaleString("pt-PT")} $`}
                width={70}
                orientation="right"
              />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--border)" }} />
              <Bar dataKey="high" shape={makeCandlestick(yDomain) as any} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}
