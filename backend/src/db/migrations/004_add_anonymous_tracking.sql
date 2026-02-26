ALTER TABLE events ADD COLUMN anonymous_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_anonymous_id ON events(anonymous_id);
