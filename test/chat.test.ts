// soSHial 0.2.0: groups, channels and messaging levels, against a real SQLite behind a D1-shaped facade with
// the example directory. What has to hold:
//   1. levels: per class and per student, On / Teacher only / Off, the stricter wins; Teacher only = a
//      teacher of the class only; Off = nothing, reading stays; teachers are never limited;
//   2. channels: every class has #general (made once); everyone in the class reads and posts, nobody else;
//      anyone adds one (a tidy name, no duplicates, no personal details); its maker or a teacher renames it;
//      a teacher locks it (only teachers post) or deletes it (#general cannot be deleted); a channel never
//      adds to the envelope's count;
//   3. groups: 2-8 people of one class, made by a student or a teacher; only its people (and the class's
//      teachers, who cannot write in it) read it; rename, add, leave; the last one out deletes it;
//   4. a teacher removes and puts back a message in a group or channel; students then see "removed";
//   5. the teacher panel lists groups and sets both levels (0.1.0's names still work); no ids in answers.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createSoshial, type Db, type DbStatement, type Session } from '../src';
import { sqlDirectory } from '../examples/sql-directory';

let passed = 0;
let failed = 0;
function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${detail ? ` -- ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
}

const sqlite = new DatabaseSync(':memory:');
for (const f of ['migrations/0001_soshial.sql', 'migrations/0002_groups_channels.sql', 'examples/schema.sql']) sqlite.exec(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const db: Db = {
  prepare(sql: string): DbStatement {
    const st = sqlite.prepare(sql);
    let args: unknown[] = [];
    const stmt: DbStatement = {
      bind: (...a: unknown[]) => { args = a; return stmt; },
      first: async <T,>() => ((st.get(...(args as never[])) as T) ?? null),
      all: async <T,>() => ({ results: st.all(...(args as never[])) as T[] }),
      run: async () => st.run(...(args as never[])),
    };
    return stmt;
  },
  async batch(stmts: DbStatement[]) {
    sqlite.exec('BEGIN');
    try { for (const q of stmts) await q.run(); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    return [];
  },
};

// Each read of the clock is a millisecond later, so 'newer than what you read' is always decidable.
let clock = Date.now();
const now = () => (clock += 1);
const soshial = createSoshial({ db, directory: sqlDirectory(db, now), now });
const sql = (q: string, ...a: unknown[]) => sqlite.prepare(q).run(...(a as never[]));
for (const [id, first, last] of [['u-ana', 'Ana', 'Lopez'], ['u-ben', 'Ben', 'Diaz'], ['u-cat', 'Cat', 'Moss'], ['u-dan', 'Dan', 'Hill'], ['u-eve', 'Eve', 'Park'], ['u-t1', 'Tess', 'Ward'], ['u-t2', 'Tom', 'Reed']]) {
  sql(`INSERT INTO users (id, first_name, last_name) VALUES (?, ?, ?)`, id, first, last);
}
sql(`INSERT INTO classes (id, name) VALUES ('C1', 'Period 1'), ('C2', 'Period 2')`);
for (const [c, u, role] of [['C1', 'u-ana', 'student'], ['C1', 'u-ben', 'student'], ['C1', 'u-cat', 'student'], ['C1', 'u-dan', 'student'], ['C2', 'u-eve', 'student'], ['C1', 'u-t1', 'teacher'], ['C2', 'u-t2', 'teacher']]) {
  sql(`INSERT INTO enrollments (class_id, user_id, role, expires_at) VALUES (?, ?, ?, NULL)`, c, u, role);
}
const S = (userId: string): Session => ({ userId });
const ANA = S('u-ana'), BEN = S('u-ben'), CAT = S('u-cat'), DAN = S('u-dan'), EVE = S('u-eve'), T1 = S('u-t1'), T2 = S('u-t2');

const bodies: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(user: Session | null, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const request = new Request(`https://x.test/api/soshial${path}`, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const res = await soshial.handle(request, user);
  if (!res) return { status: 0, body: null };
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: JSON.parse(text) };
}
const list = (u: Session) => call(u, '/messages');
const count = async (u: Session) => (await call(u, '/messages?count=1')).body.unread as number;
const create = (u: Session, body: Record<string, unknown>) => call(u, '/messages', { classId: 'C1', ...body });
const dm = (u: Session, to: string, body: string) => call(u, '/messages', { classId: 'C1', to, body });
const open = (u: Session, id: string) => call(u, `/messages/${id}`);
const post = (u: Session, id: string, body: string) => call(u, `/messages/${id}`, { body });
const act = (u: Session, id: string, action: string, extra: Record<string, unknown> = {}) => call(u, `/messages/${id}`, { action, ...extra });
const panel = (u: Session, body?: unknown) => (body === undefined ? call(u, '/classes/C1/messages') : call(u, '/classes/C1/messages', body));

