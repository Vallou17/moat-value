import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search, Loader2 } from "lucide-react";
import { searchStocks } from "@/lib/fmp.functions";
import { Input } from "@/components/ui/input";

type Result = { ticker: string; name: string; exchange: string; currency: string };

export function StockSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchStocks({ data: { query: q } });
        setResults(r);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function go(ticker: string) {
    navigate({ to: "/stock/$ticker", params: { ticker } });
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) go(results[0].ticker);
          }}
          placeholder="Pesquisar ação (ex: AAPL, Microsoft)"
          autoFocus={autoFocus}
          className="h-12 pl-10 pr-10 text-base"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
          <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto">
            {results.map((r) => (
              <li key={r.ticker + r.exchange}>
                <button
                  type="button"
                  onClick={() => go(r.ticker)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent"
                >
                  <div>
                    <div className="font-medium">{r.ticker}</div>
                    <div className="text-sm text-muted-foreground">{r.name}</div>
                  </div>
                  <span className="text-xs text-muted-foreground">{r.exchange}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
