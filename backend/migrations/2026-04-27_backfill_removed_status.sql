-- 2026-04-27 — Backfill members.status = 'removed'
--
-- Marks members who have zero real messages (message_type = 'message')
-- as 'removed'. These are the drive-by leavers, add/remove targets, and
-- silent invitees who clutter the sender dropdown and inflate member counts.
--
-- Prereq: members_status_check constraint must include 'removed'.
-- The constraint was updated in this same session before this migration ran.
--
-- Expected affected rows: 749 (out of 1322 total members)

UPDATE members m
SET status = 'removed'
WHERE NOT EXISTS (
  SELECT 1 FROM messages msg
  WHERE msg.sender = m.username
    AND msg.message_type = 'message'
);