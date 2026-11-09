import React, { Suspense, useId, useMemo, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import type { ChatMermaidMarkup, ChatMermaidRenderer, ChatMermaidSlot } from '../../utils/chatMermaid';
import { LazyBlockBoundary } from '../LazyBlockBoundary';

const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  href: 'href', align: 'align', title: 'title', start: 'start',
  src: 'src', alt: 'alt', width: 'width', height: 'height', loading: 'loading',
  type: 'type', checked: 'checked', disabled: 'disabled', target: 'target', rel: 'rel',
};
const VOID_TAGS = new Set(['br', 'hr', 'wbr', 'img', 'input']);

/** Leave a sanitized subtree without slots as HTML. In particular, Marked's
 * table whitespace must not become React children of table/thead/tr. */
function ProseElement({ tag, attributes, html }: {
  tag: string;
  attributes: Record<string, unknown>;
  html: string;
}) {
  const inner = useMemo(() => ({ __html: html }), [html]);
  return React.createElement(tag, { ...attributes, dangerouslySetInnerHTML: inner });
}

/** Invoke the host below an error boundary: a host callback or a failed lazy
 * component must leave its source readable without unmounting the chat. */
function DrawMermaid({ id, slot, renderMermaid, fallback }: {
  id: string;
  slot: ChatMermaidSlot;
  renderMermaid: ChatMermaidRenderer;
  fallback: ReactNode;
}) {
  return renderMermaid({ id, source: slot.source }, fallback);
}

function MermaidSlot({ id, slot, renderMermaid }: {
  id: string;
  slot: ChatMermaidSlot;
  renderMermaid: ChatMermaidRenderer;
}) {
  const inner = useMemo(() => ({ __html: slot.fallbackHtml }), [slot.fallbackHtml]);
  const fallback = useMemo(() => <div dangerouslySetInnerHTML={inner} />, [inner]);
  return (
    <div data-chat-mermaid="">
      {/* Only a real source replacement resets the engine's last-good SVG.
          Appending prose or changing the theme keeps this instance mounted. */}
      <LazyBlockBoundary key={slot.source} fallback={() => fallback}>
        <Suspense fallback={fallback}>
          <DrawMermaid id={id} slot={slot} renderMermaid={renderMermaid} fallback={fallback} />
        </Suspense>
      </LazyBlockBoundary>
    </div>
  );
}

/** Project already-sanitized HTML, not Markdown. Marked owns all list, quote
 * and table structure. Only the private pre/code markers become React slots;
 * neither raw HTML attributes nor SVG markup can create a slot. Null means a
 * marker was missing or duplicated, so the caller must show the source. */
function projectMarkup(markup: ChatMermaidMarkup, prefix: string, renderMermaid: ChatMermaidRenderer): ReactNode[] | null {
  if (typeof document === 'undefined') return null;
  const template = document.createElement('template');
  template.innerHTML = markup.html;
  const markers = new Map(markup.slots!.map((slot) => [slot.marker, slot]));
  const replacements = new Map<Element, ChatMermaidSlot>();
  const seen = new Set<number>();
  for (const code of template.content.querySelectorAll('pre > code')) {
    const slot = markers.get(code.textContent ?? '');
    if (!slot) continue;
    const pre = code.parentElement!;
    if (seen.has(slot.index) || pre.childNodes.length !== 1 || code.childElementCount !== 0) return null;
    seen.add(slot.index);
    replacements.set(pre, slot);
  }
  if (seen.size !== markers.size) return null;
  const containers = new Set<Element>();
  for (const pre of replacements.keys()) {
    for (let parent = pre.parentElement; parent; parent = parent.parentElement) containers.add(parent);
  }

  const children = (parent: ParentNode, path: string): ReactNode[] => {
    let elementIndex = 0;
    return Array.from(parent.childNodes, (node) => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return null;
      const element = node as Element;
      const at = `${path}-${elementIndex++}`;
      const slot = replacements.get(element);
      if (slot) return <MermaidSlot key={`mermaid-${slot.index}`} id={`${prefix}-${slot.index}`} slot={slot} renderMermaid={renderMermaid} />;
      const tag = element.tagName.toLowerCase();
      const props: Record<string, unknown> = { key: `html-${at}` };
      for (const attribute of Array.from(element.attributes)) {
        const name = ATTRIBUTE_NAMES[attribute.name];
        if (name) props[name] = name === 'checked' || name === 'disabled' ? true : attribute.value;
      }
      if (VOID_TAGS.has(tag)) return React.createElement(tag, props);
      if (!containers.has(element)) {
        const { key, ...attributes } = props;
        return <ProseElement key={String(key)} tag={tag} attributes={attributes} html={element.innerHTML} />;
      }
      return React.createElement(tag, props, ...children(element, at));
    });
  };
  return children(template.content, 'root');
}

/** Internal, engine-free body shared by both chat Markdown pipelines. No slots
 * keeps the original HTML path and a stable innerHTML object. A bridge failure
 * displays the complete source as escaped text. `rootRef` still names the text
 * part's one root, including when diagrams render inside lists or quotes. */
export function ChatMermaidContent({ markup, source, renderMermaid, rootRef, ...props }: {
  markup: ChatMermaidMarkup;
  source: string;
  renderMermaid?: ChatMermaidRenderer | null;
  rootRef?: Ref<HTMLDivElement>;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'dangerouslySetInnerHTML'>) {
  const prefix = useId().replace(/[^\w-]/g, '');
  const inner = useMemo(() => ({ __html: markup.html }), [markup.html]);
  const projected = useMemo(() => {
    if (!renderMermaid || !markup.slots?.length) return undefined;
    try {
      return projectMarkup(markup, prefix, renderMermaid);
    } catch {
      return null;
    }
  }, [markup, prefix, renderMermaid]);
  if (projected === undefined) return <div {...props} ref={rootRef} dangerouslySetInnerHTML={inner} />;
  if (projected === null) return <div {...props} ref={rootRef} style={{ ...props.style, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source}</div>;
  return <div {...props} ref={rootRef}>{projected}</div>;
}
