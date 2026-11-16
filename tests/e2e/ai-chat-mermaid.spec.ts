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
 * Successful diagrams also keep their frame, SVG, viewport and source scroll
 * through ten source round trips, without even transient rendering placeholders.
 * Hidden layers leave the accessibility tree and keyboard order. Theme and
 * source changes still reach the real renderer while the source is open.
 * Document source printing expands long code without clipping and restores the
 * screen frame and a valid diagram after print emulation.
 * The Inbox coverage mounts ChatTranscript with its real UI adapter and compiled
 * Inbox stylesheet; it does not exercise Inbox Ask transport or app caller wiring.
 *
 * Reuse fresh review/hook/Inbox build artifacts and PLANNOTATOR_E2E_BINARY.
 * Run through test:sandbox, or Playwright with a local config that sets Chromium's
 * executablePath. This spec only bundles its fixture; it never builds an app.
 * For manual review, PLANNOTATOR_E2E_PROOF_DIR enables light-mode Chinese-flow
 * source/diagram PNGs under ai-chat-mermaid-toggle/, only after the document
 * compiled-app smoke passes. With no proof directory this spec writes no PNGs.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const PROOF_FLOW = 'flowchart LR\n  A[用户请求] --> B[参数校验]\n  B --> C[模型调用]\n  C --> D[返回响应]';
const proofDir = process.env.PLANNOTATOR_E2E_PROOF_DIR
  ? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR), 'ai-chat-mermaid-toggle')
  : undefined;
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

async function expectRealDiagram(body: Locator, count = 1, nodes = 2) {
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
    })).toMatchObject({ nodes, edges: nodes - 1, width: expect.any(Number), height: expect.any(Number) });
    const box = await diagrams.nth(at).boundingBox();
    expect(box!.width).toBeGreaterThan(20);
    expect(box!.height).toBeGreaterThan(20);
  }
}

/** Watch the whole successful-mode interval, including nodes added and removed in one task. */
async function watchModeSwitches(block: Locator) {
  return block.evaluateHandle(root => {
    const frame = root.querySelector<HTMLElement>('[data-diagram-inline]')!;
    const svg = root.querySelector<SVGSVGElement>('[data-diagram-svg] > svg')!;
    const source = root.querySelector<HTMLElement>('pre')!;
    const button = root.querySelector<HTMLButtonElement>('button[aria-label="Show source"]')!;
    const wrapper = svg.parentElement!;
    const transform = wrapper.style.transform;
    const skin = () => {
      const css = getComputedStyle(frame);
      return [css.backgroundColor, css.borderColor, css.borderWidth, css.borderStyle, css.borderRadius];
    };
    const geometry = () => {
      const box = frame.getBoundingClientRect();
      const mode = button.getBoundingClientRect();
      return [box.width, box.height, mode.left - box.left, mode.top - box.top, mode.width, mode.height];
    };
    const baseline = { skin: skin(), geometry: geometry() };
    const violations = new Set<string>();
    let samples = 0;
    let mutations = 0;
    let raf = 0;
    let stopped = false;
    const pending = '[data-diagram-pending], [data-mermaid-pending], [data-diagram-fallback]';
    const rendering = /\bRendering\s+(?:diagram|Mermaid)\b/i;
    const inspect = (node: Node) => {
      if (node instanceof Element && (node.matches(pending) || node.querySelector(pending))) violations.add('rendering placeholder appeared');
      if (rendering.test(node.textContent ?? '')) violations.add('rendering status appeared');
    };
    const sample = () => {
      samples += 1;
      for (const [name, element] of [['frame', frame], ['SVG', svg], ['source', source], ['mode button', button]] as const) {
        if (!element.isConnected || !root.contains(element)) violations.add(`${name} disconnected`);
      }
      if (root.querySelector('[data-diagram-svg] > svg') !== svg) violations.add('SVG node changed');
      if (wrapper.style.transform !== transform) violations.add('zoom or pan changed');
      if (skin().some((value, at) => value !== baseline.skin[at])) violations.add('frame background, border or radius changed');
      geometry().forEach((value, at) => {
        if (Math.abs(value - baseline.geometry[at]!) > 1) violations.add(`frame or button geometry changed at ${at}: ${value} versus ${baseline.geometry[at]}`);
      });
      const mode = button.getBoundingClientRect();
      for (const other of root.querySelectorAll('button')) {
        const box = other.getBoundingClientRect();
        if (getComputedStyle(other).visibility !== 'hidden' && Math.abs(box.top - mode.top) <= 1 && box.right > mode.right + 1) {
          violations.add('mode button left the right edge of its toolbar');
        }
      }
      inspect(root);
    };
    const consume = (records: MutationRecord[]) => {
      mutations += records.length;
      for (const record of records) {
        if (record.type === 'attributes' && /^data-(?:diagram-pending|mermaid-pending|diagram-fallback)$/.test(record.attributeName!)) {
          violations.add('rendering placeholder attribute changed');
        }
        if (record.type === 'characterData' && rendering.test(record.oldValue ?? '')) violations.add('transient rendering status appeared');
        for (const node of record.addedNodes) inspect(node);
        // Inspect the removed tree too: querying the final DOM misses a one-task pending flash.
        for (const node of record.removedNodes) {
          inspect(node);
          for (const element of [frame, svg, source, button]) {
            if (node === element || node.contains(element)) violations.add('a retained frame, SVG, source or mode button was removed');
          }
        }
      }
      sample();
    };
    const observer = new MutationObserver(consume);
    observer.observe(document.getElementById('subject')!, {
      subtree: true, childList: true, attributes: true, attributeOldValue: true,
      characterData: true, characterDataOldValue: true,
    });
    const resize = new ResizeObserver(sample);
    resize.observe(frame);
    const tick = () => { sample(); raf = requestAnimationFrame(tick); };
    tick();
    return {
      baseline,
      stop() {
        if (!stopped) {
          stopped = true;
          consume(observer.takeRecords());
          observer.disconnect();
          resize.disconnect();
          cancelAnimationFrame(raf);
        }
        return { samples, mutations, violations: [...violations] };
      },
    };
  });
}

