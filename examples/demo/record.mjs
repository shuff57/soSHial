// Records docs/demo.mp4 (and the poster docs/demo.jpg): three browsers side by side (two students and
// their teacher) walking through soSHial on the demo app. Re-run with `npm run demo:record`.
//
// Needs playwright-core, a Chromium and ffmpeg. playwright-core is not a dependency of this repo, so
// point at one you have:
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core   (default: import 'playwright-core')
//   CHROME=/path/to/chrome-or-headless-shell                (default: playwright's own download)
//
// It starts its own demo server on PORT (default 4411) and stops it at the end. Waits are on real UI
// states, not fixed sleeps; any wait longer than a moment is cut out of the video afterwards, so a slow
// machine does not make a slow video. The pauses that remain are there so a viewer can read.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TMP = join(ROOT, '.tmp', 'demo-record');
const OUT = join(ROOT, 'docs', 'demo.mp4');
const POSTER = join(ROOT, 'docs', 'demo.jpg');
const PORT = Number(process.env.PORT) || 4411;
const BASE = `http://localhost:${PORT}`;
const W = 640;
const H = 760;
const LABEL_H = 40;
const CAPTION_H = 52;
const T = 90_000; // generous: the machine this was made on was very busy

const pw = process.env.PLAYWRIGHT_CORE
  ? createRequire(pathToFileURL(join(process.env.PLAYWRIGHT_CORE, 'package.json')))(process.env.PLAYWRIGHT_CORE)
  : (await import('playwright-core')).default;

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(join(ROOT, 'docs'), { recursive: true });

// ---- the demo server --------------------------------------------------------------------------------
const server = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), ['examples/demo/server.ts'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('demo server did not start')), 120_000);
  server.stdout.on('data', (b) => { if (String(b).includes('soSHial demo:')) { clearTimeout(timer); resolve(); } });
  server.on('exit', (code) => reject(new Error(`demo server exited (${code})`)));
});

let browser;
const stopAll = async () => {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
};
process.on('SIGINT', () => { void stopAll().then(() => process.exit(130)); });

