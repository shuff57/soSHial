-- soSHial 0.2.0: group chats, class channels, and three messaging levels. Apply after 0001.
--
-- A conversation (soshial_threads.kind) can now also be:
--   'group'    2-8 people of one class, made by a student or a teacher. Its people are its
--              soshial_members rows; `title` is its name ('' = shown as its people's names).
--              pair_key is 'group|<id>'.
--   'channel'  the whole class reads it and (unless `locked`) posts in it. #general is made for every
--              class the first time it is needed; anyone may add a channel; a teacher locks (only
--              teachers post), renames or deletes one. pair_key is 'channel|<class id>|<name>', so two
--              channels of a class never share a name. A channel's soshial_members rows only hold
--              read_at, never who may read it (that is everyone in the class, from your directory).
-- A class's teachers read every group, as they read conversations between two students.
--
-- Levels: what a STUDENT may send, per class and per student; the stricter wins.
--   0 On; 1 Teacher only (a message to a teacher of the class, nothing else); 2 Off (nothing; reading stays).
--   soshial_class_settings.student_level is the class's (classmates_off = 1 from 0.1.0 reads as 1);
--   soshial_mutes.level is one student's (every 0.1.0 "pause" row means 1, its default).

ALTER TABLE soshial_threads ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE soshial_threads ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE soshial_class_settings ADD COLUMN student_level INTEGER NOT NULL DEFAULT 0;
UPDATE soshial_class_settings SET student_level = 1 WHERE classmates_off = 1 AND student_level = 0;
ALTER TABLE soshial_mutes ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_soshial_threads_class_kind ON soshial_threads (class_id, kind);
