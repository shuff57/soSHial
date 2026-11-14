// Every colour the components use is a CSS variable with a dark default, so a page restyles soSHial
// by setting --soshial-* on any ancestor (light theme example in the README).

const DEFAULTS = {
  bg: '#282a36',        // panel background
  deep: '#21222c',      // inputs, the note strip
  deep2: '#343746',     // other person's bubbles
  fg: '#f8f8f2',        // text
  meta: '#a9b1d6',      // secondary text
  dim: '#8393c4',       // quiet text (4.7:1 on bg)
  line: '#44475a',      // borders
  accent: '#8be9fd',    // badges, your bubbles, Send
  'on-accent': '#1e1f29',
  link: '#8be9fd',      // small buttons
  teacher: '#bd93f9',   // the Teacher tag
  danger: '#ff5555',    // errors
  warn: '#ffb86c',      // "removed" on the teacher panel
} as const;

export type ThemeToken = keyof typeof DEFAULTS;

/** `var(--soshial-<token>, <default>)`. */
export function c(token: ThemeToken): string {
  return `var(--soshial-${token}, ${DEFAULTS[token]})`;
}

/** Text only screen readers hear. */
export const srOnly = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
} as const;

export const smallButton = {
  fontSize: 12, padding: '3px 8px', borderRadius: 4, background: 'transparent', cursor: 'pointer',
  border: `1px solid ${c('line')}`, color: c('link'),
} as const;

export function when(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} d ago`;
  return new Date(ms).toLocaleDateString();
}

export function clock(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}
