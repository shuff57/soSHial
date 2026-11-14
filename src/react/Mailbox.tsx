// The mailbox: a person's conversations (each class's channels, then groups, then two-person
// conversations), one conversation, and making a new message, group or channel. Put <Mailbox> anywhere
// (a drawer), use <MailboxButton>, which puts it in a dropdown under an envelope with your own
// notification tabs beside it, or <MessagesPage> for a full two-column page. The pieces are exported too.
// A class's teachers can lock, rename and delete a channel, delete a group, and remove a message anywhere
// between students (they still see its words; students see "Removed by a teacher"). What a student may
// send follows their level (On, Teacher only, Off). Every message is checked before it is sent (and again
// on the server).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CHANNEL_NAME_MAX, DEFAULT_LIMITS, GENERAL, GROUP_MAX_PEOPLE, GROUP_TITLE_MAX, THREAD_POLL_MS, WATCHED_NOTE, blockText,
  cleanChannelName, cleanMessage,
  type MessageItem, type PeopleClass, type ThreadSummary, type ThreadView,
} from '../core';
import { createClient, type SoshialClient } from '../client';
import { c, clock, smallButton, srOnly, when } from './theme';

const svg = (d: string, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ArrowLeft = ({ size = 14 }: { size?: number }) => svg('M19 12H5M12 19l-7-7 7-7', size);
const PenSquare = ({ size = 14 }: { size?: number }) => svg('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z', size);
const Hash = ({ size = 14 }: { size?: number }) => svg('M4 9h16M4 15h16M10 3 8 21M16 3l-2 18', size);
const Lock = ({ size = 14 }: { size?: number }) => svg('M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', size);
const Users = ({ size = 14 }: { size?: number }) => svg('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', size);
const Maximize2 = ({ size = 14 }: { size?: number }) => svg('M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7', size);

export type MailView =
  | { kind: 'list' } | { kind: 'thread'; id: string } | { kind: 'new' } | { kind: 'new-group' } | { kind: 'new-channel' };

const small = smallButton;

/** The client and the message limit every piece below uses (set by <Mailbox>, <MessagesPage> or <SoshialProvider>). */
const Ctx = createContext<{ client: SoshialClient; max: number } | null>(null);
function useSoshial(): { client: SoshialClient; max: number } {
  const v = useContext(Ctx);
  if (!v) throw new Error('soSHial: put this inside <Mailbox>, <MessagesPage> or <SoshialProvider>.');
  return v;
}
export function SoshialProvider({ client, messageMax = DEFAULT_LIMITS.messageMax, children }: { client?: SoshialClient; messageMax?: number; children: ReactNode }) {
  const made = useMemo(() => client ?? createClient(), [client]);
  const value = useMemo(() => ({ client: made, max: messageMax }), [made, messageMax]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
const field = {
  fontSize: 13, padding: '5px 8px', borderRadius: 4, background: c('deep'), color: c('fg'), border: `1px solid ${c('line')}`,
} as const;
const primary = (off: boolean) => ({
  fontSize: 13, padding: '5px 14px', borderRadius: 4, border: 'none', fontWeight: 600,
  background: off ? c('deep2') : c('accent'), color: off ? c('dim') : c('on-accent'), cursor: off ? 'default' : 'pointer',
});

const TeacherTag = ({ name }: { name?: string }) => (name === 'Teacher' ? null : (
  <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', marginLeft: 6, borderRadius: 3, color: c('teacher'), border: `1px solid ${c('teacher')}`, verticalAlign: 1 }}>
    Teacher
  </span>
));

function KindIcon({ kind, locked, size = 13 }: { kind: ThreadSummary['kind']; locked?: boolean; size?: number }) {
  if (kind === 'channel') return locked ? <Lock size={size} /> : <Hash size={size} />;
  if (kind === 'group') return <Users size={size} />;
  return null;
}

function Composer({ onSend, disabled, placeholder, autoFocus }: {
  onSend: (text: string) => Promise<string | null>; disabled?: boolean; placeholder: string; autoFocus?: boolean;
}) {
  const { max } = useSoshial();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const length = [...text].length;

  const send = async () => {
    if (busy) return;
    const cleaned = cleanMessage(text, { ...DEFAULT_LIMITS, messageMax: max });
    if ('error' in cleaned) { setError(cleaned.error); return; }
    setBusy(true);
    setError(null);
    const err = await onSend(cleaned.body);
    setBusy(false);
    if (err) setError(err);
    else setText('');
  };

  const off = disabled || busy || !text.trim();
  return (
    <div style={{ borderTop: `1px solid ${c('line')}`, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {error && <p role="alert" style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: c('danger') }}>{error}</p>}
      <label htmlFor="soshial-compose" style={srOnly}>Message</label>
      <textarea id="soshial-compose" value={text} disabled={disabled || busy} autoFocus={autoFocus}
        onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
        placeholder={placeholder} rows={2} data-testid="soshial-compose"
        style={{ ...field, resize: 'vertical', minHeight: 44, maxHeight: 160, lineHeight: 1.45, padding: '6px 8px', fontFamily: 'inherit' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: length > max ? c('danger') : c('dim'), flex: 1 }}>
          {length > max - 200 ? `${length} / ${max}` : 'Enter sends · Shift+Enter for a new line'}
        </span>
        <button type="button" onClick={() => void send()} disabled={off} data-testid="soshial-send" style={primary(off)}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

// ---- the list ------------------------------------------------------------------------------------

function Row({ t, selected, onOpen }: { t: ThreadSummary; selected: boolean; onOpen: (id: string) => void }) {
  const channel = t.kind === 'channel';
  return (
    <li>
      <button type="button" onClick={() => onOpen(t.id)} data-testid="soshial-thread" data-kind={t.kind} aria-current={selected ? 'true' : undefined}
        style={{
          display: 'flex', gap: 8, width: '100%', textAlign: 'left', padding: channel ? '6px 12px' : '9px 12px', border: 'none', cursor: 'pointer',
          color: c('fg'), borderBottom: channel ? 'none' : `1px solid ${c('line')}`,
          background: selected ? `color-mix(in srgb, ${c('accent')} 18%, transparent)` : t.unread && !channel ? `color-mix(in srgb, ${c('accent')} 9%, transparent)` : 'transparent',
        }}>
        {channel ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, minWidth: 0, flex: 1, fontWeight: t.unread ? 700 : 400, color: t.unread ? c('fg') : c('meta') }}>
            <KindIcon kind="channel" locked={t.locked} />
            {t.unread && <span style={srOnly}>New messages in </span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
          </span>
        ) : (
          <>
            <span aria-hidden="true" style={{ width: 8, height: 8, marginTop: 6, borderRadius: '50%', flexShrink: 0, background: t.unread ? c('accent') : 'transparent' }} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                {t.unread && <span style={srOnly}>New: </span>}
                <KindIcon kind={t.kind} />
                <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</strong>
                {t.kind !== 'group' && t.other.teacher && <TeacherTag name={t.other.name} />}
                <span style={{ color: c('dim'), fontSize: 11, flexShrink: 0 }}>· {t.className}</span>
              </span>
              {t.last && (
                <span style={{ fontSize: 12, color: c('meta'), display: 'block', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: t.last.removed ? 'italic' : 'normal' }}>
                  {t.last.mine ? 'You: ' : t.last.author ? `${t.last.author}: ` : ''}{t.last.removed ? 'Removed by a teacher' : t.last.snippet}
                </span>
              )}
              {t.last && <span style={{ fontSize: 11, color: c('dim'), display: 'block', marginTop: 2 }}>{when(t.last.at)}</span>}
            </span>
          </>
        )}
      </button>
    </li>
  );
}

const sectionHead = { margin: 0, padding: '10px 12px 4px', fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: c('dim') } as const;

/** Each class's channels, then groups, then two-person conversations. */
export function ConversationList({ threads, error, selected, onOpen }: {
  threads: ThreadSummary[] | null; error: string | null; selected?: string | null; onOpen: (id: string) => void;
}) {
  const parts = useMemo(() => {
    const t = threads ?? [];
    const byClass = new Map<string, ThreadSummary[]>();
    for (const c of t.filter((x) => x.kind === 'channel')) {
      const list = byClass.get(c.className) ?? [];
      list.push(c);
      byClass.set(c.className, list);
    }
    return { byClass: [...byClass.entries()], groups: t.filter((x) => x.kind === 'group'), direct: t.filter((x) => x.kind === 'teacher' || x.kind === 'students') };
  }, [threads]);
  if (error) return <p role="alert" style={{ margin: 0, padding: 12, fontSize: 13, color: c('danger') }}>{error}</p>;
  if (!threads) return <p style={{ margin: 0, padding: 12, fontSize: 13, color: c('dim') }}>Loading…</p>;
  if (!threads.length) {
    return (
      <p style={{ margin: 0, padding: 12, fontSize: 13, lineHeight: 1.5, color: c('dim') }}>
        No messages yet. Join a class, then press Message to write to your teacher or a classmate.
      </p>
    );
  }
  return (
    <nav aria-label="Conversations" data-testid="soshial-list">
      {parts.byClass.map(([name, list]) => (
        <section key={name} aria-label={`${name} channels`} style={{ paddingBottom: 4 }}>
          <h3 style={sectionHead}>{name}</h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{list.map((t) => <Row key={t.id} t={t} selected={selected === t.id} onOpen={onOpen} />)}</ul>
        </section>
      ))}
      {parts.groups.length > 0 && (
        <section aria-label="Groups">
          <h3 style={sectionHead}>Groups</h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: `1px solid ${c('line')}` }}>{parts.groups.map((t) => <Row key={t.id} t={t} selected={selected === t.id} onOpen={onOpen} />)}</ul>
        </section>
      )}
      {parts.direct.length > 0 && (
        <section aria-label="Direct messages">
          <h3 style={sectionHead}>Direct messages</h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: `1px solid ${c('line')}` }}>{parts.direct.map((t) => <Row key={t.id} t={t} selected={selected === t.id} onOpen={onOpen} />)}</ul>
        </section>
      )}
    </nav>
  );
}

