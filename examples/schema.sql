-- The example app's own tables, read by examples/sql-directory.ts. Not part of soSHial: your app has
-- its own. A teacher is an enrollment with role 'teacher'.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  first_name TEXT,
  last_name  TEXT
);
CREATE TABLE IF NOT EXISTS classes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS enrollments (
  class_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  -- epoch ms; NULL = no end
  expires_at INTEGER,
  PRIMARY KEY (class_id, user_id)
);
