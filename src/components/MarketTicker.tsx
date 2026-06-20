import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { getMarketSnapshot, type MarketQuote } from "@/lib/fmp.functions";

function fmtPrice(symbol: string, n: number): string {
  const digits = symbol === "EURUSD" ? 4 : 2;
  return new Intl.NumberFormat("pt-PT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}
function fmtPctSigned(n: number): string {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

function TickerItem({ q }: { q: MarketQuote }) {
  const up = q.changePercent >= 0;
  return (
    <div className="flex shrink-0 items-center gap-2 px-5 text-xs">
      <span className="font-medium text-foreground">{q.name}</span>
      <span className="text-muted-foreground">{fmtPrice(q.symbol, q.price)}</span>
      <span
        className={`inline-flex items-center gap-0.5 font-medium ${
          up ? "text-success" : "text-destructive"
        }`}
      >
        {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
        {fmtPctSigned(q.changePercent)}
      </span>
      <span className="text-border">•</span>
    </div>
  );
}

export function MarketTicker() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["market-snapshot"],
    queryFn: () => getMarketSnapshot(),
    refetchInterval: 10 * 60_000,
    staleTime: 9 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="border-b border-border/60 bg-card/30">
        <div className="h-8 animate-pulse" />
      </div>
    );
  }
  if (isError || !data || data.length === 0) {
    return (
      <div className="border-b border-border/60 bg-card/30">
        <div className="flex h-8 items-center justify-center text-xs text-muted-foreground">
          Dados de mercado indisponíveis
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden border-b border-border/60 bg-card/30">
      <div className="flex h-8 w-max animate-marquee items-center">
        {[...data, ...data].map((q, i) => (
          <TickerItem key={`${q.symbol}-${i}`} q={q} />
        ))}
      </div>
    </div>
  );
}
