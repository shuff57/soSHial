// soSHial's server: every route, over the Fetch API's Request and Response, so it runs in a Cloudflare
// Pages Function, a Worker, or anything else that speaks Request/Response.
//
//   const soshial = createSoshial({ db: env.DB, directory });
//   const res = await soshial.handle(request, { userId });   // null when the path is not soSHial's
//
// Routes, under `base` (default '/api/soshial'):
//   GET  /messages              the caller's conversations, newest first, plus `unread`
//   GET  /messages?count=1      only `unread`: conversations with a message the caller has not opened
//   GET  /messages?people=1     whom the caller may start a conversation with, per class
//   POST /messages              { classId, to, body }: send (reuses the pair's conversation in that class)
//   GET  /messages/<id>         one conversation; marks it read for the caller
//   POST /messages/<id>         { body }: send in it
//   GET  /classes/<id>/messages             teacher panel: the switch, students, conversations between students
//   GET  /classes/<id>/messages?thread=<id> one of them (removed messages included, for teachers)
//   POST /classes/<id>/messages             { action: 'classmates-off' | 'classmates-on' }
//                                           { action: 'mute' | 'unmute', student: <person key> }
//                                           { action: 'remove' | 'restore', messageId }
// No answer ever carries a user id or an email: a person is a random public key and a name.

import type { ClassDirectory, ClassInfo, Person, Role, Session } from './directory';
import {
  DEFAULT_LIMITS, THREAD_LIST_LIMIT, blockText, cleanMessage, isId, isPersonKey, pairKey, snippetOf,
  type ClassOverview, type ClassThread, type FindPII, type Limits, type MessageItem, type MessagePerson,
  type PeopleClass, type SendBlock, type ThreadSummary, type ThreadView,
} from './core';
import { findPII as defaultFindPII } from './pii';

/** The part of Cloudflare D1's API soSHial uses (D1 itself satisfies it). */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}
export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<unknown>;
}

export interface SoshialOptions {
  db: Db;
  directory: ClassDirectory;
  /** Where the routes live. Default '/api/soshial'. */
  base?: string;
  limits?: Partial<Limits>;
  /** Replace the personal-details check (src/pii.ts). Return a label from it, or null. */
  findPII?: FindPII;
  /** For tests. */
  now?: () => number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => n.toString(16).padStart(2, '0')).join('');
}

interface ThreadRow { id: string; class_id: string; kind: 'teacher' | 'students'; created_at: number; last_at: number }
interface MemberRow { user_id: string; name: string; teacher: number; read_at: number }
interface MessageRow { id: string; author_id: string; body: string; created_at: number; deleted_at: number | null }

