// soSHial's server: every route, over the Fetch API's Request and Response, so it runs in a Cloudflare
// Pages Function, a Worker, or anything else that speaks Request/Response.
//
//   const soshial = createSoshial({ db: env.DB, directory });
//   const res = await soshial.handle(request, { userId });   // null when the path is not soSHial's
//
// Routes, under `base` (default '/api/soshial'):
//   GET  /messages              the caller's conversations: each class's channels, then two-person
//                               conversations and groups (newest first), plus `unread`
//   GET  /messages?count=1      only `unread`: two-person conversations and groups with something unopened
//                               (a channel with news is shown bold in the list instead)
//   GET  /messages?people=1     whom the caller may write to, per class
//   POST /messages              { classId, to, body }: send to a person (reuses the pair's conversation)
//                               { classId, create: 'group', people: [keys], title? }: a group of 2-8
//                               { classId, create: 'channel', name }: a channel for the whole class
//   GET  /messages/<id>         one conversation; marks it read for the caller
//   POST /messages/<id>         { body }: send in it
//                               { action: 'rename', title } a group's people; a channel's maker or teacher
//                               { action: 'add', people }   a group: add people of the class
//                               { action: 'leave' }         a group (the last one out deletes it)
//                               { action: 'lock' | 'unlock' | 'delete' } a channel; 'delete' a group (teachers)
//                               { action: 'remove' | 'restore', messageId } a teacher of the class
//   GET  /classes/<id>/messages             teacher panel: levels, students, student conversations and groups
//   GET  /classes/<id>/messages?thread=<id> one of them (removed messages included, for teachers)
//   POST /classes/<id>/messages             { action: 'class-level', level: 0 | 1 | 2 }
//                                           { action: 'student-level', student: <key>, level: 0 | 1 | 2 }
//                                           { action: 'remove' | 'restore', messageId }
//                                           (0.1.0's 'classmates-off' | 'classmates-on' and 'mute' | 'unmute'
//                                           still work: they are levels 1 / 0)
// Levels (a student's; the stricter of class and student wins): 0 On, 1 Teacher only, 2 Off.
// No answer ever carries a user id or an email: a person is a random public key and a name.

