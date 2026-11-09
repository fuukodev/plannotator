import React, { lazy, Suspense, useMemo } from 'react';
import type { Block } from '../../types';
import type { ChatMermaidRenderer } from '../../utils/chatMermaid';

// Keep this adapter out of the neutral chat entry. Review injects its own
// server-URL adapter and must never reach this diagram import, even lazily.
const MermaidBlock = lazy(async () => ({ default: (await import('../MermaidBlock')).MermaidBlock }));

function ChatMermaidBlock({ id, source, fallback }: {
  id: string;
  source: string;
  fallback: React.ReactNode;
}) {
  const block = useMemo<Block>(() => ({
    id, type: 'code', language: 'mermaid', content: source, order: 0,
    // Chat source is local to this fence, never a document annotation target.
    startLine: 1, diagramSourceLineOffset: 0,
  }), [id, source]);
  return <Suspense fallback={fallback}><MermaidBlock block={block} readOnly /></Suspense>;
}

/** Draw a chat fence with ui's existing read-only diagram viewer. Import this
 * adapter explicitly in a host, then pass it as `renderMermaid`. It loads the
 * diagram component and runtime on the first completed fence, follows the
 * host's ThemeProvider, and reuses the viewer's source, error and Retry UI.
 * The function itself calls no hooks; ordinary chat/review modules stay free
 * of the engine unless their host imports this adapter. */
export const renderChatMermaid: ChatMermaidRenderer = (fence, fallback) =>
  <ChatMermaidBlock id={fence.id} source={fence.source} fallback={fallback} />;
