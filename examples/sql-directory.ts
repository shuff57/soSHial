// An example ClassDirectory over three plain tables (examples/schema.sql). Your app's tables will
// differ: this is the one file to rewrite for them.

import type { ClassDirectory, Db, Person, Role } from '../src';

/** First name + last initial: short, and never an email. */
export function shortName(first: string | null, last: string | null, teacher = false): string {
  const f = (first ?? '').trim();
  const l = (last ?? '').trim();
  if (f && l) return `${f} ${l[0].toUpperCase()}.`;
  if (f) return f;
  if (l) return `${l[0].toUpperCase()}.`;
  return teacher ? 'Teacher' : 'A classmate';
}

export function sqlDirectory(db: Db, now: () => number = Date.now): ClassDirectory {
  return {
    async classInfo(classId) {
      const r = await db.prepare(`SELECT id, name, archived_at FROM classes WHERE id = ?`).bind(classId)
        .first<{ id: string; name: string; archived_at: number | null }>();
      return r ? { id: r.id, name: r.name, archived: r.archived_at != null } : null;
    },
    async roleIn(classId, userId): Promise<Role | null> {
      const r = await db.prepare(
        `SELECT role FROM enrollments WHERE class_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      ).bind(classId, userId, now()).first<{ role: Role }>();
      return r?.role ?? null;
    },
    async people(classId): Promise<Person[]> {
      const rows = (await db.prepare(
        `SELECT u.id, u.first_name, u.last_name, e.role FROM enrollments e JOIN users u ON u.id = e.user_id
          WHERE e.class_id = ? AND (e.expires_at IS NULL OR e.expires_at > ?)`,
      ).bind(classId, now()).all<{ id: string; first_name: string | null; last_name: string | null; role: Role }>()).results ?? [];
      return rows.map((r) => ({ id: r.id, name: shortName(r.first_name, r.last_name, r.role === 'teacher'), role: r.role }));
    },
    async classesOf(userId) {
      const rows = (await db.prepare(
        `SELECT e.class_id FROM enrollments e JOIN classes c ON c.id = e.class_id
          WHERE e.user_id = ? AND c.archived_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > ?)`,
      ).bind(userId, now()).all<{ class_id: string }>()).results ?? [];
      return rows.map((r) => r.class_id);
    },
    async nameOf(userId) {
      const r = await db.prepare(
        `SELECT u.first_name, u.last_name, EXISTS (SELECT 1 FROM enrollments WHERE user_id = u.id AND role = 'teacher') AS teacher
           FROM users u WHERE u.id = ?`,
      ).bind(userId).first<{ first_name: string | null; last_name: string | null; teacher: number }>();
      return shortName(r?.first_name ?? null, r?.last_name ?? null, !!r?.teacher);
    },
  };
}