import type { ClassDirectory, ClassInfo, Person, Role, Session } from './directory';
import {
  CHANNELS_PER_CLASS, DEFAULT_LIMITS, GENERAL, GROUP_MAX_PEOPLE, GROUP_NOTE, MADE_PER_DAY, MESSAGES_PER_CHANNEL,
  THREAD_LIST_LIMIT, THREAD_VIEW_LIMIT, WATCHED_NOTE, blockText, channelNote, cleanChannelName, cleanGroupTitle,
  cleanMessage, groupLabel, isId, isLevel, isPersonKey, pairKey, snippetOf, toLevel,
  type ClassOverview, type ClassThread, type FindPII, type Limits, type MessageItem, type MessageLevel, type MessagePerson,
  type PeopleClass, type SendBlock, type ThreadKind, type ThreadSummary, type ThreadView,
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

interface ThreadRow {
  id: string; class_id: string; kind: ThreadKind; created_at: number; last_at: number; title: string; locked: number; created_by: string;
}
interface MemberRow { user_id: string; name: string; teacher: number; read_at: number }
interface MessageRow { id: string; author_id: string; body: string; created_at: number; deleted_at: number | null }

interface Access {
  thread: ThreadRow;
  members: MemberRow[];
  cls: ClassInfo | null;
  className: string;
  role: Role | null;
  me: MemberRow | undefined;
  read: boolean;
  moderate: boolean;
  onlooker: boolean;
}

const channelKey = (classId: string, name: string) => `channel|${classId}|${name}`;

export function createSoshial(opts: SoshialOptions) {
  const db = opts.db;
  const dir = opts.directory;
  const base = (opts.base ?? '/api/soshial').replace(/\/$/, '');
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const pii = opts.findPII ?? defaultFindPII;
  const now = opts.now ?? Date.now;
  const clean = (raw: unknown) => cleanMessage(raw, limits, pii);

  // ---- levels and who may send -------------------------------------------------------------------

  async function classLevel(classId: string): Promise<MessageLevel> {
    const r = await db.prepare(`SELECT classmates_off, student_level FROM soshial_class_settings WHERE class_id = ?`).bind(classId)
      .first<{ classmates_off: number; student_level: number }>();
    return r ? toLevel(Math.max(r.classmates_off ?? 0, r.student_level ?? 0)) : 0;
  }
  async function ownLevel(classId: string, userId: string): Promise<MessageLevel> {
    const r = await db.prepare(`SELECT level FROM soshial_mutes WHERE class_id = ? AND user_id = ?`).bind(classId, userId).first<{ level: number }>();
    return r ? toLevel(r.level) : 0;
  }

  /** May someone with this role post to a teacher ('teacher') or to classmates ('peers': a classmate, a group, a channel)? */
  async function postBlock(cls: ClassInfo, userId: string, role: Role | null, to: 'teacher' | 'peers'): Promise<SendBlock> {
    if (cls.archived) return 'archived';
    if (!role) return 'left';
    if (role === 'teacher') return null;
    const [c, own] = await Promise.all([classLevel(cls.id), ownLevel(cls.id, userId)]);
    if (c >= 2) return 'class-all-off';
    if (own >= 2) return 'all-off';
    if (to === 'teacher') return null;
    if (c >= 1) return 'class-off';
    if (own >= 1) return 'muted';
    return null;
  }

  /** May `from` write to `to` (two people) in this class right now? Re-checked on every message. */
  async function sendRule(cls: ClassInfo, from: string, to: string): Promise<{ why: SendBlock; kind: 'teacher' | 'students' | null; fromRole: Role | null; toRole: Role | null }> {
    const [fromRole, toRole] = await Promise.all([dir.roleIn(cls.id, from), dir.roleIn(cls.id, to)]);
    const kind = fromRole === 'teacher' || toRole === 'teacher' ? 'teacher' : fromRole && toRole ? 'students' : null;
    let why: SendBlock = null;
    if (cls.archived) why = 'archived';
    else if (!fromRole) why = 'left';
    else if (!toRole) why = 'other-left';
    else why = await postBlock(cls, from, fromRole, toRole === 'teacher' ? 'teacher' : 'peers');
    return { why, kind, fromRole, toRole };
  }

  // ---- people ------------------------------------------------------------------------------------

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

  /** The live classes a user is in now, and whether they teach each. */
  async function liveClasses(userId: string): Promise<{ cls: ClassInfo; role: Role }[]> {
    const out: { cls: ClassInfo; role: Role }[] = [];
    for (const id of await dir.classesOf(userId)) {
      const cls = await dir.classInfo(id);
      if (!cls || cls.archived) continue;
      const role = await dir.roleIn(id, userId);
      if (role) out.push({ cls, role });
    }
    return out;
  }

  // ---- conversations -----------------------------------------------------------------------------

  async function threadWithMembers(id: string): Promise<{ thread: ThreadRow; members: MemberRow[] } | null> {
    const thread = await db.prepare(`SELECT id, class_id, kind, created_at, last_at, title, locked, created_by FROM soshial_threads WHERE id = ?`).bind(id).first<ThreadRow>();
    if (!thread) return null;
    const members = (await db.prepare(`SELECT user_id, name, teacher, read_at FROM soshial_members WHERE thread_id = ?`)
      .bind(id).all<MemberRow>()).results ?? [];
    return { thread, members };
  }

  /** The newest `limit` messages, oldest first. */
  async function threadMessages(threadId: string, limit = THREAD_VIEW_LIMIT): Promise<MessageRow[]> {
    const rows = (await db.prepare(
      `SELECT id, author_id, body, created_at, deleted_at FROM soshial_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).bind(threadId, limit).all<MessageRow>()).results ?? [];
    return rows.reverse();
  }

  async function unreadCount(userId: string): Promise<number> {
    const r = await db.prepare(
      `SELECT COUNT(*) AS n FROM soshial_members m JOIN soshial_threads t ON t.id = m.thread_id AND t.kind != 'channel'
        WHERE m.user_id = ?1 AND EXISTS (
          SELECT 1 FROM soshial_messages x WHERE x.thread_id = m.thread_id AND x.author_id != ?1
             AND x.created_at > m.read_at AND x.deleted_at IS NULL)`,
    ).bind(userId).first<{ n: number }>();
    return r?.n ?? 0;
  }

  /**
   * Who may read: a two-person conversation's two people (and, between two students, the class's
   * teachers); a group's people and the class's teachers; a channel, everyone in the class now.
   */
  async function threadAccess(s: Session, id: string): Promise<Access | null> {
    const t = await threadWithMembers(id);
    if (!t) return null;
    const cls = await dir.classInfo(t.thread.class_id);
    const role = cls ? await dir.roleIn(cls.id, s.userId) : null;
    const teacherOf = !!s.admin || role === 'teacher';
    const me = t.members.find((m) => m.user_id === s.userId);
    const kind = t.thread.kind;
    let read = false;
    let onlooker = false;
    if (kind === 'teacher') read = !!me;
    else if (kind === 'students' || kind === 'group') { read = !!me || teacherOf; onlooker = !me && teacherOf; }
    else if (kind === 'channel') read = !!role || !!s.admin;
    return { ...t, cls, className: cls?.name ?? 'a class', role, me, read, moderate: teacherOf && kind !== 'teacher', onlooker };
  }

  /** A reader's row in a channel (it only holds what they have read), made the first time it is needed. */
  async function touchMember(threadId: string, userId: string, teacher: boolean): Promise<void> {
    const has = await db.prepare(`SELECT 1 AS x FROM soshial_members WHERE thread_id = ? AND user_id = ?`).bind(threadId, userId).first();
    if (has) return;
    await db.prepare(`INSERT OR IGNORE INTO soshial_members (thread_id, user_id, name, teacher, read_at) VALUES (?, ?, ?, ?, 0)`)
      .bind(threadId, userId, await dir.nameOf(userId), teacher ? 1 : 0).run();
  }

  async function threadBlock(a: Access, userId: string): Promise<SendBlock> {
    const kind = a.thread.kind;
    if (!a.cls) return 'archived';
    if (kind === 'teacher' || kind === 'students') {
      const other = a.members.find((m) => m.user_id !== userId);
      if (!a.me || !other) return 'not-member';
      return (await sendRule(a.cls, userId, other.user_id)).why;
    }
    if (kind === 'group' && !a.me) return 'not-member';
    if (kind === 'channel' && a.thread.locked && a.role !== 'teacher') {
      if (a.cls.archived) return 'archived';
      return a.role ? 'locked' : 'left';
    }
    return postBlock(a.cls, userId, a.role, 'peers');
  }

  function titleFor(a: Access, userId: string): string {
    const kind = a.thread.kind;
    if (kind === 'channel') return a.thread.title;
    if (kind === 'group') return groupLabel(a.thread.title, a.members.filter((m) => m.user_id !== userId).map((m) => m.name));
    if (a.onlooker) return a.members.map((m) => m.name).sort().join(' and ');
    return a.members.find((m) => m.user_id !== userId)?.name ?? 'Someone';
  }

  /** The conversation as this reader sees it, or null when they may not read it. */
  async function threadView(s: Session, threadId: string, given?: Access | null): Promise<ThreadView | null> {
    const a = given ?? await threadAccess(s, threadId);
    if (!a || !a.read) return null;
    const kind = a.thread.kind;
    const why = a.onlooker ? null : await threadBlock(a, s.userId);
    const rows = await threadMessages(threadId, THREAD_VIEW_LIMIT + 1);
    const more = rows.length > THREAD_VIEW_LIMIT;
    const shown = more ? rows.slice(rows.length - THREAD_VIEW_LIMIT) : rows;
    const names = new Map(a.members.map((m) => [m.user_id, m]));
    for (const r of shown) {
      if (!names.has(r.author_id)) names.set(r.author_id, { user_id: r.author_id, name: await dir.nameOf(r.author_id), teacher: 0, read_at: 0 });
    }
    const messages: MessageItem[] = shown.map((r) => {
      const removed = r.deleted_at != null;
      return {
        id: r.id,
        mine: r.author_id === s.userId,
        author: names.get(r.author_id)?.name ?? 'Someone',
        teacher: !!names.get(r.author_id)?.teacher,
        // A removed message's words go to the class's teachers only.
        body: removed && !a.moderate ? null : r.body,
        removed,
        at: r.created_at,
      };
    });
    const title = titleFor(a, s.userId);
    let other = { name: title, teacher: false };
    if ((kind === 'teacher' || kind === 'students') && !a.onlooker) {
      const o = a.members.find((m) => m.user_id !== s.userId);
      if (o) other = { name: o.name, teacher: !!o.teacher };
    }
    const note = kind === 'students' ? WATCHED_NOTE : kind === 'group' ? GROUP_NOTE : kind === 'channel' ? channelNote(a.className) : null;
    const canSend = !a.onlooker && why === null;
    const isTeacher = a.role === 'teacher' || !!s.admin;
    const manage = kind === 'group' ? !!a.me && canSend
      : kind === 'channel' ? isTeacher || (a.thread.created_by === s.userId && canSend)
      : false;
    let members: ThreadView['members'];
    if (kind === 'group') {
      const keys = await personKeys(a.members.map((m) => m.user_id));
      members = a.members.map((m) => ({ key: keys.get(m.user_id) ?? '', name: m.name, teacher: !!m.teacher, me: m.user_id === s.userId }))
        .sort((x, y) => Number(y.teacher) - Number(x.teacher) || x.name.localeCompare(y.name));
    }
    const whyName = kind === 'channel' ? `#${a.thread.title}` : kind === 'group' ? title : other.name;
    return {
      id: a.thread.id, classId: a.thread.class_id, className: a.className, kind, title, other,
      ...(members ? { members } : {}),
      ...(kind === 'channel' ? { locked: !!a.thread.locked } : {}),
      messages, more, canSend, why,
      whyText: a.onlooker ? 'You are reading this as a teacher of the class.' : blockText(why, whyName, a.className),
      note, moderate: a.moderate, manage, onlooker: a.onlooker,
    };
  }

  /** The caps on sending (a student only), or null when the message may go. */
  async function capRefusal(userId: string, role: Role | null, threadId: string | null, kind: ThreadKind = 'students'): Promise<string | null> {
    if (threadId) {
      const cap = kind === 'channel' ? MESSAGES_PER_CHANNEL : limits.perThread;
      const n = await db.prepare(`SELECT COUNT(*) AS n FROM soshial_messages WHERE thread_id = ?`).bind(threadId).first<{ n: number }>();
      if ((n?.n ?? 0) >= cap) {
        return kind === 'channel'
          ? `This channel has ${cap} messages, the most one can hold. Ask your teacher to start a new channel.`
          : `This conversation has ${cap} messages, the most one can hold.`;
      }
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

  async function deleteThread(threadId: string): Promise<void> {
    await db.batch([
      db.prepare(`DELETE FROM soshial_messages WHERE thread_id = ?`).bind(threadId),
      db.prepare(`DELETE FROM soshial_members WHERE thread_id = ?`).bind(threadId),
      db.prepare(`DELETE FROM soshial_threads WHERE id = ?`).bind(threadId),
    ]);
  }

  /** Every class has #general: made the first time anyone in it looks. */
  async function ensureGeneral(classIds: string[]): Promise<void> {
    if (!classIds.length) return;
    const t = now();
    await db.batch(classIds.map((c) => db.prepare(
      `INSERT OR IGNORE INTO soshial_threads (id, class_id, pair_key, kind, created_by, created_at, last_at, title) VALUES (?, ?, ?, 'channel', '', ?, 0, ?)`,
    ).bind(randomHex(16), c, channelKey(c, GENERAL), t, GENERAL)));
  }

  async function readBody(request: Request): Promise<Record<string, unknown> | null> {
    try { return (await request.json()) as Record<string, unknown>; } catch { return null; }
  }

  // ---- the mailbox -------------------------------------------------------------------------------

  interface ListRow {
    id: string; class_id: string; kind: ThreadKind; title: string; locked: number; last_at: number; others: string | null; n: number;
    m_author: string | null; m_author_name: string | null; m_body: string | null; m_at: number | null; m_deleted: number | null; unread: number;
  }
  const LAST = `x.author_id AS m_author,
            (SELECT a.name FROM soshial_members a WHERE a.thread_id = t.id AND a.user_id = x.author_id) AS m_author_name,
            x.body AS m_body, x.created_at AS m_at, x.deleted_at AS m_deleted`;
  const LAST_JOIN = `LEFT JOIN soshial_messages x ON x.id = (SELECT y.id FROM soshial_messages y WHERE y.thread_id = t.id ORDER BY y.created_at DESC, y.rowid DESC LIMIT 1)`;

  async function listThreads(me: string): Promise<ThreadSummary[]> {
    const own = (await db.prepare(
      `SELECT t.id, t.class_id, t.kind, t.title, t.locked, t.last_at,
              (SELECT GROUP_CONCAT(o.name || '~' || o.teacher, '|') FROM soshial_members o WHERE o.thread_id = t.id AND o.user_id != ?1) AS others,
              (SELECT COUNT(*) FROM soshial_members o WHERE o.thread_id = t.id) AS n,
              ${LAST},
              EXISTS (SELECT 1 FROM soshial_messages u WHERE u.thread_id = t.id AND u.author_id != ?1
                         AND u.created_at > m.read_at AND u.deleted_at IS NULL) AS unread
         FROM soshial_members m
         JOIN soshial_threads t ON t.id = m.thread_id AND t.kind != 'channel'
         ${LAST_JOIN}
        WHERE m.user_id = ?1
        ORDER BY t.last_at DESC LIMIT ?2`,
    ).bind(me, THREAD_LIST_LIMIT).all<ListRow>()).results ?? [];
    const classes = await liveClasses(me);
    const classNames = new Map(classes.map((c) => [c.cls.id, c.cls.name]));
    let channels: ListRow[] = [];
    if (classes.length) {
      const ids = classes.map((c) => c.cls.id);
      await ensureGeneral(ids);
      channels = (await db.prepare(
        `SELECT t.id, t.class_id, t.kind, t.title, t.locked, t.last_at, NULL AS others, 0 AS n,
                ${LAST},
                EXISTS (SELECT 1 FROM soshial_messages u WHERE u.thread_id = t.id AND u.author_id != ?1
                           AND u.created_at > COALESCE(m.read_at, 0) AND u.deleted_at IS NULL) AS unread
           FROM soshial_threads t
           LEFT JOIN soshial_members m ON m.thread_id = t.id AND m.user_id = ?1
           ${LAST_JOIN}
          WHERE t.kind = 'channel' AND t.class_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})
          ORDER BY CASE WHEN t.title = 'general' THEN 0 ELSE 1 END, t.title`,
      ).bind(me, ...ids).all<ListRow>()).results ?? [];
      channels.sort((a, b) => (classNames.get(a.class_id) ?? '').localeCompare(classNames.get(b.class_id) ?? ''));
    }
    for (const id of new Set(own.map((r) => r.class_id))) {
      if (!classNames.has(id)) classNames.set(id, (await dir.classInfo(id))?.name ?? 'a class');
    }
    return [...channels, ...own].map((r) => {
      const others = (r.others ?? '').split('|').filter(Boolean).map((o) => { const i = o.lastIndexOf('~'); return { name: o.slice(0, i), teacher: o.slice(i + 1) === '1' }; });
      let title = r.title;
      let other = { name: r.title, teacher: false };
      if (r.kind === 'teacher' || r.kind === 'students') { other = others[0] ?? { name: 'Someone', teacher: false }; title = other.name; }
      else if (r.kind === 'group') { title = groupLabel(r.title, others.map((o) => o.name)); other = { name: title, teacher: false }; }
      return {
        id: r.id, classId: r.class_id, className: classNames.get(r.class_id) ?? 'a class', kind: r.kind, title, other,
        ...(r.kind === 'group' ? { people: r.n } : {}),
        ...(r.kind === 'channel' ? { locked: !!r.locked } : {}),
        last: r.m_at == null ? null : {
          snippet: r.m_deleted != null ? '' : snippetOf(r.m_body ?? ''),
          mine: r.m_author === me, at: r.m_at, removed: r.m_deleted != null,
          ...(r.kind === 'group' || r.kind === 'channel' ? { author: r.m_author_name ?? 'Someone' } : {}),
        },
        unread: !!r.unread,
      };
    });
  }

  async function inboxGet(s: Session, url: URL): Promise<Response> {
    const me = s.userId;
    if (url.searchParams.get('count')) return json({ unread: await unreadCount(me) });

    if (url.searchParams.get('people')) {
      const classes: PeopleClass[] = [];
      for (const { cls, role } of await liveClasses(me)) {
        const everyone = (await dir.people(cls.id)).filter((p) => p.id !== me);
        const teaches = role === 'teacher';
        let blocked: SendBlock = null;
        let allBlocked: SendBlock = null;
        if (!teaches) {
          const [c, own] = await Promise.all([classLevel(cls.id), ownLevel(cls.id, me)]);
          if (c >= 2) allBlocked = 'class-all-off';
          else if (own >= 2) allBlocked = 'all-off';
          else if (c >= 1) blocked = 'class-off';
          else if (own >= 1) blocked = 'muted';
        }
        const listed = (allBlocked ? [] : teaches || !blocked ? everyone : everyone.filter((p) => p.role === 'teacher'))
          .sort((a, b) => Number(b.role === 'teacher') - Number(a.role === 'teacher') || a.name.localeCompare(b.name));
        const keys = await personKeys(listed.map((p) => p.id));
        classes.push({ id: cls.id, name: cls.name, teaches, people: toPeople(listed, keys), classmatesBlocked: allBlocked ?? blocked, ...(allBlocked ? { allBlocked } : {}) });
      }
      classes.sort((a, b) => a.name.localeCompare(b.name));
      return json({ classes });
    }

    return json({ threads: await listThreads(me), unread: await unreadCount(me) });
  }

  async function madeToday(userId: string): Promise<number> {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM soshial_threads WHERE created_by = ? AND kind IN ('group', 'channel') AND created_at > ?`)
      .bind(userId, now() - 86_400_000).first<{ n: number }>();
    return r?.n ?? 0;
  }

  async function create(s: Session, cls: ClassInfo, body: Record<string, unknown>): Promise<Response> {
    const role = await dir.roleIn(cls.id, s.userId);
    if (!role) return json({ error: 'That class is not there.' }, 404);
    const why = await postBlock(cls, s.userId, role, 'peers');
    if (why) return json({ error: blockText(why, '', cls.name), why }, 403);
    if (role === 'student' && (await madeToday(s.userId)) >= MADE_PER_DAY) {
      return json({ error: `You have made ${MADE_PER_DAY} groups and channels today, the most for one day.` }, 429);
    }
    const me = await dir.nameOf(s.userId);
    const id = randomHex(16);
    const t = now();

    if (body.create === 'channel') {
      const c = cleanChannelName(body.name, pii);
      if ('error' in c) return json(c, 400);
      const n = await db.prepare(`SELECT COUNT(*) AS n FROM soshial_threads WHERE class_id = ? AND kind = 'channel'`).bind(cls.id).first<{ n: number }>();
      if ((n?.n ?? 0) >= CHANNELS_PER_CLASS) return json({ error: `${cls.name} has ${CHANNELS_PER_CLASS} channels, the most a class can have.` }, 409);
      const key = channelKey(cls.id, c.name);
      if (await db.prepare(`SELECT 1 AS x FROM soshial_threads WHERE pair_key = ?`).bind(key).first()) {
        return json({ error: `${cls.name} already has a channel called #${c.name}.` }, 409);
      }
      await db.prepare(
        `INSERT OR IGNORE INTO soshial_threads (id, class_id, pair_key, kind, created_by, created_at, last_at, title) VALUES (?, ?, ?, 'channel', ?, ?, ?, ?)`,
      ).bind(id, cls.id, key, s.userId, t, t, c.name).run();
      await db.prepare(`INSERT OR IGNORE INTO soshial_members (thread_id, user_id, name, teacher, read_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(id, s.userId, me, role === 'teacher' ? 1 : 0, t).run();
      return json(await threadView(s, id), 201);
    }

    const title = cleanGroupTitle(body.title, pii);
    if ('error' in title) return json(title, 400);
    const keys = Array.isArray(body.people) ? [...new Set(body.people)] : [];
    if (!keys.length || !keys.every(isPersonKey)) return json({ error: 'Choose the people for the group.' }, 400);
    if (keys.length + 1 > GROUP_MAX_PEOPLE) return json({ error: `A group is at most ${GROUP_MAX_PEOPLE} people, you included.` }, 400);
    const inClass = new Map((await dir.people(cls.id)).map((p) => [p.id, p]));
    const people: Person[] = [];
    for (const k of keys) {
      const user = await userForKey(k as string);
      const p = user ? inClass.get(user) : undefined;
      if (!p || user === s.userId) return json({ error: 'Everyone in a group has to be in this class.' }, 400);
      people.push(p);
    }
    await db.batch([
      db.prepare(`INSERT INTO soshial_threads (id, class_id, pair_key, kind, created_by, created_at, last_at, title) VALUES (?, ?, ?, 'group', ?, ?, ?, ?)`)
        .bind(id, cls.id, `group|${id}`, s.userId, t, t, title.title),
      db.prepare(`INSERT INTO soshial_members (thread_id, user_id, name, teacher, read_at) VALUES (?, ?, ?, ?, ?)`).bind(id, s.userId, me, role === 'teacher' ? 1 : 0, t),
      ...people.map((p) => db.prepare(`INSERT INTO soshial_members (thread_id, user_id, name, teacher, read_at) VALUES (?, ?, ?, ?, 0)`)
        .bind(id, p.id, p.name, p.role === 'teacher' ? 1 : 0)),
    ]);
    return json(await threadView(s, id), 201);
  }

  async function inboxPost(s: Session, request: Request): Promise<Response> {
    const body = await readBody(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    if (typeof body.classId !== 'string') return json({ error: 'Choose who the message is for.' }, 400);
    const cls = await dir.classInfo(body.classId);
    if (body.create === 'group' || body.create === 'channel') {
      if (!cls) return json({ error: 'That class is not there.' }, 404);
      return create(s, cls, body);
    }
    if (!isPersonKey(body.to)) return json({ error: 'Choose who the message is for.' }, 400);
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
    return json(await threadView(s, threadId), 201);
  }

  async function threadGet(s: Session, id: string): Promise<Response> {
    const a = await threadAccess(s, id);
    if (!a || !a.read) return json({ error: 'Not found' }, 404);
    const view = await threadView(s, id, a);
    if (!view) return json({ error: 'Not found' }, 404);
    if (!a.onlooker) {
      if (a.thread.kind === 'channel') await touchMember(id, s.userId, a.role === 'teacher');
      const newest = view.messages.reduce((n, m) => Math.max(n, m.at), 0);
      if (newest) {
        await db.prepare(`UPDATE soshial_members SET read_at = MAX(read_at, ?) WHERE thread_id = ? AND user_id = ?`).bind(newest, id, s.userId).run();
      }
    }
    return json(view);
  }

  async function threadAction(s: Session, id: string, a: Access, body: Record<string, unknown>): Promise<Response> {
    const kind = a.thread.kind;
    const v = await threadView(s, id, a);
    const fresh = async () => json(await threadView(s, id));
    const act = body.action;

    if (act === 'remove' || act === 'restore') {
      if (!a.moderate) return json({ error: 'Only a teacher of the class can do that.' }, 403);
      if (!isId(body.messageId)) return json({ error: 'Not found' }, 404);
      const m = await db.prepare(`SELECT thread_id FROM soshial_messages WHERE id = ?`).bind(body.messageId).first<{ thread_id: string }>();
      if (!m || m.thread_id !== id) return json({ error: 'Not found' }, 404);
      if (act === 'remove') await db.prepare(`UPDATE soshial_messages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL`).bind(now(), s.userId, body.messageId).run();
      else await db.prepare(`UPDATE soshial_messages SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).bind(body.messageId).run();
      return fresh();
    }
    if (act === 'rename') {
      if (!v?.manage) return json({ error: 'You cannot rename this.' }, 403);
      if (kind === 'group') {
        const t = cleanGroupTitle(body.title, pii);
        if ('error' in t) return json(t, 400);
        await db.prepare(`UPDATE soshial_threads SET title = ? WHERE id = ?`).bind(t.title, id).run();
        return fresh();
      }
      if (a.thread.title === GENERAL) return json({ error: '#general keeps its name.' }, 400);
      const c = cleanChannelName(body.title, pii);
      if ('error' in c) return json(c, 400);
      const key = channelKey(a.thread.class_id, c.name);
      const taken = await db.prepare(`SELECT id FROM soshial_threads WHERE pair_key = ?`).bind(key).first<{ id: string }>();
      if (taken && taken.id !== id) return json({ error: `${a.className} already has a channel called #${c.name}.` }, 409);
      await db.prepare(`UPDATE soshial_threads SET title = ?, pair_key = ? WHERE id = ?`).bind(c.name, key, id).run();
      return fresh();
    }
    if (act === 'add') {
      if (kind !== 'group' || !v?.manage) return json({ error: 'You cannot add people here.' }, 403);
      const keys = Array.isArray(body.people) ? [...new Set(body.people)] : [];
      if (!keys.length || !keys.every(isPersonKey)) return json({ error: 'Choose who to add.' }, 400);
      const inClass = new Map((await dir.people(a.thread.class_id)).map((p) => [p.id, p]));
      const have = new Set(a.members.map((m) => m.user_id));
      const add: Person[] = [];
      for (const k of keys) {
        const user = await userForKey(k as string);
        const p = user ? inClass.get(user) : undefined;
        if (!p) return json({ error: 'Everyone in a group has to be in this class.' }, 400);
        if (!have.has(p.id)) add.push(p);
      }
      if (have.size + add.length > GROUP_MAX_PEOPLE) return json({ error: `A group is at most ${GROUP_MAX_PEOPLE} people.` }, 400);
      if (add.length) {
        await db.batch(add.map((p) => db.prepare(`INSERT OR IGNORE INTO soshial_members (thread_id, user_id, name, teacher, read_at) VALUES (?, ?, ?, ?, 0)`)
          .bind(id, p.id, p.name, p.role === 'teacher' ? 1 : 0)));
      }
      return fresh();
    }
    if (act === 'leave') {
      if (kind !== 'group' || !a.me) return json({ error: 'You are not in this group.' }, 400);
      await db.prepare(`DELETE FROM soshial_members WHERE thread_id = ? AND user_id = ?`).bind(id, s.userId).run();
      const left = await db.prepare(`SELECT COUNT(*) AS n FROM soshial_members WHERE thread_id = ?`).bind(id).first<{ n: number }>();
      if (!left?.n) await deleteThread(id);
      return json({ ok: true, left: true });
    }
    if (act === 'lock' || act === 'unlock') {
      if (kind !== 'channel' || !a.moderate) return json({ error: 'Only a teacher of the class can lock a channel.' }, 403);
      await db.prepare(`UPDATE soshial_threads SET locked = ? WHERE id = ?`).bind(act === 'lock' ? 1 : 0, id).run();
      return fresh();
    }
    if (act === 'delete') {
      if ((kind !== 'channel' && kind !== 'group') || !a.moderate) return json({ error: 'Only a teacher of the class can delete this.' }, 403);
      if (kind === 'channel' && a.thread.title === GENERAL) return json({ error: '#general cannot be deleted. You can lock it instead.' }, 400);
      await deleteThread(id);
      return json({ ok: true, deleted: true });
    }
    return json({ error: 'Unknown action' }, 400);
  }

  async function threadPost(s: Session, id: string, request: Request): Promise<Response> {
    const a = await threadAccess(s, id);
    if (!a || !a.read) return json({ error: 'Not found' }, 404);
    const body = await readBody(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    if (body.action != null) return threadAction(s, id, a, body);
    if (a.onlooker) return json({ error: 'You are reading this as a teacher of the class, so you cannot write in it.' }, 403);
    const kind = a.thread.kind;
    const why = await threadBlock(a, s.userId);
    if (why) {
      const name = kind === 'channel' ? `#${a.thread.title}` : a.members.find((m) => m.user_id !== s.userId)?.name ?? 'They';
      return json({ error: blockText(why, name, a.className), why }, 403);
    }
    const c = clean(body.body);
    if ('error' in c) return json(c, 400);
    const capped = await capRefusal(s.userId, a.role, id, kind);
    if (capped) return json({ error: capped }, 429);
    if (kind === 'channel') await touchMember(id, s.userId, a.role === 'teacher');
    await appendMessage(s.userId, id, c.body);
    return json(await threadView(s, id), 201);
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
    const levels = new Map(((await db.prepare(`SELECT user_id, level FROM soshial_mutes WHERE class_id = ?`).bind(classId)
      .all<{ user_id: string; level: number }>()).results ?? []).map((r) => [r.user_id, toLevel(r.level)]));
    const rows = (await db.prepare(
      `SELECT t.id, t.kind, t.title, t.last_at,
              (SELECT GROUP_CONCAT(name, '|') FROM (SELECT name FROM soshial_members WHERE thread_id = t.id ORDER BY name)) AS names,
              (SELECT COUNT(*) FROM soshial_messages WHERE thread_id = t.id) AS n,
              x.body AS m_body, x.created_at AS m_at, x.deleted_at AS m_deleted,
              (SELECT name FROM soshial_members WHERE thread_id = t.id AND user_id = x.author_id) AS m_author
         FROM soshial_threads t
         LEFT JOIN soshial_messages x ON x.id = (SELECT y.id FROM soshial_messages y WHERE y.thread_id = t.id ORDER BY y.created_at DESC, y.rowid DESC LIMIT 1)
        WHERE t.class_id = ? AND t.kind IN ('students', 'group')
        ORDER BY t.last_at DESC LIMIT 200`,
    ).bind(classId).all<{ id: string; kind: string; title: string; last_at: number; names: string | null; n: number; m_body: string | null; m_at: number | null; m_deleted: number | null; m_author: string | null }>()).results ?? [];
    const level = await classLevel(classId);
    return {
      level,
      classmatesOn: level === 0,
      students: students.flatMap((p) => {
        if (!keys.has(p.id)) return [];
        const own = levels.get(p.id) ?? 0;
        return [{ key: keys.get(p.id)!, name: p.name, level: own, muted: own > 0 }];
      }),
      threads: rows.map((r) => {
        const people = (r.names ?? '').split('|').filter(Boolean);
        return {
          id: r.id,
          kind: r.kind === 'group' ? 'group' as const : 'students' as const,
          title: r.kind === 'group' ? groupLabel(r.title, people) : '',
          people,
          count: r.n,
          lastAt: r.last_at,
          last: r.m_at == null ? null : { author: r.m_author ?? 'Someone', snippet: snippetOf(r.m_body ?? ''), at: r.m_at, removed: r.m_deleted != null },
        };
      }),
    };
  }

  /** A conversation this teacher may read on the panel: in this class, and not another teacher's own two-person one. */
  async function readableThread(s: Session, classId: string, threadId: string) {
    const t = await threadWithMembers(threadId);
    if (!t || t.thread.class_id !== classId) return null;
    if (t.thread.kind === 'teacher' && !t.members.some((m) => m.user_id === s.userId)) return null;
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

    // 0.1.0's names still work: they are levels 1 and 0.
    if (body.action === 'classmates-off' || body.action === 'classmates-on') { body.level = body.action === 'classmates-off' ? 1 : 0; body.action = 'class-level'; }
    if (body.action === 'mute' || body.action === 'unmute') { body.level = body.action === 'mute' ? 1 : 0; body.action = 'student-level'; }

    if (body.action === 'class-level') {
      if (!isLevel(body.level)) return json({ error: 'Choose On, Teacher only or Off.' }, 400);
      await db.prepare(
        `INSERT INTO soshial_class_settings (class_id, classmates_off, student_level) VALUES (?, 0, ?)
           ON CONFLICT(class_id) DO UPDATE SET classmates_off = 0, student_level = excluded.student_level`,
      ).bind(classId, body.level).run();
      return json(await overview(classId));
    }

    if (body.action === 'student-level') {
      if (!isLevel(body.level)) return json({ error: 'Choose On, Teacher only or Off.' }, 400);
      if (!isPersonKey(body.student)) return json({ error: 'Choose a student.' }, 400);
      const user = await userForKey(body.student);
      if (!user || (await dir.roleIn(classId, user)) !== 'student') return json({ error: 'That student is not in this class.' }, 404);
      if (body.level > 0) {
        await db.prepare(
          `INSERT INTO soshial_mutes (class_id, user_id, muted_at, muted_by, level) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(class_id, user_id) DO UPDATE SET level = excluded.level, muted_at = excluded.muted_at, muted_by = excluded.muted_by`,
        ).bind(classId, user, t, s.userId, body.level).run();
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

  // unreadCount: two-person conversations and groups with something unread, for your own badge or a digest.
  return { handle, deleteClass, unreadCount, limits };
}

export type Soshial = ReturnType<typeof createSoshial>;
