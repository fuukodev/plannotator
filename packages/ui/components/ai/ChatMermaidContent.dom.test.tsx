/** Chat's two Markdown pipelines share diagram slots without sharing engines.
 * DOM_TESTS=1; real engines and browser SVG proofs belong to the app e2e lane. */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Marked } from 'marked';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import { ChatMermaidCollector, chatMermaidOptions, type ChatMermaidRenderer } from '../../utils/chatMermaid';
import { ChatMermaidContent } from './ChatMermaidContent';
import type * as Transcript from '../chat/ChatTranscript';
import type * as Markdown from '../chat/chatMarkdown';
import type * as Format from '../../utils/aiChatFormat';

const hasDom = typeof document !== 'undefined';
let ChatMarkdown: typeof Transcript.ChatMarkdown;
let ChatTranscript: typeof Transcript.ChatTranscript;
let chatTextContentRenderer: typeof Markdown.chatTextContentRenderer;
let renderChatMarkdown: typeof Format.renderChatMarkdown;
let unbridge: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let mounts = 0;
let unmounts = 0;
let renders = 0;
const GRAPH = 'flowchart LR\n  A --> B';
const FENCE = `\`\`\`mermaid\n${GRAPH}\n\`\`\`\n`;

beforeAll(async () => {
  if (!hasDom) return;
  unbridge = bridgeSanitizerDom();
  ({ ChatMarkdown, ChatTranscript } = await import('../chat/ChatTranscript'));
  ({ chatTextContentRenderer } = await import('../chat/chatMarkdown'));
  ({ renderChatMarkdown } = await import('../../utils/aiChatFormat'));
});
afterAll(() => unbridge?.());
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  mounts = 0;
  unmounts = 0;
  renders = 0;
});

function Diagram({ id, source }: { id: string; source: string }) {
  useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
  useEffect(() => { renders += 1; }, [source]);
  return <svg data-test-diagram={id}><text>{source}</text></svg>;
}
const renderDiagram: ChatMermaidRenderer = (fence) => <Diagram {...fence} />;

async function draw(element: React.ReactNode) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(element));
  return host;
}

const say = (text: string, role: 'assistant' | 'user' = 'assistant', state?: 'streaming' | 'done'): Transcript.ChatMessage => ({
  id: role, role, parts: [{ type: 'text', text, state } as Transcript.ChatTextPart],
});

