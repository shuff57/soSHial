// A zero-config local demo of soSHial: one Node process, an in-memory SQLite, one seeded class and a
// small React page. `npm run demo`, then open http://localhost:4400.
//
//   PORT=4400 (default)   the port to listen on
//
// Everything here is throwaway: the database lives in memory and is gone when the process stops.

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSoshial, type Db, type DbStatement, type Session } from '../../src';
import { sqlDirectory } from '../sql-directory';
import { CLASS_ID, CLASS_NAME, PEOPLE, type DemoBoot } from './people';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const PORT = Number(process.env.PORT) || 4400;

// ---- the database: node:sqlite behind the part of D1's API soSHial uses ----------------------------

const sqlite = new DatabaseSync(':memory:');
for (const f of ['migrations/0001_soshial.sql', 'migrations/0002_groups_channels.sql', 'examples/schema.sql']) sqlite.exec(readFileSync(root(f), 'utf8'));

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

// ---- seed: one class, one teacher, three students (all fictional) ----------------------------------

const insertUser = sqlite.prepare(`INSERT INTO users (id, first_name, last_name) VALUES (?, ?, ?)`);
const enroll = sqlite.prepare(`INSERT INTO enrollments (class_id, user_id, role) VALUES (?, ?, ?)`);
sqlite.prepare(`INSERT INTO classes (id, name) VALUES (?, ?)`).run(CLASS_ID, CLASS_NAME);
for (const p of PEOPLE) {
  insertUser.run(p.id, p.first, p.last);
  enroll.run(CLASS_ID, p.id, p.role);
}

const soshial = createSoshial({ db, directory: sqlDirectory(db) });

// ---- the session ------------------------------------------------------------------------------------

// DEMO ONLY: the signed-in person is whoever the `demo_user` cookie names, and the browser picks it.
// Never trust a client-chosen id in a real app: take the user id from your own signed-in session.
function sessionOf(req: IncomingMessage): Session | null {
  const cookie = req.headers.cookie ?? '';
  const m = /(?:^|;\s*)demo_user=([^;]+)/.exec(cookie);
  const id = m ? decodeURIComponent(m[1]) : PEOPLE[0].id;
  return PEOPLE.some((p) => p.id === id) ? { userId: id } : null;
}

// ---- the page ---------------------------------------------------------------------------------------

const bundle = await build({
  entryPoints: [root('examples/demo/page.tsx')],
  bundle: true,
  write: false,
  format: 'esm',
  minify: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const appJs = bundle.outputFiles[0].text;

function pageHtml(session: Session | null): string {
  const boot: DemoBoot = {
    me: session?.userId ?? null,
    classId: CLASS_ID,
    className: CLASS_NAME,
    people: PEOPLE.map(({ id, label, role }) => ({ id, label, role })),
  };
  // The boot data is our own constants; escape '<' anyway so it can never close the script tag.
  const json = JSON.stringify(boot).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>soSHial demo</title>
<link rel="stylesheet" href="/demo.css">
</head>
<body>
<div id="root"></div>
<script>window.__DEMO__ = ${json};</script>
<script type="module" src="/app.js"></script>
</body>
</html>`;
}

// ---- Node http <-> Fetch ----------------------------------------------------------------------------

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const method = req.method ?? 'GET';
  return new Request(`http://localhost:${PORT}${req.url ?? '/'}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

const text = (body: string, type: string) => new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const session = sessionOf(req);
    if (path.startsWith('/api/soshial/')) {
      const r = await soshial.handle(await toRequest(req), session);
      return await send(res, r ?? new Response('Not found', { status: 404 }));
    }
    if (path === '/' || path === '/index.html') return await send(res, text(pageHtml(session), 'text/html; charset=utf-8'));
    if (path === '/app.js') return await send(res, text(appJs, 'text/javascript; charset=utf-8'));
    if (path === '/demo.css') return await send(res, text(readFileSync(root('examples/demo/demo.css'), 'utf8'), 'text/css; charset=utf-8'));
    return await send(res, new Response('Not found', { status: 404 }));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`soSHial demo: http://localhost:${PORT}`);
  console.log(`  ${CLASS_NAME}: ${PEOPLE.map((p) => p.label).join(', ')}. Pick who you are at the top of the page.`);
});
