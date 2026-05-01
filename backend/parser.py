import json
import os
import re
import hashlib
from datetime import datetime, timezone
from collections import defaultdict

# ============================================================
# ENCODING FIX
# Instagram exports text using a broken encoding. Characters
# and emojis get mangled into junk like \u00e2\u009d\u00a4.
# This function repairs any string back to normal text/emojis.
# ============================================================

def fix_encoding(text):
    if not isinstance(text, str):
        return text
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text


# ============================================================
# MESSAGE ID GENERATOR
# Unique ID via MD5 of (sender, timestamp_ms, content). Same
# message parsed twice hashes identically, so DB inserts with
# ON CONFLICT DO NOTHING are idempotent on re-imports.
# ============================================================

def make_message_id(sender, timestamp_ms, content):
    content = (content or "").strip()
    raw = f"{sender}_{timestamp_ms}_{content}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


# ============================================================
# MEDIA TYPE DETECTOR
# ============================================================

def get_media_type(msg):
    if "photos" in msg:
        return "photo"
    if "videos" in msg:
        return "video"
    if "audio_files" in msg:
        return "audio"
    if "share" in msg:
        link = msg["share"].get("link", "")
        if "giphy.com" in link:
            return "gif"
        if "instagram.com/reel" in link:
            return "reel"
        return "link"
    return None


# ============================================================
# SYSTEM EVENT CLASSIFIER
# Instagram's JSON export does NOT structurally distinguish
# system events from real messages — they all come through with
# the same fields (sender_name, timestamp_ms, content). The only
# exception is `call_duration`, which is set on call-related rows.
#
# So classification is content-pattern based for everything else.
# Patterns are tightly anchored to avoid catching real messages
# that happen to contain words like "named" or "called". For
# system events, sender_name is unreliable — Instagram attributes
# events to whichever participant is structurally adjacent during
# export, not the actual actor — so we don't validate against it.
#
# Order matters: more-specific patterns first.
# ============================================================

# Each entry: (compiled regex, message_type label)
# All regexes anchor on $ (end of string) where possible to
# minimize collisions with real messages that quote system events.
SYSTEM_PATTERNS = [
    # Reactions and likes — distinct trailing structure
    (re.compile(r'^.+ reacted .+ to your message $'),               "system_reaction"),
    (re.compile(r'^.+ liked a message$'),                           "system_like"),

    # Group membership events
    (re.compile(r'^.+ left the group\.$'),                          "system_left"),
    (re.compile(r'^.+ added .+ to the group\.$'),                   "system_added"),
    (re.compile(r'^.+ removed .+ from the group\.$'),               "system_removed"),

    # Group customization
    (re.compile(r'^.+ named the group .+\.$'),                      "system_named"),
    (re.compile(r'^.+ changed the group photo\.$'),                 "system_photo_change"),
    (re.compile(r'^.+ set the nickname for .+ to .+\.$'),           "system_nickname"),
    (re.compile(r'^.+ set their own nickname to .+\.$'),            "system_nickname"),
    # Theme has embedded user-provided AI prompt; anchor on the prefix structure
    (re.compile(r'^.+ changed the theme using AI to "'),            "system_theme"),

    # Polls and pins
    (re.compile(r'^.+ created a poll: .+\.$'),                      "system_poll"),
    (re.compile(r'^.+ pinned a message\.$'),                        "system_pin"),

    # Calls without call_duration field (start-of-call rows)
    (re.compile(r'^.+ started a video chat$'),                      "system_call"),

    # Stickers (rendered as a notification when export couldn't embed)
    (re.compile(r'^.+ sent a sticker\.$'),                          "system_sticker"),
]

def classify_message(msg):
    """
    Returns the message_type label for a raw Instagram JSON message dict.
    Preference order:
      1. call_duration field present  -> system_call (most reliable signal)
      2. content matches a system pattern -> corresponding system_* label
      3. fallback                     -> 'message'
    """
    if "call_duration" in msg:
        return "system_call"

    content = msg.get("content", "")
    if not content:
        return "message"  # media-only rows, no system pattern possible

    for pat, label in SYSTEM_PATTERNS:
        if pat.match(content):
            return label

    return "message"


# ============================================================
# DISPLAY-NAME -> HANDLE EXTRACTOR (free aliasing data)
# When a system event content begins with a handle (e.g.
# "mileskuzz2026 changed the group photo."), and Instagram tagged
# the row to a different sender_name (e.g. "Miles"), we have
# evidence that "Miles" is the display name for the handle
# "mileskuzz2026". We collect these pairs and emit them
# alongside the parsed messages so they can populate
# members.bio_name later.
#
# We DON'T trust any single observation. Only pairs that appear
# multiple times consistently get exported as confident mappings.
# ============================================================

# Patterns where the FIRST capture group is the actor's handle
HANDLE_EXTRACTION_PATTERNS = [
    re.compile(r'^([^\s]+) liked a message$'),
    re.compile(r'^([^\s]+) reacted .+ to your message $'),
    re.compile(r'^([^\s]+) left the group\.$'),
    re.compile(r'^([^\s]+) added .+ to the group\.$'),
    re.compile(r'^([^\s]+) removed .+ from the group\.$'),
    re.compile(r'^([^\s]+) named the group .+\.$'),
    re.compile(r'^([^\s]+) changed the group photo\.$'),
    re.compile(r'^([^\s]+) set the nickname for .+ to .+\.$'),
    re.compile(r'^([^\s]+) set their own nickname to .+\.$'),
    re.compile(r'^([^\s]+) changed the theme using AI to "'),
    re.compile(r'^([^\s]+) created a poll: .+\.$'),
    re.compile(r'^([^\s]+) pinned a message\.$'),
    re.compile(r'^([^\s]+) started a video chat$'),
    re.compile(r'^([^\s]+) sent a sticker\.$'),
]

