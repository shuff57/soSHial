// The mailbox: a person's conversations, one conversation, and "New message". Put it anywhere (a page,
// a drawer), or use <MailboxButton>, which puts it in a dropdown under an envelope with your own
// notification tabs beside it. Every message is checked before it is sent (and again on the server).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_LIMITS, THREAD_POLL_MS, WATCHED_NOTE, blockText, cleanMessage,
  type PeopleClass, type ThreadSummary, type ThreadView,
} from '../core';
import { createClient, type SoshialClient } from '../client';
import { c, clock, smallButton, srOnly, when } from './theme';

type View = { kind: 'list' } | { kind: 'thread'; id: string } | { kind: 'new' };

const Back = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);
const Pen = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const TeacherTag = ({ name }: { name?: string }) => (name === 'Teacher' ? null : (
  <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', marginLeft: 6, borderRadius: 3, color: c('teacher'), border: `1px solid ${c('teacher')}`, verticalAlign: 1 }}>
    Teacher
  </span>
));

const iconButton = { ...smallButton, display: 'inline-flex', alignItems: 'center', padding: 4, color: c('fg') } as const;

function Composer({ onSend, disabled, placeholder, autoFocus, max }: {
  onSend: (text: string) => Promise<string | null>; disabled?: boolean; placeholder: string; autoFocus?: boolean; max: number;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const length = [...text].length;
  const off = disabled || busy || !text.trim();

  const send = async () => {
    if (busy) return;
    const checked = cleanMessage(text, { ...DEFAULT_LIMITS, messageMax: max });
    if ('error' in checked) { setError(checked.error); return; }
    setBusy(true);
    setError(null);
    const err = await onSend(checked.body);
    setBusy(false);
    if (err) setError(err);
    else setText('');
  };

  return (
    <div style={{ borderTop: `1px solid ${c('line')}`, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {error && <p role="alert" style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: c('danger') }}>{error}</p>}
      <label htmlFor="soshial-compose" style={srOnly}>Message</label>
      <textarea id="soshial-compose" value={text} disabled={disabled || busy} autoFocus={autoFocus}
        onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
        placeholder={placeholder} rows={2} data-testid="soshial-compose"
        style={{
          resize: 'vertical', minHeight: 44, maxHeight: 160, fontSize: 13, lineHeight: 1.45, padding: '6px 8px', borderRadius: 4,
          background: c('deep'), color: c('fg'), border: `1px solid ${c('line')}`, fontFamily: 'inherit',
        }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: length > max ? c('danger') : c('dim'), flex: 1 }}>
          {length > max - 200 ? `${length} / ${max}` : 'Enter sends · Shift+Enter for a new line'}
        </span>
        <button type="button" onClick={() => void send()} disabled={off} data-testid="soshial-send"
          style={{
            fontSize: 13, padding: '5px 14px', borderRadius: 4, border: 'none', fontWeight: 600,
            background: off ? c('deep2') : c('accent'), color: off ? c('dim') : c('on-accent'), cursor: off ? 'default' : 'pointer',
          }}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function ThreadPane({ client, id, onBack, max }: { client: SoshialClient; id: string; onBack: () => void; max: number }) {
  const [view, setView] = useState<ThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const load = useCallback(async () => {
    const r = await client.thread(id);
    if (r.ok) { setView(r.value); setError(null); } else setError(r.error);
  }, [client, id]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, THREAD_POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    const n = view?.messages.length ?? 0;
    if (n !== lastCount.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    lastCount.current = n;
  }, [view]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${c('line')}` }}>
        <button type="button" onClick={onBack} aria-label="Back to all messages" title="Back" style={iconButton}><Back /></button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: c('fg') }}>
            {view ? view.other.name : '…'}{view?.other.teacher && <TeacherTag name={view.other.name} />}
          </div>
          {view && <div style={{ fontSize: 11, color: c('dim') }}>{view.className}</div>}
        </div>
      </div>
      {view?.kind === 'students' && (
        <p data-testid="soshial-watched" style={{ margin: 0, padding: '6px 12px', fontSize: 12, color: c('meta'), background: c('deep'), borderBottom: `1px solid ${c('line')}` }}>
          {WATCHED_NOTE}
        </p>
      )}
      <div ref={logRef} role="log" aria-label={view ? `Messages with ${view.other.name}` : 'Messages'} aria-live="polite"
        style={{ overflowY: 'auto', flex: 1, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}>
        {error && <p role="alert" style={{ margin: 0, fontSize: 13, color: c('danger') }}>{error}</p>}
        {!view && !error && <p style={{ margin: 0, fontSize: 13, color: c('dim') }}>Loading…</p>}
        {view?.messages.map((m) => (
          <div key={m.id} data-testid="soshial-message" style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            <div style={{
              fontSize: 13, lineHeight: 1.45, padding: '6px 10px', borderRadius: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              background: m.removed ? 'transparent' : m.mine ? `color-mix(in srgb, ${c('accent')} 22%, ${c('bg')})` : c('deep2'),
              border: m.removed ? `1px dashed ${c('line')}` : '1px solid transparent',
              color: m.removed ? c('dim') : c('fg'), fontStyle: m.removed ? 'italic' : 'normal',
            }}>
              {m.removed ? 'Removed by a teacher' : m.body}
            </div>
            <div style={{ fontSize: 10, color: c('dim'), marginTop: 2, textAlign: m.mine ? 'right' : 'left' }}>
              {m.mine ? 'You' : m.author} · {clock(m.at)}
            </div>
          </div>
        ))}
      </div>
      {view && (view.canSend
        ? <Composer max={max} placeholder={`Message ${view.other.name}`} autoFocus onSend={async (text) => {
            const r = await client.reply(id, text);
            if (!r.ok) { if (r.status === 403) void load(); return r.error; }
            setView(r.value);
            return null;
          }} />
        : <p data-testid="soshial-closed" style={{ margin: 0, padding: '10px 12px', fontSize: 12, lineHeight: 1.45, color: c('meta'), borderTop: `1px solid ${c('line')}` }}>
            {view.whyText || blockText(view.why, view.other.name, view.className)}
          </p>)}
    </div>
  );
}

function NewMessage({ client, onBack, onSent, max }: { client: SoshialClient; onBack: () => void; onSent: (id: string) => void; max: number }) {
  const [classes, setClasses] = useState<PeopleClass[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [classId, setClassId] = useState('');
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void client.people().then((r) => {
      if (!r.ok) { setError(r.error); return; }
      setClasses(r.value);
      if (r.value.length) setClassId(r.value[0].id);
    });
  }, [client]);

  const cls = classes?.find((x) => x.id === classId) ?? null;
  const people = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (cls?.people ?? []).filter((p) => !f || p.name.toLowerCase().includes(f));
  }, [cls, filter]);
  const person = cls?.people.find((p) => p.key === to) ?? null;
  const field = { fontSize: 13, padding: '5px 8px', borderRadius: 4, background: c('deep'), color: c('fg'), border: `1px solid ${c('line')}` } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${c('line')}` }}>
        <button type="button" onClick={person ? () => setTo('') : onBack} aria-label={person ? 'Choose someone else' : 'Back to all messages'} title="Back" style={iconButton}>
          <Back />
        </button>
        <div style={{ fontSize: 13, fontWeight: 600, color: c('fg'), flex: 1 }}>
          {person ? <>To {person.name}{person.teacher && <TeacherTag name={person.name} />}</> : 'New message'}
        </div>
      </div>
      {error && <p role="alert" style={{ margin: 0, padding: 12, fontSize: 13, color: c('danger') }}>{error}</p>}
      {!classes && !error && <p style={{ margin: 0, padding: 12, fontSize: 13, color: c('dim') }}>Loading…</p>}
      {classes && !classes.length && (
        <p style={{ margin: 0, padding: 12, fontSize: 13, lineHeight: 1.5, color: c('dim') }}>
          You are not in a class yet. Once you are, you can message the people in it.
        </p>
      )}
      {cls && !person && (
        <>
          <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderBottom: `1px solid ${c('line')}` }}>
            {classes!.length > 1 && (
              <label style={{ fontSize: 12, color: c('meta'), display: 'flex', alignItems: 'center', gap: 6 }}>
                Class
                <select value={classId} onChange={(e) => { setClassId(e.target.value); setTo(''); }} style={{ ...field, padding: '3px 6px' }}>
                  {classes!.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
            )}
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
            {!people.length && <li style={{ padding: 12, fontSize: 13, color: c('dim') }}>No one by that name in {cls.name}.</li>}
          </ul>
        </>
      )}
      {cls && person && (
        <>
          <div style={{ flex: 1, padding: '10px 12px', fontSize: 12, lineHeight: 1.5, color: c('meta') }}>
            {person.teacher || cls.teaches ? `In ${cls.name}.` : <>In {cls.name}. {WATCHED_NOTE}</>}
          </div>
          <Composer max={max} placeholder={`Message ${person.name}`} autoFocus onSend={async (text) => {
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

export interface MailboxProps {
  /** From createClient(); one is made with the default base when left out. */
  client?: SoshialClient;
  /** Polls the list while true (e.g. while the dropdown is open). Default true. */
  active?: boolean;
  /** Characters in one message, if you changed the server's `limits.messageMax`. */
  messageMax?: number;
}

export function Mailbox({ client: given, active = true, messageMax = DEFAULT_LIMITS.messageMax }: MailboxProps) {
  const client = useMemo(() => given ?? createClient(), [given]);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await client.threads();
    if (r.ok) { setThreads(r.value); setError(null); } else setError(r.error);
  }, [client]);

  useEffect(() => {
    if (!active || view.kind !== 'list') return;
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, THREAD_POLL_MS);
    return () => window.clearInterval(t);
  }, [active, view.kind, load]);

  if (view.kind === 'thread') return <ThreadPane client={client} max={messageMax} id={view.id} onBack={() => setView({ kind: 'list' })} />;
  if (view.kind === 'new') return <NewMessage client={client} max={messageMax} onBack={() => setView({ kind: 'list' })} onSent={(id) => setView({ kind: 'thread', id })} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${c('line')}` }}>
        <button type="button" onClick={() => setView({ kind: 'new' })} data-testid="soshial-new"
          style={{ ...smallButton, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '5px 10px' }}>
          <Pen /> New message
        </button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {error && <p role="alert" style={{ margin: 0, padding: 12, fontSize: 13, color: c('danger') }}>{error}</p>}
        {!threads && !error && <p style={{ margin: 0, padding: 12, fontSize: 13, color: c('dim') }}>Loading…</p>}
        {threads && !threads.length && (
          <p style={{ margin: 0, padding: 12, fontSize: 13, lineHeight: 1.5, color: c('dim') }}>
            No messages yet. Press New message to write to your teacher or a classmate.
          </p>
        )}
        {threads && threads.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {threads.map((t) => (
              <li key={t.id} style={{ borderBottom: `1px solid ${c('line')}` }}>
                <button type="button" onClick={() => setView({ kind: 'thread', id: t.id })} data-testid="soshial-thread"
                  style={{
                    display: 'flex', gap: 8, width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', cursor: 'pointer', color: c('fg'),
                    background: t.unread ? `color-mix(in srgb, ${c('accent')} 9%, transparent)` : 'transparent',
                  }}>
                  <span aria-hidden="true" style={{ width: 8, height: 8, marginTop: 6, borderRadius: '50%', flexShrink: 0, background: t.unread ? c('accent') : 'transparent' }} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 13, display: 'block' }}>
                      {t.unread && <span style={srOnly}>New: </span>}
                      <strong>{t.other.name}</strong>{t.other.teacher && <TeacherTag name={t.other.name} />}
                      <span style={{ color: c('dim'), fontSize: 11 }}> · {t.className}</span>
                    </span>
                    {t.last && (
                      <span style={{ fontSize: 12, color: c('meta'), display: 'block', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: t.last.removed ? 'italic' : 'normal' }}>
                        {t.last.mine ? 'You: ' : ''}{t.last.removed ? 'Removed by a teacher' : t.last.snippet}
                      </span>
                    )}
                    {t.last && <span style={{ fontSize: 11, color: c('dim'), display: 'block', marginTop: 2 }}>{when(t.last.at)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
