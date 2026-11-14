// Stand-in for your app's sign-in. Replace with the code that reads your session cookie.
// NEVER trust a user id the browser sends: this example refuses everything until you wire it up.

import type { Session } from '../src';

export async function getSession(_request: Request, _env: unknown): Promise<Session | null> {
  return null;
}
