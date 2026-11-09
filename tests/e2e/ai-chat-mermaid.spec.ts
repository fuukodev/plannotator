/**
 * AI answers used to show Mermaid as code. Guard the three real rendering paths,
 * their host adapters and real Mermaid SVGs in Chromium. The package fixture
 * controls transport state; it does not replace Markdown, sanitization or engines.
 * Document and Review also get compiled-binary smoke tests with only /api/ai/*
 * intercepted, following annotate-ai-history.spec.ts. Review uses a static patch,
 * so no repository, commit, agent, GitHub CLI or Inbox process is needed.
 *
 * Completion: safe ordinary Markdown/HTML, streamed close versus final EOF,
 * stopped partial answers, independent repeated diagrams, stable SVG nodes when
 * prose appends, readable syntax failures, theme colours and a 280px chat column.
 * The Inbox coverage mounts ChatTranscript with its real UI adapter and compiled
 * Inbox stylesheet; it does not exercise Inbox Ask transport or app caller wiring.
 *
 * Reuse fresh review/hook/Inbox build artifacts and PLANNOTATOR_E2E_BINARY.
 * Run through test:sandbox, or Playwright with a local config that sets Chromium's
 * executablePath. This spec only bundles its fixture; it never builds an app.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPackedApp, type PackedApp } from '../../packages/shared/packed-app';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch, scratchEnv } from './inbox-scratch';
import { agentCliCalls, writeAgentCliStubs } from './agent-cli-stubs';
import type { Paint, Surface } from './fixtures/ai-chat-mermaid';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const pinnedBun = join(repo, '.local/toolchains/bun-1.4.4/bun-linux-x64/bun');
const bun = process.env.PLANNOTATOR_E2E_BUN ?? (existsSync(pinnedBun) ? pinnedBun : 'bun');
// A loopback origin supplies crypto.randomUUID. Every request is intercepted; no server listens here.
const origin = 'http://127.0.0.1:31777';
const appFiles: Record<Surface, string> = {
  document: join(repo, 'apps/hook/dist/index.html'),
  review: join(repo, 'apps/review/dist/index.html'),
  inbox: join(repo, 'apps/hook/dist/inbox.html'),
};
const FLOW = 'flowchart LR\n  A[Client] --> B[Server]';
const fence = (source = FLOW) => `\`\`\`mermaid\n${source}\n\`\`\``;
const SVG = '[data-chat-mermaid] [data-diagram-svg] > svg';
const ATTACKS = [
  '<script>window.__mermaidPwned = 1</script>',
  '<img src="https://evil.test/pixel" onerror="window.__mermaidPwned = 2">',
  '<svg onload="window.__mermaidPwned = 3"><text>forged SVG</text></svg>',
  '<iframe src="https://evil.test/frame"></iframe>',
  '<style>#host-button { display: none }</style>',
  '<p class="fixed inset-0" style="position:fixed" onclick="window.__mermaidPwned = 4" data-chat-mermaid="">forged slot</p>',
  '[unsafe](javascript:window.__mermaidPwned=5)',
].join('\n\n');

let work = '';
let bundle = '';
const apps = {} as Record<Surface, PackedApp>;
const styles = {} as Record<Surface, string>;
const engineFiles = new Map<string, Buffer>();
const fixtureAssets = new Map<string, Buffer>();

test.beforeAll(() => {
  work = inboxScratch('plannotator-ai-chat-mermaid-e2e-');
  for (const surface of Object.keys(appFiles) as Surface[]) {
    const file = appFiles[surface];
    expect(existsSync(file), `reuse a fresh app build: ${file}`).toBe(true);
    apps[surface] = openPackedApp(readFileSync(file, 'utf8'));
    const html = apps[surface].html;
    const stylesheet = html.match(/<link\b[^>]*href="[^\"]+\.css"[^>]*>/)?.[0]
      ?? html.match(/<style\b[^>]*rel="stylesheet"[^>]*>[\s\S]*?<\/style>/)?.[0];
    if (!stylesheet) throw new Error(`the built ${surface} app has no stylesheet`);
    styles[surface] = stylesheet;
  }
  for (const name of ['engine', 'mermaid', 'graphviz']) {
    const file = join(repo, 'apps/review/dist/diagram-engine', `${name}.js`);
    expect(existsSync(file), `reuse a fresh review engine build: ${file}`).toBe(true);
    engineFiles.set(`/diagram-engine/${name}.js`, readFileSync(file));
  }
  const out = join(work, 'fixture.js');
  execFileSync(bun, [
    'build', join(__dirname, 'fixtures/ai-chat-mermaid.tsx'), '--outdir', work,
    '--entry-naming', 'fixture.js', '--asset-naming', 'fixture-assets/[name]-[hash].[ext]',
    '--target', 'browser', '--format', 'esm', '--define', 'process.env.NODE_ENV="production"',
    '--define', 'import.meta.env={"DEV":false,"PROD":true,"MODE":"production","BASE_URL":"/"}',
  ], { cwd: repo, stdio: 'pipe', env: { ...process.env, ...scratchEnv(work), NO_BROWSER, PLANNOTATOR_TEST_SANDBOX: work } });
  bundle = readFileSync(out, 'utf8');
  const assets = join(work, 'fixture-assets');
  if (existsSync(assets)) {
    for (const name of readdirSync(assets)) fixtureAssets.set(`/fixture-assets/${name}`, readFileSync(join(assets, name)));
  }
});

test.afterAll(async () => {
  if (work) await removeInboxScratch(work);
});

function observe(page: Page) {
  const seen = { errors: [] as string[], hostileRequests: [] as string[], dialogs: 0 };
  page.on('pageerror', error => seen.errors.push(error.message));
  page.on('dialog', dialog => { seen.dialogs += 1; void dialog.dismiss(); });
  page.on('request', request => {
    if (new URL(request.url()).hostname === 'evil.test') seen.hostileRequests.push(request.url());
  });
  return seen;
}

async function openFixture(page: Page, surface: Surface) {
  const seen = observe(page);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/assets/')) {
      const asset = await apps[surface].answer(url.pathname, 'GET', null, false);
      return route.fulfill({ status: asset.status, headers: asset.headers, body: asset.body });
    }
    const fixtureAsset = fixtureAssets.get(url.pathname);
    if (fixtureAsset) return route.fulfill({ contentType: 'application/octet-stream', body: fixtureAsset });
    const engine = engineFiles.get(url.pathname);
    if (engine) return route.fulfill({ contentType: 'text/javascript', body: engine });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
      ${styles[surface]}
      <style>
        body { margin: 0; padding: 16px; background: var(--background); color: var(--foreground) }
        #mount { width: 420px; max-width: 100%; min-width: 0 }
        #fixture-controls { margin-bottom: 12px }
        #subject { display: flex; flex-direction: column; height: 700px; min-width: 0 }
        #host-button { position: fixed; right: 8px; top: 8px }
      </style></head><body><button id="host-button">Host</button><div id="mount"></div>
      <script type="module" src="/fixture.js"></script></body></html>` });
  });
  await page.goto(`${origin}/fixture/${surface}`);
  expect(seen.errors, 'the real component fixture must initialize').toEqual([]);
  await expect(page.getByRole('button', { name: 'Switch to light' })).toBeVisible();
  const body = surface === 'inbox'
    ? page.locator('#subject [data-text-part][data-message-role="assistant"]')
    : page.locator('#subject .ai-markdown');
  return { body, seen };
}

const show = (page: Page, next: Paint) => page.evaluate(paint => window.__mermaidChat.show(paint), next);

async function expectRealDiagram(body: Locator, count = 1) {
  const diagrams = body.locator(SVG);
  try {
    await expect(diagrams).toHaveCount(count);
  } catch (error) {
    console.error('Chat DOM at diagram failure:', await body.evaluateAll(nodes => nodes.map(node => node.outerHTML.slice(0, 12000))));
    throw error;
  }
  for (let at = 0; at < count; at += 1) {
    await expect(diagrams.nth(at)).toBeVisible();
    // A real flowchart has laid-out nodes and an edge, not just an SVG shell or an icon.
    expect(await diagrams.nth(at).evaluate(svg => {
      const box = (svg as SVGSVGElement).getBBox();
      return { nodes: svg.querySelectorAll('g.node').length, edges: svg.querySelectorAll('path.flowchart-link').length, width: box.width, height: box.height };
    })).toMatchObject({ nodes: 2, edges: 1, width: expect.any(Number), height: expect.any(Number) });
    const box = await diagrams.nth(at).boundingBox();
    expect(box!.width).toBeGreaterThan(20);
    expect(box!.height).toBeGreaterThan(20);
  }
}

async function expectSafe(body: Locator, page: Page) {
  const unsafe = await body.evaluate(root => Array.from(root.querySelectorAll('*')).filter(element => {
    if (element.closest('[data-chat-mermaid]')) return false;
    return /^(SCRIPT|IMG|SVG|IFRAME|OBJECT|EMBED|STYLE|LINK|FORM)$/.test(element.tagName)
      || element.getAttributeNames().some(name => /^(on|style$|class$|data-)/i.test(name))
      || /^\s*(javascript|data):/i.test(element.getAttribute('href') ?? '');
  }).map(element => element.outerHTML));
  expect(unsafe).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __mermaidPwned?: number }).__mermaidPwned)).toBeUndefined();
}

for (const surface of ['document', 'review', 'inbox'] as const) {
  test.describe(`${surface} chat component`, () => {
    test('renders real Mermaid beside ordinary Markdown while hostile HTML stays inert', async ({ page }) => {
      const { body, seen } = await openFixture(page, surface);
      const ordinary = '**Reason** with `inline code`.\n\n- one item\n\n```html\n<svg onload="window.__mermaidPwned=6"></svg>\n```';
      await show(page, { text: `${ordinary}\n\n${ATTACKS}\n\n${fence()}\n`, userText: `${ATTACKS}\n\n${fence()}` });
      await expectRealDiagram(body);
      await expect(body.locator('strong')).toHaveText('Reason');
      await expect(body.locator('li')).toHaveText('one item');
      await expect(body.locator('pre > code').first()).toContainText('<svg onload=');
      await expect(body.locator('[data-chat-mermaid]')).toHaveCount(1);
      await expectSafe(body, page);
      if (surface === 'inbox') {
        await expect(page.locator('[data-text-part][data-message-role="user"] [data-chat-mermaid], [data-text-part][data-message-role="user"] svg')).toHaveCount(0);
        await expect(page.locator('[data-text-part][data-message-role="user"]')).toContainText('<script>');
      }
      await expect(page.getByRole('button', { name: 'Host', exact: true })).toBeVisible();
      expect(seen).toEqual({ errors: [], hostileRequests: [], dialogs: 0 });
    });

    test('waits for the streaming close and preserves independent SVGs as prose appends', async ({ page }) => {
      const { body, seen } = await openFixture(page, surface);
      const open = `\`\`\`mermaid\n${FLOW}\n`;
      await show(page, { text: open, streaming: true });
      await expect(body.locator('pre > code')).toContainText(FLOW);
      await expect(body.locator('[data-chat-mermaid]')).toHaveCount(0);
      await show(page, { text: `${open}\`\`\``, streaming: true });
      await expect(body.locator('[data-chat-mermaid]')).toHaveCount(0);
      await show(page, { text: `${fence()}\n`, streaming: true });
      await expectRealDiagram(body);
      const first = await body.locator(SVG).elementHandle();
      const text = `${fence()}\n\n${fence()}\n\nAdded **body**.\n`;
      await show(page, { text, streaming: true });
      await expectRealDiagram(body, 2);
      const second = await body.locator(SVG).nth(1).elementHandle();
      expect(await body.locator(SVG).first().evaluate((svg, original) => svg === original && original.isConnected, first)).toBe(true);
      expect(await body.locator(SVG).evaluateAll(svgs => new Set(svgs.map(svg => svg.id)).size)).toBe(2);
      await expect(body.locator('strong')).toHaveText('body');
      await show(page, { text: `${text}\nFinal paragraph.`, streaming: false });
      expect(await body.locator(SVG).first().evaluate((svg, original) => svg === original && original.isConnected, first)).toBe(true);
      expect(await body.locator(SVG).nth(1).evaluate((svg, original) => svg === original && original.isConnected, second)).toBe(true);
      await first!.dispose();
      await second!.dispose();
      expect(seen.errors).toEqual([]);
    });

    test('accepts a final EOF close and a stopped close but keeps an unclosed fence as code', async ({ page }) => {
      const { body } = await openFixture(page, surface);
      await show(page, { id: 'final', text: fence(), streaming: true });
      await expect(body.locator('[data-chat-mermaid]')).toHaveCount(0);
      await show(page, { id: 'final', text: fence() });
      await expectRealDiagram(body);
      await show(page, { id: 'stopped', text: fence(), streaming: true });
      await expect(body.locator('[data-chat-mermaid]')).toHaveCount(0);
      await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
      await expectRealDiagram(body);
      if (surface === 'inbox') await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
      await show(page, { id: 'already-drawn', text: `${fence()}\n`, streaming: true });
      await expectRealDiagram(body);
      const painted = await body.locator(SVG).elementHandle();
      await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
      expect(await body.locator(SVG).evaluate((svg, original) => svg === original && original.isConnected, painted)).toBe(true);
      await painted!.dispose();
      await show(page, { id: 'unclosed', text: `\`\`\`mermaid\n${FLOW}`, partStreaming: true, status: 'error' });
      await expect(body.locator('[data-chat-mermaid]')).toHaveCount(0);
      await expect(body.locator('pre > code')).toContainText(FLOW);
    });

    test('keeps invalid Mermaid source readable and still renders the next valid fence', async ({ page }) => {
      const { body, seen } = await openFixture(page, surface);
      const invalid = 'flowchart LR\n  A[broken --> B\n  <script>window.__mermaidPwned=7</script>';
      await show(page, { text: `${fence(invalid)}\n\nStill **readable**.\n\n${fence()}\n` });
      await expectRealDiagram(body);
      const failed = body.locator('[data-chat-mermaid]').first();
      await expect(failed.locator('pre > code')).toHaveText(invalid);
      await expect(failed.locator('[data-diagram-pending]')).toHaveCount(0);
      await expect(failed.locator('[data-diagram-svg] > svg')).toHaveCount(0);
      await expect(body.locator('strong')).toHaveText('readable');
      await expectSafe(body, page);
      expect(seen).toEqual({ errors: [], hostileRequests: [], dialogs: 0 });
    });

    test('keeps labels and controls inside a narrow column and follows the host theme', async ({ page }) => {
      const { body, seen } = await openFixture(page, surface);
      await page.locator('#mount').evaluate(element => { element.style.width = '280px'; });
      await show(page, { text: `Before **diagram**.\n\n${fence()}\n\nAfter diagram.` });
      await expectRealDiagram(body);
      const block = body.locator('[data-chat-mermaid]');
      const nodeFill = () => body.locator(`${SVG} g.node rect`).first().evaluate(node => getComputedStyle(node).fill);
      const darkFill = await nodeFill();
      const label = block.locator('span.nodeLabel p').first();
      await expect(label).toBeVisible();
      // Generic chat paragraph/pre rules must leave trusted diagram labels and source controls alone.
      await expect(label).toHaveCSS('margin-bottom', '0px');
      await expect(block.locator('[data-diagram-canvas]')).toHaveCSS('overflow-x', 'hidden');
      const overflow = await block.evaluate(element => {
        const host = document.getElementById('mount')!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return { left: box.left - host.left, right: box.right - host.right, page: document.documentElement.scrollWidth - innerWidth };
      });
      expect(overflow.left).toBeGreaterThanOrEqual(-1);
      expect(overflow.right).toBeLessThanOrEqual(1);
      expect(overflow.page).toBeLessThanOrEqual(1);
      await page.getByRole('button', { name: 'Switch to light' }).click();
      await expect(page.locator('html')).toHaveClass(/\blight\b/);
      await expect.poll(nodeFill).not.toBe(darkFill);
      await expectRealDiagram(body);
      await expect(label).toHaveCSS('margin-bottom', '0px');
      await block.hover();
      await block.getByRole('button', { name: 'Show source', exact: true }).click();
      await expect(block.locator('pre > code')).toHaveText(FLOW);
      await expect(block.locator('pre')).toHaveCSS('padding-top', '16px');
      await block.getByRole('button', { name: 'Show diagram', exact: true }).click();
      await expectRealDiagram(body);
      expect(seen.errors).toEqual([]);
    });
  });
}

const FIRST_RUN: Record<string, string> = {
  'plannotator-plan-look-choice-resolved': 'true',
  'plannotator-look-feel-announcement-seen': '2',
  'plannotator-vim-mode-announcement-seen': '2',
  'plannotator-permission-mode-configured': 'true',
  'plannotator-plan-ai-announcement-seen': '1',
  'plannotator-edit-mode-announcement-seen': '3',
  'plannotator-guide-intro-seen': '2',
  'plannotator-review-dest-spotlight-seen': '1',
  'plannotator-auto-viewed-notice-seen': '1',
  'plannotator-token-hover-announcement-seen': '1',
  'plannotator-announce-tui-herdr-seen': '1',
  'plannotator-announce-inbox-seen': '1',
  'plannotator-announce-ask-session-seen': '1',
  'plannotator-announce-agent-tool-seen': '1',
};

/** Only AI transport is faked. The binary still serves the real app and engine. */
async function fakeAI(page: Page, answer: string) {
  const queries: unknown[] = [];
  await page.route('**/api/ai/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/capabilities')) {
      return route.fulfill({ json: { available: true, defaultProvider: 'test', providers: [{ id: 'test', name: 'test', capabilities: {}, models: [{ id: 'one', label: 'One' }] }] } });
    }
    if (path.endsWith('/session')) return route.fulfill({ json: { sessionId: 'mermaid-fixture' } });
    if (path.endsWith('/query')) {
      queries.push(route.request().postDataJSON());
      const body = [{ type: 'text_delta', delta: answer }, { type: 'result', result: answer }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
      return route.fulfill({ contentType: 'text/event-stream', body });
    }
    return route.fulfill({ json: {} });
  });
  return queries;
}

