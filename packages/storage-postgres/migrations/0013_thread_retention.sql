-- Up Migration
ALTER TABLE threads ADD COLUMN IF NOT EXISTS ttl_strategy text;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS ttl_pinned boolean NOT NULL DEFAULT false;
-- Older rows do not distinguish explicit pins from unconfigured retention. Preserve their pins.
UPDATE threads SET ttl_pinned = true WHERE ttl_minutes IS NULL;
