// An envelope for your header: one count for messages AND your own notifications, and a dropdown with a
// Messages tab (the <Mailbox>) beside any notification tabs you pass in. soSHial has no notification
// store of its own: your app already knows what is news (a comment, a grade, a due date), so you hand
// each tab its count and what to show, and the envelope adds the counts up.
//
//   <MailboxButton client={client} tabs={[{ id: 'activity', label: 'Activity', count: n, render: () => <MyList /> }]} />

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { COUNT_POLL_MS, DEFAULT_LIMITS } from '../core';
import { createClient, type SoshialClient } from '../client';
import { Mailbox } from './Mailbox';
import { c } from './theme';

export interface NotificationTab {
  id: string;
  label: string;
  /** Unread items in this tab; added to the envelope's count. */
  count: number;
  /** What the tab shows. Called only while it is open. */
  render: () => ReactNode;
  /** Called when the dropdown opens, so the tab can fetch fresh items. */
  onOpen?: () => void;
}

export interface MailboxButtonProps {
  client?: SoshialClient;
  /** Your notification tabs, shown after Messages. */
  tabs?: NotificationTab[];
  /** Characters in one message, if you changed the server's `limits.messageMax`. */
  messageMax?: number;
  /** Where your full Messages page is (<MessagesPage>): the dropdown shows a button to open it. */
  fullPageHref?: string;
}

const Envelope = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </svg>
);

export function MailboxButton({ client: given, tabs = [], messageMax = DEFAULT_LIMITS.messageMax, fullPageHref }: MailboxButtonProps) {
  const client = useMemo(() => given ?? createClient(), [given]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('messages');
  const [mail, setMail] = useState(client.unread());
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const off = client.onUnread(setMail);
    void client.refreshCount();
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') void client.refreshCount(); }, COUNT_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void client.refreshCount(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { off(); window.clearInterval(poll); document.removeEventListener('visibilitychange', onVisible); };
  }, [client]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown, true); };
  }, [open]);

  const others = tabs.reduce((n, t) => n + Math.max(0, t.count), 0);
  const total = mail + others;
  const label = total ? `Messages and notifications, ${total} unread` : 'Messages and notifications';

  const toggle = () => {
    if (!open) {
      for (const t of tabs) t.onOpen?.();
      // Open on Messages unless only a notification tab has news.
      const news = tabs.find((t) => t.count > 0);
      setTab(mail === 0 && news ? news.id : 'messages');
    }
    setOpen((v) => !v);
  };

  const tabStyle = (on: boolean) => ({
    fontSize: 13, padding: '8px 4px', background: 'transparent', border: 'none', cursor: 'pointer',
    borderBottom: on ? `2px solid ${c('accent')}` : '2px solid transparent', color: on ? c('fg') : c('meta'), fontWeight: on ? 600 : 400,
  } as const);
  const badge = (n: number) => (n > 0 ? (
    <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '0 5px', borderRadius: 8, background: c('accent'), color: c('on-accent') }}>
      {n > 9 ? '9+' : n}
    </span>
  ) : null);
  const current = tabs.find((t) => t.id === tab);

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button ref={buttonRef} type="button" onClick={toggle} aria-label={label} aria-expanded={open} aria-haspopup="true"
        title="Messages and notifications" data-testid="soshial-button"
        style={{
          position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 34, height: 34, borderRadius: 6, cursor: 'pointer', color: 'inherit',
          background: open ? c('deep2') : 'transparent', border: '1px solid transparent',
        }}>
        <Envelope />
        {total > 0 && (
          <span aria-hidden="true" data-testid="soshial-count"
            style={{
              position: 'absolute', top: 1, right: 0, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
              background: c('accent'), color: c('on-accent'), fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
            }}>
            {total > 9 ? '9+' : total}
          </span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Messages and notifications" data-testid="soshial-panel"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 'min(400px, calc(100vw - 32px))',
            height: tab === 'messages' ? 'min(560px, 75vh)' : undefined, maxHeight: '75vh',
            display: 'flex', flexDirection: 'column', background: c('bg'), color: c('fg'),
            border: `1px solid ${c('line')}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)', zIndex: 1000,
          }}>
          {tabs.length > 0 && (
            <div role="tablist" aria-label="Mailbox" style={{ display: 'flex', gap: 16, padding: '0 12px', borderBottom: `1px solid ${c('line')}` }}>
              <button type="button" role="tab" aria-selected={tab === 'messages'} onClick={() => setTab('messages')} style={tabStyle(tab === 'messages')}>
                Messages{badge(mail)}
              </button>
              {tabs.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} style={tabStyle(tab === t.id)}>
                  {t.label}{badge(t.count)}
                </button>
              ))}
            </div>
          )}
          {tab === 'messages' || !current
            ? <Mailbox client={client} active={open} messageMax={messageMax} fullPageHref={fullPageHref} />
            : <div style={{ overflowY: 'auto', flex: 1 }}>{current.render()}</div>}
        </div>
      )}
    </div>
  );
}
