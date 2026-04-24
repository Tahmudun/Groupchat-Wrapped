-- ============================================================================
-- Groupchat Analytics — Database Schema
-- ============================================================================
-- This file is the single source of truth for the database structure.
-- It is idempotent: safe to run multiple times against the same database.
-- Running it against a fresh Postgres instance should produce a database
-- functionally identical to production.
--
-- Apply by pasting into Supabase Dashboard → SQL Editor → Run.
--
-- Last rebuilt from live database introspection: 2026-04-23
-- ============================================================================


-- ============================================================================
-- SECTION 1: TABLES
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TABLE: messages
-- ----------------------------------------------------------------------------
-- One row per Instagram DM event. The `id` column is an MD5 hash generated in
-- parser.py from (sender + timestamp + content). Same message parsed twice
-- hashes identically, so ON CONFLICT DO NOTHING makes re-imports idempotent.
--
-- NOTE: `message_type` distinguishes real messages from system events
-- (user added, user left, shared location, etc.). 99% of app queries want
-- only message_type='message'. Pure reactors (people who only reacted but
-- never sent a message) DO appear in this table via reaction_type rows,
-- which is why filtering is required everywhere.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT        PRIMARY KEY,       -- MD5 hash from parser.py
    sender          TEXT        NOT NULL,          -- post-encoding-fix username
    timestamp_ms    BIGINT      NOT NULL,          -- raw Unix ms, precise sorting
    timestamp       TIMESTAMPTZ NOT NULL,          -- human-readable, date filters
    content         TEXT        NOT NULL DEFAULT '', -- '' for media-only
    media_type      TEXT        NULL,              -- 'photo'|'video'|'audio'|'gif'|'reel'|'link'|NULL
    message_type    TEXT        NOT NULL DEFAULT 'message', -- 'message'|'system'|'reaction'|etc
    -- Generated tsvector column for full-text search.
    -- Content is weighted 'A' (highest), sender 'B'. 'english' config gives
    -- us stemming so 'running' matches 'ran', 'runs', etc. Sender uses
    -- 'simple' to avoid stemming usernames.
    search_vector   TSVECTOR    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(content, '')), 'A') ||
        setweight(to_tsvector('simple',  coalesce(sender,  '')), 'B')
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_messages_sender        ON messages (sender);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp     ON messages (timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_media_type    ON messages (media_type) WHERE media_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_message_type  ON messages (message_type);
CREATE INDEX IF NOT EXISTS idx_messages_search_vector ON messages USING GIN (search_vector);


-- ----------------------------------------------------------------------------
-- TABLE: reactions
-- ----------------------------------------------------------------------------
-- One row per emoji reaction. Same user can react to same message with
-- multiple different emojis, so PK is the full triple. ON DELETE CASCADE
-- means deleting a message cleans up its reactions automatically.
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
-- TABLE: members
-- ----------------------------------------------------------------------------
-- Human-curated metadata about every sender in the chat. Separate from the
-- messages table so we can edit it without touching the raw data.
--
-- status values: 'unrecognized' (default for new/unknown), 'active',
-- 'banned', 'removed', 'reporter-suspected'. Free-text check constraint
-- defined inline below — we don't use a strict enum to make it easy to add
-- new categories from the Members tab without a migration.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
    username    TEXT        PRIMARY KEY,
    alias       TEXT        NULL,                                     -- friendly display name
    status      TEXT        NOT NULL DEFAULT 'unrecognized'
                CHECK (status IN ('unrecognized', 'active', 'banned', 'removed', 'reporter-suspected')),
    notes       TEXT        NULL,                                     -- free-text
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_status ON members (status);


-- ============================================================================
-- SECTION 2: FUNCTIONS (RPCs callable from frontend)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- FUNCTION: search_messages
-- ----------------------------------------------------------------------------
-- Primary search RPC. Returns matching messages ranked by relevance (when
-- keyword present) then by timestamp descending. All filter params are
-- nullable — pass NULL to skip.
--
-- KNOWN ISSUES (flagged for next session):
--   1. LEFT JOIN reactions + GROUP BY is expensive; same bug we just fixed
--      in count_messages. High-volume sender-only searches can time out.
--   2. Missing WHERE m.message_type = 'message' filter — system events
--      (adds/leaves) still leak into results.
--   3. Planned: add sort_order parameter for user-controlled ordering.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_messages(
    query_text    TEXT    DEFAULT NULL,
    filter_sender TEXT    DEFAULT NULL,
    filter_media  TEXT    DEFAULT NULL,
    start_date    TIMESTAMPTZ DEFAULT NULL,
    end_date      TIMESTAMPTZ DEFAULT NULL,
    min_reactions INT     DEFAULT 0,
    result_limit  INT     DEFAULT 50,
    result_offset INT     DEFAULT 0
)
RETURNS TABLE (
    id            TEXT,
    sender        TEXT,
    ts            TIMESTAMPTZ,
    content       TEXT,
    media_type    TEXT,
    reaction_count BIGINT,
    rank          REAL
)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  tsq tsquery;
BEGIN
  IF query_text IS NOT NULL AND trim(query_text) <> '' THEN
    tsq := plainto_tsquery('english', query_text);
  END IF;

  RETURN QUERY
  SELECT
    m.id,
    m.sender,
    m.timestamp                                        AS ts,
    m.content,
    m.media_type,
    COUNT(r.emoji)                                     AS reaction_count,
    COALESCE(
      CASE WHEN tsq IS NOT NULL
        THEN ts_rank(m.search_vector, tsq)
      END,
      0.0
    )                                                  AS rank
  FROM messages m
  LEFT JOIN reactions r ON r.message_id = m.id
  WHERE
    (tsq IS NULL OR m.search_vector @@ tsq)
    AND (filter_sender IS NULL OR m.sender     = filter_sender)
    AND (filter_media  IS NULL OR m.media_type = filter_media)
    AND (start_date    IS NULL OR m.timestamp  >= start_date)
    AND (end_date      IS NULL OR m.timestamp  <= end_date)
  GROUP BY m.id, m.sender, m.timestamp, m.content, m.media_type, m.search_vector
  HAVING COUNT(r.emoji) >= min_reactions
  ORDER BY
    CASE WHEN tsq IS NOT NULL
      THEN ts_rank(m.search_vector, tsq)
    END DESC NULLS LAST,
    m.timestamp DESC
  LIMIT  result_limit
  OFFSET result_offset;
END;
$$;


-- ----------------------------------------------------------------------------
-- FUNCTION: count_messages
-- ----------------------------------------------------------------------------
-- Lightweight count RPC for pagination ("Page 3 of 47"). Same filter logic
-- as search_messages but returns only COUNT(*). Intentionally avoids the
-- reactions join when min_reactions = 0 — that join was previously causing
-- timeouts on keyword-only searches.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION count_messages(
    query_text    TEXT    DEFAULT NULL,
    filter_sender TEXT    DEFAULT NULL,
    filter_media  TEXT    DEFAULT NULL,
    start_date    TIMESTAMPTZ DEFAULT NULL,
    end_date      TIMESTAMPTZ DEFAULT NULL,
    min_reactions INT     DEFAULT 0
)
RETURNS BIGINT
LANGUAGE SQL STABLE AS $$
  SELECT COUNT(*)::BIGINT
  FROM messages m
  WHERE
    m.message_type = 'message'
    AND (query_text IS NULL OR query_text = '' OR m.search_vector @@ websearch_to_tsquery('english', query_text))
    AND (filter_sender IS NULL OR m.sender = filter_sender)
    AND (filter_media IS NULL OR m.media_type = filter_media)
    AND (start_date IS NULL OR m.timestamp >= start_date)
    AND (end_date IS NULL OR m.timestamp <= end_date)
    AND (
      min_reactions = 0
      OR (SELECT COUNT(*) FROM reactions WHERE message_id = m.id) >= min_reactions
    );
$$;


-- ----------------------------------------------------------------------------
-- FUNCTION: get_distinct_senders
-- ----------------------------------------------------------------------------
-- Powers the sender dropdown on every tab. Returns a JSONB array with each
-- sender's username, alias, status, and message count — joined against
-- members table so the UI shows friendly names.
--
-- Returns JSONB (not a table) to sidestep PostgREST's default 1,000-row cap
-- that was truncating our sender list to 11 senders early in the project.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_distinct_senders()
RETURNS JSONB
LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'sender',        m.sender,
        'alias',         mem.alias,
        'status',        COALESCE(mem.status, 'unrecognized'),
        'message_count', m.msg_count
      )
      ORDER BY m.msg_count DESC, m.sender
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT sender, COUNT(*) AS msg_count
    FROM messages
    WHERE message_type = 'message'
    GROUP BY sender
  ) m
  LEFT JOIN members mem ON mem.username = m.sender;