def extract_handle_from_content(content):
    """Return the handle at the start of a system-event content string, or None."""
    if not content:
        return None
    for pat in HANDLE_EXTRACTION_PATTERNS:
        m = pat.match(content)
        if m:
            return m.group(1)
    return None


# ============================================================
# SINGLE MESSAGE PARSER
# ============================================================

def parse_message(msg):
    sender = fix_encoding(msg.get("sender_name", "Unknown"))
    timestamp_ms = msg.get("timestamp_ms", 0)
    content = fix_encoding(msg.get("content", ""))
    media_type = get_media_type(msg)
    message_type = classify_message(msg)

    dt = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
    timestamp_readable = dt.strftime("%Y-%m-%d %H:%M:%S%z")

    reactions = []
    for r in msg.get("reactions", []):
        reactions.append({
            "emoji": fix_encoding(r.get("reaction", "")),
            "actor": fix_encoding(r.get("actor", ""))
        })

    message_id = make_message_id(sender, timestamp_ms, content)

    return {
        "id"           : message_id,
        "sender"       : sender,
        "timestamp_ms" : timestamp_ms,
        "timestamp"    : timestamp_readable,
        "content"      : content,
        "media_type"   : media_type,
        "message_type" : message_type,
        "reactions"    : reactions,
    }


# ============================================================
# JUNK-ROW FILTER
# ~2% of rows have no content and no media — leftover artifacts
# (often reaction-only events the export half-captured). They
# carry no information and just inflate sender counts. Skip.
# ============================================================

def is_junk_row(msg):
    if msg.get("content"):
        return False
    if "call_duration" in msg:
        return False  # call rows can have empty content but are real
    if any(k in msg for k in ("photos", "videos", "audio_files", "share")):
        return False
    if msg.get("reactions"):
        return False
    return True


# ============================================================
# FILE PARSER
# ============================================================

def parse_file(filepath, name_to_handle_observations=None):
    """
    Parse one message_X.json file. If name_to_handle_observations is provided
    (a defaultdict(Counter)), it gets populated with sender_name -> handle
    sightings derived from system events. Mutates in place.
    """
    with open(filepath, encoding="utf-8") as f:
        data = json.load(f)

    messages = data.get("messages", [])
    parsed = []
    skipped = 0

    for msg in messages:
        if is_junk_row(msg):
            skipped += 1
            continue

        parsed_msg = parse_message(msg)
        parsed.append(parsed_msg)

        # Side effect: collect sender_name -> handle observations
        # ONLY from rows we classified as system events
        if name_to_handle_observations is not None and parsed_msg["message_type"].startswith("system_"):
            handle = extract_handle_from_content(parsed_msg["content"])
            if handle and handle != "You":
                name_to_handle_observations[parsed_msg["sender"]][handle] += 1

    return parsed, skipped


# ============================================================
# FOLDER PARSER
# ============================================================

def parse_groupchat(folder_path):
    from collections import Counter
    name_to_handle_observations = defaultdict(Counter)
    all_messages = []
    total_skipped = 0

    filenames = sorted(os.listdir(folder_path))

    for filename in filenames:
        if not filename.startswith("message_") or not filename.endswith(".json"):
            continue
        filepath = os.path.join(folder_path, filename)
        print(f"Parsing {filename}...")
        messages, skipped = parse_file(filepath, name_to_handle_observations)
        all_messages.extend(messages)
        total_skipped += skipped
        print(f"  -> {len(messages)} messages parsed, {skipped} junk rows skipped")

    print(f"\nTotal messages parsed: {len(all_messages)}")
    print(f"Total junk rows skipped: {total_skipped}")

    # Distill name->handle observations into confident mappings.
    # A mapping is "confident" if the sender_name -> handle pair was
    # observed at least 3 times AND the dominant handle for that name
    # accounts for >=80% of that name's observations.
    confident_mappings = {}
    for name, handle_counter in name_to_handle_observations.items():
        total = sum(handle_counter.values())
        if total < 3:
            continue
        top_handle, top_count = handle_counter.most_common(1)[0]
        if top_count / total >= 0.8:
            confident_mappings[name] = top_handle

    return all_messages, confident_mappings


# ============================================================
# MAIN (test harness)
# ============================================================

if __name__ == "__main__":
    import sys
    import json as _json
    from collections import Counter

    folder = sys.argv[1] if len(sys.argv) > 1 else "."
    messages, name_to_handle = parse_groupchat(folder)

    # Summary stats
    type_counter = Counter(m["message_type"] for m in messages)
    print("\n=== MESSAGE TYPE BREAKDOWN ===")
    for t, c in type_counter.most_common():
        print(f"  {t:25s}  {c:>7d}  ({100*c/len(messages):.1f}%)")

    # Show first 30 mappings inline for quick eyeball
    print(f"\n=== CONFIDENT NAME -> HANDLE MAPPINGS (first 30) ===")
    for i, (name, handle) in enumerate(list(name_to_handle.items())[:30]):
        print(f"  {name!r:40s} -> {handle!r}")
    print(f"\nTotal confident mappings: {len(name_to_handle)}")

    # Dump full mapping to a JSON file for the bio_name backfill SQL.
    # Skip self-mappings (where bio_name would equal the handle — pointless).
    real_mappings = {name: handle for name, handle in name_to_handle.items()
                     if name != handle}
    out_path = "name_handle_mappings.json"
    with open(out_path, "w") as f:
        _json.dump(real_mappings, f, indent=2, ensure_ascii=False)
    print(f"\nFull mappings ({len(real_mappings)} after filtering self-maps) "
          f"written to: {out_path}")