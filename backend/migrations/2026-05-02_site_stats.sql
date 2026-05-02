-- Migration: add site_stats table
-- Applied: 2026-05-02
-- Purpose: single-row cache of aggregate stats so the frontend never runs
--          count(*) on the messages table. Updated at the end of every ingest.

CREATE TABLE IF NOT EXISTS site_stats (
    singleton_id     BOOLEAN     PRIMARY KEY DEFAULT TRUE,
    CONSTRAINT       only_one_row CHECK (singleton_id = TRUE),
    total_messages   BIGINT      NOT NULL DEFAULT 0,
    total_reactions  BIGINT      NOT NULL DEFAULT 0,
    member_count     BIGINT      NOT NULL DEFAULT 0,
    date_range_start TIMESTAMPTZ,
    date_range_end   TIMESTAMPTZ,
    last_ingested_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE site_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read site_stats" ON site_stats;
CREATE POLICY "anon can read site_stats" ON site_stats FOR SELECT USING (true);

-- Seed from live data (safe to re-run — ON CONFLICT upserts)
INSERT INTO site_stats (
    singleton_id, total_messages, total_reactions, member_count,
    date_range_start, date_range_end, last_ingested_at
)
SELECT
    TRUE,
    COUNT(*) FILTER (WHERE message_type = 'message'),
    (SELECT COUNT(*) FROM reactions),
    COUNT(DISTINCT sender) FILTER (WHERE message_type = 'message'),
    MIN(timestamp) FILTER (WHERE message_type = 'message'),
    MAX(timestamp) FILTER (WHERE message_type = 'message'),
    NOW()
FROM messages
ON CONFLICT (singleton_id) DO UPDATE SET
    total_messages   = EXCLUDED.total_messages,
    total_reactions  = EXCLUDED.total_reactions,
    member_count     = EXCLUDED.member_count,
    date_range_start = EXCLUDED.date_range_start,
    date_range_end   = EXCLUDED.date_range_end,
    last_ingested_at = EXCLUDED.last_ingested_at;
