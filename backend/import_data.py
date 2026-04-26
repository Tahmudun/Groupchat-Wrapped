"""
import_data.py — CLI script to parse Instagram JSON and load it into Supabase.

USAGE:
    python backend/import_data.py <path-to-groupchat-folder>

EXAMPLE:
    python backend/import_data.py data/your_instagram_activity/messages/inbox/mygc_abc123/

WHAT IT DOES:
    1. Uses parser.py to read all message_*.json files in the folder.
    2. Uses db.py to insert the parsed messages into Supabase.
    3. Prints a summary of how many messages were new vs. already-seen.

WHY IT'S SEPARATE FROM db.py:
    db.py is a LIBRARY — other code (future analytics scripts, maybe the
    FastAPI backend) will import from it. import_data.py is a SCRIPT — it's
    something you RUN from the terminal. Keeping them apart makes each
    file's job obvious at a glance.

RE-IMPORT SAFETY:
    You can run this script as many times as you want on the same folder.
    The MD5-based dedup in db.py means duplicate messages are silently
    skipped. So when you do a new Instagram export next month, you just run
    this again on the new folder — no cleanup, no special flags.
"""

import sys           # to read CLI args and exit with error codes
import time          # to time the whole operation, nice for long imports
from pathlib import Path  # cleaner than os.path for file path logic

# These imports work because we'll run this file FROM the project root as
# `python backend/import_data.py …`. That puts `backend/` on the path.
from parser import parse_groupchat
from db import insert_messages, log


def main():
    # argv[0] is the script name; argv[1] should be the folder path.
    if len(sys.argv) != 2:
        print("Usage: python backend/import_data.py <groupchat-folder-path>")
        sys.exit(1)

    folder = Path(sys.argv[1])
    if not folder.is_dir():
        print(f"Error: {folder} is not a directory.")
        sys.exit(1)

    log.info(f"Parsing groupchat JSON from: {folder}")
    t0 = time.perf_counter()

    # parser.parse_groupchat reads every message_*.json file in the folder.
    # It returns a tuple: (list of parsed message dicts, dict of confident
    # name->handle mappings derived from system events). The mappings are
    # collected for free during parsing and will be used later to populate
    # members.bio_name; for now we just log the count.
    messages, name_handle_mappings = parse_groupchat(str(folder))
    t_parse = time.perf_counter() - t0
    log.info(f"Parsed {len(messages):,} messages in {t_parse:.1f}s.")
    log.info(f"Collected {len(name_handle_mappings)} confident name->handle mappings.")

    if not messages:
        log.info("No messages found. Exiting.")
        return

    # Hand off to the database layer.
    t1 = time.perf_counter()
    summary = insert_messages(messages)
    t_insert = time.perf_counter() - t1

    log.info("=" * 60)
    log.info(f"SUMMARY")
    log.info(f"  Parse time:         {t_parse:6.1f}s")
    log.info(f"  Insert time:        {t_insert:6.1f}s")
    log.info(f"  Messages seen:      {summary['messages_seen']:,}")
    log.info(f"  Messages inserted:  {summary['messages_inserted']:,}  (new)")
    log.info(f"  Messages skipped:   {summary['messages_seen'] - summary['messages_inserted']:,}  (duplicates)")
    log.info(f"  Reactions inserted: {summary['reactions_inserted']:,}")
    log.info("=" * 60)


if __name__ == "__main__":
    main()