// ---- a visible cursor (recordings have none) -------------------------------------------------------
const CURSOR = () => {
  const add = () => {
    const dot = document.createElement('div');
    dot.id = '__cursor';
    Object.assign(dot.style, {
      position: 'fixed', left: '-40px', top: '-40px', width: '22px', height: '22px', margin: '-11px 0 0 -11px',
      borderRadius: '50%', background: 'rgba(239, 68, 68, 0.35)', border: '2px solid rgba(220, 38, 38, 0.9)',
      zIndex: '2147483647', pointerEvents: 'none', transition: 'transform 120ms ease-out',
    });
    document.documentElement.appendChild(dot);
    addEventListener('mousemove', (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    addEventListener('mousedown', () => { dot.style.transform = 'scale(0.6)'; dot.style.background = 'rgba(220, 38, 38, 0.7)'; }, true);
    addEventListener('mouseup', () => { dot.style.transform = 'scale(1)'; dot.style.background = 'rgba(239, 68, 68, 0.35)'; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add); else add();
};

// ---- timeline: when each thing happened, and which waits to cut ---------------------------------
const cuts = []; // [start, end] in seconds since t0, removed from the video
const captions = []; // { at, text } in seconds since t0
let t0 = 0;
const now = () => (Date.now() - t0) / 1000;
const caption = (text) => captions.push({ at: now(), text });

/** Wait for a real state; if it took more than a moment, cut the dead part out of the video. */
async function until(promise) {
  const a = now();
  await promise;
  const b = now();
  if (b - a > 0.9) cuts.push([a + 0.3, b - 0.3]);
}
const hold = (page, ms) => page.waitForTimeout(ms);

async function click(page, locator) {
  await until(locator.waitFor({ state: 'visible', timeout: T }));
  await locator.scrollIntoViewIfNeeded({ timeout: T });
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await hold(page, 180);
  await page.mouse.down();
  await hold(page, 90);
  await page.mouse.up();
  await hold(page, 250);
}
async function type(page, text) {
  const box = page.getByTestId('soshial-compose');
  await until(box.waitFor({ state: 'visible', timeout: T }));
  await box.pressSequentially(text, { delay: 38 });
  await hold(page, 350);
}

// ---- the three browsers ------------------------------------------------------------------------------
browser = await pw.chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--disable-gpu'] });

async function person(name, userId, label, init) {
  const dir = join(TMP, name);
  const context = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 1,
    recordVideo: { dir, size: { width: W, height: H } },
  });
  context.setDefaultTimeout(T);
  await context.addCookies([{ name: 'demo_user', value: userId, url: BASE }]);
  await context.addInitScript(CURSOR);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const created = Date.now();
  return { name, label, page, context, dir, created };
}

const sam = await person('sam', 'u-sam', 'Student: Sam');
// Alex has already seen the demo's fake Activity item, so their envelope counts only the message.
const alex = await person('alex', 'u-alex', 'Student: Alex', () => { try { localStorage.setItem('demo-activity-seen:u-alex', '1'); } catch {} });
const teacher = await person('teacher', 'u-rivera', 'Teacher: Ms Rivera');
const all = [sam, alex, teacher];

await Promise.all(all.map((p) => p.page.goto(BASE, { timeout: T })));
await Promise.all(all.map((p) => p.page.getByTestId('soshial-button').waitFor({ timeout: T })));
await teacher.page.getByTestId('soshial-class').waitFor({ timeout: T });
// Park each cursor somewhere neutral.
for (const p of all) await p.page.mouse.move(W / 2, H - 120);

t0 = Math.max(...all.map((p) => p.created));
// Everything before this point (page loads) is cut.
cuts.push([0, Math.max(0, now() - 0.4)]);

try {
  const s = sam.page;
  const a = alex.page;
  const t = teacher.page;

  // 1. Sam: one envelope for messages and the app's own notifications.
  caption('One envelope: messages, plus the app\'s own notifications.');
  await hold(s, 500);
  await click(s, s.getByTestId('soshial-button'));
  await until(s.getByText('commented on your').waitFor({ timeout: T }));
  await hold(s, 1500);
  await click(s, s.getByRole('tab', { name: /Messages/ }));
  await hold(s, 400);

  // 2. Sam writes to a classmate.
  caption('Sam writes to a classmate.');
  await click(s, s.getByTestId('soshial-new'));
  await click(s, s.getByTestId('soshial-person').filter({ hasText: 'Alex B.' }));
  await type(s, 'Hi Alex! Did you finish the loops lab?');
  await click(s, s.getByTestId('soshial-send'));
  await until(s.getByTestId('soshial-message').first().waitFor({ timeout: T }));
  await until(s.getByTestId('soshial-watched').waitFor({ timeout: T }));
  await hold(s, 1400);

  // 3. Alex sees the count and replies.
  caption('Alex sees the new message and replies.');
  await a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await until(a.getByTestId('soshial-count').waitFor({ timeout: T }));
  await hold(a, 1000);
  await click(a, a.getByTestId('soshial-button'));
  await click(a, a.locator('[data-testid=soshial-thread][data-kind=students]').first());
  await until(a.getByTestId('soshial-message').first().waitFor({ timeout: T }));
  await hold(a, 600);
  await type(a, 'Almost! Jordan\'s code looks like spaghetti lol');
  await click(a, a.getByTestId('soshial-send'));
  await until(a.getByTestId('soshial-message').nth(1).waitFor({ timeout: T }));
  await hold(a, 900);

  // 3b. Channels: every class has #general, and anyone can add one.
  caption('Every class has channels, and anyone can add one.');
  await click(s, s.getByRole('button', { name: 'Back to all messages' }));
  await click(s, s.getByTestId('soshial-new-channel'));
  await s.getByTestId('soshial-channel-name').pressSequentially('Loop help', { delay: 45 });
  await click(s, s.getByTestId('soshial-channel-create'));
  await until(s.getByTestId('soshial-title').filter({ hasText: '#loop-help' }).waitFor({ timeout: T }));
  await type(s, 'How do I space the circles out?');
  await click(s, s.getByTestId('soshial-send'));
  await until(s.getByTestId('soshial-message').first().waitFor({ timeout: T }));
  await hold(s, 900);

  // 3c. Group chats, and the full Messages page.
  caption('Group chats too, and a full Messages page.');
  await click(s, s.getByRole('button', { name: 'Back to all messages' }));
  await click(s, s.getByTestId('soshial-new-group'));
  await s.getByTestId('soshial-group-title').pressSequentially('Circle crew', { delay: 45 });
  await click(s, s.locator('label').filter({ hasText: /Alex/ }).getByTestId('soshial-group-person'));
  await click(s, s.getByTestId('soshial-group-create'));
  await until(s.getByTestId('soshial-title').filter({ hasText: 'Circle crew' }).waitFor({ timeout: T }));
  await type(s, 'Want to split the loops lab?');
  await click(s, s.getByTestId('soshial-send'));
  await until(s.getByTestId('soshial-message').first().waitFor({ timeout: T }));
  await until(a.goto(`${BASE}/?view=messages`, { timeout: T }));
  await until(a.getByTestId('soshial-page').waitFor({ timeout: T }));
  await a.mouse.move(W / 2, H - 120);
  await click(a, a.locator('[data-testid=soshial-thread][data-kind=channel]').filter({ hasText: 'loop-help' }));
  await until(a.getByTestId('soshial-message').filter({ hasText: 'space the circles' }).waitFor({ timeout: T }));
  await type(a, 'Add i * 30 to x each time round.');
  await click(a, a.getByTestId('soshial-send'));
  await until(a.getByTestId('soshial-message').filter({ hasText: 'i * 30' }).waitFor({ timeout: T }));
  await hold(a, 1200);

  // 4. Sam tries to share a phone number.
  caption('A message with a phone number is refused, in plain words.');
  await click(s, s.getByRole('button', { name: 'Back to all messages' }));
  await click(s, s.locator('[data-testid=soshial-thread][data-kind=students]').first());
  await until(s.getByTestId('soshial-message').nth(1).waitFor({ timeout: T }));
  await hold(s, 700);
  await type(s, 'Want to work on it tonight? Text me at 555-201-3344');
  await click(s, s.getByTestId('soshial-send'));
  await until(s.getByRole('alert').waitFor({ timeout: T }));
  await hold(s, 3800);

  // 5. The teacher reads the conversation and removes a message.
  caption('Ms Rivera reads conversations between students and removes a message.');
  await click(t, t.getByTestId('demo-refresh'));
  const row = t.getByTestId('soshial-class-thread').filter({ hasText: 'spaghetti' }).first();
  await click(t, row.getByRole('button', { name: 'Read' }));
  const unkind = t.locator('li').filter({ hasText: 'spaghetti' });
  await until(unkind.waitFor({ timeout: T }));
  await hold(t, 1300);
  await click(t, unkind.getByTestId('soshial-remove'));
  await until(t.getByText('removed (students see').waitFor({ timeout: T }));
  await hold(t, 1800);

  // 6. ...and turns messages between classmates off for the class.
  caption('She sets messages in the class to Teacher only.');
  await click(t, t.getByTestId('soshial-level'));
  await t.getByTestId('soshial-level').selectOption('1');
  await until(t.getByText('Student messages in this class: Teacher only').waitFor({ timeout: T }));
  await hold(t, 1500);

  // 7. Sam sees both.
  caption('Sam sees "Removed by a teacher", and that the class is set to teacher only.');
  await click(s, s.getByRole('button', { name: 'Back to all messages' }));
  await click(s, s.locator('[data-testid=soshial-thread][data-kind=students]').first());
  await until(s.getByTestId('soshial-closed').waitFor({ timeout: T }));
  await until(s.getByText('Removed by a teacher').first().waitFor({ timeout: T }));
  await hold(s, 4200);
} catch (e) {
  for (const p of all) await p.page.screenshot({ path: join(TMP, `fail-${p.name}.png`) }).catch(() => {});
  await stopAll();
  throw e;
}

const end = now();
for (const p of all) await p.context.close();
await stopAll();

// ---- compose -----------------------------------------------------------------------------------------
const videos = all.map((p) => {
  const f = readdirSync(p.dir).find((x) => x.endsWith('.webm'));
  return { ...p, file: join(p.dir, f), offset: (t0 - p.created) / 1000 };
});

// Merge overlapping cuts; map an original time to its time in the cut video.
const merged = cuts.filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0])
  .reduce((out, c) => { const last = out[out.length - 1]; if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]); else out.push([...c]); return out; }, []);
