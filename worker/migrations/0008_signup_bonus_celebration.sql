ALTER TABLE signup_credit_grants ADD COLUMN celebration_seen_at TEXT;

-- Do not show the new welcome celebration retroactively to accounts that
-- received the launch bonus before this feature existed.
UPDATE signup_credit_grants
SET celebration_seen_at = granted_at
WHERE celebration_seen_at IS NULL;
