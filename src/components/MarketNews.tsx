import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Newspaper } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getMarketNews } from "@/lib/fmp.functions";

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} d`;
}

export function MarketNews() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["market-news"],
    queryFn: () => getMarketNews(),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:mb-4 sm:gap-2 sm:text-sm">
        <Newspaper className="h-4 w-4 text-primary" /> Últimas notícias
      </h2>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              <div className="h-4 w-full animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : isError || !data || data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Notícias indisponíveis.</p>
      ) : (
        <ul className="space-y-3">
          {data.map((n, i) => (
            <li key={i} className="border-b border-border/40 pb-3 last:border-0 last:pb-0">
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group block"
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-primary">{n.source || "Notícias"}</span>
                  <span>•</span>
                  <span>{relativeTime(n.publishedAt)}</span>
                </div>
                <p className="text-sm leading-snug text-foreground transition-colors group-hover:text-primary">
                  {n.title}
                  <ExternalLink className="ml-1 inline h-3 w-3 opacity-60" />
                </p>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
