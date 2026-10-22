CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  path TEXT,
  referrer_host TEXT,
  utm_source TEXT,
  country TEXT,
  device TEXT,
  browser TEXT,
  visitor_hash TEXT,
  session_id TEXT,
  game TEXT,
  props TEXT            -- JSON
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_type_ts ON events(type, ts);
CREATE INDEX idx_events_path ON events(path);
-- 분당 rate limit 조회용
CREATE INDEX idx_events_visitor_ts ON events(visitor_hash, ts);

CREATE TABLE daily_stats (
  day TEXT NOT NULL,     -- YYYY-MM-DD (KST)
  metric TEXT NOT NULL,  -- 'pageviews','visitors','plays:stack-up', 'post:/blog/xxx' ...
  value REAL NOT NULL,
  PRIMARY KEY (day, metric)
);

CREATE TABLE salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL);
