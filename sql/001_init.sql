CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS channels (
  id text PRIMARY KEY,
  joined_at timestamptz NOT NULL,
  history_cursor text,
  oldest_imported_ts text,
  imported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_messages (
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  ts text NOT NULL,
  thread_ts text,
  user_id text,
  processed_at timestamptz,
  PRIMARY KEY (channel_id, ts)
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  source_ts text NOT NULL,
  title text NOT NULL,
  owner_id text,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'complete', 'rejected')),
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  last_dm_at timestamptz,
  escalated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, source_ts, title)
);

CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (status, last_updated_at);
CREATE INDEX IF NOT EXISTS tasks_channel_idx ON tasks (channel_id, created_at DESC);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pending_owner_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS proposal_message_ts text;

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_key text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  recipient_id text,
  message text NOT NULL,
  blocks jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deliveries_pending_idx ON deliveries (status, created_at);

ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'uncertain'));
