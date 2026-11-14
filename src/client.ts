// The page's side of soSHial: the calls the React components make, and the unread count they share.
// createClient(base) once; the components take it as a prop (or make their own with the default base).

import type { ClassOverview, ClassThread, PeopleClass, ThreadSummary, ThreadView } from './core';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

/** The message to show for a failed request: the server's {"error": "..."} when there is one. */
async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch { /* not JSON */ }
  return `Something went wrong (HTTP ${res.status}).`;
}

export function createClient(base = '/api/soshial') {
  const root = base.replace(/\/$/, '');
  let unread = 0;
  const listeners = new Set<(n: number) => void>();
  const setUnread = (n: number) => {
    if (n === unread) return;
    unread = n;
    for (const l of listeners) l(n);
  };

  async function ask<T>(path: string, init?: RequestInit): Promise<Result<T>> {
    let res: Response;
    try {
      res = await fetch(root + path, { credentials: 'same-origin', cache: 'no-store', ...init });
    } catch {
      return { ok: false, error: 'Could not reach the server. Check your connection and try again.', status: 0 };
    }
    if (!res.ok) return { ok: false, error: await errorText(res), status: res.status };
    return { ok: true, value: (await res.json()) as T };
  }
  const post = (body: unknown): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  return {
    /** The last unread count heard, and a way to hear when it changes. */
    unread: () => unread,
    onUnread(fn: (n: number) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },

    async refreshCount(): Promise<number> {
      const r = await ask<{ unread: number }>('/messages?count=1');
      if (r.ok) setUnread(r.value.unread);
      return unread;
    },
    async threads(): Promise<Result<ThreadSummary[]>> {
      const r = await ask<{ threads: ThreadSummary[]; unread: number }>('/messages');
      if (!r.ok) return r;
      setUnread(r.value.unread);
      return { ok: true, value: r.value.threads };
    },
    async thread(id: string): Promise<Result<ThreadView>> {
      const r = await ask<ThreadView>(`/messages/${encodeURIComponent(id)}`);
      if (r.ok) void this.refreshCount(); // opening it marked it read
      return r;
    },
    async people(): Promise<Result<PeopleClass[]>> {
      const r = await ask<{ classes: PeopleClass[] }>('/messages?people=1');
      return r.ok ? { ok: true, value: r.value.classes } : r;
    },
    sendNew(classId: string, to: string, body: string) { return ask<ThreadView>('/messages', post({ classId, to, body })); },
    reply(threadId: string, body: string) { return ask<ThreadView>(`/messages/${encodeURIComponent(threadId)}`, post({ body })); },

    // The teacher panel.
    classOverview(classId: string) { return ask<ClassOverview>(`/classes/${encodeURIComponent(classId)}/messages`); },
    async classThread(classId: string, threadId: string): Promise<Result<ClassThread>> {
      const r = await ask<{ thread: ClassThread }>(`/classes/${encodeURIComponent(classId)}/messages?thread=${encodeURIComponent(threadId)}`);
      return r.ok ? { ok: true, value: r.value.thread } : r;
    },
    classAction<T = ClassOverview>(classId: string, body: Record<string, unknown>) {
      return ask<T>(`/classes/${encodeURIComponent(classId)}/messages`, post(body));
    },
  };
}

export type SoshialClient = ReturnType<typeof createClient>;
