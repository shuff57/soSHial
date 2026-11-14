// soSHial's rules and words, shared by the server (server.ts) and the page (client.ts, react/*).
//
// Four kinds of conversation, each in ONE class:
//   'teacher'   two people, one of them a teacher of the class;
//   'students'  two students of the class;
//   'group'     2-8 people of the class, made by a student or a teacher, with an optional name;
//   'channel'   the whole class (#general is made for every class; anyone may add one; a teacher can
//               lock one so only teachers post, rename or delete it).
// What a STUDENT may send is a level, per class and per student, and the stricter wins:
//   0 On, 1 Teacher only (a message to a teacher of the class, nothing else), 2 Off (nothing; reading stays).
// Teachers always may. Who may read: a two-person conversation's two people; a group's people; a
// channel, everyone in the class. The class's teachers also read every conversation between students and
// every group (students are told so: WATCHED_NOTE, GROUP_NOTE).
// Every message is checked for personal details on the server (and in the page before it is sent).

import { findPII as defaultFindPII } from './pii';

export interface Limits {
  /** Characters in one message. */
  messageMax: number;
  /** Lines in one message. */
  messageLines: number;
  /** Messages one student may send in one minute (teachers have no cap). */
  perMinute: number;
  /** Messages one student may send in one day. */
  perDay: number;
  /** Messages one conversation holds. */
  perThread: number;
}

export const DEFAULT_LIMITS: Limits = {
  messageMax: 1000,
  messageLines: 30,
  perMinute: 10,
  perDay: 200,
  perThread: 2000,
};

/** Conversations listed in the mailbox (channels come on top of these). */
export const THREAD_LIST_LIMIT = 50;
/** A conversation opens on its newest messages. */
export const THREAD_VIEW_LIMIT = 200;
/** People in one group, its maker included. */
export const GROUP_MAX_PEOPLE = 8;
export const GROUP_TITLE_MAX = 40;
export const CHANNEL_NAME_MAX = 24;
export const CHANNELS_PER_CLASS = 30;
/** Groups and channels one student may make in a day. */
export const MADE_PER_DAY = 10;
/** Messages one channel holds (a two-person conversation or a group: Limits.perThread). */
export const MESSAGES_PER_CHANNEL = 10_000;
export const GENERAL = 'general';
/** How often an open mailbox asks for new messages, and how often the closed button asks for the count. */
export const THREAD_POLL_MS = 10_000;
export const COUNT_POLL_MS = 30_000;

const PII_WORDS: Record<string, string> = {
  SSN: 'a Social Security number',
  email: 'an email address',
  phone: 'a phone number',
  'credit card': 'a long number like a card number',
  address: 'a street address',
  'bank account number': 'a bank account number',
};

/** The words shown when the personal-details check refuses a message. */
export function piiRefusal(label: string): string {
  const what = PII_WORDS[label] ?? 'personal information';
  return `This message looks like it has ${what} in it, so it was not sent. To keep everyone safe, messages cannot share phone numbers, addresses, emails or other personal details.`;
}

export type FindPII = (text: string) => string | null;

/** Tidy a message and check it: length, lines, special characters and the personal-details check. */
export function cleanMessage(
  raw: unknown,
  limits: Limits = DEFAULT_LIMITS,
  findPII: FindPII = defaultFindPII,
): { body: string } | { error: string; safety?: true } {
  if (typeof raw !== 'string') return { error: 'Write a message first.' };
  const body = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return { error: 'Write a message first.' };
  if ([...body].length > limits.messageMax) return { error: `A message is at most ${limits.messageMax} characters. Split it into two.` };
  if (body.split('\n').length > limits.messageLines) return { error: `A message is at most ${limits.messageLines} lines. Split it into two.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(body)) return { error: 'That message has special characters in it. Type it again in plain words.' };
  const pii = findPII(body);
  if (pii) return { error: piiRefusal(pii), safety: true };
  return { body };
}

/** Why a person may not send in a conversation right now, or null when they may. */
export type SendBlock =
  | 'left' | 'other-left' | 'class-off' | 'muted' | 'archived'
  | 'class-all-off' | 'all-off' | 'locked' | 'not-member' | null;

/** A student's messaging level: 0 On, 1 Teacher only, 2 Off. The stricter of class and student wins. */
export type MessageLevel = 0 | 1 | 2;
export const LEVEL_LABEL: Record<MessageLevel, string> = { 0: 'On', 1: 'Teacher only', 2: 'Off' };
export const isLevel = (v: unknown): v is MessageLevel => v === 0 || v === 1 || v === 2;
export const toLevel = (n: unknown): MessageLevel => (Number(n) >= 2 ? 2 : Number(n) >= 1 ? 1 : 0);

export function blockText(why: SendBlock, other = 'They', className = 'this class'): string {
  switch (why) {
    case 'class-all-off': return `Your teacher has turned off student messages in ${className}. You can still read them.`;
    case 'all-off': return `Your teacher has turned off your messages in ${className}. You can still read them.`;
    case 'locked': return `Only teachers can post in ${other}.`;
    case 'not-member': return `You are not in ${other} any more.`;
    case 'left': return `You are not in ${className} any more, so you cannot send messages here.`;
    case 'other-left': return `${other} is not in ${className} any more, so messages cannot be sent here.`;
    case 'archived': return `${className} has been archived, so messages cannot be sent here.`;
    case 'class-off': return `Your teacher has set messages in ${className} to teacher only. You can still message your teacher.`;
    case 'muted': return `Your teacher has paused your messages to classmates in ${className}. You can still message your teacher.`;
    default: return '';
  }
}

/** The line shown above every conversation between two students. */
export const WATCHED_NOTE = 'Your teacher can read messages between classmates.';
export const GROUP_NOTE = 'Your teacher can read this group.';
export function channelNote(className: string): string {
  return `Everyone in ${className} can read this channel, and so can your teacher.`;
}

export type ThreadKind = 'teacher' | 'students' | 'group' | 'channel';

/** A channel name as Discord writes one: lower case, words joined by dashes, 1-24 characters. */
export function cleanChannelName(raw: unknown, findPII: FindPII = defaultFindPII): { name: string } | { error: string; safety?: true } {
  const name = (typeof raw === 'string' ? raw : '').toLowerCase().trim().replace(/^#+/, '')
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!name) return { error: 'Give the channel a name (letters, numbers and dashes).' };
  if (name.length > CHANNEL_NAME_MAX) return { error: `A channel name is at most ${CHANNEL_NAME_MAX} characters.` };
  const pii = findPII(name.replace(/-/g, ' '));
  if (pii) return { error: `That name looks like it has ${PII_WORDS[pii] ?? 'personal information'} in it. Pick another name.`, safety: true };
  return { name };
}

/** A group's name: one line, at most 40 characters, may be empty (then it shows its people's names). */
export function cleanGroupTitle(raw: unknown, findPII: FindPII = defaultFindPII): { title: string } | { error: string; safety?: true } {
  const title = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
  if ([...title].length > GROUP_TITLE_MAX) return { error: `A group name is at most ${GROUP_TITLE_MAX} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(title)) return { error: 'That name has special characters in it. Type it again in plain words.' };
  const pii = findPII(title);
  if (pii) return { error: `That name looks like it has ${PII_WORDS[pii] ?? 'personal information'} in it. Pick another name.`, safety: true };
  return { title };
}