export function createSoshial(opts: SoshialOptions) {
  const db = opts.db;
  const dir = opts.directory;
  const base = (opts.base ?? '/api/soshial').replace(/\/$/, '');
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const pii = opts.findPII ?? defaultFindPII;
  const now = opts.now ?? Date.now;
  const clean = (raw: unknown) => cleanMessage(raw, limits, pii);

  // ---- small helpers -----------------------------------------------------------------------------

  async function classmatesOff(classId: string): Promise<boolean> {
    const r = await db.prepare(`SELECT classmates_off FROM soshial_class_settings WHERE class_id = ?`).bind(classId).first<{ classmates_off: number }>();
    return !!r?.classmates_off;
  }
  async function isMuted(classId: string, userId: string): Promise<boolean> {
    return !!(await db.prepare(`SELECT 1 AS x FROM soshial_mutes WHERE class_id = ? AND user_id = ?`).bind(classId, userId).first());
  }

  /** May `from` write to `to` in this class right now? Re-checked on every message. */
  async function sendRule(cls: ClassInfo, from: string, to: string): Promise<{ why: SendBlock; kind: 'teacher' | 'students' | null; fromRole: Role | null; toRole: Role | null }> {
    const [fromRole, toRole] = await Promise.all([dir.roleIn(cls.id, from), dir.roleIn(cls.id, to)]);
    const kind = fromRole === 'teacher' || toRole === 'teacher' ? 'teacher' : fromRole && toRole ? 'students' : null;
    let why: SendBlock = null;
    if (cls.archived) why = 'archived';
    else if (!fromRole) why = 'left';
    else if (!toRole) why = 'other-left';
    else if (fromRole === 'student' && toRole === 'student') {
      if (await classmatesOff(cls.id)) why = 'class-off';
      else if (await isMuted(cls.id, from)) why = 'muted';
    }
    return { why, kind, fromRole, toRole };
  }

  async function personKeys(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const uniq = [...new Set(ids)];
    const read = async (list: string[]) => {
      for (let i = 0; i < list.length; i += 90) {
        const part = list.slice(i, i + 90);
        const rows = (await db.prepare(`SELECT user_id, key FROM soshial_person_keys WHERE user_id IN (${part.map(() => '?').join(',')})`)
          .bind(...part).all<{ user_id: string; key: string }>()).results ?? [];
        for (const r of rows) out.set(r.user_id, r.key);
      }
    };
    await read(uniq);
    const missing = uniq.filter((u) => !out.has(u));
    if (missing.length) {
      await db.batch(missing.map((u) => db.prepare(`INSERT OR IGNORE INTO soshial_person_keys (user_id, key) VALUES (?, ?)`).bind(u, 'p' + randomHex(10))));
      await read(missing);
    }
    return out;
  }

  async function userForKey(key: string): Promise<string | null> {
    const r = await db.prepare(`SELECT user_id FROM soshial_person_keys WHERE key = ?`).bind(key).first<{ user_id: string }>();
    return r?.user_id ?? null;
  }

  const toPeople = (rows: Person[], keys: Map<string, string>): MessagePerson[] =>
    rows.flatMap((p) => (keys.has(p.id) ? [{ key: keys.get(p.id)!, name: p.name, teacher: p.role === 'teacher' }] : []));

  async function threadWithMembers(id: string): Promise<{ thread: ThreadRow; members: MemberRow[] } | null> {
    const thread = await db.prepare(`SELECT id, class_id, kind, created_at, last_at FROM soshial_threads WHERE id = ?`).bind(id).first<ThreadRow>();
    if (!thread) return null;
    const members = (await db.prepare(`SELECT user_id, name, teacher, read_at FROM soshial_members WHERE thread_id = ?`)
      .bind(id).all<MemberRow>()).results ?? [];
    return { thread, members };
  }

  const threadMessages = async (threadId: string) => (await db.prepare(
    `SELECT id, author_id, body, created_at, deleted_at FROM soshial_messages WHERE thread_id = ? ORDER BY created_at, rowid`,
  ).bind(threadId).all<MessageRow>()).results ?? [];

  async function unreadCount(userId: string): Promise<number> {
    const r = await db.prepare(
      `SELECT COUNT(*) AS n FROM soshial_members m
        WHERE m.user_id = ?1 AND EXISTS (
          SELECT 1 FROM soshial_messages x WHERE x.thread_id = m.thread_id AND x.author_id != ?1
             AND x.created_at > m.read_at AND x.deleted_at IS NULL)`,
    ).bind(userId).first<{ n: number }>();
    return r?.n ?? 0;
  }

  /** The view for one of its two people, or null when the caller is not one of them. */
  async function memberView(me: string, threadId: string): Promise<ThreadView | null> {
    const t = await threadWithMembers(threadId);
    if (!t) return null;
    const mine = t.members.find((m) => m.user_id === me);
    const other = t.members.find((m) => m.user_id !== me);
    if (!mine || !other) return null;
    const cls = await dir.classInfo(t.thread.class_id);
    const className = cls?.name ?? 'a class';
    const why: SendBlock = cls ? (await sendRule(cls, me, other.user_id)).why : 'archived';
    const names = new Map(t.members.map((m) => [m.user_id, m]));
    const messages: MessageItem[] = (await threadMessages(threadId)).map((r) => ({
      id: r.id,
      mine: r.author_id === me,
      author: names.get(r.author_id)?.name ?? 'Someone',
      teacher: !!names.get(r.author_id)?.teacher,
      body: r.deleted_at == null ? r.body : null,
      removed: r.deleted_at != null,
      at: r.created_at,
    }));
    return {
      id: t.thread.id, classId: t.thread.class_id, className, kind: t.thread.kind,
      other: { name: other.name, teacher: !!other.teacher },
      messages, canSend: why === null, why, whyText: blockText(why, other.name, className),
    };
  }

  /** The caps on sending (a student only), or null when the message may go. */
  async function capRefusal(userId: string, role: Role | null, threadId: string | null): Promise<string | null> {
    if (threadId) {
      const n = await db.prepare(`SELECT COUNT(*) AS n FROM soshial_messages WHERE thread_id = ?`).bind(threadId).first<{ n: number }>();
      if ((n?.n ?? 0) >= limits.perThread) return `This conversation has ${limits.perThread} messages, the most one can hold.`;
    }
    if (role === 'teacher') return null;
    const t = now();
    const [minute, day] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM soshial_messages WHERE author_id = ? AND created_at > ?`).bind(userId, t - 60_000).first<{ n: number }>(),
      db.prepare(`SELECT COUNT(*) AS n FROM soshial_messages WHERE author_id = ? AND created_at > ?`).bind(userId, t - 86_400_000).first<{ n: number }>(),
    ]);
    if ((minute?.n ?? 0) >= limits.perMinute) return `You have sent ${limits.perMinute} messages in the last minute, the most for one minute. Wait a moment and try again.`;
    if ((day?.n ?? 0) >= limits.perDay) return `You have sent ${limits.perDay} messages today, the most for one day. You can send more tomorrow.`;
    return null;
  }

  async function appendMessage(userId: string, threadId: string, body: string): Promise<void> {
    const t = now();
    await db.batch([
      db.prepare(`INSERT INTO soshial_messages (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)`).bind(randomHex(16), threadId, userId, body, t),
      db.prepare(`UPDATE soshial_threads SET last_at = MAX(last_at, ?) WHERE id = ?`).bind(t, threadId),
      db.prepare(`UPDATE soshial_members SET read_at = MAX(read_at, ?) WHERE thread_id = ? AND user_id = ?`).bind(t, threadId, userId),
    ]);
  }

  async function readBody(request: Request): Promise<Record<string, unknown> | null> {
    try { return (await request.json()) as Record<string, unknown>; } catch { return null; }
  }

  // ---- the mailbox -------------------------------------------------------------------------------

  async function inboxGet(s: Session, url: URL): Promise<Response> {
    const me = s.userId;
    if (url.searchParams.get('count')) return json({ unread: await unreadCount(me) });

    if (url.searchParams.get('people')) {
      const classes: PeopleClass[] = [];
      for (const id of await dir.classesOf(me)) {
        const cls = await dir.classInfo(id);
        if (!cls || cls.archived) continue;
        const role = await dir.roleIn(id, me);
        if (!role) continue;
        const everyone = (await dir.people(id)).filter((p) => p.id !== me);
        const teaches = role === 'teacher';
        let blocked: SendBlock = null;
        if (!teaches) {
          if (await classmatesOff(id)) blocked = 'class-off';
          else if (await isMuted(id, me)) blocked = 'muted';
        }
        const listed = (teaches || !blocked ? everyone : everyone.filter((p) => p.role === 'teacher'))
          .sort((a, b) => Number(b.role === 'teacher') - Number(a.role === 'teacher') || a.name.localeCompare(b.name));
        const keys = await personKeys(listed.map((p) => p.id));
        classes.push({ id, name: cls.name, teaches, people: toPeople(listed, keys), classmatesBlocked: blocked });
      }
      classes.sort((a, b) => a.name.localeCompare(b.name));
      return json({ classes });
    }

    const rows = (await db.prepare(
      `SELECT t.id, t.class_id, t.kind, t.last_at, o.name AS other_name, o.teacher AS other_teacher,
              x.author_id AS m_author, x.body AS m_body, x.created_at AS m_at, x.deleted_at AS m_deleted,
              EXISTS (SELECT 1 FROM soshial_messages u WHERE u.thread_id = t.id AND u.author_id != ?1
                         AND u.created_at > m.read_at AND u.deleted_at IS NULL) AS unread
         FROM soshial_members m
         JOIN soshial_threads t ON t.id = m.thread_id
         JOIN soshial_members o ON o.thread_id = t.id AND o.user_id != ?1
         LEFT JOIN soshial_messages x ON x.id = (SELECT y.id FROM soshial_messages y WHERE y.thread_id = t.id ORDER BY y.created_at DESC, y.rowid DESC LIMIT 1)
        WHERE m.user_id = ?1
        ORDER BY t.last_at DESC LIMIT ?2`,
    ).bind(me, THREAD_LIST_LIMIT).all<{
      id: string; class_id: string; kind: 'teacher' | 'students'; last_at: number; other_name: string; other_teacher: number;
      m_author: string | null; m_body: string | null; m_at: number | null; m_deleted: number | null; unread: number;
    }>()).results ?? [];
    const classNames = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.class_id))) classNames.set(id, (await dir.classInfo(id))?.name ?? 'a class');
    const threads: ThreadSummary[] = rows.map((r) => ({
      id: r.id,
      classId: r.class_id,
      className: classNames.get(r.class_id) ?? 'a class',
      kind: r.kind,
      other: { name: r.other_name, teacher: !!r.other_teacher },
      last: r.m_at == null ? null : {
        snippet: r.m_deleted != null ? '' : snippetOf(r.m_body ?? ''),
        mine: r.m_author === me, at: r.m_at, removed: r.m_deleted != null,
      },
      unread: !!r.unread,
    }));
    return json({ threads, unread: await unreadCount(me) });
  }

  async function inboxPost(s: Session, request: Request): Promise<Response> {
    const body = await readBody(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    if (typeof body.classId !== 'string' || !isPersonKey(body.to)) return json({ error: 'Choose who the message is for.' }, 400);
    const cls = await dir.classInfo(body.classId);
    const to = await userForKey(body.to);
    const notHere = () => json({ error: 'That person is not in this class.' }, 404);
    if (!cls || !to || to === s.userId) return notHere();

    const rule = await sendRule(cls, s.userId, to);
    // Someone not in the class learns nothing about who is.
    if (!rule.fromRole || rule.why === 'other-left') return notHere();
    const toName = await dir.nameOf(to);
    if (rule.why) return json({ error: blockText(rule.why, toName, cls.name), why: rule.why }, 403);

    const c = clean(body.body);
    if ('error' in c) return json(c, 400);

    const key = pairKey(cls.id, s.userId, to);
    const existing = await db.prepare(`SELECT id FROM soshial_threads WHERE pair_key = ?`).bind(key).first<{ id: string }>();
    const capped = await capRefusal(s.userId, rule.fromRole, existing?.id ?? null);
    if (capped) return json({ error: capped }, 429);

    let threadId = existing?.id;
    if (!threadId) {
      const t = now();
      await db.prepare(
        `INSERT OR IGNORE INTO soshial_threads (id, class_id, pair_key, kind, created_by, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(randomHex(16), cls.id, key, rule.kind, s.userId, t, t).run();
      // Two people starting the same conversation at once both land in the one that won.
      threadId = (await db.prepare(`SELECT id FROM soshial_threads WHERE pair_key = ?`).bind(key).first<{ id: string }>())!.id;
      const myName = await dir.nameOf(s.userId);
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO soshial_members (thread_id, user_id, name, teacher, read_at) VALUES (?, ?, ?, ?, 0)`)
          .bind(threadId, s.userId, myName, rule.fromRole === 'teacher' ? 1 : 0),
        db.prepare(`INSERT OR IGNORE INTO soshial_members (thread_id, user_id, name, teacher, read_at) VALUES (?, ?, ?, ?, 0)`)
          .bind(threadId, to, toName, rule.toRole === 'teacher' ? 1 : 0),
      ]);
    }
    await appendMessage(s.userId, threadId, c.body);
    return json(await memberView(s.userId, threadId), 201);
  }

  async function threadGet(s: Session, id: string): Promise<Response> {
    const view = await memberView(s.userId, id);
    if (!view) return json({ error: 'Not found' }, 404);
    const newest = view.messages.reduce((n, m) => Math.max(n, m.at), 0);
    if (newest) {
      await db.prepare(`UPDATE soshial_members SET read_at = MAX(read_at, ?) WHERE thread_id = ? AND user_id = ?`).bind(newest, id, s.userId).run();
    }
    return json(view);
  }

  async function threadPost(s: Session, id: string, request: Request): Promise<Response> {
    const t = await threadWithMembers(id);
    const other = t?.members.find((m) => m.user_id !== s.userId);
    if (!t || !other || !t.members.some((m) => m.user_id === s.userId)) return json({ error: 'Not found' }, 404);
    const body = await readBody(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const cls = await dir.classInfo(t.thread.class_id);
    if (!cls) return json({ error: blockText('archived', other.name, 'This class'), why: 'archived' }, 403);
    const rule = await sendRule(cls, s.userId, other.user_id);
    if (rule.why) return json({ error: blockText(rule.why, other.name, cls.name), why: rule.why }, 403);
    const c = clean(body.body);
    if ('error' in c) return json(c, 400);
    const capped = await capRefusal(s.userId, rule.fromRole, id);
    if (capped) return json({ error: capped }, 429);
    await appendMessage(s.userId, id, c.body);
    return json(await memberView(s.userId, id), 201);
  }

  // ---- the teacher panel -------------------------------------------------------------------------

  async function teacherRefusal(s: Session, classId: string): Promise<Response | null> {
    const cls = await dir.classInfo(classId);
    if (!cls) return json({ error: 'Class not found' }, 404);
    if (s.admin) return null;
    if ((await dir.roleIn(classId, s.userId)) !== 'teacher') return json({ error: 'Teachers of this class only' }, 403);
    return null;
  }

  async function overview(classId: string): Promise<ClassOverview> {
    const students = (await dir.people(classId)).filter((p) => p.role === 'student').sort((a, b) => a.name.localeCompare(b.name));
    const keys = await personKeys(students.map((p) => p.id));
    const muted = new Set(((await db.prepare(`SELECT user_id FROM soshial_mutes WHERE class_id = ?`).bind(classId)
      .all<{ user_id: string }>()).results ?? []).map((r) => r.user_id));
    const rows = (await db.prepare(
      `SELECT t.id, t.last_at,
              (SELECT GROUP_CONCAT(name, '|') FROM (SELECT name FROM soshial_members WHERE thread_id = t.id ORDER BY name)) AS names,
              (SELECT COUNT(*) FROM soshial_messages WHERE thread_id = t.id) AS n,
              x.body AS m_body, x.created_at AS m_at, x.deleted_at AS m_deleted,
              (SELECT name FROM soshial_members WHERE thread_id = t.id AND user_id = x.author_id) AS m_author
         FROM soshial_threads t
         LEFT JOIN soshial_messages x ON x.id = (SELECT y.id FROM soshial_messages y WHERE y.thread_id = t.id ORDER BY y.created_at DESC, y.rowid DESC LIMIT 1)
        WHERE t.class_id = ? AND t.kind = 'students'
        ORDER BY t.last_at DESC LIMIT 200`,
    ).bind(classId).all<{ id: string; last_at: number; names: string | null; n: number; m_body: string | null; m_at: number | null; m_deleted: number | null; m_author: string | null }>()).results ?? [];
    return {
      classmatesOn: !(await classmatesOff(classId)),
      students: students.flatMap((p) => (keys.has(p.id) ? [{ key: keys.get(p.id)!, name: p.name, muted: muted.has(p.id) }] : [])),
      threads: rows.map((r) => ({
        id: r.id,
        people: (r.names ?? '').split('|').filter(Boolean),
        count: r.n,
        lastAt: r.last_at,
        last: r.m_at == null ? null : { author: r.m_author ?? 'Someone', snippet: snippetOf(r.m_body ?? ''), at: r.m_at, removed: r.m_deleted != null },
      })),
    };
  }

  /** A conversation this teacher may read on the panel: in this class, between two students (or the teacher is in it). */
  async function readableThread(s: Session, classId: string, threadId: string) {
    const t = await threadWithMembers(threadId);
    if (!t || t.thread.class_id !== classId) return null;
    if (t.thread.kind !== 'students' && !t.members.some((m) => m.user_id === s.userId)) return null;
    return t;
  }

  async function classThread(s: Session, classId: string, threadId: string): Promise<ClassThread | null> {
    const t = await readableThread(s, classId, threadId);
    if (!t) return null;
    const names = new Map(t.members.map((m) => [m.user_id, m]));
    return {
      id: t.thread.id,
      people: t.members.map((m) => ({ name: m.name, teacher: !!m.teacher })),
      messages: (await threadMessages(threadId)).map((r) => ({
        id: r.id,
        author: names.get(r.author_id)?.name ?? 'Someone',
        teacher: !!names.get(r.author_id)?.teacher,
        body: r.body,
        removed: r.deleted_at != null,
        at: r.created_at,
      })),
    };
  }

  async function classGet(s: Session, classId: string, url: URL): Promise<Response> {
    const refused = await teacherRefusal(s, classId);
    if (refused) return refused;
    const thread = url.searchParams.get('thread');
    if (thread != null) {
      if (!isId(thread)) return json({ error: 'Not found' }, 404);
      const view = await classThread(s, classId, thread);
      return view ? json({ thread: view }) : json({ error: 'Not found' }, 404);
    }
    return json(await overview(classId));
  }

  async function classPost(s: Session, classId: string, request: Request): Promise<Response> {
    const refused = await teacherRefusal(s, classId);
    if (refused) return refused;
    const body = await readBody(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const t = now();

    if (body.action === 'classmates-off' || body.action === 'classmates-on') {
      const off = body.action === 'classmates-off' ? 1 : 0;
      await db.prepare(
        `INSERT INTO soshial_class_settings (class_id, classmates_off) VALUES (?, ?)
           ON CONFLICT(class_id) DO UPDATE SET classmates_off = excluded.classmates_off`,
      ).bind(classId, off).run();
      return json(await overview(classId));
    }

    if (body.action === 'mute' || body.action === 'unmute') {
      if (!isPersonKey(body.student)) return json({ error: 'Choose a student.' }, 400);
      const user = await userForKey(body.student);
      if (!user || (await dir.roleIn(classId, user)) !== 'student') return json({ error: 'That student is not in this class.' }, 404);
      if (body.action === 'mute') {
        await db.prepare(`INSERT OR IGNORE INTO soshial_mutes (class_id, user_id, muted_at, muted_by) VALUES (?, ?, ?, ?)`).bind(classId, user, t, s.userId).run();
      } else {
        await db.prepare(`DELETE FROM soshial_mutes WHERE class_id = ? AND user_id = ?`).bind(classId, user).run();
      }
      return json(await overview(classId));
    }

    if (body.action === 'remove' || body.action === 'restore') {
      if (!isId(body.messageId)) return json({ error: 'Not found' }, 404);
      const m = await db.prepare(`SELECT thread_id FROM soshial_messages WHERE id = ?`).bind(body.messageId).first<{ thread_id: string }>();
      if (!m || !(await readableThread(s, classId, m.thread_id))) return json({ error: 'Not found' }, 404);
      if (body.action === 'remove') {
        await db.prepare(`UPDATE soshial_messages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL`).bind(t, s.userId, body.messageId).run();
      } else {
        await db.prepare(`UPDATE soshial_messages SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).bind(body.messageId).run();
      }
      return json({ thread: await classThread(s, classId, m.thread_id) });
    }

    return json({ error: 'Unknown action' }, 400);
  }

  // ---- the router --------------------------------------------------------------------------------

  /** Answers a soSHial request, or null when the path is not one of soSHial's. `session` null = 401. */
  async function handle(request: Request, session: Session | null): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return null;
    const parts = url.pathname.slice(base.length).split('/').filter(Boolean).map(decodeURIComponent);
    const method = request.method.toUpperCase();
    const route = (() => {
      if (parts.length === 1 && parts[0] === 'messages') return method === 'GET' ? 'inbox-get' : method === 'POST' ? 'inbox-post' : 'bad';
      if (parts.length === 2 && parts[0] === 'messages') return method === 'GET' ? 'thread-get' : method === 'POST' ? 'thread-post' : 'bad';
      if (parts.length === 3 && parts[0] === 'classes' && parts[2] === 'messages') return method === 'GET' ? 'class-get' : method === 'POST' ? 'class-post' : 'bad';
      return null;
    })();
    if (!route) return null;
    if (route === 'bad') return json({ error: 'Method not allowed' }, 405);
    if (!session?.userId) return json({ error: 'Sign in first' }, 401);
    switch (route) {
      case 'inbox-get': return inboxGet(session, url);
      case 'inbox-post': return inboxPost(session, request);
      case 'thread-get': return isId(parts[1]) ? threadGet(session, parts[1]) : json({ error: 'Not found' }, 404);
      case 'thread-post': return isId(parts[1]) ? threadPost(session, parts[1], request) : json({ error: 'Not found' }, 404);
      case 'class-get': return classGet(session, parts[1], url);
      case 'class-post': return classPost(session, parts[1], request);
    }
    return null;
  }

  /** Delete everything soSHial holds for one class (call it when your app deletes the class). */
  async function deleteClass(classId: string): Promise<void> {
    await db.batch([
      db.prepare(`DELETE FROM soshial_messages WHERE thread_id IN (SELECT id FROM soshial_threads WHERE class_id = ?)`).bind(classId),
      db.prepare(`DELETE FROM soshial_members WHERE thread_id IN (SELECT id FROM soshial_threads WHERE class_id = ?)`).bind(classId),
      db.prepare(`DELETE FROM soshial_threads WHERE class_id = ?`).bind(classId),
      db.prepare(`DELETE FROM soshial_mutes WHERE class_id = ?`).bind(classId),
      db.prepare(`DELETE FROM soshial_class_settings WHERE class_id = ?`).bind(classId),
    ]);
  }

  // unreadCount: conversations with something unread for one user, for your own badge or a digest.
  return { handle, deleteClass, unreadCount, limits };
}

export type Soshial = ReturnType<typeof createSoshial>;
