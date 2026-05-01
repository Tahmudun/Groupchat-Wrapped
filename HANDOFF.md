# HANDOFF — current session state

*Last updated: 2026-04-30*

## What's in flight

**Building the weekly Instagram export ingestion pipeline.** Tah will be re-exporting the group chat from Instagram roughly weekly. Each export covers a custom date range he picks, and ranges *will* overlap with previously-loaded data. The system needs to ingest cleanly — no duplicates, no manual bookkeeping, no broken state — and the live frontend stats need to reflect the new totals afterward.

**Trigger model:** manual now (CLI script), web UI later. Build the ingestion as a single callable function so the future admin page can call the same code path.

**Currently waiting on:** the next Instagram export from Tah. Once those JSON files land in `data/flix/`, run the pipeline against them.

## Design decisions (settled — don't relitigate)

1. **Dedupe via content hash, not date tracking.** Add a `content_hash CHAR(64) UNIQUE NOT NULL` column to `messages`. Hash is SHA-256 of `(sender_name, timestamp_ms, content, message_type)`. Parser uses `INSERT ... ON CONFLICT (content_hash) DO NOTHING`. Same scheme on `reactions` with hash over `(message_hash, actor, reaction, timestamp_ms)`. This makes re-running the parser on the same files a no-op, and overlapping exports merge cleanly without any "which files have I seen" state.

2. **`site_stats` table for live counters.** Single row, written at the end of every ingestion run. Holds `total_messages`, `total_reactions`, `member_count`, `date_range_start`, `date_range_end`, `last_ingested_at`. Frontend `init()` reads this one row instead of running `count(*)` on the big tables — faster cold start *and* the displayed counts always match what the script intends.

3. **Ingestion is idempotent.** Hash-based dedupe + a single `site_stats` row that gets fully recomputed (not incremented) means a partial/failed run can simply be re-run.

## Build plan (in order)

### Step 1 — Schema changes

New migration: `backend/migrations/2026-04-30_ingestion_pipeline.sql`

- `ALTER TABLE messages ADD COLUMN content_hash CHAR(64)` — nullable initially so backfill can happen, then `NOT NULL` + `UNIQUE` after backfill.
- `ALTER TABLE reactions ADD COLUMN content_hash CHAR(64)` — same pattern.
- `CREATE TABLE site_stats` (single-row table — enforce with a `CHECK` constraint on a `singleton_id` column, or just trust the script).
- Index on `messages(content_hash)` (UNIQUE constraint creates this automatically).

Sync into `supabase/schema.sql` in the same commit.

### Step 2 — Backfill existing data

One-off script: `backend/backfill_content_hash.py`

- Loops over existing `messages` and `reactions`, computes hash per row, writes it back.
- 477k messages + 401k reactions — batch in chunks of 5k, this should run in a few minutes.
- After backfill completes, run a follow-up migration to add `NOT NULL` and `UNIQUE` constraints.

### Step 3 — Refactor the parser

`backend/parser.py` becomes `backend/ingest.py` (or keep the name, but restructure). Single entry point:

```python
def ingest_export(export_dir: Path) -> IngestResult:
    """
    Idempotent. Safe to call on previously-ingested exports.
    Returns counts: messages_inserted, messages_skipped (dupes), reactions_inserted, etc.
    """
```

Key behaviors:
- Reads all `message_*.json` files in the export dir.
- For each message: compute content_hash, build the row, batch insert with `ON CONFLICT (content_hash) DO NOTHING`.
- Same for reactions.
- After the inserts, recompute `site_stats` from a single SQL query and `UPSERT` the singleton row.
- Returns a result dict (don't `print` from inside the function — log it). The CLI wrapper prints; the future web endpoint will return JSON.

CLI wrapper: `python -m backend.ingest data/flix/inbox/<chat_folder>` invokes `ingest_export()` and prints the result.

### Step 4 — Update frontend init()

In `app.js`, replace the `count(*)` warmup query and the `get_distinct_senders()` call with a single `select * from site_stats limit 1` plus the senders RPC. The senders dropdown still needs the RPC — only the *counts* move to `site_stats`. This should also help the cold-start bug since the heavy `count(*)` goes away.

### Step 5 — Verify on real data

Once Tah's next export lands:
1. Run ingestion against the new export.
2. Confirm result dict shows non-zero `messages_inserted` and some `messages_skipped` (the overlap with existing data).
3. Hard-refresh the site, confirm `site_stats` reflects the new totals, confirm date range in syslog is updated.
4. Try running the same ingestion *again* on the same export — should show 0 inserted, all skipped. That's the idempotency check.

## Open questions for Tah

- **Where does `data/flix/` live exactly when a new export comes in?** Instagram exports as a zip with `messages/inbox/<chat_name>/message_1.json`, `message_2.json`, etc. Does Tah extract into `data/flix/inbox/<chat_name>/` and overwrite, or keep each export in its own dated subfolder? (Recommendation: each export in its own folder, e.g. `data/flix/2026-05-04/`. Keeps a paper trail and makes it possible to re-run a specific export if needed.)
- **Reactions schema:** confirm what fields are stored. The hash design assumes `(message_hash, actor, reaction, timestamp_ms)` is enough — verify against `schema.sql` before writing the migration.
- **`site_stats` date range — is it the min/max of `messages.timestamp_ms`, or specifically the date range Tah requested at export time?** Recommendation: min/max of actual data, which automatically reflects whatever's in the DB.

## Not blocking, but on the radar

- Cold-start connectivity bug from previous session may resolve once `init()` stops calling `count(*)` on a 477k row table. Worth re-testing after Step 4.
- Eventual web UI for ingestion — when it gets built, it'll need: an upload endpoint that accepts a zip, extracts to a temp dir, calls `ingest_export()`, returns the result dict as JSON. Auth-gated to Tah only.
- Mobile audit on the user's phone is still pending (was blocked on the connectivity bug last session).

## What was done last session (for context)

- Mobile dropdown bugs fixed (selection on web/mobile, scroll vs. tap distinction, list height for iOS).
- Click-on-search-result → context view feature shipped (chat-bubble thread ±6 hours around the anchor message, back button overlay).
- Empty results message + busy-state lock on search/pagination buttons.
- Filter dropdown visibility on initial load.

The site is close to deploy-ready. Ingestion pipeline is the last big infrastructure piece before Netlify.
