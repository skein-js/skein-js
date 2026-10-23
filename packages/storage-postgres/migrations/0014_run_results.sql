-- Up Migration
-- Immutable per-run output for protocol consumers; excluded from ordinary Run projections.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS result JSONB;