/** Message, Group, Channel. */
export function NewButtons({ onPick }: { onPick: (v: MailView) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <button type="button" onClick={() => onPick({ kind: 'new' })} data-testid="soshial-new" style={{ ...small, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, padding: '4px 9px' }}>
        <PenSquare size={13} /> Message
      </button>
      <button type="button" onClick={() => onPick({ kind: 'new-group' })} data-testid="soshial-new-group" style={{ ...small, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, padding: '4px 9px' }}>
        <Users size={13} /> Group
      </button>
      <button type="button" onClick={() => onPick({ kind: 'new-channel' })} data-testid="soshial-new-channel" style={{ ...small, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, padding: '4px 9px' }}>
        <Hash size={13} /> Channel
      </button>
    </div>
  );
}

// ---- one conversation -----------------------------------------------------------------------------

function MessageRow({ m, view, onModerate }: { m: MessageItem; view: ThreadView; onModerate: (m: MessageItem) => void }) {
  const many = view.kind === 'group' || view.kind === 'channel' || view.onlooker;
  const removedWords = m.removed && m.body != null;
  return (
    <div data-testid="soshial-message" style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
      {many && !m.mine && (
        <div style={{ fontSize: 11, color: c('meta'), marginBottom: 2 }}>
          <strong>{m.author}</strong>{m.teacher && <TeacherTag name={m.author} />}
        </div>
      )}
      {(m.removed || m.body) && (
        <div style={{
          fontSize: 13, lineHeight: 1.45, padding: '6px 10px', borderRadius: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          background: m.removed ? 'transparent' : m.mine ? `color-mix(in srgb, ${c('accent')} 22%, ${c('bg')})` : c('deep2'),
          border: m.removed ? `1px dashed ${c('line')}` : '1px solid transparent',
          color: m.removed ? c('dim') : c('fg'), fontStyle: m.removed && !removedWords ? 'italic' : 'normal',
          textDecoration: removedWords ? 'line-through' : 'none',
        }}>
          {removedWords ? m.body : m.removed ? 'Removed by a teacher' : m.body}
        </div>
      )}
      <div style={{ fontSize: 10, color: c('dim'), marginTop: 2, textAlign: m.mine ? 'right' : 'left' }}>
        {m.mine ? 'You' : m.author} · {clock(m.at)}
        {removedWords && <span style={{ color: c('warn') }}> · removed (students see &ldquo;Removed by a teacher&rdquo;)</span>}
        {view.moderate && (
          <button type="button" onClick={() => onModerate(m)} data-testid="soshial-moderate"
            style={{ marginLeft: 8, fontSize: 10, padding: 0, border: 'none', background: 'none', color: c('link'), cursor: 'pointer', textDecoration: 'underline' }}>
            {m.removed ? 'Put back' : 'Remove'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Pick people of a class (a new group, or adding to one). */
function PeoplePicker({ cls, chosen, setChosen, exclude = [], room }: {
  cls: PeopleClass; chosen: Set<string>; setChosen: (s: Set<string>) => void; exclude?: string[]; room: number;
}) {
  const [filter, setFilter] = useState('');
  const shown = cls.people.filter((p) => !exclude.includes(p.key) && (!filter.trim() || p.name.toLowerCase().includes(filter.trim().toLowerCase())));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
      <label style={srOnly} htmlFor="soshial-people-filter">Find a person</label>
      <input id="soshial-people-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a person" style={field} />
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', maxHeight: 220 }} aria-label={`People in ${cls.name}`}>
        {shown.map((p) => {
          const on = chosen.has(p.key);
          const full = !on && chosen.size >= room;
          return (
            <li key={p.key}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', fontSize: 13, cursor: full ? 'default' : 'pointer', color: full ? c('dim') : c('fg') }}>
                <input type="checkbox" checked={on} disabled={full} data-testid="soshial-group-person"
                  onChange={() => { const next = new Set(chosen); if (on) next.delete(p.key); else next.add(p.key); setChosen(next); }} />
                {p.name}{p.teacher && <TeacherTag name={p.name} />}
              </label>
            </li>
          );
        })}
        {!shown.length && <li style={{ padding: 6, fontSize: 13, color: c('dim') }}>No one to add.</li>}
      </ul>
    </div>
  );
}

export function ThreadPane({ id, onBack, onGone, onChanged }: {
  id: string; onBack?: () => void; onGone?: () => void; onChanged?: () => void;
}) {
  const { client } = useSoshial();
  const [view, setView] = useState<ThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<'rename' | 'add' | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState<{ cls: PeopleClass | null; chosen: Set<string> }>({ cls: null, chosen: new Set() });
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const load = useCallback(async () => {
    const r = await client.thread(id);
    if (r.ok) { setView(r.value); setError(null); } else setError(r.error);
  }, [id, client]);

  useEffect(() => {
    setView(null);
    setEditing(null);
    setNote(null);
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, THREAD_POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    const n = view?.messages.length ?? 0;
    if (n !== lastCount.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    lastCount.current = n;
  }, [view]);

  const run = async (action: string, extra: Record<string, unknown> = {}, ask?: string): Promise<void> => {
    if (busy || (ask && !window.confirm(ask))) return;
    setBusy(true);
    setNote(null);
    const r = await client.manage(id, action, extra);
    setBusy(false);
    if (!r.ok) { setNote(r.error); return; }
    if (r.value.left || r.value.deleted) { onChanged?.(); onGone?.(); return; }
    setView(r.value);
    setEditing(null);
    onChanged?.();
  };

  const startAdd = async () => {
    setEditing('add');
    setAdding({ cls: null, chosen: new Set() });
    const r = await client.people();
    if (!r.ok) { setNote(r.error); return; }
    setAdding({ cls: r.value.find((c) => c.id === view?.classId) ?? null, chosen: new Set() });
  };

  const v = view;
  const isChannel = v?.kind === 'channel';
  const isGroup = v?.kind === 'group';
  const headTitle = v ? (isChannel ? `#${v.title}` : v.title) : '…';
  const sub = v ? [v.className, isGroup && v.members ? v.members.map((m) => (m.me ? 'you' : m.name)).join(', ') : null, isChannel && v.locked ? 'only teachers post' : null].filter(Boolean).join(' · ') : '';
  const tools: { label: string; on: () => void; testid: string }[] = [];
  if (v) {
    if (v.manage && !(isChannel && v.title === GENERAL)) tools.push({ label: 'Rename', testid: 'soshial-rename', on: () => { setDraft(v.kind === 'group' ? (v.title === v.members?.filter((m) => !m.me).map((m) => m.name).join(', ') ? '' : v.title) : v.title); setEditing('rename'); } });
    if (isGroup && v.manage) tools.push({ label: 'Add people', testid: 'soshial-add', on: () => void startAdd() });
    if (isGroup && !v.onlooker) tools.push({ label: 'Leave', testid: 'soshial-leave', on: () => void run('leave', {}, `Leave "${v.title}"? You will not see its messages any more.`) });
    if (isChannel && v.moderate) tools.push({ label: v.locked ? 'Let everyone post' : 'Only teachers post', testid: 'soshial-lock', on: () => void run(v.locked ? 'unlock' : 'lock') });
    if (v.moderate && (isGroup || (isChannel && v.title !== GENERAL))) {
      tools.push({ label: 'Delete', testid: 'soshial-delete', on: () => void run('delete', {}, `Delete ${headTitle} and every message in it, for everyone? This cannot be undone.`) });
    }
  }
  const groupRoom = v?.members ? GROUP_MAX_PEOPLE - v.members.length : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }} data-testid="soshial-pane">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${c('line')}` }}>
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to all messages" title="Back"
            style={{ ...small, display: 'inline-flex', alignItems: 'center', padding: 4, color: c('fg') }}>
            <ArrowLeft size={14} />
          </button>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: c('fg'), display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }} data-testid="soshial-title">
            {v && v.kind !== 'channel' && <KindIcon kind={v.kind} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headTitle}</span>
            {v && (v.kind === 'teacher' || v.kind === 'students') && !v.onlooker && v.other.teacher && <TeacherTag name={v.other.name} />}
          </div>
          {v && <div style={{ fontSize: 11, color: c('dim'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
        </div>
      </div>
      {tools.length > 0 && editing === null && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '6px 10px', borderBottom: `1px solid ${c('line')}` }}>
          {tools.map((t) => <button key={t.label} type="button" style={small} disabled={busy} onClick={t.on} data-testid={t.testid}>{t.label}</button>)}
        </div>
      )}
      {editing === 'rename' && v && (
        <form onSubmit={(e) => { e.preventDefault(); void run('rename', { title: draft }); }}
          style={{ display: 'flex', gap: 6, padding: '6px 10px', borderBottom: `1px solid ${c('line')}` }}>
          <label style={srOnly} htmlFor="soshial-thread-name">New name</label>
          <input id="soshial-thread-name" value={draft} autoFocus maxLength={isChannel ? CHANNEL_NAME_MAX + 10 : GROUP_TITLE_MAX}
            onChange={(e) => setDraft(e.target.value)} placeholder={isChannel ? 'soshial-channel-name' : 'Group name'} style={{ ...field, flex: 1, minWidth: 0 }} />
          <button type="submit" style={primary(busy)} disabled={busy}>Save</button>
          <button type="button" style={small} onClick={() => setEditing(null)}>Cancel</button>
        </form>
      )}
      {editing === 'add' && v && (
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${c('line')}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {!adding.cls ? <p style={{ margin: 0, fontSize: 12, color: c('dim') }}>Loading…</p> : (
            <PeoplePicker cls={adding.cls} chosen={adding.chosen} setChosen={(s) => setAdding((a) => ({ ...a, chosen: s }))}
              exclude={(v.members ?? []).map((m) => m.key)} room={groupRoom} />
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: c('dim'), flex: 1 }}>A group is at most {GROUP_MAX_PEOPLE} people.</span>
            <button type="button" style={primary(busy || !adding.chosen.size)} disabled={busy || !adding.chosen.size}
              onClick={() => void run('add', { people: [...adding.chosen] })}>Add</button>
            <button type="button" style={small} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      {note && <p role="alert" style={{ margin: 0, padding: '6px 12px', fontSize: 12, color: c('danger') }}>{note}</p>}
      {v?.note && (
        <p data-testid="soshial-watched" style={{ margin: 0, padding: '6px 12px', fontSize: 12, color: c('meta'), background: c('deep'), borderBottom: `1px solid ${c('line')}` }}>
          {v.note}
        </p>
      )}
      <div ref={logRef} role="log" aria-label={v ? `Messages in ${headTitle}` : 'Messages'} aria-live="polite"
        style={{ overflowY: 'auto', flex: 1, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}>
        {error && <p role="alert" style={{ margin: 0, fontSize: 13, color: c('danger') }}>{error}</p>}
        {!v && !error && <p style={{ margin: 0, fontSize: 13, color: c('dim') }}>Loading…</p>}
        {v?.more && <p style={{ margin: 0, fontSize: 11, color: c('dim'), textAlign: 'center' }}>Showing the newest {v.messages.length} messages.</p>}
        {v && !v.messages.length && (
          <p style={{ margin: 0, fontSize: 13, color: c('dim') }}>
            {isChannel ? `This is the start of #${v.title}.` : isGroup ? 'No messages yet. Say hello to the group.' : 'No messages yet.'}
          </p>
        )}
        {v?.messages.map((m) => (
          <MessageRow key={m.id} m={m} view={v}
            onModerate={(x) => void run(x.removed ? 'restore' : 'remove', { messageId: x.id }, x.removed ? undefined : 'Remove this message? Students will see "Removed by a teacher". You can put it back.')} />
        ))}
      </div>
      {v && (v.canSend
        ? <Composer placeholder={isChannel ? `Message #${v.title}` : `Message ${v.title}`} autoFocus onSend={async (text) => {
            const r = await client.reply(id, text);
            if (!r.ok) { if (r.status === 403) void load(); return r.error; }
            setView(r.value);
            onChanged?.();
            return null;
          }} />
        : <p data-testid="soshial-closed" style={{ margin: 0, padding: '10px 12px', fontSize: 12, lineHeight: 1.45, color: c('meta'), borderTop: `1px solid ${c('line')}` }}>
            {v.whyText || blockText(v.why, v.other.name, v.className)}
          </p>)}
    </div>
  );
}