/** Traverse a complete Tab cycle so hidden canvas controls or source scrolling cannot take focus. */
async function expectActiveLayerTabOrder(page: Page, block: Locator, sourceActive: boolean) {
  const toggle = block.getByRole('button', { name: sourceActive ? 'Show diagram' : 'Show source', exact: true });
  await toggle.focus();
  const limit = await page.locator('button, a[href], input, textarea, select, [tabindex]').count() + 2;
  let reachedActive = false;
  let returnedToToggle = false;
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    const focus = await block.evaluate((root, sourceActive) => {
      const active = document.activeElement;
      const source = root.querySelector('pre')!;
      const canvas = root.querySelector('[data-diagram-canvas]')!;
      const withinSource = source === active || source.contains(active);
      const withinCanvas = canvas === active || canvas.contains(active);
      return {
        inactive: sourceActive ? withinCanvas : withinSource,
        active: sourceActive ? withinSource : withinCanvas,
        toggle: active?.getAttribute('aria-label') === (sourceActive ? 'Show diagram' : 'Show source'),
      };
    }, sourceActive);
    expect(focus.inactive, 'Tab must skip the inactive diagram layer').toBe(false);
    reachedActive ||= focus.active;
    if (focus.toggle) { returnedToToggle = true; break; }
  }
  expect(reachedActive, 'Tab must reach the active canvas or source scroll area').toBe(true);
  expect(returnedToToggle, 'Tab must complete a focus cycle').toBe(true);
}

