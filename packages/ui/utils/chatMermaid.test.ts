import { describe, expect, test } from 'bun:test';
import { Marked } from 'marked';
import { ChatMermaidCollector, chatMermaidOptions } from './chatMermaid';

function parse(source: string, streaming = false, markdown = new Marked()) {
  const collector = new ChatMermaidCollector(streaming, source);
  const html = markdown.parse(source, chatMermaidOptions({ ...markdown.defaults, async: false }, collector)) as string;
  return { collector, html };
}

const GRAPH = 'flowchart LR\n  A --> B';

describe('Marked owns chat Mermaid fence structure', () => {
  test.each([
    ['backticks', `\`\`\`mermaid\n${GRAPH}\n\`\`\`\n`],
    ['case and info', `\`\`\`MeRmAiD title="Example"\n${GRAPH}\n\`\`\`\n`],
    ['four backticks', `\`\`\`\`mermaid\n${GRAPH}\n\`\`\`\n\`\`\`\`\n`],
    ['tildes', `~~~mermaid extra\n${GRAPH}\n~~~~\n`],
    ['CRLF', `\`\`\`mermaid\r\n${GRAPH.replaceAll('\n', '\r\n')}\r\n\`\`\`\r\n`],
    ['list', `- text\n\n  \`\`\`mermaid\n  ${GRAPH.replaceAll('\n', '\n  ')}\n  \`\`\`\n`],
    ['quote and list', `> - text\n>\n>   ~~~MERMAID extra\n>   ${GRAPH.replaceAll('\n', '\n>   ')}\n>   ~~~\n`],
  ])('%s becomes one fence with code text', (_name, source) => {
    const { collector, html } = parse(source, true);
    expect(collector.slots).toHaveLength(1);
    expect(collector.slots[0].source).toContain(GRAPH);
    expect(html).toContain(`<pre><code>${collector.slots[0].marker}</code></pre>`);
  });

  test.each([
    ['inline code', '`mermaid flowchart LR A-->B`'],
    ['indented code', '    mermaid\n    flowchart LR\n    A-->B'],
    ['another language', `\`\`\`mermaid-example\n${GRAPH}\n\`\`\`\n`],
    ['unlabelled code', `\`\`\`\nmermaid\n${GRAPH}\n\`\`\`\n`],
    ['a fence inside ordinary code', `\`\`\`\`text\n\`\`\`mermaid\n${GRAPH}\n\`\`\`\n\`\`\`\`\n`],
    ['raw HTML', '<pre><code class="language-mermaid">flowchart LR\nA-->B</code></pre>'],
    ['an open fence', `\`\`\`mermaid\n${GRAPH}\n`],
    ['a short close', `\`\`\`\`mermaid\n${GRAPH}\n\`\`\`\n`],
    ['a mismatched close', `~~~mermaid\n${GRAPH}\n\`\`\`\n`],
    ['words after the close', `\`\`\`mermaid\n${GRAPH}\n\`\`\` more\n`],
  ])('%s remains ordinary Markdown', (_name, source) => {
    expect(parse(source).collector.slots).toHaveLength(0);
  });

  test('an EOF close waits for a newline or the end of the turn', () => {
    const source = `\`\`\`mermaid\n${GRAPH}\n\`\`\``;
    expect(parse(source, true).collector.slots).toHaveLength(0);
    expect(parse(`${source}\n`, true).collector.slots).toHaveLength(1);
    expect(parse(source, false).collector.slots).toHaveLength(1);
  });

  test('nested EOF closes wait too, while earlier nested closes can render before later prose', () => {
    const source = '- item\n  ```mermaid\n  flowchart LR\n    A --> B\n  ```';
    expect(parse(source, true).collector.slots).toHaveLength(0);
    expect(parse(`${source}\n`, true).collector.slots).toHaveLength(1);
    expect(parse(`${source}\n\nOutside`, true).collector.slots).toHaveLength(1);
    expect(parse(source, false).collector.slots).toHaveLength(1);
  });

  test('each parse has private markers, but appending prose keeps fence indexes', () => {
    const source = `\`\`\`mermaid\n${GRAPH}\n\`\`\`\n`;
    const first = parse(source).collector.slots[0];
    const next = parse(`${source}\nMore words.\n\n${source}`).collector.slots;
    expect(first.marker).not.toBe(next[0].marker);
    expect(next.map((slot) => slot.index)).toEqual([0, 1]);
    expect(next[0].source).toBe(first.source);
  });

  test('HTTP hosts can use secure random values without randomUUID; no randomness keeps code', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const crypto = globalThis.crypto;
    const source = `\`\`\`mermaid\n${GRAPH}\n\`\`\`\n`;
    try {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: crypto.getRandomValues.bind(crypto) } });
      expect(parse(source).collector.slots).toHaveLength(1);
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      expect(parse(source).collector.slots).toHaveLength(0);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  });

  test('cold extension renderers parse ordinary lists through the local parser and restore their state', () => {
    const markdown = new Marked<string, string>({ renderer: { text() { return false; } } });
    const original = markdown.defaults.renderer!;
    const previousParser = original.parser;
    const previousOptions = original.options;
    const source = `- **one** and [docs](https://example.test)\n\n\`\`\`mermaid\n${GRAPH}\n\`\`\`\n`;
    const { html, collector } = parse(source, false, markdown);
    expect(html).toContain('<li><strong>one</strong> and <a href="https://example.test">docs</a></li>');
    expect(collector.slots).toHaveLength(1);
    expect(original.parser).toBe(previousParser);
    expect(original.options).toBe(previousOptions);
  });

  test('the original code renderer can still refuse an expensive diagram', () => {
    const markdown = new Marked({ renderer: { code() { throw new Error('block budget'); } } });
    const original = markdown.defaults.renderer!;
    const previousParser = original.parser;
    const previousOptions = original.options;
    expect(() => parse(`\`\`\`mermaid\n${GRAPH}\n\`\`\`\n`, false, markdown)).toThrow('block budget');
    expect(original.parser).toBe(previousParser);
    expect(original.options).toBe(previousOptions);
  });

  test('HTML budgets still pay for the original escaped code, not its marker', () => {
    const source = `\`\`\`mermaid\n${'&'.repeat(2000)}\n\`\`\`\n`;
    const ordinary = new Marked().parse(source, { async: false }) as string;
    const { collector, html } = parse(source);
    expect(html.length + collector.omittedHtmlChars).toBe(ordinary.length);
    expect(collector.slots[0].fallbackHtml).toContain('&amp;&amp;');
  });
});