// ---- making something new -------------------------------------------------------------------------

function useClasses(): { classes: PeopleClass[] | null; error: string | null; classId: string; setClassId: (id: string) => void } {
  const { client } = useSoshial();
  const [classes, setClasses] = useState<PeopleClass[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [classId, setClassId] = useState('');
  useEffect(() => {
    void client.people().then((r) => {
      if (!r.ok) { setError(r.error); return; }
      setClasses(r.value);
      if (r.value.length) setClassId(r.value[0].id);
    });
  }, [client]);
  return { classes, error, classId, setClassId };
}

function NewHeader({ title, onBack }: { title: React.ReactNode; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${c('line')}` }}>
      <button type="button" onClick={onBack} aria-label="Back to all messages" title="Back"
        style={{ ...small, display: 'inline-flex', alignItems: 'center', padding: 4, color: c('fg') }}>
        <ArrowLeft size={14} />
      </button>
      <div style={{ fontSize: 13, fontWeight: 600, color: c('fg'), flex: 1 }}>{title}</div>
    </div>
  );
}

function ClassPick({ classes, classId, setClassId }: { classes: PeopleClass[]; classId: string; setClassId: (id: string) => void }) {
  if (classes.length < 2) return null;
  return (
    <label style={{ fontSize: 12, color: c('meta'), display: 'flex', alignItems: 'center', gap: 6 }}>
      Class
      <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ ...field, padding: '3px 6px' }}>
        {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}

const status = (text: string, color = c('dim')) => <p style={{ margin: 0, padding: 12, fontSize: 13, lineHeight: 1.5, color }}>{text}</p>;

export function NewMessage({ onBack, onSent }: { onBack: () => void; onSent: (id: string) => void }) {
  const { client } = useSoshial();
  const { classes, error, classId, setClassId } = useClasses();
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState('');

  const cls = classes?.find((c) => c.id === classId) ?? null;
  const people = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (cls?.people ?? []).filter((p) => !f || p.name.toLowerCase().includes(f));
  }, [cls, filter]);
  const person = cls?.people.find((p) => p.key === to) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <NewHeader onBack={person ? () => setTo('') : onBack}
        title={person ? <>To {person.name}{person.teacher && <TeacherTag name={person.name} />}</> : 'New message'} />
      {error && status(error, c('danger'))}
      {!classes && !error && status('Loading…')}
      {classes && !classes.length && status('You are not in a class yet. Once you are, you can message the people in it.')}
      {cls && !person && (
        <>
          <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderBottom: `1px solid ${c('line')}` }}>
            <ClassPick classes={classes!} classId={classId} setClassId={(id) => { setClassId(id); setTo(''); }} />
            <label htmlFor="soshial-filter" style={srOnly}>Find a person</label>
            <input id="soshial-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a person" autoFocus style={field} />
            {cls.classmatesBlocked && (
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: c('meta') }}>{blockText(cls.classmatesBlocked, '', cls.name)}</p>
            )}
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1 }} aria-label={`People in ${cls.name}`}>
            {people.map((p) => (
              <li key={p.key}>
                <button type="button" onClick={() => setTo(p.key)} data-testid="soshial-person"
                  style={{ width: '100%', textAlign: 'left', padding: '8px 12px', background: 'transparent', border: 'none', borderBottom: `1px solid ${c('line')}`, color: c('fg'), fontSize: 13, cursor: 'pointer' }}>
                  {p.name}{p.teacher && <TeacherTag name={p.name} />}
                </button>
              </li>
            ))}
            {!people.length && !cls.allBlocked && <li style={{ padding: 12, fontSize: 13, color: c('dim') }}>No one by that name in {cls.name}.</li>}
          </ul>
        </>
      )}
      {cls && person && (
        <>
          <div style={{ flex: 1, padding: '10px 12px', fontSize: 12, lineHeight: 1.5, color: c('meta') }}>
            {person.teacher || cls.teaches ? `In ${cls.name}.` : <>In {cls.name}. {WATCHED_NOTE}</>}
          </div>
          <Composer placeholder={`Message ${person.name}`} autoFocus onSend={async (text) => {
            const r = await client.sendNew(cls.id, person.key, text);
            if (!r.ok) return r.error;
            onSent(r.value.id);
            return null;
          }} />
        </>
      )}
    </div>
  );
}

export function NewGroup({ onBack, onMade }: { onBack: () => void; onMade: (id: string) => void }) {
  const { client } = useSoshial();
  const { classes, error, classId, setClassId } = useClasses();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cls = classes?.find((c) => c.id === classId) ?? null;
  const blocked = cls && !cls.teaches ? cls.classmatesBlocked : null;

  const make = async () => {
    if (!cls || !chosen.size || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await client.createGroup(cls.id, [...chosen], title);
    setBusy(false);
    if (!r.ok) { setProblem(r.error); return; }
    onMade(r.value.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <NewHeader onBack={onBack} title="New group" />
      {error && status(error, c('danger'))}
      {!classes && !error && status('Loading…')}
      {classes && !classes.length && status('You are not in a class yet. Once you are, you can make a group with people in it.')}
      {cls && (
        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1 }}>
          <ClassPick classes={classes!} classId={classId} setClassId={(id) => { setClassId(id); setChosen(new Set()); }} />
          {blocked ? (
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: c('meta') }}>{blockText(blocked, '', cls.name)}</p>
          ) : (
            <>
              <label style={{ fontSize: 12, color: c('meta'), display: 'flex', flexDirection: 'column', gap: 4 }}>
                Name (you can leave it empty)
                <input value={title} maxLength={GROUP_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="Maze team" style={field} data-testid="soshial-group-title" />
              </label>
              <div style={{ fontSize: 12, color: c('meta') }}>People ({chosen.size + 1} of {GROUP_MAX_PEOPLE}, you included)</div>
              <PeoplePicker cls={cls} chosen={chosen} setChosen={setChosen} room={GROUP_MAX_PEOPLE - 1} />
              <p style={{ margin: 0, fontSize: 12, color: c('meta') }}>{cls.teaches ? `In ${cls.name}.` : `In ${cls.name}. Your teacher can read this group.`}</p>
              {problem && <p role="alert" style={{ margin: 0, fontSize: 12, color: c('danger') }}>{problem}</p>}
              <div><button type="button" onClick={() => void make()} disabled={busy || !chosen.size} style={primary(busy || !chosen.size)} data-testid="soshial-group-create">
                {busy ? 'Making it…' : 'Make the group'}
              </button></div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function NewChannel({ onBack, onMade }: { onBack: () => void; onMade: (id: string) => void }) {
  const { client } = useSoshial();
  const { classes, error, classId, setClassId } = useClasses();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cls = classes?.find((c) => c.id === classId) ?? null;
  const blocked = cls && !cls.teaches ? cls.classmatesBlocked : null;
  const tidy = cleanChannelName(name);

  const make = async () => {
    if (!cls || busy) return;
    if ('error' in tidy) { setProblem(tidy.error); return; }
    setBusy(true);
    setProblem(null);
    const r = await client.createChannel(cls.id, tidy.name);
    setBusy(false);
    if (!r.ok) { setProblem(r.error); return; }
    onMade(r.value.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <NewHeader onBack={onBack} title="New channel" />
      {error && status(error, c('danger'))}
      {!classes && !error && status('Loading…')}
      {classes && !classes.length && status('You are not in a class yet.')}
      {cls && (
        <form onSubmit={(e) => { e.preventDefault(); void make(); }} style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ClassPick classes={classes!} classId={classId} setClassId={setClassId} />
          {blocked ? (
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: c('meta') }}>{blockText(blocked, '', cls.name)}</p>
          ) : (
            <>
              <label style={{ fontSize: 12, color: c('meta'), display: 'flex', flexDirection: 'column', gap: 4 }}>
                Name
                <input value={name} autoFocus maxLength={CHANNEL_NAME_MAX + 10} onChange={(e) => { setName(e.target.value); setProblem(null); }}
                  placeholder="game-ideas" style={field} data-testid="soshial-channel-name" />
              </label>
              {'name' in tidy && <p style={{ margin: 0, fontSize: 12, color: c('meta') }}>It will be <strong>#{tidy.name}</strong>. Everyone in {cls.name} can read it and post in it.</p>}
              {problem && <p role="alert" style={{ margin: 0, fontSize: 12, color: c('danger') }}>{problem}</p>}
              <div><button type="submit" disabled={busy || !name.trim()} style={primary(busy || !name.trim())} data-testid="soshial-channel-create">
                {busy ? 'Making it…' : 'Make the channel'}
              </button></div>
            </>
          )}
        </form>
      )}
    </div>
  );
}

/** The pieces for a new message, group or channel, by view. */
export function NewThing({ view, onBack, onOpen }: { view: MailView; onBack: () => void; onOpen: (id: string) => void }) {
  if (view.kind === 'new') return <NewMessage onBack={onBack} onSent={onOpen} />;
  if (view.kind === 'new-group') return <NewGroup onBack={onBack} onMade={onOpen} />;
  if (view.kind === 'new-channel') return <NewChannel onBack={onBack} onMade={onOpen} />;
  return null;
}

/** The conversations, asked again every THREAD_POLL_MS while `active` and visible. */
export function useThreads(active: boolean): { threads: ThreadSummary[] | null; error: string | null; reload: () => void } {
  const { client } = useSoshial();
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await client.threads();
    if (r.ok) { setThreads(r.value); setError(null); } else setError(r.error);
  }, [client]);
  useEffect(() => {
    if (!active) return;
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, THREAD_POLL_MS);
    return () => window.clearInterval(t);
  }, [active, load]);
  return { threads, error, reload: () => void load() };
}

export interface MailboxProps {
  /** From createClient(); one is made with the default base when left out. */
  client?: SoshialClient;
  /** Polls the list while true (e.g. while the dropdown is open). Default true. */
  active?: boolean;
  /** Characters in one message, if you changed the server's `limits.messageMax`. */
  messageMax?: number;
  /** Where your full Messages page is (<MessagesPage>): shows a button to open it. */
  fullPageHref?: string;
}

function MailboxInner({ active, fullPageHref }: { active: boolean; fullPageHref?: string }) {
  const [view, setView] = useState<MailView>({ kind: 'list' });
  const { threads, error, reload } = useThreads(active && view.kind === 'list');
  const toList = () => { setView({ kind: 'list' }); reload(); };

  if (view.kind === 'thread') return <ThreadPane id={view.id} onBack={toList} onGone={toList} />;
  if (view.kind !== 'list') return <NewThing view={view} onBack={toList} onOpen={(id) => setView({ kind: 'thread', id })} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, color: c('fg') }}>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${c('line')}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}><NewButtons onPick={setView} /></div>
        {fullPageHref && (
          <a href={fullPageHref} title="Open Messages as a full page" aria-label="Open Messages as a full page" data-testid="soshial-full"
            style={{ ...small, display: 'inline-flex', alignItems: 'center', padding: 5, color: c('fg'), textDecoration: 'none' }}>
            <Maximize2 size={13} />
          </a>
        )}
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        <ConversationList threads={threads} error={error} onOpen={(id) => setView({ kind: 'thread', id })} />
      </div>
    </div>
  );
}

/** The mailbox: the list, a conversation, and New message / Group / Channel. */
export function Mailbox({ client, active = true, messageMax = DEFAULT_LIMITS.messageMax, fullPageHref }: MailboxProps) {
  return (
    <SoshialProvider client={client} messageMax={messageMax}>
      <MailboxInner active={active} fullPageHref={fullPageHref} />
    </SoshialProvider>
  );
}
