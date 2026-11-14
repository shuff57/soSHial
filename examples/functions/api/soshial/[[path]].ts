// One catch-all Cloudflare Pages Function for every soSHial route (/api/soshial/*).
// `getSession` is yours: read your session cookie and return { userId } (or null when signed out).

import { createSoshial, type Db, type Session } from '../../../../src';
import { sqlDirectory } from '../../../sql-directory';
import { getSession } from '../../../session';

interface Env {
  DB: Db;
}

export const onRequest = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  const session: Session | null = await getSession(request, env);
  const soshial = createSoshial({ db: env.DB, directory: sqlDirectory(env.DB) });
  return (await soshial.handle(request, session)) ?? new Response('Not found', { status: 404 });
};
