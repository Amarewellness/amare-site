import { useLayoutEffect, useRef, useState, type RefObject } from "react";

type Options = {
  onRefresh: () => Promise<void>;
  enabled?: boolean;
  threshold?: number;
  ignoreClosest?: string;
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
  { onRefresh, enabled = true, threshold = 72, ignoreClosest }: Options,
) {
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const pullPx = useRef(0);
  const busy = useRef(false);
  const tracking = useRef(false);
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

    function ignoredTarget(e: TouchEvent) {
      if (!ignoreClosest) return false;
      const t = e.target;
      return t instanceof Element && Boolean(t.closest(ignoreClosest));
    }

    function onTouchStart(e: TouchEvent) {
      tracking.current = false;
      pullPx.current = 0;
      if (busy.current || scrollTop() > 4 || ignoredTarget(e)) return;
      startY.current = e.touches[0]?.clientY ?? 0;
      tracking.current = true;
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking.current || busy.current || scrollTop() > 4) return;
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
      if (!tracking.current || busy.current) {
        tracking.current = false;
        pullPx.current = 0;
        setPulling(false);
        return;
      }
      tracking.current = false;
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
  }, [containerRef, enabled, onRefresh, threshold, ignoreClosest, attachTick]);

  return { pulling, refreshing };
}
