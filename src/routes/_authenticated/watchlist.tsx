import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Star, Trash2, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getStockData } from "@/lib/fmp.functions";
import { computeDcf, discountPremiumPct } from "@/lib/dcf";
import { fmtMoney, fmtPct } from "@/lib/format";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/watchlist")({
  component: WatchlistPage,
});

type Row = {
  id: string;
  ticker: string;
  company_name: string | null;
  price?: number;
  iv?: number;
  dp?: number;
  currency?: string;
  loading?: boolean;
  err?: string;
};

function WatchlistPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("watchlist")
        .select("id, ticker, company_name")
        .order("added_at", { ascending: false });
      if (error) {
        toast.error(error.message);
        setLoading(false);
        return;
      }
      const initial: Row[] = (data ?? []).map((r) => ({ ...r, loading: true }));
      setRows(initial);
      setLoading(false);

      // Fetch DCFs in parallel
      initial.forEach(async (row) => {
        try {
          const d = await getStockData({ data: { ticker: row.ticker } });
          const r = computeDcf({
            startingFcf: d.fcfAdjusted,
            growthRate1to5: d.baseGrowthRate,
            growthRate6to10: d.baseGrowthRate / 2,
            growthRate11to20: d.baseGrowthRate / 4,
            discountRate: 0.05,
            sharesOutstanding: d.sharesOutstanding,
            totalDebt: d.totalDebt,
            cash: d.cash,
          });
          setRows((prev) =>
            prev.map((x) =>
              x.id === row.id
                ? {
                    ...x,
                    price: d.price,
                    iv: r.intrinsicValuePerShare,
                    dp: discountPremiumPct(d.price, r.intrinsicValuePerShare),
                    currency: d.currency,
                    loading: false,
                  }
                : x,
            ),
          );
        } catch (e) {
          setRows((prev) =>
            prev.map((x) =>
              x.id === row.id ? { ...x, loading: false, err: (e as Error).message } : x,
            ),
          );
        }
      });
    })();
  }, []);

  async function remove(id: string) {
    await supabase.from("watchlist").delete().eq("id", id);
    setRows((prev) => prev.filter((r) => r.id !== id));
    toast.success("Removido");
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8">
      <h1 className="flex items-center gap-2 text-2xl font-bold">
        <Star className="h-5 w-5 text-primary" /> A minha watchlist
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Valor intrínseco calculado com DCF Ajustado (CAPEX Médio 4A) e taxa de desconto 5%.
      </p>

      {loading ? (
        <div className="mt-8 grid place-items-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <Card className="mt-6 p-8 text-center text-sm text-muted-foreground">
          A sua watchlist está vazia. Pesquise uma ação e adicione-a.
        </Card>
      ) : (
        <div className="mt-6 space-y-2">
          {rows.map((r) => (
            <Card key={r.id} className="p-4">
              <div className="flex flex-wrap items-center gap-4">
                <Link
                  to="/stock/$ticker"
                  params={{ ticker: r.ticker }}
                  className="min-w-0 flex-1"
                >
                  <div className="font-semibold">{r.ticker}</div>
                  <div className="truncate text-sm text-muted-foreground">
                    {r.company_name ?? ""}
                  </div>
                </Link>
                {r.loading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : r.err ? (
                  <span className="text-xs text-destructive">{r.err}</span>
                ) : (
                  <>
                    <div className="text-right">
                      <div className="text-[11px] text-muted-foreground">Preço</div>
                      <div className="text-sm font-medium">
                        {fmtMoney(r.price ?? 0, r.currency ?? "USD")}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] text-muted-foreground">Valor Intrínseco</div>
                      <div className="text-sm font-medium">
                        {fmtMoney(r.iv ?? 0, r.currency ?? "USD")}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] text-muted-foreground">Diferença</div>
                      <div
                        className={
                          "text-sm font-semibold " +
                          ((r.dp ?? 0) < 0 ? "text-success" : "text-destructive")
                        }
                      >
                        {(r.dp ?? 0) < 0 ? "" : "+"}
                        {fmtPct(r.dp ?? 0, 1)}
                      </div>
                    </div>
                  </>
                )}
                <Button variant="ghost" size="icon" onClick={() => remove(r.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