async function stopApp(child: ChildProcess | undefined, url: string | undefined, root: string) {
  if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    // inbox-guard: own child (only this spec's annotate/review CLI, never an Inbox).
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise<void>(done => setTimeout(done, 5_000))]);
  }
  await removeInboxScratch(root);
}

for (const surface of ['document', 'review'] as const) {
  test(`${surface} compiled app wires Ask AI to its Mermaid adapter`, async ({ page }) => {
    expect(existsSync(binary), `reuse a freshly compiled binary: ${binary}`).toBe(true);
    const root = inboxScratch(`plannotator-${surface}-chat-mermaid-`);
    const ready = join(root, 'ready.jsonl');
    // Review discovers model lists at startup. Its own stubs keep those probes
    // away from both the runner's tripwire and every installed agent CLI.
    const agentBin = writeAgentCliStubs(join(root, 'bin'));
    let child: ChildProcess | undefined;
    let url: string | undefined;
    try {
      const target = join(root, surface === 'document' ? 'document.md' : 'change.patch');
      writeFileSync(target, surface === 'document'
        ? '# Mermaid browser fixture\n\nAsk about this document.\n'
        : 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const before = 1;\n+export const after = 2;\n');
      child = spawn(binary, surface === 'document' ? ['annotate', target] : ['review', '--patch-file', target], {
        cwd: root, stdio: 'ignore', env: {
          PATH: agentBin, ...scratchEnv(root), NO_BROWSER,
          PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_READY_FILE: ready,
          PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0',
          PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_GIT_REMOTE_CHECK: '0',
        },
      });
      await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '', { timeout: 30_000 }).toContain('"url"');
      url = JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url;
      await page.context().addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url: url! })));
      const seen = observe(page);
      await page.route('https://evil.test/**', route => route.abort());
      const queries = await fakeAI(page, `An **answer**.\n\n${ATTACKS}\n\n${fence()}`);
      await page.goto(url!);
      const chat = surface === 'document'
        ? page.getByRole('button', { name: 'Show AI chat', exact: true })
        : page.getByRole('button', { name: 'AI Chat', exact: true });
      await chat.click();
      const input = page.getByPlaceholder(surface === 'document' ? 'Ask about this document...' : 'Ask about the overall changes...');
      await input.fill('Draw a Mermaid flowchart');
      await input.press('ControlOrMeta+Enter');
      const body = page.locator('[data-question-id] .ai-markdown');
      await expectRealDiagram(body);
      await expect(body.locator('strong')).toHaveText('answer');
      await expect(body.locator('[data-chat-mermaid]')).toHaveCount(1);
      await expectSafe(body, page);
      expect(queries).toHaveLength(1);
      expect(seen).toEqual({ errors: [], hostileRequests: [], dialogs: 0 });
      const modelProbe = /^(cursor-agent models|opencode models|pi --list-models|copilot help config)$/;
      expect(agentCliCalls(agentBin).filter(call => !modelProbe.test(call))).toEqual([]);
    } finally {
      await stopApp(child, url, root);
    }
  });
}
