
CREATE TABLE public.price_history_cache (
  symbol TEXT PRIMARY KEY,
  candles JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.price_history_cache TO anon, authenticated;
GRANT ALL ON public.price_history_cache TO service_role;
ALTER TABLE public.price_history_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read price history cache" ON public.price_history_cache FOR SELECT USING (true);