describe.if(hasDom)('chat Mermaid DOM bridge', () => {
  test('a cold bounded transcript draws an ordinary list and Mermaid before any parser warmup', async () => {
    const text = `**Reason** with inline text.\n\n- one item\n\n${FENCE}`;
    // Keep this first: a previous non-diagram render sets the captured Marked
    // renderer's parser and used to hide a broken shallow renderer clone.
    await draw(<ChatTranscript messages={[say(text)]} status="ready" agentName="Agent" renderMermaid={renderDiagram} />);
    expect(host!.querySelector('strong')?.textContent).toBe('Reason');
    expect(host!.querySelector('li')?.textContent).toBe('one item');
    expect(host!.querySelector('svg')).not.toBeNull();
    expect(host!.textContent).not.toContain('```mermaid');
  });

  test.each(['legacy', 'transcript'] as const)('%s keeps nested containers, prose and table alignment', async (pipeline) => {
    const text = [
      '**Before**\nsecond line', '',
      '> - item', '>', '>   ~~~MeRmAiD extra', '>   flowchart LR', '>     A --> B', '>   ~~~', '',
      '| Name | Cost |', '|:--|--:|', '| a | 2 |', '',
      '[docs](https://example.test)', '', FENCE,
    ].join('\n');
    const view = await draw(pipeline === 'legacy'
      ? renderChatMarkdown(text, { renderMermaid: renderDiagram })
      : <ChatMarkdown text={text} renderMermaid={renderDiagram} />);
    expect(view.querySelectorAll('svg[data-test-diagram]')).toHaveLength(2);
    expect(view.querySelector('blockquote li > [data-chat-mermaid] svg')).not.toBeNull();
    expect(view.querySelector('strong')?.textContent).toBe('Before');
    expect(view.querySelector('th[align="left"]')).not.toBeNull();
    expect(view.querySelector('th[align="right"]')).not.toBeNull();
    expect(view.querySelector('a')?.getAttribute('href')).toBe('https://example.test');
    expect(new Set([...view.querySelectorAll('svg')].map((svg) => svg.getAttribute('data-test-diagram'))).size).toBe(2);
    expect(view.textContent).not.toContain('pn-chat-mermaid-');
  });

  test('both opt-in and old paths retain their own raw HTML behavior', async () => {
    const text = `<p class="fixed" data-chat-mermaid="forged" onclick="bad()">kept</p>\n\n${FENCE}`;
    const legacy = await draw(renderChatMarkdown(text, { renderMermaid: renderDiagram }));
    expect(legacy.querySelector('p')?.textContent).toBe('kept');
    expect(legacy.querySelector('p')?.getAttributeNames()).toEqual([]);
    expect(legacy.querySelectorAll('[data-chat-mermaid]')).toHaveLength(1);
    await draw(<ChatMarkdown text={text} renderMermaid={renderDiagram} />);
    expect(host!.textContent).toContain('<p class="fixed"');
    expect(host!.querySelector('p.fixed')).toBeNull();
    expect(host!.querySelectorAll('[data-chat-mermaid]')).toHaveLength(1);
  });

  test('a completed diagram survives later deltas, another diagram and a loose-list change', async () => {
    const first = `- item\n  \`\`\`mermaid\n  flowchart LR\n    A --> B\n  \`\`\`\n`;
    await draw(<ChatMarkdown text={first} streaming renderMermaid={renderDiagram} />);
    const svg = host!.querySelector('svg');
    const id = svg?.getAttribute('data-test-diagram');
    expect(svg).not.toBeNull();
    await draw(<ChatMarkdown text={`${first}\n- next item\n\nAfter.\n\n${FENCE}`} streaming renderMermaid={renderDiagram} />);
    expect(host!.querySelector('svg')).toBe(svg);
    expect(host!.querySelector('svg')?.getAttribute('data-test-diagram')).toBe(id);
    expect(mounts).toBe(2);
    expect(renders).toBe(2);
    expect(unmounts).toBe(0);
  });

  test('streaming waits for the close line; stopping accepts an EOF close with the same text', async () => {
    const eof = FENCE.trimEnd();
    await draw(<ChatTranscript messages={[say(eof, 'assistant', 'streaming')]} status="streaming" agentName="Agent" renderMermaid={renderDiagram} />);
    expect(host!.querySelector('svg')).toBeNull();
    await draw(<ChatTranscript messages={[say(eof, 'assistant', 'streaming')]} status="streaming" stopped={new Set(['assistant'])} agentName="Agent" renderMermaid={renderDiagram} />);
    expect(host!.querySelector('svg')).not.toBeNull();
    const svg = host!.querySelector('svg');
    await draw(<ChatTranscript messages={[say(eof, 'assistant', 'done')]} status="ready" agentName="Agent" renderMermaid={renderDiagram} />);
    expect(host!.querySelector('svg')).toBe(svg);
    expect(mounts).toBe(1);
  });

  test('an unclosed final answer stays code; a final response without deltas renders', async () => {
    const open = `\`\`\`mermaid\n${GRAPH}`;
    await draw(<ChatMarkdown text={open} renderMermaid={renderDiagram} />);
    expect(host!.querySelector('svg')).toBeNull();
    expect(host!.querySelector('pre')?.textContent).toContain(GRAPH);
    await draw(<ChatMarkdown text={FENCE.trimEnd()} renderMermaid={renderDiagram} />);
    expect(host!.querySelector('svg')).not.toBeNull();
  });

  test('custom parts inherit the host renderer; null and person text keep code', async () => {
    const messages = [say(FENCE), say(FENCE, 'user')];
    await draw(<ChatTranscript messages={messages} status="ready" agentName="Agent" renderMermaid={renderDiagram}
      renderPart={(part, { message }) => <ChatMarkdown text={(part as Transcript.ChatTextPart).text} literalHtml={message.role === 'user'} />} />);
    expect(host!.querySelectorAll('svg')).toHaveLength(1);
    await draw(<ChatTranscript messages={messages} status="ready" agentName="Agent" renderMermaid={renderDiagram}
      renderPart={(part) => <ChatMarkdown text={(part as Transcript.ChatTextPart).text} renderMermaid={null} />} />);
    expect(host!.querySelector('svg')).toBeNull();
    expect(host!.querySelectorAll('pre')).toHaveLength(2);
  });

  test('the default public transcript does not invoke any diagram renderer', async () => {
    await draw(<ChatTranscript messages={[say(FENCE)]} status="ready" agentName="Agent" />);
    expect(host!.querySelector('[data-chat-mermaid]')).toBeNull();
    expect(host!.querySelector('pre')?.textContent).toContain(GRAPH);
  });

  test('rich attributes survive safe projection without changing the default allowlist', async () => {
    const text = `5. ~~gone~~\n6. [x] done\n\n![cat](https://example.test/cat.png "Cat")\n\n${FENCE}`;
    await draw(<ChatMarkdown text={text} richMarkdown renderMermaid={renderDiagram} />);
    expect(host!.querySelector('ol')?.getAttribute('start')).toBe('5');
    expect(host!.querySelector('del')?.textContent).toBe('gone');
    expect(host!.querySelector('input')?.hasAttribute('disabled')).toBe(true);
    expect(host!.querySelector('input')?.hasAttribute('checked')).toBe(true);
    expect(host!.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    await draw(<ChatMarkdown text={text} renderMermaid={renderDiagram} />);
    expect(host!.querySelector('ol')?.hasAttribute('start')).toBe(false);
    expect(host!.querySelector('input, img, del')).toBeNull();
  });

  test('a renderer failure retains its source and a source replacement can recover', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const broken: ChatMermaidRenderer = () => { throw new Error('unavailable'); };
    try {
      await draw(<ChatMarkdown text={FENCE} renderMermaid={broken} />);
      expect(host!.querySelector('pre')?.textContent).toContain(GRAPH);
      expect(host!.querySelector('svg')).toBeNull();
      await draw(<ChatMarkdown text={FENCE.replace('A --> B', 'B --> C')} renderMermaid={renderDiagram} />);
      expect(host!.querySelector('svg')?.textContent).toContain('B --> C');
    } finally {
      error.mockRestore();
    }
  });

  test('missing or duplicate markers fall back to the whole escaped source', async () => {
    const markdown = new Marked();
    const collector = new ChatMermaidCollector(false, FENCE);
    const html = markdown.parse(FENCE, chatMermaidOptions({ ...markdown.defaults, async: false }, collector)) as string;
    const markup = collector.sanitize(html, (value) => value);
    for (const altered of ['', html + html]) {
      await draw(<ChatMermaidContent markup={{ ...markup, html: altered }} source={FENCE} renderMermaid={renderDiagram} />);
      expect(host!.querySelector('svg')).toBeNull();
      expect(host!.textContent).toBe(FENCE);
      expect(host!.textContent).not.toContain('pn-chat-mermaid-');
    }
  });

  test('diagram markers cannot bypass streaming HTML limits or a spent parse budget', () => {
    const expensive = `\`\`\`mermaid\n${'&'.repeat(60_000)}\n\`\`\`\n`;
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const render = chatTextContentRenderer(false, false, false, true);
      const limited = render(expensive, true);
      expect(limited.slots).toBeUndefined();
      expect(limited.html).not.toContain('pn-chat-mermaid-');
      const held = render(`${expensive}short delta`, true);
      expect(held).toBe(limited);
      const finished = render(expensive, false);
      expect(finished.slots).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
    let now = 0;
    const spent = spyOn(Date, 'now').mockImplementation(() => (now += 1000));
    try {
      const result = chatTextContentRenderer(false, false, false, true)(FENCE, true);
      expect(result.slots).toBeUndefined();
      expect(result.html).toContain('flowchart LR');
    } finally {
      spent.mockRestore();
    }
  });
});
