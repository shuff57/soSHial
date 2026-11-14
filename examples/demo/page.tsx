// The demo page: a header with the envelope and a "You are" picker, a stand-in for the class's lesson,
// and, for the teacher, the class page with <ClassMessages>. Bundled by server.ts at startup.

import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClassMessages, MailboxButton, MessagesPage, createClient, type NotificationTab } from '../../src/react';
import type { DemoBoot } from './people';

declare global {
  interface Window { __DEMO__: DemoBoot }
}

const boot = window.__DEMO__;
const client = createClient('/api/soshial');

/** Per-browser memory for the fake Activity item. Storage can be blocked; the demo works without it. */
function seen(key: string, set?: true): boolean {
  try {
    if (set) localStorage.setItem(key, '1');
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function ActivityList({ onSeen }: { onSeen: () => void }) {
  useEffect(onSeen, [onSeen]);
  return (
    <ul className="activity">
      <li>
        <strong>Ms Rivera</strong> commented on your <em>Loops lab</em>
        <span>&ldquo;Nice start. Try a for loop for step 3.&rdquo; · 1 h ago</span>
      </li>
    </ul>
  );
}

function YouAre() {
  return (
    <label className="you-are">
      You are
      <select
        value={boot.me ?? ''}
        data-testid="demo-you-are"
        onChange={(e) => {
          // DEMO ONLY: the browser picks who it is signed in as. A real app takes this from its sign-in.
          document.cookie = `demo_user=${encodeURIComponent(e.target.value)}; path=/; SameSite=Lax`;
          location.reload();
        }}
      >
        {boot.people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
    </label>
  );
}

function Toast({ toast }: { toast: { text: string; kind?: 'info' | 'error'; n: number } | null }) {
  if (!toast) return null;
  return <div key={toast.n} className={`toast ${toast.kind === 'error' ? 'error' : ''}`} role="status">{toast.text}</div>;
}

function ClassPage() {
  const [toast, setToast] = useState<{ text: string; kind?: 'info' | 'error'; n: number } | null>(null);
  const [version, setVersion] = useState(0);
  const onToast = useCallback((text: string, kind?: 'info' | 'error') => setToast((t) => ({ text, kind, n: (t?.n ?? 0) + 1 })), []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);
  // <ClassMessages> loads once; reload it when the tab comes back so a returning teacher sees new conversations.
  useEffect(() => {
    const on = () => { if (document.visibilityState === 'visible') setVersion((v) => v + 1); };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Class page · {boot.className}</h2>
        <button type="button" className="quiet" onClick={() => setVersion((v) => v + 1)} data-testid="demo-refresh">Refresh</button>
      </div>
      <ClassMessages key={version} client={client} classId={boot.classId} onToast={onToast} />
      <Toast toast={toast} />
    </section>
  );
}

function Lesson() {
  return (
    <section className="card">
      <h2>Today in {boot.className}</h2>
      <p className="lede">Loops lab: draw a row of ten circles with a <code>for</code> loop.</p>
      <ol className="steps">
        <li>Draw one circle.</li>
        <li>Put it inside a loop that runs ten times.</li>
        <li>Move each circle a little to the right.</li>
      </ol>
      <p className="hint">Stuck? Use the envelope at the top to message your teacher or a classmate.</p>
    </section>
  );
}

function App() {
  const me = boot.people.find((p) => p.id === boot.me) ?? null;
  // /?view=messages: the full Messages page (<MessagesPage>), linked from the envelope's dropdown.
  const fullPage = new URLSearchParams(window.location.search).get('view') === 'messages';
  const activityKey = `demo-activity-seen:${boot.me ?? ''}`;
  const [activity, setActivity] = useState(seen(activityKey) ? 0 : 1);
  const markSeen = useCallback(() => { seen(activityKey, true); setActivity(0); }, [activityKey]);
  const tabs: NotificationTab[] = useMemo(() => (me?.role === 'student'
    ? [{ id: 'activity', label: 'Activity', count: activity, render: () => <ActivityList onSeen={markSeen} /> }]
    : []), [me, activity, markSeen]);

  return (
    <>
      <header className="top">
        <div className="brand"><span className="logo" aria-hidden="true">s</span> Classroom</div>
        <YouAre />
        <div className="spacer" />
        {me && <span className="who">{me.label.replace(/ \(.*\)$/, '')}</span>}
        <MailboxButton client={client} tabs={tabs} fullPageHref="/?view=messages" />
      </header>
      <main>
        {!me && <p>Pick who you are above.</p>}
        {me && fullPage
          ? <><p><a href="/">Back to the class</a></p><MessagesPage client={client} /></>
          : me?.role === 'teacher' ? <ClassPage /> : me ? <Lesson /> : null}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
