-- Optional camera-object configuration for media and character zones.
-- JSONB keeps this experimental feature additive while its authoring controls
-- evolve; all existing zones remain unaffected with a NULL configuration.
alter table public.zones
  add column if not exists ar_config jsonb;
