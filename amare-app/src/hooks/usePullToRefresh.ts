import { useLayoutEffect, useRef, useState, type RefObject } from "react";

type Options = {
  onRefresh: () => Promise<void>;
  enabled?: boolean;
  threshold?: number;
};

function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let n = el?.parentElement ?? null;
  while (n) {
    const { overflowY } = getComputedStyle(n);
    if (overflowY === "auto" || overflowY === "scroll") return n;
    n = n.parentElement;
  }
  return el;
}

export function usePullToRefresh(
  containerRef: RefObject<HTMLElement | null>,
  { onRefresh, enabled = true, threshold = 72 }: Options,
) {
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const pullPx = useRef(0);
  const busy = useRef(false);
  const [attachTick, setAttachTick] = useState(0);

  useLayoutEffect(() => {
    const page = containerRef.current;
    if (!enabled) return;
    if (!page) {
      if (attachTick < 16) {
        const id = requestAnimationFrame(() => setAttachTick((n) => n + 1));
        return () => cancelAnimationFrame(id);
      }
      return;
    }

    const el = scrollParentOf(page) ?? page;

    function scrollTop() {
      return el.scrollTop || window.scrollY || 0;
    }

    function onTouchStart(e: TouchEvent) {
      if (busy.current || scrollTop() > 4) return;
      startY.current = e.touches[0]?.clientY ?? 0;
      pullPx.current = 0;
    }

    function onTouchMove(e: TouchEvent) {
      if (busy.current || scrollTop() > 4) return;
      const y = e.touches[0]?.clientY ?? 0;
      const delta = y - startY.current;
      if (delta <= 0) {
        pullPx.current = 0;
        setPulling(false);
        return;
      }
      pullPx.current = Math.min(delta, threshold * 1.4);
      setPulling(pullPx.current >= threshold * 0.45);
      if (delta > 8) e.preventDefault();
    }

    async function onTouchEnd() {
      if (busy.current) return;
      const shouldRefresh = pullPx.current >= threshold;
      pullPx.current = 0;
      setPulling(false);
      if (!shouldRefresh) return;
      busy.current = true;
      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        busy.current = false;
        setRefreshing(false);
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [containerRef, enabled, onRefresh, threshold, attachTick]);

  return { pulling, refreshing };
}