$$;


-- ----------------------------------------------------------------------------
-- FUNCTION: get_members_with_counts
-- ----------------------------------------------------------------------------
-- Powers the Members tab. Returns every row from the members table plus
-- a live message count joined from messages. LEFT JOIN ensures members
-- with zero messages (pure reactors we added manually) still appear.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_members_with_counts()
RETURNS TABLE (
    username       TEXT,
    alias          TEXT,
    status         TEXT,
    notes          TEXT,
    message_count  BIGINT
)
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT
    m.username,
    m.alias,
    m.status,
    m.notes,
    COUNT(msg.id) AS message_count
  FROM members m
  LEFT JOIN messages msg ON msg.sender = m.username
  GROUP BY m.username, m.alias, m.status, m.notes
  ORDER BY message_count DESC;
$$;


-- ----------------------------------------------------------------------------
-- FUNCTION: update_member
-- ----------------------------------------------------------------------------
-- Single-row UPDATE wrapper for the Members tab edit form. SECURITY DEFINER
-- so anon key can call it without needing direct write permission on the
-- members table.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_member(
    p_username TEXT,
    p_alias    TEXT,
    p_status   TEXT,
    p_notes    TEXT
)
RETURNS VOID
LANGUAGE SQL SECURITY DEFINER AS $$
  UPDATE members SET
    alias      = p_alias,
    status     = p_status,
    notes      = p_notes,
    updated_at = now()
  WHERE username = p_username;
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
-- For the Timeline tab. Given a center timestamp and a window in hours,
-- returns per-sender activity stats (count + first/last msg time) within
-- the window. Useful for "what was happening in the chat around the time
-- X's account got taken down?"
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


