import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** The live scroll measurements used by the chat follower, in CSS pixels. */
export interface ChatScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Follow growing chat content until the person scrolls away from its bottom.
 * `pause` also covers an explicit history jump: smooth-scroll frames near the
 * old bottom cannot re-arm following before the jump leaves the 24px edge.
 * Call `onScroll` for viewport scrolling and `refresh` after layout changes.
 * Optional `targetTop` supplies a scroll position for a grouped review's latest
 * answer; null means that answer is not visible. Positions clamp to the pane.
 * Reading measurements alone never changes the person's following choice.
 */
export function createChatScrollFollower(box: ChatScrollBox, targetTop?: () => number | null) {
  let following = true;
  let lastTop = box.scrollTop;
  let historyJump = false;
  const destination = () => {
    const target = targetTop ? targetTop() : box.scrollHeight - box.clientHeight;
    return target === null ? null : Math.max(0, Math.min(target, box.scrollHeight - box.clientHeight));
  };
  return {
    refresh() {
      const top = destination();
      if (!following || top === null) return;
      box.scrollTop = top;
      lastTop = box.scrollTop;
    },
    onScroll() {
      const target = destination();
      if (target !== null) {
        const atBottom = Math.abs(target - box.scrollTop) < 24;
        if (historyJump) {
          if (!atBottom) historyJump = false;
        } else if (atBottom) {
          following = true;
        } else if ((box.scrollTop - lastTop) * (target - box.scrollTop) < 0) {
          // Anchoring can move toward a growing target. Only movement away
          // from that target releases an existing follow choice.
          following = false;
        }
      }
      lastTop = box.scrollTop;
    },
    pause() {
      following = false;
      historyJump = true;
      lastTop = box.scrollTop;
    },
  };
}

/**
 * Share bottom-following across chat hosts without changing their layout.
 * Pass the viewport ref, or a natural content ref whose parent is the viewport.
 * Natural content is observed directly. A transcript without a content wrapper
 * observes its direct element children, tracking only direct child-list changes.
 * `observeContent: false` retains viewport-only observation for plain hosts.
 * Optional `target` aligns a grouped review's latest answer rather than the
 * whole list; a missing target leaves the reading position unchanged.
 * Effects refresh after React updates even without ResizeObserver or during
 * hydration. All observers and scroll listeners are removed on detach/unmount.
 * `pauseFollowing` must precede an explicit history scroll. Returning to the
 * bottom after that jump restores following; layout changes alone do not.
 */
export function useChatScroll(
  viewportRef: RefObject<HTMLElement | null> | null,
  contentRef: RefObject<HTMLElement | null> | null = null,
  options: { target?: () => HTMLElement | null; observeContent?: boolean } = {},
) {
  const targetRef = useRef(options.target);
  targetRef.current = options.target;
  const watchContent = options.observeContent ?? true;
  const current = useRef<{
    viewport: HTMLElement;
    content: HTMLElement | null;
    watchContent: boolean;
    follower: ReturnType<typeof createChatScrollFollower>;
    dispose: () => void;
  } | null>(null);

  // Refs may attach after an empty-state render. Resolve after every commit,
  // but keep the same follower and observers while the actual nodes stay put.
  useEffect(() => {
    const content = contentRef?.current ?? null;
    const viewport = viewportRef?.current ?? content?.parentElement ?? null;
    if (current.current?.viewport !== viewport || current.current?.content !== content || current.current?.watchContent !== watchContent) {
      const previous = current.current;
      previous?.dispose();
      current.current = null;
      if (viewport) {
        const follower = previous?.viewport === viewport ? previous.follower : createChatScrollFollower(viewport, () => {
          if (!targetRef.current) return viewport.scrollHeight - viewport.clientHeight;
          const target = targetRef.current();
          return target ? viewport.scrollTop + target.getBoundingClientRect().bottom
            - viewport.getBoundingClientRect().top - viewport.clientTop - viewport.clientHeight : null;
        });
        let active = true;
        const refresh = () => { if (active) follower.refresh(); };
        const onScroll = () => follower.onScroll();
        viewport.addEventListener('scroll', onScroll, { passive: true });
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
        const observed = new Set<Element>();
        const observeContent = () => {
          if (!observer || !active) return;
          const targets = new Set<Element>([viewport, ...(watchContent ? (content ? [content] : Array.from(viewport.children)) : [])]);
          for (const node of observed) {
            if (!targets.has(node)) { observer.unobserve(node); observed.delete(node); }
          }
          for (const node of targets) {
            if (!observed.has(node)) { observer.observe(node); observed.add(node); }
          }
        };
        observeContent();
        const children = watchContent && !content && observer && typeof MutationObserver === 'function'
          ? new MutationObserver(() => { observeContent(); refresh(); })
          : null;
        children?.observe(viewport, { childList: true });
        current.current = {
          viewport, content, watchContent, follower,
          dispose() {
            active = false;
            observer?.disconnect();
            children?.disconnect();
            viewport.removeEventListener('scroll', onScroll);
          },
        };
      }
    }
    current.current?.follower.refresh();
  });

  useEffect(() => () => {
    current.current?.dispose();
    current.current = null;
  }, []);

  const pauseFollowing = useCallback(() => current.current?.follower.pause(), []);
  const refresh = useCallback(() => current.current?.follower.refresh(), []);
  return { pauseFollowing, refresh };
}
