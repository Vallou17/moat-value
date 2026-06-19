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

// "2026-06-15" -> for 1M: "Jun." | for 1A/3A/5A: "Jun. 26"
function formatAxisDate(dateStr: string, range: Range): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const month = MONTHS_PT[d.getMonth()];
  if (range === "1M") return month;
  const yy = String(d.getFullYear()).slice(2);
  return `${month} ${yy}`;
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
  const [range, setRange] = useState<Range>("1M");

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

  const yDomain = useMemo<[number, number] | undefined>(() => {
    const d = history.data;
    if (!d || d.length === 0) return undefined;
    let lo = Infinity, hi = -Infinity;
    for (const c of d) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    const pad = (hi - lo) * 0.05;
    return [lo - pad, hi + pad];
  }, [history.data]);

  const up = (sp?.changePercent ?? 0) >= 0;

  return (
    <Card className="flex h-full flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <LineChart className="h-4 w-4 text-primary" /> Evolução do mercado
          </h2>
          {sp ? (
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold">{fmtNum(sp.price)}</span>
              <span
                className={`inline-flex items-center gap-0.5 text-sm font-medium ${
                  up ? "text-success" : "text-destructive"
                }`}
              >
                {up ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                {(sp.changePercent >= 0 ? "+" : "") + sp.changePercent.toFixed(2)}%
              </span>
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

      <div className="h-[280px] w-full">
        {history.isLoading ? (
          <div className="h-full w-full animate-pulse rounded bg-muted/40" />
        ) : history.isError || !history.data || history.data.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Dados de mercado indisponíveis
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={history.data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickFormatter={(d) => formatAxisDate(String(d), range)}
                minTickGap={30}
              />
              <YAxis
                domain={yDomain ?? ["auto", "auto"]}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickFormatter={(v) => fmtNum(Number(v))}
                width={60}
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