let r = await call(ANA, '/messages?people=1');
const c1 = r.body.classes.find((c: { id: string }) => c.id === 'C1');
const key = (name: string) => c1.people.find((p: { name: string }) => p.name === name).key as string;
const BEN_K = key('Ben D.'), CAT_K = key('Cat M.'), DAN_K = key('Dan H.'), T1_K = key('Tess W.');

// 2. channels
r = await list(ANA);
const general = r.body.threads.find((t: { kind: string; title: string }) => t.kind === 'channel' && t.title === 'general');
check('every class has #general, listed with the class', general && general.className === 'Period 1');
await list(BEN); await list(T1);
check('...made once, however many people look', (sqlite.prepare(`SELECT COUNT(*) AS n FROM soshial_threads WHERE kind = 'channel' AND class_id = 'C1'`).get() as { n: number }).n === 1);
const G = general.id as string;
r = await post(ANA, G, 'hi everyone');
check('a student posts in #general', r.status === 201 && r.body.kind === 'channel' && /Everyone in Period 1/.test(r.body.note));
r = await open(BEN, G);
check('a classmate reads it, the author named', r.status === 200 && r.body.messages.at(-1).author === 'Ana L.');
check('someone in another class gets 404, reading or posting', (await open(EVE, G)).status === 404 && (await post(EVE, G, 'x')).status === 404);
await post(BEN, G, 'hello Ana');
r = await list(ANA);
check('a new channel message shows the channel bold', r.body.threads.find((t: { id: string }) => t.id === G)?.unread === true);
check('...but never adds to the envelope count', (await count(ANA)) === 0);