async function expectSourceMode(block: Locator, sourceActive: boolean) {
  await expect(block.getByRole('button', { name: sourceActive ? 'Show diagram' : 'Show source', exact: true })).toBeVisible();
  await expect(block.getByRole('code')).toHaveCount(sourceActive ? 1 : 0);
  await expect(block.getByRole('group', { name: 'Zoom', exact: true })).toHaveCount(sourceActive ? 0 : 1);
  if (sourceActive) {
    await expect(block.locator('pre')).toBeVisible();
    await expect(block.locator('[data-diagram-canvas]')).toBeHidden();
  } else {
    await expect(block.locator('pre')).toBeHidden();
    await expect(block.locator('[data-diagram-canvas]')).toBeVisible();
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

    test('preserves the successful frame, SVG, viewport and source scroll through ten source round trips', async ({ page }) => {
      const { body, seen } = await openFixture(page, surface);
      await page.locator('#mount').evaluate(element => { element.style.width = '280px'; });
      // Comments make both source axes overflow without inflating the rendered two-node diagram.
      const source = `${FLOW}\n${Array.from({ length: 48 }, (_, line) => `  %% ${line + 1} ${'long source comment '.repeat(18)}`).join('\n')}`;
      await show(page, { text: fence(source) });
      await expectRealDiagram(body);
      await page.evaluate(() => document.fonts.ready.then(() => {}));
      const block = body.locator('[data-chat-mermaid]');
      const pre = block.locator('pre');
      await expect(pre).toHaveCount(1);
      const canvas = block.locator('[data-diagram-canvas]');
      const viewport = () => block.locator('[data-diagram-svg]').evaluate(element => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return { x: matrix.e, y: matrix.f, scale: matrix.a };
      });
      await canvas.focus();
      const fit = await viewport();
      await canvas.press('+');
      await expect.poll(async () => (await viewport()).scale).toBeGreaterThan(fit.scale);
      const zoomed = await viewport();
      await canvas.press('ArrowRight');
      await canvas.press('ArrowDown');
      await expect.poll(async () => (await viewport()).x).not.toBe(zoomed.x);
      await expect.poll(async () => (await viewport()).y).not.toBe(zoomed.y);
      const audit = await watchModeSwitches(block);
      try {
        const baseline = await audit.evaluate(watcher => watcher.baseline);
        expect(baseline.skin[0], 'the shared frame has a background').not.toMatch(/^(?:transparent|rgba\(0, 0, 0, 0\))$/);
        expect(baseline.skin.slice(2, 4)).toEqual(['1px', 'solid']);
        expect(parseFloat(baseline.skin[4]!), 'the shared frame follows the host rounded theme').toBeGreaterThan(0);
        let scroll = { left: 0, top: 0 };
        for (let round = 0; round < 10; round += 1) {
          await block.getByRole('button', { name: 'Show source', exact: true }).click();
          await expectSourceMode(block, true);
          if (round === 0) {
            await expect(pre).toHaveCSS('padding-top', '16px');
            await expect(pre).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await expect(pre).toHaveCSS('border-top-width', '0px');
            await expect(pre).toHaveCSS('border-radius', '0px');
            const code = block.getByRole('code');
            await expect(code).toHaveCSS('padding', '0px');
            await expect(code).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await expect(code).toHaveCSS('white-space', 'pre');
            scroll = await pre.evaluate(element => {
              element.scrollTo({
                left: (element.scrollWidth - element.clientWidth) / 2,
                top: (element.scrollHeight - element.clientHeight) / 2,
                behavior: 'instant',
              });
              return { left: element.scrollLeft, top: element.scrollTop };
            });
            expect(scroll.left, 'long source scrolls horizontally inside the frame').toBeGreaterThan(50);
            expect(scroll.top, 'long source scrolls vertically inside the frame').toBeGreaterThan(50);
            await expectActiveLayerTabOrder(page, block, true);
          }
          expect(await pre.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop })), 'source scroll survives a reopen').toEqual(scroll);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 'source must not widen the page').toBeLessThanOrEqual(1);
          await block.getByRole('button', { name: 'Show diagram', exact: true }).click();
          await expectSourceMode(block, false);
          if (round === 0) await expectActiveLayerTabOrder(page, block, false);
        }
        const report = await audit.evaluate(watcher => watcher.stop());
        expect(report.mutations, 'the observer covered actual mode changes').toBeGreaterThan(0);
        expect(report.samples).toBeGreaterThan(20);
        expect(report.violations).toEqual([]);
        await expectRealDiagram(body);
        expect(seen.errors).toEqual([]);
      } finally {
        await audit.evaluate(watcher => watcher.stop());
        await audit.dispose();
      }
    });

    test('renders theme and source changes made while source is open', async ({ page }) => {
      const { body, seen } = await openFixture(page, surface);
      await show(page, { text: fence() });
      await expectRealDiagram(body);
      const block = body.locator('[data-chat-mermaid]');
      const nodeFill = () => block.locator('[data-diagram-svg] > svg g.node rect').first().evaluate(node => getComputedStyle(node).fill);
      const darkFill = await nodeFill();
      await block.getByRole('button', { name: 'Show source', exact: true }).click();
      await expectSourceMode(block, true);
      await page.getByRole('button', { name: 'Switch to light', exact: true }).click();
      await expect(page.locator('html')).toHaveClass(/\blight\b/);
      await expect.poll(nodeFill).not.toBe(darkFill);
      await expectSourceMode(block, true);
      const lightFill = await nodeFill();
      await block.getByRole('button', { name: 'Show diagram', exact: true }).click();
      await expectRealDiagram(body);
      expect(await nodeFill()).toBe(lightFill);
      const previous = await block.locator('[data-diagram-svg] > svg').elementHandle();
      try {
        await block.getByRole('button', { name: 'Show source', exact: true }).click();
        await expectSourceMode(block, true);
        const updated = 'flowchart LR\n  A[Gateway] --> B[Database]';
        await show(page, { text: fence(updated) });
        // The chat bridge intentionally resets a fence subtree when its source changes.
        // Either initial mode is valid, but the old SVG must never stand in for the new result.
        const next = block.locator('[data-diagram-svg] > svg');
        await expect(next).toHaveCount(1);
        await expect(next.locator('g.node')).toHaveText([/Gateway/, /Database/]);
        const returnToDiagram = block.getByRole('button', { name: 'Show diagram', exact: true });
        if (await returnToDiagram.count()) await returnToDiagram.click();
        await expectRealDiagram(body);
        expect(await next.evaluate((svg, old) => svg !== old && svg.isConnected && !old!.isConnected, previous)).toBe(true);
        expect(await nodeFill()).toBe(lightFill);
        expect(seen.errors).toEqual([]);
      } finally {
        await previous!.dispose();
      }
    });

    if (surface === 'document') test('prints long source without clipping and restores the screen frame', async ({ page }) => {
      const { body, seen } = await openFixture(page, surface);
      await page.getByRole('button', { name: 'Switch to light', exact: true }).click();
      await expect(page.locator('html')).toHaveClass(/\blight\b/);
      const source = `${FLOW}\n${Array.from({ length: 48 }, (_, line) => `  %% ${line + 1} ${'print every source line '.repeat(14)}`).join('\n')}`;
      await show(page, { text: fence(source) });
      await expectRealDiagram(body);
      const block = body.locator('[data-chat-mermaid]');
      const frame = block.locator('[data-diagram-inline]');
      const pre = block.locator('pre');
      await block.getByRole('button', { name: 'Show source', exact: true }).click();
      await expectSourceMode(block, true);
      const screenBox = await frame.boundingBox();
      const scroll = await pre.evaluate(element => {
        element.scrollTo({ left: 150, top: 200, behavior: 'instant' });
        const styles = (node: Element) => {
          const css = getComputedStyle(node);
          return {
            whiteSpace: css.whiteSpace, overflow: css.overflow,
            overflowX: css.overflowX, overflowY: css.overflowY, scrollBehavior: css.scrollBehavior,
          };
        };
        return {
          left: element.scrollLeft, top: element.scrollTop,
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
          scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
          pre: styles(element), code: styles(element.querySelector('code')!),
        };
      });
      const scrollProbe = `screen source scroll: ${JSON.stringify(scroll)}`;
      expect(scroll.left, scrollProbe).toBeGreaterThan(50);
      expect(scroll.top, scrollProbe).toBeGreaterThan(50);
      try {
        await page.emulateMedia({ media: 'print' });
        await expect(pre).toBeVisible();
        await expect(block.locator('[data-diagram-canvas]')).toBeHidden();
        await expect(block.getByRole('button', { name: 'Show diagram', exact: true })).toBeHidden();
        const printed = await pre.evaluate(element => {
          const box = element.getBoundingClientRect();
          const frame = element.closest('[data-diagram-inline]')!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element.querySelector('code')!);
          const text = range.getBoundingClientRect();
          return {
            height: box.height,
            overflowX: element.scrollWidth - element.clientWidth,
            overflowY: element.scrollHeight - element.clientHeight,
            clipped: text.left < box.left - 1 || text.right > box.right + 1
              || text.top < box.top - 1 || text.bottom > box.bottom + 1
              || box.left < frame.left - 1 || box.right > frame.right + 1
              || box.top < frame.top - 1 || box.bottom > frame.bottom + 1,
          };
        });
        expect(printed.height, 'paper expands the full source beyond the screen frame').toBeGreaterThan(screenBox!.height + 50);
        expect(printed.overflowX, 'paper wraps long source lines').toBeLessThanOrEqual(1);
        expect(printed.overflowY, 'paper contains every source line without scrolling').toBeLessThanOrEqual(1);
        expect(printed.clipped, 'the printed frame and source contain all source text').toBe(false);
      } finally {
        await page.emulateMedia({ media: 'screen' });
      }
      await expectSourceMode(block, true);
      const restored = await frame.boundingBox();
      expect(Math.abs(restored!.width - screenBox!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(restored!.height - screenBox!.height)).toBeLessThanOrEqual(1);
      await block.getByRole('button', { name: 'Show diagram', exact: true }).click();
      await expectRealDiagram(body);
      expect(seen.errors).toEqual([]);
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
    const manualReview = surface === 'document' && !!proofDir;
    let proof: { source: Buffer; diagram: Buffer } | undefined;
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
      // The proof uses the app's real theme and panel-width preferences (600px is its resize maximum).
      const cookies = { ...FIRST_RUN, ...(manualReview ? { 'plannotator-theme': 'light', 'plannotator-panel-width': '600' } : {}) };
      await page.context().addCookies(Object.entries(cookies).map(([name, value]) => ({ name, value, url: url! })));
      const seen = observe(page);
      await page.route('https://evil.test/**', route => route.abort());
      const queries = await fakeAI(page, `An **answer**.\n\n${ATTACKS}\n\n${fence(manualReview ? PROOF_FLOW : FLOW)}`);
      await page.goto(url!);
      const chat = surface === 'document'
        ? page.getByRole('button', { name: 'Show AI chat', exact: true })
        : page.getByRole('button', { name: 'AI Chat', exact: true });
      await chat.click();
      const input = page.getByPlaceholder(surface === 'document' ? 'Ask about this document...' : 'Ask about the overall changes...');
      await input.fill('Draw a Mermaid flowchart');
      await input.press('ControlOrMeta+Enter');
      const body = page.locator('[data-question-id] .ai-markdown');
      await expectRealDiagram(body, 1, manualReview ? 4 : 2);
      await expect(body.locator('strong')).toHaveText('answer');
      await expect(body.locator('[data-chat-mermaid]')).toHaveCount(1);
      await expectSafe(body, page);
      expect(queries).toHaveLength(1);
      expect(seen).toEqual({ errors: [], hostileRequests: [], dialogs: 0 });
      const modelProbe = /^(cursor-agent models|opencode models|pi --list-models|copilot help config)$/;
      expect(agentCliCalls(agentBin).filter(call => !modelProbe.test(call))).toEqual([]);
      if (manualReview) {
        await expect(page.locator('html')).toHaveClass(/\blight\b/);
        const block = body.locator('[data-chat-mermaid]');
        const frame = block.locator('[data-diagram-inline]');
        await block.getByRole('button', { name: 'Show source', exact: true }).click();
        await expectSourceMode(block, true);
        await expect(block.getByRole('code')).toHaveText(PROOF_FLOW);
        const sourceBox = await frame.boundingBox();
        const source = await frame.screenshot();
        await block.getByRole('button', { name: 'Show diagram', exact: true }).click();
        await expectSourceMode(block, false);
        await expectRealDiagram(body, 1, 4);
        await expect(block.locator('[data-diagram-svg] > svg g.node')).toHaveText([/用户请求/, /参数校验/, /模型调用/, /返回响应/]);
        const diagramBox = await frame.boundingBox();
        expect(Math.abs(sourceBox!.width - diagramBox!.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(sourceBox!.height - diagramBox!.height)).toBeLessThanOrEqual(1);
        proof = { source, diagram: await frame.screenshot() };
        expect(seen).toEqual({ errors: [], hostileRequests: [], dialogs: 0 });
      }
    } finally {
      await stopApp(child, url, root);
    }
    // Keep image bytes in memory until assertions and the sandbox cleanup both succeed.
    if (proof) {
      mkdirSync(proofDir!, { recursive: true });
      writeFileSync(join(proofDir!, 'document-light-source.png'), proof.source);
      writeFileSync(join(proofDir!, 'document-light-diagram.png'), proof.diagram);
    }
  });
}
