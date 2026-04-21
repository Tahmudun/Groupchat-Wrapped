"""
db.py — Database layer for groupchat-analytics.

This module is deliberately small. It has two responsibilities:

  1. Open a connection to our Supabase Postgres database.
  2. Insert parsed messages (and their reactions) in bulk, safely skipping
     any messages we've already stored.

Everything else — search queries, analytics — is either a SQL function in
supabase/schema.sql or a future Python module. Keeping db.py tiny means
it's easy to reason about and debug.

KEY IDEAS:

  * We use `psycopg2` (not the supabase-py client) because we need bulk
    inserts. Psycopg2's `execute_values` batches thousands of rows into a
    single SQL statement, which is ~50x faster than inserting one at a time.

  * Deduplication is handled by Postgres, not Python. Our `messages.id`
    column is a MD5 hash of the message's content, and it's the PRIMARY KEY.
    `ON CONFLICT (id) DO NOTHING` tells Postgres: "if a row with this id
    already exists, silently skip this insert." This is why re-importing
    the same JSON files is safe — duplicates just evaporate.

  * Secrets (the DB connection string) come from environment variables, NOT
    hardcoded. We load them from a `.env` file using python-dotenv.
"""

# --- Standard library ---
import os           # to read environment variables
import logging      # nicer than print() for status messages during long imports

# --- Third-party ---
import psycopg2                          # Postgres driver — the low-level workhorse
from psycopg2.extras import execute_values  # the bulk-insert helper
from dotenv import load_dotenv           # reads .env into os.environ

# Load .env from the project root. This walks up the directory tree looking
# for a .env file, so it works whether you run scripts from /backend or from
# the project root.
load_dotenv()

# Configure logging once, at module load. INFO level means we see progress
# messages but not debug noise.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("db")


# ----------------------------------------------------------------------------
# Connection
# ----------------------------------------------------------------------------

def get_connection():
    """
    Open a new Postgres connection to Supabase.

    Returns a psycopg2 connection object. The caller is responsible for
    closing it (or using it in a `with` block, which closes automatically).

    Raises RuntimeError if SUPABASE_DB_URL is missing, because that's the
    single most common setup mistake and we want a clear error message.
    """
    db_url = os.getenv("SUPABASE_DB_URL")
    if not db_url:
        raise RuntimeError(
            "SUPABASE_DB_URL not set. Copy .env.example to .env and fill it in."
        )
    # psycopg2.connect accepts the full postgres:// URL directly.
    return psycopg2.connect(db_url)


# ----------------------------------------------------------------------------
# Bulk insert
# ----------------------------------------------------------------------------

# How many rows to send in a single execute_values call. 1000 is a safe
# sweet spot — large enough to be fast, small enough not to blow memory
# or hit Postgres statement-size limits on a massive content field.
BATCH_SIZE = 1000


def insert_messages(parsed_messages):
    """
    Insert a list of parsed message dicts into the database, deduped.

    Each dict must have the shape produced by parser.py:
        {
          'id': str,          # MD5 hash — the PRIMARY KEY
          'sender': str,
          'timestamp_ms': int,
          'timestamp': str,   # '2024-03-15 14:32:07' format
          'content': str,
          'media_type': str | None,
          'reactions': list[{'emoji': str, 'actor': str}],
        }

    Returns a dict summarizing what happened:
        {
          'messages_seen':     int,  # total messages we tried to insert
          'messages_inserted': int,  # how many were actually new
          'reactions_seen':    int,
          'reactions_inserted': int,
        }
    """
    if not parsed_messages:
        log.info("Nothing to insert.")
        return {"messages_seen": 0, "messages_inserted": 0,
                "reactions_seen": 0, "reactions_inserted": 0}

    # We'll flatten reactions into their own list of tuples up front. This
    # means one pass over parsed_messages instead of two.
    message_rows = []      # tuples ready for the messages table
    reaction_rows = []     # tuples ready for the reactions table

    for msg in parsed_messages:
        message_rows.append((
            msg["id"],
            msg["sender"],
            msg["timestamp_ms"],
            msg["timestamp"],      # Postgres parses this string into TIMESTAMPTZ
            msg["content"],
            msg["media_type"],     # may be None — Postgres handles that
        ))
        # A message with zero reactions just contributes nothing here.
        for rxn in msg.get("reactions", []):
            reaction_rows.append((
                msg["id"],
                rxn["actor"],
                rxn["emoji"],
            ))

    log.info(f"Prepared {len(message_rows):,} messages and "
             f"{len(reaction_rows):,} reactions for insert.")

    # Open ONE connection for the whole job. Opening/closing 50 times
    # would waste seconds of network handshake per file.
    with get_connection() as conn:
        with conn.cursor() as cur:
            # ----- messages -----
            # ON CONFLICT (id) DO NOTHING is the magic for dedup. If the
            # MD5 id already exists in the table, this row is silently
            # skipped. The RETURNING id clause gives us back the ids of
            # rows that WERE inserted, so we can count them accurately.
            msg_insert_sql = """
                INSERT INTO messages (id, sender, timestamp_ms, timestamp, content, media_type)
                VALUES %s
                ON CONFLICT (id) DO NOTHING
                RETURNING id
            """
            inserted_msg_ids = []
            # Chunk the inserts so one bad row doesn't blow up 1M rows at once.
            for i in range(0, len(message_rows), BATCH_SIZE):
                chunk = message_rows[i:i + BATCH_SIZE]
                # execute_values expands `%s` into (%s,%s,%s,%s,%s,%s), (%s,...), ...
                # It's the fastest safe way to do bulk inserts in psycopg2.
                result = execute_values(
                    cur, msg_insert_sql, chunk, fetch=True
                )
                inserted_msg_ids.extend(row[0] for row in result)
                log.info(f"  messages: {i + len(chunk):,}/{len(message_rows):,} processed")

            # ----- reactions -----
            # Same pattern. Reactions have a composite primary key
            # (message_id, reactor, emoji), so the ON CONFLICT clause
            # targets all three columns together.
            rxn_insert_sql = """
                INSERT INTO reactions (message_id, reactor, emoji)
                VALUES %s
                ON CONFLICT (message_id, reactor, emoji) DO NOTHING
                RETURNING message_id
            """
            inserted_rxn_count = 0
            for i in range(0, len(reaction_rows), BATCH_SIZE):
                chunk = reaction_rows[i:i + BATCH_SIZE]
                result = execute_values(
                    cur, rxn_insert_sql, chunk, fetch=True
                )
                inserted_rxn_count += len(result)
                log.info(f"  reactions: {i + len(chunk):,}/{len(reaction_rows):,} processed")

        # Exiting the `with conn` block commits the transaction automatically
        # (or rolls back if an exception was raised).

    summary = {
        "messages_seen":      len(message_rows),
        "messages_inserted":  len(inserted_msg_ids),
        "reactions_seen":     len(reaction_rows),
        "reactions_inserted": inserted_rxn_count,
    }
    log.info(
        f"Done. Inserted {summary['messages_inserted']:,} new messages "
        f"({summary['messages_seen'] - summary['messages_inserted']:,} were duplicates). "
        f"Inserted {summary['reactions_inserted']:,} new reactions."
    )
    return summary


# ----------------------------------------------------------------------------
# Smoke test — lets you run `python db.py` to check the connection works.
# ----------------------------------------------------------------------------

if __name__ == "__main__":
    log.info("Testing connection…")
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM messages")
            total = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM reactions")
            rxn_total = cur.fetchone()[0]
    log.info(f"Connected. messages={total:,}  reactions={rxn_total:,}")
