import { createElement, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ChatMermaidCollector, chatMermaidOptions, type ChatMermaidRenderer } from './chatMermaid';
import { ChatMermaidContent } from '../components/ai/ChatMermaidContent';

export type { ChatMermaidRenderer } from './chatMermaid';

/** Optional diagram support. Omit `renderMermaid` to retain ordinary code
 * blocks. While streaming, a fence's closing line needs a newline; at turn
 * end an EOF close is complete too. An unclosed fence always remains code. */
export interface ChatMarkdownOptions {
  readonly streaming?: boolean;
  readonly renderMermaid?: ChatMermaidRenderer | null;
}

/**
 * What DOMPurify keeps of an Ask AI answer. Every tag and attribute marked
 * writes for the markdown an answer uses must be listed here, or DOMPurify
 * drops the element and keeps only its text (#2069: tables ran together).
 */
export const CHAT_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  // `align` is what marked writes on th/td for aligned GFM columns. No `class`
  // (an answer's raw HTML could style itself with the app's utility classes;
  // nothing in `.ai-markdown` reads one) and no `rel` (marked never writes it
  // and `target` is not allowed).
  ALLOWED_ATTR: ['href', 'align'],
  // DOMPurify keeps data-* and aria-* unless told not to.
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/** The markdown step of {@link renderChatMarkdown}, before sanitizing. */
export function chatMarkdownToHtml(text: string): string {
  return marked.parse(text, { async: false, breaks: true }) as string;
}

/**
 * Never throws: deeply nested input can overflow the stack in marked, and a
 * throw inside a render would unmount the whole page. On any failure the
 * answer is shown as plain text, line breaks kept, as a React text child
 * (React escapes it).
 */
export function renderChatMarkdown(text: string, options?: ChatMarkdownOptions): ReactNode {
  try {
    const sanitize = (html: string) => DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [...CHAT_SANITIZE_CONFIG.ALLOWED_TAGS],
      ALLOWED_ATTR: [...CHAT_SANITIZE_CONFIG.ALLOWED_ATTR],
      ALLOW_DATA_ATTR: CHAT_SANITIZE_CONFIG.ALLOW_DATA_ATTR,
      ALLOW_ARIA_ATTR: CHAT_SANITIZE_CONFIG.ALLOW_ARIA_ATTR,
    });
    if (options?.renderMermaid) {
      const collector = new ChatMermaidCollector(options.streaming ?? false, text);
      const html = marked.parse(text, chatMermaidOptions({ ...marked.defaults, async: false, breaks: true }, collector)) as string;
      const markup = collector.sanitize(html, sanitize);
      return createElement(ChatMermaidContent, {
        className: 'ai-markdown', source: text, markup, renderMermaid: options.renderMermaid,
      });
    }
    return createElement('div', {
      className: 'ai-markdown',
      dangerouslySetInnerHTML: { __html: sanitize(chatMarkdownToHtml(text)) },
    });
  } catch {
    return createElement(
      'div',
      { className: 'ai-markdown', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
      String(text),
    );
  }
}

export function formatRelativeTime(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
