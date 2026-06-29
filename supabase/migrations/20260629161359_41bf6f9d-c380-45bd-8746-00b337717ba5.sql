CREATE TABLE public.stock_fundamentals_cache (
  ticker text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.stock_fundamentals_cache TO anon, authenticated;
GRANT ALL ON public.stock_fundamentals_cache TO service_role;
ALTER TABLE public.stock_fundamentals_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read stock fundamentals cache" ON public.stock_fundamentals_cache FOR SELECT USING (true);

CREATE TABLE public.edgar_history_cache (
  ticker text PRIMARY KEY,
  history jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.edgar_history_cache TO anon, authenticated;
GRANT ALL ON public.edgar_history_cache TO service_role;
ALTER TABLE public.edgar_history_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read edgar history cache" ON public.edgar_history_cache FOR SELECT USING (true);