/** Browser fixture: real chat components and host adapters, with only transport state supplied by the test. */
import type * as ReactTypes from '../../../packages/ui/node_modules/@types/react';
import type * as ReactDOMTypes from '../../../packages/ui/node_modules/@types/react-dom';
import type * as ReactDOMClientTypes from '../../../packages/ui/node_modules/@types/react-dom/client';
// Resolve the same private React peers as ui. The repository root has no React dependency.
const React: typeof ReactTypes = require('../../../packages/ui/node_modules/react');
// Bun 1.4.4 miscompiles typed require destructuring. Read the functions from module objects.
const ReactDOM: typeof ReactDOMTypes = require('../../../packages/ui/node_modules/react-dom');
const ReactDOMClient: typeof ReactDOMClientTypes = require('../../../packages/ui/node_modules/react-dom/client');
const flushSync = ReactDOM.flushSync;
const createRoot = ReactDOMClient.createRoot;
import { DocumentAIChatPanel } from '../../../packages/ui/components/ai/DocumentAIChatPanel';
import { renderChatMermaid } from '../../../packages/ui/components/ai/ChatMermaidBlock';
import { ChatTranscript, type ChatTextPart } from '../../../packages/ui/components/chat/ChatTranscript';
import { ThemeProvider, useTheme } from '../../../packages/ui/components/ThemeProvider';
import { AITab } from '../../../packages/review-editor/components/AITab';
import { chatMermaidRenderer } from '../../../packages/review-editor/components/ChatMermaidBlock';

export type Surface = 'document' | 'review' | 'inbox';
export interface Paint {
  text: string;
  id?: string;
  streaming?: boolean;
  /** A stopped Inbox turn can retain a streaming text part after the transport ends. */
  partStreaming?: boolean;
  stopped?: boolean;
  userText?: string;
  status?: 'ready' | 'error';
}
export interface MermaidChatHarness {
  show: (next: Paint) => void;
}
declare global {
  interface Window { __mermaidChat: MermaidChatHarness }
}

const h = React.createElement;
const surface = location.pathname.split('/').pop() as Surface;
const reviewRenderer = chatMermaidRenderer({
  engine: '/diagram-engine/engine.js',
  mermaid: '/diagram-engine/mermaid.js',
  graphviz: '/diagram-engine/graphviz.js',
});
const root = createRoot(document.getElementById('mount')!);
let state: Paint = { text: '' };

function stop() {
  state = { ...state, streaming: false, partStreaming: true, stopped: true };
  draw();
}

function ThemeControl() {
  const { resolvedMode, setMode } = useTheme();
  const next = resolvedMode === 'dark' ? 'light' : 'dark';
  return h('button', { onClick: () => setMode(next) }, `Switch to ${next}`);
}

function Subject() {
  const id = state.id ?? 'answer';
  const entry = {
    question: { id, prompt: state.userText ?? 'Explain this diagram', createdAt: 1 },
    response: { questionId: id, text: state.text, isStreaming: !!state.streaming, createdAt: 1 },
  };
  const shared = {
    messages: [entry], isCreatingSession: false, isStreaming: !!state.streaming,
    onAskGeneral: () => {}, onStop: stop,
  };
  if (surface === 'document') return h(DocumentAIChatPanel, { ...shared, renderMermaid: renderChatMermaid });
  if (surface === 'review') return h(AITab, { ...shared, onScrollToLines: () => {}, renderMermaid: reviewRenderer });
  return h(React.Fragment, null,
    h(ChatTranscript<ChatTextPart>, {
      messages: [
        { id: 'person', role: 'user', parts: [{ type: 'text', text: state.userText ?? 'Explain this diagram' }] },
        { id, role: 'assistant', parts: [{ type: 'text', text: state.text, state: state.streaming || state.partStreaming ? 'streaming' : 'done' }] },
      ],
      status: state.streaming ? 'streaming' : state.status ?? 'ready',
      agentName: 'Fixture agent',
      stopped: state.stopped ? new Set([id]) : undefined,
      renderMermaid: renderChatMermaid,
    }),
    // ChatTranscript delegates cancellation to its host. Document and Review use their own Stop controls.
    state.streaming && h('button', { onClick: stop }, 'Stop generating'),
  );
}

function draw() {
  flushSync(() => root.render(h(ThemeProvider, {
    defaultTheme: 'dark',
    children: h(React.Fragment, null,
      h('div', { id: 'fixture-controls' }, h(ThemeControl)),
      h('div', { id: 'subject' }, h(Subject)),
    ),
  })));
}

window.__mermaidChat = { show(next) { state = next; draw(); } };
draw();
