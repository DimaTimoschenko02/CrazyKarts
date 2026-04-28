-- Master server schema. Idempotent: CREATE TABLE IF NOT EXISTS.
-- Migrations are tracked via PRAGMA user_version + db/migrations.js.

CREATE TABLE IF NOT EXISTS profiles (
    nickname_lower      TEXT PRIMARY KEY,
    nickname_display    TEXT NOT NULL,
    auth_token_hash     TEXT NOT NULL UNIQUE,
    created_at          INTEGER NOT NULL,
    last_seen_at        INTEGER NOT NULL,
    total_kills         INTEGER NOT NULL DEFAULT 0,
    total_deaths        INTEGER NOT NULL DEFAULT 0,
    total_assists       INTEGER NOT NULL DEFAULT 0,
    total_damage_dealt  INTEGER NOT NULL DEFAULT 0,
    total_damage_taken  INTEGER NOT NULL DEFAULT 0,
    total_shots_fired   INTEGER NOT NULL DEFAULT 0,
    total_shots_hit     INTEGER NOT NULL DEFAULT 0,
    total_matches       INTEGER NOT NULL DEFAULT 0,
    total_wins          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS matches (
    match_id        TEXT PRIMARY KEY,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    map_id          TEXT NOT NULL DEFAULT 'map_1',
    room_code       TEXT,
    player_count    INTEGER NOT NULL DEFAULT 0,
    duration_s      INTEGER
);

CREATE TABLE IF NOT EXISTS match_participants (
    match_id        TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
    nickname_lower  TEXT NOT NULL REFERENCES profiles(nickname_lower) ON DELETE CASCADE,
    kills           INTEGER NOT NULL DEFAULT 0,
    deaths          INTEGER NOT NULL DEFAULT 0,
    assists         INTEGER NOT NULL DEFAULT 0,
    damage_dealt    INTEGER NOT NULL DEFAULT 0,
    damage_taken    INTEGER NOT NULL DEFAULT 0,
    shots_fired     INTEGER NOT NULL DEFAULT 0,
    shots_hit       INTEGER NOT NULL DEFAULT 0,
    score           INTEGER NOT NULL DEFAULT 0,
    placement       INTEGER,
    weapon_stats    TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (match_id, nickname_lower)
);

CREATE INDEX IF NOT EXISTS idx_mp_match    ON match_participants(match_id);
CREATE INDEX IF NOT EXISTS idx_mp_profile  ON match_participants(nickname_lower);
CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at);
