-- Happyhappyhappy database schema
-- Positive news only!

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_region TEXT DEFAULT 'global',   -- us | india | global
  summary TEXT,
  image_url TEXT,
  published_at INTEGER,
  ingested_at INTEGER DEFAULT (unixepoch()),
  joy_score INTEGER DEFAULT 0,           -- 1-10 Gemini positivity score
  category TEXT DEFAULT 'feel-good',     -- feel-good | science | animals | arts
  reading_time INTEGER DEFAULT 2,
  hidden INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS digest_days (
  date TEXT PRIMARY KEY,                 -- YYYY-MM-DD
  item_ids TEXT NOT NULL,               -- JSON array of top 5-7 item IDs
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_joy ON items(joy_score DESC);
CREATE INDEX IF NOT EXISTS idx_items_hidden ON items(hidden, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_ingested ON items(ingested_at DESC);
