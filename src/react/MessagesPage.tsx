// A full Messages page, Discord-style: the list on the left (each class's channels, groups, two-person
// conversations), the open conversation on the right. ?c=<id> opens one conversation, so a link can point
// at it. On a narrow screen the two take turns. Put it on a page of its own (e.g. /messages) and pass the
// same href to <MailboxButton fullPageHref> so the dropdown links to it.

import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_LIMITS, isId } from '../core';
import type { SoshialClient } from '../client';
import { ConversationList, NewButtons, NewThing, SoshialProvider, ThreadPane, useThreads, type MailView } from './Mailbox';
import { c } from './theme';

export interface MessagesPageProps {
  client?: SoshialClient;
  messageMax?: number;
  /** Under the list: your own links (help, your issue tracker, ...). */
  footer?: ReactNode;
  /** The page's height. Default: the window less 170 px, at least 420 px. */
  height?: string;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 760px)');
    const on = () => setNarrow(q.matches);
    on();
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return narrow;
}

function Page({ footer, height }: { footer?: ReactNode; height: string }) {
  const [view, setView] = useState<MailView>({ kind: 'list' });
  const { threads, error, reload } = useThreads(true);
  const narrow = useNarrow();

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('c');
    if (isId(id)) setView({ kind: 'thread', id });
  }, []);
  // Keep ?c= in step with what is open, so a reload or a copied link opens the same conversation.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view.kind === 'thread') url.searchParams.set('c', view.id); else url.searchParams.delete('c');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, [view]);

  const open = (id: string) => setView({ kind: 'thread', id });
  const toList = () => { setView({ kind: 'list' }); reload(); };
  const showList = !narrow || view.kind === 'list';
  const showPane = !narrow || view.kind !== 'list';

  return (
    <div data-testid="soshial-page"
      style={{
        display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(240px, 300px) 1fr', height, minHeight: 420,
        border: `1px solid ${c('line')}`, borderRadius: 8, overflow: 'hidden', background: c('bg'), color: c('fg'),
      }}>
      {showList && (
        <aside style={{ display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: narrow ? 'none' : `1px solid ${c('line')}`, background: c('deep') }}>
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${c('line')}` }}><NewButtons onPick={setView} /></div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            <ConversationList threads={threads} error={error} selected={view.kind === 'thread' ? view.id : null} onOpen={open} />
          </div>
          {footer && <div style={{ padding: '10px 12px', borderTop: `1px solid ${c('line')}`, fontSize: 13 }}>{footer}</div>}
        </aside>
      )}
      {showPane && (
        <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }} aria-label="Conversation">
          {view.kind === 'thread'
            ? <ThreadPane key={view.id} id={view.id} onBack={narrow ? toList : undefined} onGone={toList} onChanged={reload} />
            : view.kind !== 'list'
              ? <NewThing view={view} onBack={toList} onOpen={(id) => { reload(); open(id); }} />
              : <p style={{ margin: 'auto', fontSize: 14, color: c('dim'), textAlign: 'center', padding: 24 }}>
                  Pick a channel, group or conversation on the left, or start a new one.
                </p>}
        </section>
      )}
    </div>
  );
}

export function MessagesPage({ client, messageMax = DEFAULT_LIMITS.messageMax, footer, height = 'calc(100vh - 170px)' }: MessagesPageProps) {
  return (
    <SoshialProvider client={client} messageMax={messageMax}>
      <Page footer={footer} height={height} />
    </SoshialProvider>
  );
}
