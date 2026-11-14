// soSHial's rules and words, shared by the server (server.ts) and the page (client.ts, react/*).
//
// Who may write to whom, in one class:
//   - a student and a teacher of the class: always, both ways (a paused student too);
//   - two students of the class: unless a teacher turned messages between classmates off for that
//     class, or paused the one writing;
//   - two teachers of the class: always.
// Who may read a conversation: its two people, and, for a conversation between two students, the
// class's teachers (students are told so above it: WATCHED_NOTE).
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

/** Conversations listed in the mailbox. */
export const THREAD_LIST_LIMIT = 50;
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
export type SendBlock = 'left' | 'other-left' | 'class-off' | 'muted' | 'archived' | null;

export function blockText(why: SendBlock, other = 'They', className = 'this class'): string {
  switch (why) {
    case 'left': return `You are not in ${className} any more, so you cannot send messages here.`;
    case 'other-left': return `${other} is not in ${className} any more, so messages cannot be sent here.`;
    case 'archived': return `${className} has been archived, so messages cannot be sent here.`;
    case 'class-off': return `Your teacher has turned off messages between classmates in ${className}. You can still message your teacher.`;
    case 'muted': return `Your teacher has paused your messages to classmates in ${className}. You can still message your teacher.`;
    default: return '';
  }
}

/** The line shown above every conversation between two students. */
export const WATCHED_NOTE = 'Your teacher can read messages between classmates.';

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
  kind: 'teacher' | 'students';
  other: { name: string; teacher: boolean };
  last: { snippet: string; mine: boolean; at: number; removed: boolean } | null;
  unread: boolean;
}

/** One message as a page receives it. `body` is null once a teacher removed it. */
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
  kind: 'teacher' | 'students';
  other: { name: string; teacher: boolean };
  messages: MessageItem[];
  canSend: boolean;
  why: SendBlock;
  whyText: string;
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
}

/** GET <base>/classes/<id>/messages: the teacher panel. */
export interface ClassOverview {
  classmatesOn: boolean;
  students: { key: string; name: string; muted: boolean }[];
  threads: {
    id: string; people: string[]; count: number; lastAt: number;
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
