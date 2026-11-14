-- soSHial: messages between a teacher and their students, and between classmates.
--
-- A conversation is between TWO people in ONE class. Who is in a class, and who teaches it, is your
-- app's business: soSHial asks your ClassDirectory (src/directory.ts) and stores only your user ids.
--
-- pair_key is "<class id>|<user id>|<user id>" with the two ids sorted, so a second "New message"
-- to the same person in the same class reopens the same conversation.
--
-- A message a teacher removes keeps its row (deleted_at, deleted_by): students see "Removed by a
-- teacher", never its words; teachers still can.
--
-- soshial_person_keys gives each user a random public key, so a page names the person a message is
-- for without ever being sent your user id or an email.

CREATE TABLE IF NOT EXISTS soshial_threads (
  id         TEXT    PRIMARY KEY,
  class_id   TEXT    NOT NULL,
  pair_key   TEXT    NOT NULL,
  -- 'teacher' when one of the two teaches the class, else 'students'
  kind       TEXT    NOT NULL,
  created_by TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  last_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_soshial_threads_pair ON soshial_threads (pair_key);
CREATE INDEX IF NOT EXISTS idx_soshial_threads_class ON soshial_threads (class_id, last_at);

CREATE TABLE IF NOT EXISTS soshial_members (
  thread_id TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  -- the name shown, written down when the conversation starts
  name      TEXT    NOT NULL,
  teacher   INTEGER NOT NULL DEFAULT 0,
  read_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_soshial_members_user ON soshial_members (user_id);

CREATE TABLE IF NOT EXISTS soshial_messages (
  id         TEXT    PRIMARY KEY,
  thread_id  TEXT    NOT NULL,
  author_id  TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_soshial_messages_thread ON soshial_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_soshial_messages_author ON soshial_messages (author_id, created_at);

CREATE TABLE IF NOT EXISTS soshial_person_keys (
  user_id TEXT PRIMARY KEY,
  key     TEXT NOT NULL UNIQUE
);

-- A teacher's switches for one class.
CREATE TABLE IF NOT EXISTS soshial_class_settings (
  class_id       TEXT    PRIMARY KEY,
  -- 1 = students cannot message each other in this class (they can still message a teacher)
  classmates_off INTEGER NOT NULL DEFAULT 0
);

-- One student paused: they cannot message classmates in this class (they can still message a teacher).
CREATE TABLE IF NOT EXISTS soshial_mutes (
  class_id TEXT    NOT NULL,
  user_id  TEXT    NOT NULL,
  muted_at INTEGER NOT NULL,
  muted_by TEXT    NOT NULL,
  PRIMARY KEY (class_id, user_id)
);
