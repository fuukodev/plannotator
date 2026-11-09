import type { ReactNode } from 'react';
import { Renderer, type MarkedOptions, type Token, type Tokens } from 'marked';
import { isMermaidLanguage } from '../components/diagramLanguages';

/** A host draws one completed Mermaid fence. `id` stays stable while later
 * text arrives; `source` is Marked's code text, without the fence or container
 * indentation. Return `fallback` to keep the ordinary, sanitized code block.
 * The host owns loading and rendering. This module imports no diagram engine. */
export type ChatMermaidRenderer = (
  fence: { id: string; source: string },
  fallback: ReactNode,
) => ReactNode;

/** Internal: a code token replaced by a private marker before sanitizing. */
export interface ChatMermaidSlot {
  readonly index: number;
  readonly marker: string;
  readonly source: string;
  readonly fallbackHtml: string;
}

/** Internal: sanitized prose and its separately rendered diagram fences. */
export interface ChatMermaidMarkup {
  readonly html: string;
  readonly slots?: readonly ChatMermaidSlot[];
}

/** Check only a fence that Marked already recognized. Its recursive lexer has
 * removed list/quote prefixes. An EOF close may still receive more characters
 * during a stream, so it becomes eligible only after a newline or turn end. */
export function isClosedChatMermaidFence(token: Tokens.Code, streaming: boolean): boolean {
  if (token.codeBlockStyle === 'indented' || !isMermaidLanguage(token.lang)) return false;
  const raw = token.raw.replace(/\r\n?/g, '\n');
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(raw);
  if (!opening || (streaming && !raw.endsWith('\n'))) return false;
  const lines = raw.slice(opening[0].length).split('\n');
  // Marked may consume blank lines after the close. They do not change it.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  const fence = opening[1];
  return new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(last);
}

/** getRandomValues also works on HTTP hosts where randomUUID is unavailable. */
function markerNonce(): string | null {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (!crypto?.getRandomValues) return null;
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, '0')).join('');
}

/** A per-parse collection. Markers use a fresh random nonce, not an attribute
 * that a message could supply. The DOM bridge also requires exactly one match
 * for each slot. Without secure randomness, ordinary code is the fallback. */
export class ChatMermaidCollector {
  readonly slots: ChatMermaidSlot[] = [];
  /** Add the original code HTML's cost back before enforcing HTML budgets. */
  omittedHtmlChars = 0;
  private readonly nonce = markerNonce();
  private lastToken: Token | undefined;

  constructor(private readonly streaming: boolean, private readonly source: string) {}

  /** Marked trims a list item's terminal newline from its child code token.
   * Its own token walk tells us whether the close precedes later content;
   * the original source supplies the newline when this is the final token. */
  observeToken(token: Token): void {
    if (token.type !== 'space') this.lastToken = token;
  }

  code(token: Tokens.Code, fallbackHtml: string): string {
    const atLiveEnd = this.streaming && !/[\r\n]$/.test(this.source) && this.lastToken === token;
    if (!this.nonce || !isClosedChatMermaidFence(token, atLiveEnd)) return fallbackHtml;
    const index = this.slots.length;
    const marker = `pn-chat-mermaid-${this.nonce}-${index}`;
    const html = `<pre><code>${marker}</code></pre>\n`;
    this.slots.push({ index, marker, source: token.text, fallbackHtml });
    this.omittedHtmlChars += fallbackHtml.length - html.length;
    return html;
  }

  /** Keep the caller's sanitizer, including its mode and hooks. Code fallbacks
   * are washed too; no unsanitized renderer output reaches the React bridge. */
  sanitize(html: string, sanitize: (html: string) => string): ChatMermaidMarkup {
    const clean = sanitize(html);
    if (this.slots.length === 0) return { html: clean };
    return {
      html: clean,
      slots: this.slots.map((slot) => ({ ...slot, fallbackHtml: sanitize(slot.fallbackHtml) })),
    };
  }
}

/** A local renderer override, never `marked.use()` on a shared instance. The
 * original code renderer runs first, so the transcript's block-budget check
 * and Marked's code escaping stay in force for diagram sources too. */
export function chatMermaidOptions(options: MarkedOptions, collector: ChatMermaidCollector): MarkedOptions {
  const original = options.renderer;
  const renderer = Object.assign(new Renderer(options), original);
  if (original) {
    // Marked.use wraps methods in arrows that capture the original renderer.
    // A shallow clone alone leaves those methods reading its old/absent
    // parser. Bind the captured instance only for this synchronous call;
    // nested methods share the current parser and even a throw restores it.
    for (const [name, method] of Object.entries(original)) {
      if (typeof method !== 'function') continue;
      Object.defineProperty(renderer, name, {
        configurable: true,
        writable: true,
        value: function (this: Renderer, ...args: unknown[]) {
          const parser = original.parser;
          const previousOptions = original.options;
          original.parser = this.parser;
          original.options = this.options;
          try {
            return method.apply(this, args);
          } finally {
            original.parser = parser;
            original.options = previousOptions;
          }
        },
      });
    }
  }
  const code = renderer.code;
  renderer.code = function (token) {
    return collector.code(token, code.call(this, token));
  };
  return {
    ...options,
    renderer,
    walkTokens(token) {
      collector.observeToken(token);
      return options.walkTokens?.call(this, token);
    },
  };
}