const mapT = (t) => t - merged.reduce((n, [x, y]) => n + Math.max(0, Math.min(t, y) - x), 0);
const keep = merged.map(([x, y]) => `between(t,${x.toFixed(3)},${y.toFixed(3)})`).join('+') || '0';

const font = (() => {
  try { return execFileSync('fc-match', ['-f', '%{file}', 'Liberation Sans:bold']).toString().trim(); } catch { return ''; }
})();
const fontOpt = font ? `fontfile='${font}':` : '';

const parts = [];
videos.forEach((v, i) => {
  const labelFile = join(TMP, `label-${v.name}.txt`);
  writeFileSync(labelFile, v.label);
  parts.push(
    `[${i}:v]trim=start=${v.offset.toFixed(3)},setpts=PTS-STARTPTS,fps=25,` +
    `scale=${W}:${H},pad=${W}:${H + LABEL_H}:0:${LABEL_H}:color=0x1f2937,` +
    `drawtext=${fontOpt}textfile='${labelFile}':fontcolor=white:fontsize=20:x=(w-text_w)/2:y=(${LABEL_H}-text_h)/2` +
    (i < videos.length - 1 ? `,pad=${W + 4}:ih:0:0:color=0x111827` : '') + `[v${i}]`,
  );
});
let graph = parts.join(';') + `;${videos.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${videos.length},` +
  `trim=end=${end.toFixed(3)},select='not(${keep})',setpts=N/25/TB,pad=iw:ih+${CAPTION_H}:0:0:color=0x111827`;
