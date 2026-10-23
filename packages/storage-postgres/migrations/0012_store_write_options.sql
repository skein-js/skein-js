-- Up Migration
ALTER TABLE store_items ADD COLUMN IF NOT EXISTS index_fields jsonb;
