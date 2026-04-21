-- ============================================================================
-- Groupchat Analytics — Database Schema
-- ============================================================================
-- This file defines every table, index, and function in the database.
-- Apply it by pasting the whole thing into Supabase Dashboard → SQL Editor → Run.
-- It is idempotent: safe to run multiple times (uses IF NOT EXISTS everywhere).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- TABLE: messages
-- ----------------------------------------------------------------------------
-- One row per message. The `id` column is the MD5 hash generated in parser.py
-- from (sender + timestamp + content). That makes every message uniquely
-- identifiable by its content, which is the key to dedup-on-reimport:
-- if the same message is parsed again, it hashes to the same id, and
-- ON CONFLICT DO NOTHING makes the second insert a silent no-op.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT        PRIMARY KEY,       -- MD5 hash from parser.py
    sender          TEXT        NOT NULL,          -- post-encoding-fix username
    timestamp_ms    BIGINT      NOT NULL,          -- raw Unix ms, for precise sorting
    timestamp       TIMESTAMPTZ NOT NULL,          -- human-readable, for date filters
    content         TEXT        NOT NULL DEFAULT '', -- '' for media-only messages
    media_type      TEXT        NULL,              -- 'photo'|'video'|'audio'|'gif'|'reel'|'link'|NULL
    -- tsvector column used for full-text search. Generated automatically from
    -- content + sender so we never have to populate it by hand. 'english'
    -- config handles stemming (search 'running' → matches 'ran', 'runs').
    search_vector   TSVECTOR    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(content, '')), 'A') ||
        setweight(to_tsvector('simple',  coalesce(sender,  '')), 'B')
    ) STORED
);