r = await create(BEN, { create: 'channel', name: '  Game Ideas!! ' });
const GI = r.body.id as string;
check('a student adds a channel with a tidied name', r.status === 201 && r.body.title === 'game-ideas' && r.body.manage === true);
check('two channels of a class cannot share a name', (await create(CAT, { create: 'channel', name: 'game ideas' })).status === 409);
check('a channel name with personal details is refused', (await create(CAT, { create: 'channel', name: 'call 555 201 3344' })).body.safety === true);
check("a classmate cannot rename someone else's channel", (await act(CAT, GI, 'rename', { title: 'cats' })).status === 403);
r = await act(BEN, GI, 'rename', { title: 'game-plans' });
check('its maker renames it', r.status === 200 && r.body.title === 'game-plans');
check('a student cannot lock a channel', (await act(BEN, GI, 'lock')).status === 403);
r = await act(T1, GI, 'lock');
check('a teacher locks it', r.status === 200 && r.body.locked === true);
r = await post(CAT, GI, 'can I post?');
check('...then a student cannot post (plain words)', r.status === 403 && r.body.why === 'locked' && /Only teachers can post in #game-plans/.test(r.body.error));
check('...a teacher can', (await post(T1, GI, 'Announcements only.')).status === 201);
check('#general cannot be deleted', (await act(T1, G, 'delete')).status === 400);
check('a student cannot delete a channel', (await act(BEN, GI, 'delete')).status === 403);
r = await act(T1, GI, 'delete');
check('a teacher deletes a channel and everything in it', r.status === 200 && (await open(BEN, GI)).status === 404);

// 3. groups
r = await create(ANA, { create: 'group', people: [BEN_K, CAT_K], title: 'Maze team' });
const GR = r.body.id as string;
check('a student makes a group with two classmates', r.status === 201 && r.body.kind === 'group' && r.body.title === 'Maze team' && r.body.members.length === 3 && r.body.note === 'Your teacher can read this group.');
await post(BEN, GR, 'I will do the walls');
check('a group message counts on the envelope of its other people', (await count(CAT)) === 1 && (await count(ANA)) === 1);
check('a classmate not in it gets 404', (await open(DAN, GR)).status === 404);
r = await open(T1, GR);
check("the class's teacher reads it as an onlooker who cannot write", r.status === 200 && r.body.onlooker && !r.body.canSend && r.body.moderate);
check('...posting is refused', (await post(T1, GR, 'hello')).status === 403);
check("another class's teacher gets 404", (await open(T2, GR)).status === 404);
check('a group is at most 8 people', (await create(ANA, { create: 'group', people: [BEN_K, CAT_K, DAN_K, T1_K, ...[1, 2, 3, 4].map((n) => 'p' + String(n).repeat(20))] })).status === 400);
check('people are named by public key, never a user id', (await create(DAN, { create: 'group', people: ['u-ana'] })).status === 400);
r = await act(CAT, GR, 'rename', { title: 'Maze crew' });
check('a member renames the group', r.status === 200 && r.body.title === 'Maze crew');
r = await act(CAT, GR, 'add', { people: [DAN_K] });
check('a member adds a classmate', r.status === 200 && r.body.members.length === 4 && (await open(DAN, GR)).status === 200);
r = await act(DAN, GR, 'leave');
check('a member leaves', r.status === 200 && (await open(DAN, GR)).status === 404);
r = await create(ANA, { create: 'group', people: [BEN_K] });
const G2 = r.body.id as string;
check('a group with no name is called by its people', r.status === 201 && r.body.title === 'Ben D.');
await act(ANA, G2, 'leave'); await act(BEN, G2, 'leave');
check('the last one out deletes it', !sqlite.prepare(`SELECT 1 FROM soshial_threads WHERE id = ?`).get(G2));

// 4. removing
r = await open(T1, GR);
const walls = r.body.messages.find((m: { body: string }) => m.body === 'I will do the walls');
r = await act(T1, GR, 'remove', { messageId: walls.id });
check('a teacher removes a message in a group and still sees its words', r.status === 200 && r.body.messages.find((m: { id: string }) => m.id === walls.id).body === 'I will do the walls');
r = await open(CAT, GR);
check('...students see it removed without its words', r.body.messages.find((m: { id: string }) => m.id === walls.id).body === null);
check('a student cannot remove messages', (await act(BEN, GR, 'remove', { messageId: walls.id })).status === 403);
r = await act(T1, GR, 'restore', { messageId: walls.id });
check('...the teacher puts it back', r.status === 200 && !r.body.messages.find((m: { id: string }) => m.id === walls.id).removed);

// 1. levels
r = await panel(T1, { action: 'student-level', student: CAT_K, level: 1 });
check('the teacher sets one student to Teacher only', r.status === 200 && r.body.students.find((s: { name: string }) => s.name === 'Cat M.').level === 1);
check('...they cannot post in a channel or a group, make a group, or message a classmate',
  (await post(CAT, G, 'hi')).status === 403 && (await post(CAT, GR, 'hi')).status === 403
  && (await create(CAT, { create: 'group', people: [BEN_K] })).status === 403 && (await dm(CAT, BEN_K, 'hi')).status === 403);
r = await dm(CAT, T1_K, 'Can you help?');
check('...but can message the teacher', r.status === 201);
const CT = r.body.id as string;
await panel(T1, { action: 'student-level', student: CAT_K, level: 2 });
r = await post(CAT, CT, 'still there?');
check('Off: not even the teacher', r.status === 403 && r.body.why === 'all-off');
check('...they can still read', (await open(CAT, CT)).body.canSend === false);
r = await call(CAT, '/messages?people=1');
check('...New message lists nobody, saying why', r.body.classes[0].people.length === 0 && r.body.classes[0].allBlocked === 'all-off');
check('a teacher can still write to them', (await post(T1, CT, 'I will come over.')).status === 201);
await panel(T1, { action: 'student-level', student: CAT_K, level: 0 });
check('On again: they post', (await post(CAT, G, 'back!')).status === 201);
r = await panel(T1, { action: 'class-level', level: 1 });
check('the class set to Teacher only: no student posts in a channel, all still message the teacher',
  r.body.level === 1 && (await post(ANA, G, 'x')).body.why === 'class-off' && (await dm(ANA, T1_K, 'q')).status === 201);
await panel(T1, { action: 'student-level', student: BEN_K, level: 2 });
check('the stricter wins: class Teacher only, student Off = Off', (await dm(BEN, T1_K, 'q')).body.why === 'all-off');
await panel(T1, { action: 'class-level', level: 2 });
await panel(T1, { action: 'student-level', student: BEN_K, level: 0 });
check('the class Off: no student sends anything; teachers still post', (await dm(ANA, T1_K, 'q')).body.why === 'class-all-off' && (await post(T1, G, 'x')).status === 201);
r = await panel(T1, { action: 'classmates-on' });
check("0.1.0's switch name still works (on = level 0)", r.status === 200 && r.body.level === 0 && r.body.classmatesOn === true);
check('a level outside 0-2 is refused; a student cannot set levels', (await panel(T1, { action: 'class-level', level: 3 })).status === 400 && (await panel(ANA, { action: 'class-level', level: 2 })).status === 403);

// 5. the panel
r = await panel(T1);
check('the teacher panel lists groups beside conversations between students', r.body.threads.some((t: { id: string; kind: string; title: string }) => t.id === GR && t.kind === 'group' && t.title === 'Maze crew'));
check('no answer carries a user id', !bodies.some((b) => /u-(ana|ben|cat|dan|eve|t1|t2)/.test(b)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
