// The teacher's panel for one class: what students may send, for the whole class and for each student
// (On, Teacher only, Off; the stricter wins), and every conversation between two students and every
// group of the class, which the teacher can read and remove a message from (students then see "Removed
// by a teacher"; the words stay readable here, and Put back undoes it). Conversations between a student
// and a teacher are in the teacher's own mailbox, and so are the class's channels (where a teacher can
// lock, rename or delete them). Put it on your class page.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COUNT_POLL_MS, LEVEL_LABEL, type ClassOverview, type ClassThread, type MessageLevel } from '../core';
import { createClient, type SoshialClient } from '../client';
import { c, clock, smallButton, srOnly } from './theme';

export interface ClassMessagesProps {
  classId: string;
  client?: SoshialClient;
  /** Say what happened ("Paused Sam's messages…"); errors come with kind 'error'. Default: nothing. */
  onToast?: (message: string, kind?: 'info' | 'error') => void;
}

export function ClassMessages({ classId, client: given, onToast }: ClassMessagesProps) {
  const client = useMemo(() => given ?? createClient(), [given]);
  const toast = useCallback((m: string, kind?: 'info' | 'error') => onToast?.(m, kind), [onToast]);
  const [data, setData] = useState<ClassOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [thread, setThread] = useState<ClassThread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await client.classOverview(classId);
    if (r.ok) { setData(r.value); setError(null); } else setError(r.error);
  }, [client, classId]);
  // A teacher may leave the class page open all lesson: refresh every 30 s while the tab is visible, and
  // when it comes back into view, so new conversations and messages show up (the open one too).
  const openRef = useRef<string | null>(null);
  openRef.current = open;
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void load();
      const id = openRef.current;
      if (!id) return;
      void client.classThread(classId, id).then((r) => { if (r.ok && openRef.current === id) setThread(r.value); });
    };
    const timer = window.setInterval(refresh, COUNT_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [load, client, classId]);

  const act = async <T,>(body: Record<string, unknown>, done: (value: T) => string | null): Promise<boolean> => {
    setBusy(true);
    const r = await client.classAction<T>(classId, body);
    setBusy(false);
    if (!r.ok) { toast(r.error, 'error'); return false; }
    const said = done(r.value);
    if (said) toast(said, 'info');
    return true;
  };

  const view = async (id: string) => {
    if (open === id) { setOpen(null); setThread(null); return; }
    setOpen(id);
    setThread(null);
    setThreadError(null);
    const r = await client.classThread(classId, id);
    if (r.ok) setThread(r.value); else setThreadError(r.error);
  };

  if (error) return <p style={{ color: c('danger'), fontSize: 13 }}>{error}</p>;
  if (!data) return <p style={{ color: c('dim'), fontSize: 13 }}>Loading…</p>;

  const LEVEL_HELP: Record<MessageLevel, string> = {
    0: 'can message you and classmates, and post in groups and channels',
    1: 'can message you only',
    2: 'cannot send anything (they can still read)',
  };
  const levels = [0, 1, 2] as MessageLevel[];
  const limited = data.students.filter((s) => s.level > 0);
  const field = { fontSize: 13, padding: '3px 6px', borderRadius: 4, background: c('deep'), color: c('fg'), border: `1px solid ${c('line')}` } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, color: c('fg') }} data-testid="soshial-class">
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: c('meta'), maxWidth: '70ch' }}>
        Students can message you and their classmates, make groups and post in the class&rsquo;s channels. Messages with
        phone numbers, addresses or emails are refused. Every conversation between two students and every group is
        listed below, and students are told you can read them. Your own conversations, and the class&rsquo;s channels
        (where you can lock, rename or delete them), are in your mailbox.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label htmlFor={`soshial-level-${classId}`} style={{ fontSize: 13, fontWeight: 600 }}>Student messages in this class</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select id={`soshial-level-${classId}`} value={data.level} disabled={busy} data-testid="soshial-level" style={field}
            onChange={(e) => {
              const level = Number(e.target.value) as MessageLevel;
              setData((d) => (d ? { ...d, level, classmatesOn: level === 0 } : d)); // at once; a refusal reloads below
              void act<ClassOverview>({ action: 'class-level', level }, (v) => {
                setData(v);
                return `Student messages in this class: ${LEVEL_LABEL[level]}. Students ${LEVEL_HELP[level]}.`;
              }).then((ok) => { if (!ok) void load(); });
            }}>
            {levels.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
          </select>
          <span style={{ fontSize: 12, color: c('dim') }}>Students {LEVEL_HELP[data.level]}.</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>One student</div>
        <p style={{ margin: 0, fontSize: 12, color: c('dim'), maxWidth: '70ch' }}>
          Teacher only: they can message you, nothing else. Off: they cannot send anything, even to you. The stricter of
          this and the class setting is what counts.
        </p>
        {limited.length === 0 && <p style={{ margin: 0, fontSize: 13, color: c('dim') }}>Every student is On.</p>}
        {data.students.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
            {[...data.students].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name)).map((s) => (
              <li key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <label htmlFor={`soshial-student-${s.key}`} style={{ minWidth: 140 }}>{s.name}</label>
                <select id={`soshial-student-${s.key}`} value={s.level} disabled={busy} data-testid="soshial-student-level" style={field}
                  onChange={(e) => {
                    const level = Number(e.target.value) as MessageLevel;
                    void act<ClassOverview>({ action: 'student-level', student: s.key, level }, (v) => {
                      setData(v);
                      return level === 0 ? `${s.name}'s messages are On again.` : `${s.name}: ${LEVEL_LABEL[level]}. They ${LEVEL_HELP[level]}.`;
                    });
                  }}>
                  {levels.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                </select>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Conversations between students, and groups</div>
        {!data.threads.length && <p style={{ margin: 0, fontSize: 13, color: c('dim') }}>None yet.</p>}
        {data.threads.map((t) => (
          <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="soshial-class-thread">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, minWidth: 160, flex: 1 }}>
                {t.kind === 'group'
                  ? <><strong>{t.title}</strong> <span style={{ color: c('dim') }}>(group: {t.people.join(', ')})</span></>
                  : <strong>{t.people.join(' and ')}</strong>}{' '}
                <span style={{ color: c('dim') }}>· {t.count} {t.count === 1 ? 'message' : 'messages'} · last {clock(t.lastAt)}</span>
                {t.last && (
                  <div style={{ fontSize: 12, color: c('meta'), marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.last.author}: {t.last.removed ? <em>removed</em> : t.last.snippet}
                  </div>
                )}
              </div>
              <button type="button" style={smallButton} aria-expanded={open === t.id} onClick={() => void view(t.id)}>
                {open === t.id ? 'Hide' : 'Read'}
              </button>
            </div>
            {open === t.id && (
              threadError
                ? <p style={{ color: c('danger'), fontSize: 13, margin: 0 }}>{threadError}</p>
                : !thread
                  ? <p style={{ color: c('dim'), fontSize: 13, margin: 0 }}>Loading…</p>
                  : (
                    <ol aria-label={`Messages between ${t.people.join(' and ')}`}
                      style={{ listStyle: 'none', margin: 0, padding: '8px 10px', maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, background: c('bg'), border: `1px solid ${c('line')}`, borderRadius: 4 }}>
                      {thread.messages.map((m) => (
                        <li key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, color: c('dim') }}>
                              <strong style={{ color: c('meta') }}>{m.author}</strong> · {clock(m.at)}
                              {m.removed && <span style={{ color: c('warn') }}> · removed (students see &ldquo;Removed by a teacher&rdquo;)</span>}
                            </div>
                            <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: m.removed ? c('dim') : c('fg'), textDecoration: m.removed ? 'line-through' : 'none' }}>
                              {m.body}
                            </div>
                          </div>
                          <button type="button" style={smallButton} disabled={busy} data-testid="soshial-remove"
                            onClick={() => void act<{ thread: ClassThread }>({ action: m.removed ? 'restore' : 'remove', messageId: m.id }, (v) => {
                              setThread(v.thread);
                              void load();
                              return m.removed ? 'Put the message back.' : 'Removed the message. Students now see "Removed by a teacher".';
                            })}>
                            {m.removed ? 'Put back' : 'Remove'}
                          </button>
                        </li>
                      ))}
                    </ol>
                  )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