-- Indexes for the filters your UI will actually use:
CREATE INDEX IF NOT EXISTS idx_messages_sender        ON messages (sender);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp     ON messages (timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_media_type    ON messages (media_type) WHERE media_type IS NOT NULL;
-- GIN index on the tsvector — this is what makes full-text search fast.
CREATE INDEX IF NOT EXISTS idx_messages_search_vector ON messages USING GIN (search_vector);


-- ----------------------------------------------------------------------------
-- TABLE: reactions
-- ----------------------------------------------------------------------------
-- One row per reaction. A single message can have many reactions, and a
-- single user can react to the same message multiple times with different
-- emojis, so the PRIMARY KEY is the combination of all three columns.
-- ON DELETE CASCADE: if a message is ever deleted, its reactions go too.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reactions (
    message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reactor     TEXT NOT NULL,
    emoji       TEXT NOT NULL,
    PRIMARY KEY (message_id, reactor, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_reactor ON reactions (reactor);
CREATE INDEX IF NOT EXISTS idx_reactions_emoji   ON reactions (emoji);


-- ----------------------------------------------------------------------------
-- FUNCTION: search_messages
-- ----------------------------------------------------------------------------
-- Custom search RPC the frontend will call via supabase.rpc('search_messages').
-- Takes optional filters, returns matching messages ranked by relevance.
-- All params are NULL-able: pass NULL to skip that filter.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_messages(
    query_text    TEXT    DEFAULT NULL,
    filter_sender TEXT    DEFAULT NULL,
    filter_media  TEXT    DEFAULT NULL,
    start_date    TIMESTAMPTZ DEFAULT NULL,
    end_date      TIMESTAMPTZ DEFAULT NULL,
    min_reactions INT     DEFAULT 0,
    result_limit  INT     DEFAULT 100,
    result_offset INT     DEFAULT 0
)
RETURNS TABLE (
    id            TEXT,
    sender        TEXT,
    ts            TIMESTAMPTZ,   -- renamed from `timestamp` (reserved word)
    content       TEXT,
    media_type    TEXT,
    reaction_count BIGINT,
    rank          REAL
)
LANGUAGE SQL STABLE AS $$
    SELECT
        m.id,
        m.sender,
        m.timestamp AS ts,       -- aliased to match return-table name
        m.content,
        m.media_type,
        COALESCE(r.cnt, 0) AS reaction_count,
        CASE
            WHEN query_text IS NULL OR query_text = '' THEN 0::REAL
            ELSE ts_rank(m.search_vector, websearch_to_tsquery('english', query_text))
        END AS rank
    FROM messages m
    LEFT JOIN (
        SELECT message_id, COUNT(*)::BIGINT AS cnt
        FROM reactions
        GROUP BY message_id
    ) r ON r.message_id = m.id
    WHERE
        (query_text    IS NULL OR query_text = '' OR m.search_vector @@ websearch_to_tsquery('english', query_text))
        AND (filter_sender IS NULL OR m.sender     = filter_sender)
        AND (filter_media  IS NULL OR m.media_type = filter_media)
        AND (start_date    IS NULL OR m.timestamp >= start_date)
        AND (end_date      IS NULL OR m.timestamp <= end_date)
        AND (COALESCE(r.cnt, 0) >= min_reactions)
    ORDER BY
        CASE WHEN query_text IS NULL OR query_text = '' THEN 0 ELSE 1 END DESC,
        rank DESC,
        m.timestamp DESC
    LIMIT result_limit
    OFFSET result_offset;
$$;


-- ----------------------------------------------------------------------------
-- FUNCTION: find_interactions
-- ----------------------------------------------------------------------------
-- Temporal-adjacency "replies". Given two users A and B and a time window
-- in seconds, returns every pair (A_msg, B_msg) where B sent a message
-- within `window_seconds` AFTER A. Approximates "B replied to A".
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_interactions(
    user_a         TEXT,
    user_b         TEXT,
    window_seconds INT DEFAULT 60,
    result_limit   INT DEFAULT 200
)
RETURNS TABLE (
    a_id         TEXT,
    a_timestamp  TIMESTAMPTZ,
    a_content    TEXT,
    b_id         TEXT,
    b_timestamp  TIMESTAMPTZ,
    b_content    TEXT,
    gap_seconds  INT
)
LANGUAGE SQL STABLE AS $$
    SELECT
        a.id         AS a_id,
        a.timestamp  AS a_timestamp,
        a.content    AS a_content,
        b.id         AS b_id,
        b.timestamp  AS b_timestamp,
        b.content    AS b_content,
        EXTRACT(EPOCH FROM (b.timestamp - a.timestamp))::INT AS gap_seconds
    FROM messages a
    JOIN messages b
        ON b.sender = user_b
       AND b.timestamp >  a.timestamp
       AND b.timestamp <= a.timestamp + (window_seconds || ' seconds')::INTERVAL
    WHERE a.sender = user_a
    ORDER BY a.timestamp DESC
    LIMIT result_limit;
$$;


-- ----------------------------------------------------------------------------
-- FUNCTION: activity_around
-- ----------------------------------------------------------------------------
-- For the reporter-hunting timeline view. Given a center timestamp and a
-- window in hours, returns every message in that window plus per-sender
-- counts. Useful for "what happened in the chat in the 24h before X's
-- account got taken down?"
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION activity_around(
    center_time   TIMESTAMPTZ,
    window_hours  INT DEFAULT 24
)
RETURNS TABLE (
    sender        TEXT,
    message_count BIGINT,
    first_msg     TIMESTAMPTZ,
    last_msg      TIMESTAMPTZ
)
LANGUAGE SQL STABLE AS $$
    SELECT
        sender,
        COUNT(*)::BIGINT AS message_count,
        MIN(timestamp) AS first_msg,
        MAX(timestamp) AS last_msg
    FROM messages
    WHERE timestamp BETWEEN center_time - (window_hours || ' hours')::INTERVAL
                        AND center_time + (window_hours || ' hours')::INTERVAL
    GROUP BY sender
    ORDER BY message_count DESC;
$$;


-- ----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- Supabase enables RLS by default on new tables accessed via the API.
-- For a private analytics tool, we lock these tables down so the `anon` key
-- (used by the frontend) can only READ. All writes go through the backend
-- with the service_role key, which bypasses RLS.
-- ----------------------------------------------------------------------------
ALTER TABLE messages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;

-- Drop first so re-running the file doesn't error on duplicate policies.
DROP POLICY IF EXISTS "anon can read messages"  ON messages;
DROP POLICY IF EXISTS "anon can read reactions" ON reactions;

CREATE POLICY "anon can read messages"  ON messages  FOR SELECT USING (true);
CREATE POLICY "anon can read reactions" ON reactions FOR SELECT USING (true);

-- Let the anon key call our search functions too:
GRANT EXECUTE ON FUNCTION search_messages    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION find_interactions  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION activity_around    TO anon, authenticated;