captions.forEach((c, i) => {
  const from = mapT(c.at);
  const to = i + 1 < captions.length ? mapT(captions[i + 1].at) : 1e6;
  const f = join(TMP, `caption-${i}.txt`);
  writeFileSync(f, c.text);
  graph += `,drawtext=${fontOpt}textfile='${f}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=h-${CAPTION_H}+(${CAPTION_H}-text_h)/2:enable='between(t,${from.toFixed(2)},${to.toFixed(2)})'`;
});
// A busy machine stretches the clicks and the typing; play it back fast enough to fit in TARGET seconds.
const TARGET = 55;
const speed = Math.max(1, mapT(end) / TARGET);
if (speed > 1.001) graph += `,setpts=PTS/${speed.toFixed(4)},fps=25`;
graph += '[out]';

// H.264 either way: libx264 when this ffmpeg has it, else libopenh264 (what some distributions ship).
const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString();
const h264 = /\blibx264\b/.test(encoders)
  ? ['-c:v', 'libx264', '-preset', 'slow', '-crf', '30']
  : ['-c:v', 'libopenh264', '-b:v', '520k', '-maxrate', '900k'];
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  ...videos.flatMap((v) => ['-i', v.file]),
  '-filter_complex', graph, '-map', '[out]',
  '-an', ...h264, '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  OUT,
], { stdio: 'inherit' });

const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT]).toString());
// Poster: the last moment, where all three panes tell the whole story.
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, duration - 1)), '-i', OUT, '-frames:v', '1', '-q:v', '4', POSTER]);
console.log(`wrote ${OUT}: ${duration.toFixed(1)} s, ${(statSync(OUT).size / 1e6).toFixed(2)} MB; poster ${POSTER}`);
console.log(`played at ${speed.toFixed(2)}x`);
console.log(`cut ${merged.reduce((n, [x, y]) => n + (y - x), 0).toFixed(1)} s of waiting`);