/** What a group is called when it has no name: its other people. */
export function groupLabel(title: string, names: string[]): string {
  if (title) return title;
  if (!names.length) return 'Group';
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

export interface MessagePerson {
  /** A random public key for this person; never your user id or an email. */
  key: string;
  name: string;
  teacher: boolean;
}

/** One conversation in the mailbox list. */
export interface ThreadSummary {
  id: string;
  classId: string;
  className: string;
  kind: ThreadKind;
  /** The person (two-person), the group's name, or the channel's name (no #). */
  title: string;
  /** Two-person: the other person. A group or channel: its title, not a teacher. */
  other: { name: string; teacher: boolean };
  /** A group: how many people. */
  people?: number;
  /** A channel: only teachers post. */
  locked?: boolean;
  last: { snippet: string; mine: boolean; at: number; removed: boolean; author?: string } | null;
  /** A channel with news is shown bold; it never adds to the envelope's count. */
  unread: boolean;
}

/** One message as a page receives it. `body` is null once a teacher removed it (for students; the class's teachers still get the words). */
export interface MessageItem {
  id: string;
  mine: boolean;
  author: string;
  teacher: boolean;
  body: string | null;
  removed: boolean;
  at: number;
}

/** GET <base>/messages/<id>. */
export interface ThreadView {
  id: string;
  classId: string;
  className: string;
  kind: ThreadKind;
  title: string;
  other: { name: string; teacher: boolean };
  /** A group's people (the reader included). */
  members?: { key: string; name: string; teacher: boolean; me: boolean }[];
  locked?: boolean;
  messages: MessageItem[];
  /** There are older messages than these (only the newest THREAD_VIEW_LIMIT are sent). */
  more: boolean;
  canSend: boolean;
  why: SendBlock;
  whyText: string;
  /** The line above it: who else can read it, or null. */
  note: string | null;
  /** A teacher of the class: may remove and put back messages (removed words are sent to them). */
  moderate: boolean;
  /** May rename it / add people (a group's people; a channel: its maker and the class's teachers). */
  manage: boolean;
  /** Reading it as a teacher of the class, not as one of its people. */
  onlooker: boolean;
}

/** GET <base>/messages?people=1: whom the caller may start a conversation with, per class. */
export interface PeopleClass {
  id: string;
  name: string;
  /** The caller teaches this class. */
  teaches: boolean;
  people: MessagePerson[];
  /** For a student: why classmates are not listed (teachers still are), or null. */
  classmatesBlocked: SendBlock;
  /** For a student whose messages are Off: nobody is listed, and this says why. */
  allBlocked?: SendBlock;
}

/** GET <base>/classes/<id>/messages: the teacher panel. */
export interface ClassOverview {
  /** The class's level (0 On, 1 Teacher only, 2 Off). */
  level: MessageLevel;
  /** level === 0 (0.1.0's switch). */
  classmatesOn: boolean;
  /** Each student's own level; `muted` = level > 0 (0.1.0's pause). */
  students: { key: string; name: string; level: MessageLevel; muted: boolean }[];
  /** Conversations between two students, and groups. */
  threads: {
    id: string; kind: 'students' | 'group'; title: string; people: string[]; count: number; lastAt: number;
    last: { author: string; snippet: string; at: number; removed: boolean } | null;
  }[];
}

/** GET <base>/classes/<id>/messages?thread=<id>: removed messages keep their words for teachers. */
export interface ClassThread {
  id: string;
  people: { name: string; teacher: boolean }[];
  messages: { id: string; author: string; teacher: boolean; body: string; removed: boolean; at: number }[];
}

export function snippetOf(body: string, n = 90): string {
  const one = body.replace(/\s+/g, ' ').trim();
  return [...one].length > n ? [...one].slice(0, n - 1).join('') + '…' : one;
}

/** "<class id>|<a>|<b>" with the two ids sorted: one conversation per pair per class. */
export function pairKey(classId: string, a: string, b: string): string {
  return [classId, ...[a, b].sort()].join('|');
}

export const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
export const isPersonKey = (v: unknown): v is string => typeof v === 'string' && /^p[0-9a-f]{20}$/.test(v);
