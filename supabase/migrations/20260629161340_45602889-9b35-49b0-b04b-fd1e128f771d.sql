ALTER TABLE public.moat_cache RENAME TO moat_analysis_cache;
ALTER TABLE public.moat_analysis_cache RENAME COLUMN analysis_json TO categories;
ALTER TABLE public.moat_analysis_cache RENAME COLUMN generated_at TO updated_at;
ALTER TABLE public.moat_analysis_cache ADD CONSTRAINT moat_analysis_cache_ticker_key UNIQUE (ticker);