-- ============================================================================
-- SECTION 3: ROW LEVEL SECURITY
-- ============================================================================
-- All three tables have RLS enabled. The anon key (shipped to the browser)
-- can READ all tables and UPDATE only the members table. All inserts and
-- message/reaction mutations go through the backend with the service_role
-- key, which bypasses RLS entirely.
-- ============================================================================

ALTER TABLE messages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE members   ENABLE ROW LEVEL SECURITY;

-- Drop first so re-running the file doesn't error on duplicate policies.
DROP POLICY IF EXISTS "anon can read messages"   ON messages;
DROP POLICY IF EXISTS "anon can read reactions"  ON reactions;
DROP POLICY IF EXISTS "anon can read members"    ON members;
DROP POLICY IF EXISTS "anon can update members"  ON members;

CREATE POLICY "anon can read messages"   ON messages  FOR SELECT USING (true);
CREATE POLICY "anon can read reactions"  ON reactions FOR SELECT USING (true);
CREATE POLICY "anon can read members"    ON members   FOR SELECT USING (true);
CREATE POLICY "anon can update members"  ON members   FOR UPDATE USING (true);


-- ============================================================================
-- SECTION 4: FUNCTION GRANTS
-- ============================================================================
-- Allow anon + authenticated roles to call each RPC from the frontend.
-- ============================================================================

GRANT EXECUTE ON FUNCTION search_messages         TO anon, authenticated;
GRANT EXECUTE ON FUNCTION count_messages          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_distinct_senders    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_members_with_counts TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_member           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION find_interactions       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION activity_around         TO anon, authenticated;