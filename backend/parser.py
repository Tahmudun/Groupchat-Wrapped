import json
import os
import hashlib
from datetime import datetime, timezone

# ============================================================
# ENCODING FIX
# Instagram exports text using a broken encoding. Characters
# and emojis get mangled into junk like \u00e2\u009d\u00a4.
# This function repairs any string back to normal text/emojis.
# also helps read weird fonts like "𝕬𝖑𝖎𝖈𝖊" as normal "Alice"
# ============================================================

def fix_encoding(text):
    if not isinstance(text, str):
        return text
    try:
        fixed = text.encode("latin-1").decode("utf-8")
        return fixed
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text


# ============================================================
# MESSAGE ID GENERATOR
# Every message needs a unique ID so the database can detect
# and skip duplicates when you re-import overlapping exports.
# We generate it by hashing three fields that together uniquely
# identify any message: who sent it, when, and what it said.
# hashlib is a built-in Python library for generating hashes.
# ============================================================

def make_message_id(sender, timestamp_ms, content):
    content = (content or "").strip()   # handles null safety
    raw = f"{sender}_{timestamp_ms}_{content}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()
    # can use md5 or sha256 for hashing. gonna stick to md5 for now but 
    # sha256 is more collision resistant. gonna have to think about
    # how i want to handle near identical messages, with identical senders and near identical timestamps
    # have to look into collisions more but i think i should be good


# ============================================================
# MEDIA TYPE DETECTOR
# A message can contain photos, videos, audio, a shared reel,
# a shared GIF, or just plain text. This function looks at
# the raw message dictionary and returns a string describing
# what kind of media it contains, if any.
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
# SINGLE MESSAGE PARSER
# Takes one raw message dictionary straight from the JSON file
# and returns a clean, structured dictionary we can insert
# into our database. Every field is explicitly handled here.
# ============================================================

def parse_message(msg):
    sender = fix_encoding(msg.get("sender_name", "Unknown"))
    timestamp_ms = msg.get("timestamp_ms", 0)
    content = fix_encoding(msg.get("content", ""))
    media_type = get_media_type(msg)

    # Convert millisecond timestamp to a datetime object in UTC.
    # Using timezone-aware UTC ensures this behaves identically on any
    # machine, any timezone. The frontend can convert to local time for display.
    dt = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
    # ISO-like format Postgres parses cleanly: "2026-03-26 20:12:42+00:00"
    timestamp_readable = dt.strftime("%Y-%m-%d %H:%M:%S%z")

    # Parse reactions, each is a dict with "reaction" and  "actor"
    reactions = []
    for r in msg.get("reactions", []):
        reactions.append({
            "emoji": fix_encoding(r.get("reaction", "")),
            "actor": fix_encoding(r.get("actor", ""))
        })
    
    # generate the unique ID for this message
    message_id = make_message_id(sender, timestamp_ms, content)

    return {
        "id"           : message_id,
        "sender"       : sender,
        "timestamp_ms" : timestamp_ms,         # raw Unix ms (integer)
        "timestamp"    : timestamp_readable,   # human-readable string for Postgres
        "content"      : content,
        "media_type"   : media_type,
        "reactions"    : reactions
    }

# ============================================================
# FILE PARSER
# Takes the path to a single message_X.json file, loads it,
# and runs every message through parse_message().
# Returns a list of clean message dictionaries.
# ============================================================

def parse_file(filepath):
    with open(filepath, encoding="utf-8") as f:
        data = json.load(f)
    
    messages = data.get("messages", [])
    parsed = []

    for msg in messages:
        # here i'm going to (temporarily) skip system messages
        # mainly meant to skip video call notifs. these have a separate call_duration field
        # aren't real messages. might care about these later
        if "call_duration" in msg:
            continue
    
        parsed.append(parse_message(msg))
    
    return parsed

# ============================================================
# FOLDER PARSER
# When exported from instagram, I got around 50 files for a 3 month long active groupchat
# This function takes the path to the group chat folder,
# finds every message_X.json file inside it, parses all of
# them, and returns one big combined list of all messages.
# ============================================================


def parse_groupchat(folder_path):
    all_messages = []

    # sort folder, lowest number = most recent from batch, highest = oldest
    filenames = sorted(os.listdir(folder_path))

    for filename in filenames:
        # Only process files named message_X.json, skip everything else
        if not filename.startswith("message_") or not filename.endswith(".json"):
            continue

        filepath = os.path.join(folder_path, filename)
        print(f"Parsing {filename}...")

        messages = parse_file(filepath)
        all_messages.extend(messages)
        print(f"  → {len(messages)} messages found")

    print(f"\nTotal messages parsed: {len(all_messages)}")
    return all_messages

