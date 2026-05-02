# GC Dossier — Claude Code Context File

*Last updated: 2026-05-02. Read this before touching anything.*

---

## What this project is

**GC Dossier** (folder: `Groupchat-Wrapped`) is a search hub for an Instagram group chat archive. Tah exported ~3 years of Instagram DMs from a friend group, parsed and loaded them into Postgres via Supabase, and built a vanilla-JS frontend to search/filter/explore them. Three tabs: Search (full-text + filters), Interactions (find when User B replied to User A within a time window), Timeline (who was active around a specific moment).

**Stack:** Vanilla HTML/CSS/JS (no build step), Supabase free tier (Postgres + PostgREST RPCs + RLS), Python backend scripts.

**Live site:** Deployed on Netlify, connected to the GitHub repo (`Tahmudun/Groupchat-Wrapped`). Every push to `main` auto-deploys.

**DB credentials:** `.env` at project root has `SUPABASE_DB_URL` (direct Postgres connection string). You can run SQL directly from Python — see *Direct DB Access* below. Don't copy-paste SQL into the Supabase dashboard unless there's a reason.

---

## Current DB state (as of 2026-05-02)

| Table | Rows |
|---|---|
| messages | 477,415 |
| reactions | 401,746 |
| members | 1,322 (573 active, 749 status='removed') |
| site_stats | 1 (singleton row) |

**messages date range:** 2025-12-30 → 2026-03-27 (from the first export)

**member status values:** `'recognized'`, `'unrecognized'`, `'deleted'`, `'removed'`
- `removed` = person who appears in members but has zero real messages. Hidden from dropdowns/search by default. Pass `include_inactive=TRUE` to RPCs to see them.

---

## Key files

```
frontend/
  index.html          — structure
  style.css           — all styles including mobile breakpoint (600px)
  app.js              — all frontend logic

backend/
  parser.py           — Instagram JSON → Python dicts (pure parser, no DB)
  db.py               — DB connection + bulk insert + site_stats update
  import_data.py      — CLI entry point: python backend/import_data.py <folder>
  migrations/         — dated SQL files, one per schema change

supabase/
  schema.sql          — single source of truth for DB structure. Idempotent.

data/
  flix/               — Instagram export JSON files (gitignored)
    2026-03-27/       — first export (already ingested)
    <next-date>/      — future exports go here, one dated subfolder each time

.env                  — SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, SUPABASE_DB_URL
```

---

## Direct DB access

The project uses psycopg2 with a direct Postgres connection. You can run SQL without copy-pasting into Supabase:

```python
source venv/bin/activate
python - <<'EOF'
import sys
sys.path.insert(0, 'backend')
from db import get_connection, log

with get_connection() as conn:
    with conn.cursor() as cur:
        cur.execute("YOUR SQL HERE")
        # conn.autocommit = True  # needed for DDL like CREATE INDEX
EOF
```

Use this for migrations, one-off queries, and anything that would otherwise require the Supabase dashboard.

---

## Ingestion pipeline

When a new Instagram export is ready:

1. Extract the zip. Put the `message_*.json` files in a **new dated subfolder**: `data/flix/YYYY-MM-DD/`
2. Run: `python backend/import_data.py data/flix/YYYY-MM-DD/`
3. The script parses → bulk inserts → updates `site_stats` in one shot.
4. **After every import, run ANALYZE** (stale stats cause search timeouts):
   ```python
   with get_connection() as conn:
       conn.autocommit = True
       with conn.cursor() as cur:
           cur.execute("ANALYZE messages")
           cur.execute("ANALYZE reactions")
   ```

**Dedup is automatic.** Message IDs are MD5 of `(sender_name, timestamp_ms, content)`. Reactions have a composite PK. Both use `ON CONFLICT DO NOTHING`. Overlapping export date ranges are safe — duplicates silently skip. Running the same export twice inserts 0 rows.

**Connection timeout fix (already done):** `db.py` uses three separate connections (messages → reactions → site_stats) and TCP keepalives. This prevents Supabase/PgBouncer from dropping the socket during long batches.

---

## RPCs (PostgREST functions callable from frontend)

All live in `supabase/schema.sql`. Four of them accept `include_inactive BOOLEAN DEFAULT FALSE`:

| RPC | Purpose |
|---|---|
| `search_messages(...)` | Primary search. V4 two-path query (see below). |
| `count_messages(...)` | Pagination count. Same filters as search. |
| `get_distinct_senders(include_inactive)` | Powers sender dropdown. Returns JSONB. |
| `get_members_with_counts(include_inactive)` | Powers Members tab. |
| `update_member(username, alias, status, notes)` | Admin edit. SECURITY DEFINER. |
| `find_interactions(user_a, user_b, window_seconds, limit)` | Interactions tab. |
| `activity_around(center_time, window_hours)` | Timeline tab. |

**`search_messages` performance history (important context):**
- V1/V2: various timeout issues
- V3: CTE-based — caused a seqscan on all 443k messages when reactions filter was active, timed out
- **V4 (current, 2026-05-02):** Two-path split:
  - *Fast path* (`needs_reactions = FALSE`): GIN index for keyword, correlated subquery for reaction count on the 50 returned rows only
  - *Reactions path* (`min_reactions > 0` or `sort = most_reactions`): aggregates reactions first via `idx_reactions_message_id` (index-only scan), pre-sorts + limits inside subquery to force PK lookups into messages instead of seqscan
- Warm benchmarks: keyword 0.14s, min_reactions=5/most_reactions 0.21s, sender filter 0.03s

**Indexes on reactions:** `reactor`, `emoji`, `message_id` (added 2026-05-02 — critical for the reactions aggregate)

---

## `site_stats` table

