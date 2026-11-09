import React from 'react';
import type { ChatMermaidRenderer } from '@plannotator/ui/utils/chatMermaid';
import type { Block } from '@plannotator/ui/types';
import type { DiagramEngineUrls } from '../utils/diagramEngineContract';
import { ReviewDiagramFence } from './ReviewDiagramFence';

/**
 * Draw chat fences with the server's on-demand diagram engine. An older server
 * without an advert keeps the ordinary code fallback and requests no assets.
 * Each fence keeps the chat bridge's identity, including repeated sources.
 */
export function chatMermaidRenderer(urls: DiagramEngineUrls | null | undefined): ChatMermaidRenderer | undefined {
  if (!urls) return undefined;
  return ({ id, source }, fallback) => {
    const block: Block = { id, type: 'code', language: 'mermaid', content: source, order: 0, startLine: 1 };
    return <ReviewDiagramFence block={block} kind="mermaid" urls={urls} fallback={fallback} />;
  };
}
