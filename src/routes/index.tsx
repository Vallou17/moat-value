import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { TrendingUp, Star, Clock, ChevronRight } from "lucide-react";
import { StockSearch } from "@/components/StockSearch";
import { MarketTicker } from "@/components/MarketTicker";
import { SP500Chart } from "@/components/SP500Chart";
import { MarketNews } from "@/components/MarketNews";
import { Card } from "@/components/ui/card";
import { getRecent } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ValueScope — Análise de Valor Intrínseco" },
      {
        name: "description",
        content:
          "Pesquise qualquer ação e veja imediatamente o seu valor intrínseco calculado por DCF.",
      },
    ],
  }),
  component: Home,
});

type Watch = { ticker: string; company_name: string | null };

function Home() {
  const { user } = useAuth();
  const [recent, setRecent] = useState<{ ticker: string; name: string }[]>([]);
  const [watchlist, setWatchlist] = useState<Watch[]>([]);

  useEffect(() => {
    setRecent(getRecent());
  }, []);

  useEffect(() => {
    if (!user) {
      setWatchlist([]);
      return;
    }
    supabase
      .from("watchlist")
      .select("ticker, company_name")
      .order("added_at", { ascending: false })
      .limit(6)
      .then(({ data }) => setWatchlist(data ?? []));
  }, [user]);

  return (
    <>
      <MarketTicker />

      <div className="mx-auto max-w-[1400px] px-6 pb-20 lg:px-10">
        {/* Hero */}
        <section className="mx-auto max-w-3xl pt-10 text-center sm:pt-16">
          <div className="mx-auto inline-flex max-w-md items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-1.5 text-center text-xs text-muted-foreground">
            <TrendingUp className="h-3 w-3 shrink-0 text-primary" /> Valor intrínseco calculado
            através de algoritmo próprio derivado do método Discounted Cash Flow
          </div>
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-5xl">
            Sabes se uma ação está <span className="text-primary">valorizada</span> ou{" "}
            <span className="text-primary">desvalorizada</span>?
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground sm:text-base">
            Pesquisa qualquer ação e fica a conhecer o seu valor intrínseco.
          </p>
          <div className="mt-8">
            <StockSearch autoFocus />
          </div>
        </section>

        {/* Chart + News */}
        <section className="mt-12 grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <SP500Chart />
          </div>
          <div className="lg:col-span-2">
            <MarketNews />
          </div>
        </section>

        {/* Watchlist */}
        {watchlist.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Star className="h-4 w-4 text-primary" /> Watchlist
            </h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {watchlist.map((w) => (
                <TickerCard key={w.ticker} ticker={w.ticker} name={w.company_name ?? ""} />
              ))}
            </div>
          </section>
        )}

        {recent.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Clock className="h-4 w-4" /> Vistos recentemente
            </h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {recent.map((r) => (
                <TickerCard key={r.ticker} ticker={r.ticker} name={r.name} />
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function TickerCard({ ticker, name }: { ticker: string; name: string }) {
  return (
    <Link to="/stock/$ticker" params={{ ticker }}>
      <Card className="flex items-center justify-between gap-3 p-4 transition-colors hover:border-primary/60 hover:bg-accent/40">
        <div className="min-w-0">
          <div className="font-semibold">{ticker}</div>
          <div className="truncate text-sm text-muted-foreground">{name}</div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </Card>
    </Link>
  );
}