Single-row cache for the frontend's header stats. Eliminates the slow `count(*)` on 477k rows that was causing cold-start timeouts.

Columns: `total_messages`, `total_reactions`, `member_count`, `date_range_start`, `date_range_end`, `last_ingested_at`

Updated automatically at the end of every `import_data.py` run. The frontend's `init()` reads this one row instead of querying the messages table.

---

## Known issues / things left to fix

### Sender name drift (display name changes)
**Problem:** Instagram uses your current display name at export time for ALL historical messages, not the name you had at message time. So when Tah changed his name from "Monkey T 🪴" to "Monkey T 🦋", the new export labeled all his messages — including months-old ones — as "Monkey T 🦋". Since the dedup hash includes sender_name, these look like new messages from a different person. Result: two separate member rows, split message counts, some true duplicates in the DB.

**Root cause:** MD5 dedup hash = `(sender_name, timestamp_ms, content)`. Name change → different hash → treated as new message.

**Planned fix (not yet built):** Admin page merge UI:
1. Show "potential duplicate members" (similar display names)
2. Confirm merge — pick canonical name
3. Merge operation:
   - Find true duplicates via `(timestamp_ms, content)` match across both senders → delete one
   - `UPDATE messages SET sender = canonical WHERE sender = alias`
   - Add alias to `members.aliases` for the canonical member
   - Collapse the two members rows into one
4. At ingest time: normalize sender name through aliases table before computing hash → future imports are dedup-correct

**Current workaround:** The `aliases` array on each member row can map multiple display name variants to one person for UI display purposes, but message counts are still split until the merge is run.

### ANALYZE after imports
Always run `ANALYZE messages; ANALYZE reactions;` after a new import. Stale stats cause search query plan flips that result in seqscans instead of index scans → timeouts. This should eventually be added to `import_data.py` automatically.

### Hardcoded syslog warning
`index.html` has a hardcoded `[WARN] 17,822 msgs attributed to deleted accounts` in the syslog bar. This number may be stale. "Instagram User" is the pseudo-member that all deactivated/banned accounts collapse into. Either pull live from DB or verify and update the static value.

### Mobile audit still pending
The 600px breakpoint CSS was written and deployed but never tested on a real phone. Walk through all three tabs on Tah's iPhone after any significant UI change.

---

## Admin page (not yet built)

Planned features, in rough priority order:
1. **Member merge UI** — see Sender name drift section above. This is the highest-value feature.
2. **Ingest trigger** — upload a zip or point at a folder, call `import_data.py`, show result dict as JSON
3. **Members table editor** — already has `update_member` RPC, just needs UI
4. **Alias picker / @-mention resolver** — uses `members.aliases` TEXT[] array

Auth: gate to Tah only. Implementation TBD (Supabase Auth or simple token check).

---

## What's been done (session history)

**Sessions 1–5 (pre-Claude Code):**
- Full parser rewrite: classifies 14 message types (`message`, `system_left`, `system_added`, etc.) to exclude system events from search/counts
- Migrated from SQLite to Supabase
- Added `bio_name` + `aliases` to members; backfilled 124 Instagram handles from system event content
- Added `status='removed'` to members; backfilled 749 silent members
- Added `include_inactive` parameter to four RPCs
- Fixed sender dropdown cap (was truncating to 11 senders via PostgREST default limit — solved by returning JSONB instead of a table)
- Mobile CSS patch (600px breakpoint)
- Cold-start fix: replaced async retry loop with `setTimeout`-based retries

**Session 6 (2026-04-29, Claude.ai web chat):**
- All the above session 5 work
- Handoff doc (`Groupchat_Wrapped_Handoff_Session6.docx`) written for transition to Claude Code

**Session 7 (2026-04-30 → 2026-05-02, Claude Code):**
- Fixed cold-start connectivity: replaced warmup ping + retry loop with plain `setTimeout`-based retries — this solved it
- Built context view: click any search result → thread view showing ±6 hours of chat around that message
- Shipped mobile dropdown fixes: selection on web/mobile, scroll vs tap, list height for iOS
- Empty results message + busy-state lock on search/pagination buttons
- Filter dropdown visibility on initial load
- **Deployed to Netlify** — added `netlify.toml` (publish dir = `frontend/`), connected GitHub repo, auto-deploy on push
- **Ingestion pipeline built:**
  - `site_stats` table created and seeded (singleton row, RLS anon read)
  - `db.py` updated: `insert_messages()` now calls site_stats upsert at the end
  - `app.js` `init()` now reads `site_stats` instead of `count(*)`
  - Three separate DB connections (messages / reactions / site_stats) + TCP keepalives to avoid Supabase PgBouncer timeout
  - Dated subfolder convention established: `data/flix/2026-03-27/` is the first import
- **Search performance fixed:**
  - Added `idx_reactions_message_id` index — eliminated 35MB disk spill in reactions aggregate
  - Rewrote `search_messages` to V4 (two-path: fast path + reactions path)
  - Ran `ANALYZE` after import

---

## About Tah

CS senior at Brooklyn College, graduating December 2026. Strong Python/DSA background (NeetCode 150+). His other project is **Flix** — a vanilla-JS group voting/tier-list app. This project is partly a portfolio piece during an active Summer 2026 internship search.

**Communication style:** direct and practical. He'll tell you when something's off. Follow his priority order when he gives one. He prefers real dev practices — git, schema migrations, modular files — over quick hacks.

**Workflow preferences:**
- Never copy-paste SQL into Supabase dashboard — use the direct psycopg2 connection
- Dated migration files for every schema change (`backend/migrations/YYYY-MM-DD_description.sql`)
- `supabase/schema.sql` stays in sync with live DB after every change
- Commits are logical units — schema change + migration in one commit
- Push to `main` = auto-deploy on Netlify, so test before pushing
