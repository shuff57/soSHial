// soSHial's server against a real SQLite (node:sqlite) behind a D1-shaped facade, with the example
// directory over examples/schema.sql. What has to hold:
//   1. a student is offered their teacher and classmates, only from classes they are in now; no ids or emails;
//   2. a student messages a classmate and a teacher, the teacher replies; a second message to the same
//      person in the same class lands in the same conversation; unread counts and reading work;
//   3. someone outside the class or the conversation gets 404; signed out gets 401;
//   4. the words: empty, too long and personal details (phone, email, address) are refused in plain words;
//   5. the class switch: off stops classmates (new and existing conversations), never a teacher;
//   6. a pause: the paused student cannot message classmates but can message a teacher;
//   7. the teacher panel lists conversations between two students only, reads them (removed words
//      included), removes and restores a message; students then see "removed", never the words;
//      another class's teacher and a student are refused;
//   8. a student is capped at 10 messages a minute; a teacher is not;
//   9. deleteClass removes everything for that class.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createSoshial, type Db, type DbStatement, type Session } from '../src';
import { sqlDirectory } from '../examples/sql-directory';

let passed = 0;
let failed = 0;
function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${detail ? ` -- ${JSON.stringify(detail)}` : ''}`); }
}

// ---- a D1-shaped facade over node:sqlite ----
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

let clock = Date.now();
const now = () => clock;
const soshial = createSoshial({ db, directory: sqlDirectory(db, now), now });

const sql = (q: string, ...a: unknown[]) => sqlite.prepare(q).run(...(a as never[]));
for (const [id, first, last] of [['u-ana', 'Ana', 'Lopez'], ['u-ben', 'Ben', 'Diaz'], ['u-cat', 'Cat', 'Moss'], ['u-old', 'Old', 'Timer'], ['u-t1', 'Tess', 'Ward'], ['u-t2', 'Tom', 'Reed']]) {
  sql(`INSERT INTO users (id, first_name, last_name) VALUES (?, ?, ?)`, id, first, last);
}
sql(`INSERT INTO classes (id, name) VALUES ('C1', 'Period 1'), ('C2', 'Period 2')`);
for (const [c, u, role, exp] of [
  ['C1', 'u-ana', 'student', null], ['C1', 'u-ben', 'student', null], ['C2', 'u-cat', 'student', null],
  ['C1', 'u-old', 'student', clock - 1000], ['C1', 'u-t1', 'teacher', null], ['C2', 'u-t2', 'teacher', null],
]) sql(`INSERT INTO enrollments (class_id, user_id, role, expires_at) VALUES (?, ?, ?, ?)`, c, u, role, exp);

const ANA: Session = { userId: 'u-ana' };
const BEN: Session = { userId: 'u-ben' };
const CAT: Session = { userId: 'u-cat' };
const OLD: Session = { userId: 'u-old' };
const T1: Session = { userId: 'u-t1' };
const T2: Session = { userId: 'u-t2' };

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
const people = (u: Session) => call(u, '/messages?people=1');
const list = (u: Session) => call(u, '/messages');
const count = (u: Session) => call(u, '/messages?count=1');
const start = (u: Session, classId: string, to: string, body: string) => call(u, '/messages', { classId, to, body });
const open = (u: Session, id: string) => call(u, `/messages/${id}`);
const reply = (u: Session, id: string, body: string) => call(u, `/messages/${id}`, { body });
const panel = (u: Session, cls: string) => call(u, `/classes/${cls}/messages`);
const panelThread = (u: Session, cls: string, t: string) => call(u, `/classes/${cls}/messages?thread=${t}`);
const act = (u: Session, cls: string, body: unknown) => call(u, `/classes/${cls}/messages`, body);

// 0. routing
check('a path that is not soSHial\'s is left alone (null)', (await soshial.handle(new Request('https://x.test/api/other'), ANA)) === null);
check('signed out is 401', (await call(null, '/messages')).status === 401);

// 1. whom a student is offered
let r = await people(ANA);
const c1 = r.body.classes?.find((c: { id: string }) => c.id === 'C1');
check('a student is offered only the classes they are in now', r.status === 200 && r.body.classes.length === 1 && c1);
check('...their teacher (marked) and their classmates, not someone whose enrollment ran out, not themselves',
  c1.people.some((p: { name: string; teacher: boolean }) => p.name === 'Tess W.' && p.teacher)
  && c1.people.some((p: { name: string; teacher: boolean }) => p.name === 'Ben D.' && !p.teacher)
  && !c1.people.some((p: { name: string }) => p.name === 'Old T.' || p.name === 'Ana L.'));
const key = (name: string) => c1.people.find((p: { name: string }) => p.name === name).key as string;
const BEN_KEY = key('Ben D.');
const T1_KEY = key('Tess W.');

// 2. sending and replying
r = await start(ANA, 'C1', BEN_KEY, 'Want to code together after lunch?');
const AB = r.body.id as string;
check('a student messages a classmate; the answer is the conversation, between classmates',
  r.status === 201 && AB && r.body.kind === 'students' && r.body.other.name === 'Ben D.' && r.body.messages.length === 1 && r.body.messages[0].mine);
check('the classmate has one unread conversation', (await count(BEN)).body.unread === 1);
r = await list(BEN);
// (Every class also lists its #general channel.)
const benOwn = r.body.threads.filter((t: { kind: string }) => t.kind !== 'channel');
check("the classmate's list shows it, unread, with the first words", benOwn.length === 1 && benOwn[0].unread && /lunch/.test(benOwn[0].last.snippet) && benOwn[0].className === 'Period 1');
r = await open(BEN, AB);
check('opening it shows the message and it can be answered', r.status === 200 && r.body.canSend && r.body.messages[0].author === 'Ana L.');
check('...and marks it read', (await count(BEN)).body.unread === 0);
clock += 1000;
r = await reply(BEN, AB, 'Sure!');
check('the classmate replies', r.status === 201 && r.body.messages.length === 2);
r = await start(ANA, 'C1', BEN_KEY, 'See you then');
check('a second "new message" to the same person in the same class reuses the conversation', r.status === 201 && r.body.id === AB && r.body.messages.length === 3);
r = await start(ANA, 'C1', T1_KEY, 'I am stuck on 2.3');
const AT = r.body.id as string;
check('a student messages their teacher', r.status === 201 && r.body.kind === 'teacher' && r.body.other.teacher);
clock += 1000;
r = await reply(T1, AT, 'Look at the loop condition.');
check('the teacher replies', r.status === 201 && r.body.messages[1].teacher && r.body.messages[1].mine);

// 3. outsiders
check('someone not in the conversation gets 404', (await open(CAT, AB)).status === 404);
check('...and cannot write in it', (await reply(CAT, AB, 'hi')).status === 404);
check('a student not in the class cannot message someone in it', (await start(CAT, 'C1', BEN_KEY, 'hi')).status === 404);
check('a student whose enrollment ran out cannot message the class', (await start(OLD, 'C1', BEN_KEY, 'hi')).status === 404);
check('an unknown person key is 404', (await start(ANA, 'C1', 'p' + '0'.repeat(20), 'hi')).status === 404);

// 4. the words
check('an empty message is refused', (await reply(ANA, AB, '   ')).status === 400);
r = await reply(ANA, AB, 'x'.repeat(1001));
check('a message over 1000 characters is refused', r.status === 400 && /1000/.test(r.body.error));
r = await reply(ANA, AB, 'call me at 530-555-1234');
check('a phone number is refused in plain words', r.status === 400 && r.body.safety && /phone number/.test(r.body.error) && /not sent/.test(r.body.error));
check('an email address is refused', /email address/.test((await reply(ANA, AB, 'mine is ana@example.com')).body.error));
check('a street address is refused', /street address/.test((await reply(ANA, AB, 'I live at 123 Oak Street')).body.error));
check('nothing refused was stored', (await open(BEN, AB)).body.messages.length === 3);

// 5. the class switch
r = await act(T1, 'C1', { action: 'classmates-off' });
check('the teacher turns messages between classmates off', r.status === 200 && r.body.classmatesOn === false);
r = await reply(ANA, AB, 'still there?');
check('an existing conversation between classmates is closed (403, plain reason)', r.status === 403 && r.body.why === 'class-off' && /teacher only/.test(r.body.error));
r = await open(ANA, AB);
check('...it can still be read, and says why', r.status === 200 && !r.body.canSend && /message your teacher/.test(r.body.whyText));
check('the student can still message the teacher', (await reply(ANA, AT, 'Thanks!')).status === 201);
r = await people(BEN);
check('classmates are not offered while it is off; the teacher still is',
  r.body.classes[0].classmatesBlocked === 'class-off' && r.body.classes[0].people.length === 1 && r.body.classes[0].people[0].teacher);
await act(T1, 'C1', { action: 'classmates-on' });
check('turned back on, classmates can write again', (await reply(ANA, AB, 'back on')).status === 201);

// 6. a pause
r = await panel(T1, 'C1');
const anaRow = r.body.students.find((s: { name: string }) => s.name === 'Ana L.');
check("the panel lists the class's students with a key", anaRow && /^p[0-9a-f]{20}$/.test(anaRow.key) && !anaRow.muted);
r = await act(T1, 'C1', { action: 'mute', student: anaRow.key });
check('the teacher pauses one student', r.status === 200 && r.body.students.find((s: { name: string }) => s.name === 'Ana L.').muted);
r = await reply(ANA, AB, 'hello?');
check('the paused student cannot message a classmate', r.status === 403 && r.body.why === 'muted' && /paused/.test(r.body.error));
check('the paused student can still message the teacher', (await reply(ANA, AT, 'Why?')).status === 201);
check('a teacher cannot be paused', (await act(T1, 'C1', { action: 'mute', student: T1_KEY })).status === 404);
await act(T1, 'C1', { action: 'unmute', student: anaRow.key });
check('unpaused, they can write again', (await reply(ANA, AB, 'ok')).status === 201);

// 7. the teacher panel
r = await panel(T1, 'C1');
check('the panel lists conversations between two students, not a teacher conversation',
  r.body.threads.some((t: { id: string }) => t.id === AB) && !r.body.threads.some((t: { id: string }) => t.id === AT));
const abRow = r.body.threads.find((t: { id: string }) => t.id === AB);
check('...with both names and the count', abRow.people.join(',') === 'Ana L.,Ben D.' && abRow.count >= 5);
r = await panelThread(T1, 'C1', AB);
check('the teacher reads it', r.status === 200 && r.body.thread.messages.length === abRow.count);
const target = r.body.thread.messages.find((m: { body: string }) => m.body === 'Sure!');
const benUnread = (await count(BEN)).body.unread;
r = await act(T1, 'C1', { action: 'remove', messageId: target.id });
const removed = r.body.thread.messages.find((m: { id: string }) => m.id === target.id);
check('the teacher removes a message and still sees its words, marked', r.status === 200 && removed.removed && removed.body === 'Sure!');
r = await open(ANA, AB);
const gone = r.body.messages.find((m: { id: string }) => m.id === target.id);
check('students see it removed, without its words', gone.removed && gone.body === null && !bodies[bodies.length - 1].includes('Sure!'));
r = await act(T1, 'C1', { action: 'restore', messageId: target.id });
check('and it can be put back', !r.body.thread.messages.find((m: { id: string }) => m.id === target.id).removed);
check("another class's teacher is refused", (await panelThread(T2, 'C1', AB)).status === 403);
check('a student is refused the panel', (await panel(BEN, 'C1')).status === 403);
check('an admin may use any panel', (await panel({ userId: 'u-admin', admin: true }, 'C1')).status === 200);
check('a conversation is only read through its own class', [403, 404].includes((await panelThread(T2, 'C2', AB)).status));
check('reading on the panel marks nothing read', (await count(BEN)).body.unread === benUnread);

// 8. caps
clock += 120_000;
let capped: { status: number; body: { error: string } } | null = null;
for (let i = 0; i < 12 && !capped; i++) { const x = await reply(ANA, AB, `burst ${i}`); if (x.status === 429) capped = x; }
check('a student is capped at 10 messages a minute', capped && /minute/.test(capped.body.error));
let teacherOk = true;
for (let i = 0; i < 12; i++) if ((await reply(T1, AT, `note ${i}`)).status !== 201) teacherOk = false;
check('a teacher is not', teacherOk);

// no user ids or emails
const leaked = bodies.filter((b) => /u-(ana|ben|cat|old|t1|t2)/.test(b));
check('no answer carries a user id', leaked.length === 0, leaked[0]);

// 9. deleting a class
await soshial.deleteClass('C1');
const left = sqlite.prepare(`SELECT (SELECT COUNT(*) FROM soshial_threads WHERE class_id = 'C1') + (SELECT COUNT(*) FROM soshial_messages) AS n`).get() as { n: number };
check('deleteClass removes its conversations and messages', left.n === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
