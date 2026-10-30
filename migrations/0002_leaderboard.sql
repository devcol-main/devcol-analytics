-- 온라인 리더보드. 로그인 없음: 소유 증명은 서버가 발급한 토큰의 SHA-256만 저장한다.
-- IP, UA, 쿠키, 게임 쪽 player ID는 저장하지 않는다. 개인 데이터는 공개된 닉네임뿐.

-- 게임별 sanity bound. 목록은 코드에 없다: /games/<slug>/가 사이트에 있으면 첫 제출 때 등록된다.
CREATE TABLE lb_games (
  slug TEXT PRIMARY KEY,
  max_score REAL NOT NULL,
  max_score_per_sec REAL NOT NULL,   -- 0이면 검사 안 함
  min_duration_ms INTEGER NOT NULL,
  stat_max TEXT,                     -- JSON {"maxCombo": 500, ...}, 없으면 검사 안 함
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE lb_owners (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- 플레이어(owner)당 게임당 한 줄 (최고 점수)
CREATE TABLE lb_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,                -- 공개 이름 (통과한 닉네임 또는 Player####)
  name_status TEXT NOT NULL,         -- ok | unchecked_ai | rules_fallback | ai_fallback | banned_owner | reported | admin_renamed
  name_locked INTEGER NOT NULL DEFAULT 0,  -- 1이면 다음 제출의 닉네임을 쓰지 않는다 (신고/관리자 변경)
  score REAL NOT NULL,
  stats TEXT,                        -- JSON
  duration_ms INTEGER,
  ts INTEGER NOT NULL,               -- 최고 점수를 낸 시각
  updated_at INTEGER NOT NULL,       -- 마지막 제출 (보관기간 기준)
  hidden INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner_id, game)
);
CREATE INDEX idx_lb_entries_top ON lb_entries(game, hidden, score DESC, ts);
CREATE INDEX idx_lb_entries_updated ON lb_entries(updated_at);
CREATE INDEX idx_lb_entries_status ON lb_entries(name_status);

-- AI 판정 캐시: 같은 이름은 AI를 한 번만 부른다. key = 소문자 NFKC 이름
CREATE TABLE lb_names (
  name_key TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,             -- safe | unsafe
  checked_at INTEGER NOT NULL
);

-- 관리자가 추가한 차단어 (코드의 기본 목록에 더해짐)
CREATE TABLE lb_terms (
  term TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL
);

-- 신고. reporter_hash = 그날 솔트로 만든 해시 (방문자 집계와 같은 방식, 다음 날 연결 불가)
CREATE TABLE lb_reports (
  entry_id INTEGER NOT NULL,
  reporter_hash TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (entry_id, reporter_hash)
);
CREATE INDEX idx_lb_reports_ts ON lb_reports(ts);

-- Workers AI 일일 호출 상한 (UTC 날짜: 무료 Neuron 할당이 00:00 UTC에 초기화)
CREATE TABLE lb_ai_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL
);

-- 짧게 사는 rate-limit 기록 (cron이 정리)
CREATE TABLE lb_rate (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_lb_rate ON lb_rate(key, ts);
