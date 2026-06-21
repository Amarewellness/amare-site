import { useEffect, useRef, useState, type RefObject } from "react";

type Options = {
  onRefresh: () => Promise<void>;
  enabled?: boolean;
  threshold?: number;
};

export function usePullToRefresh(
  containerRef: RefObject<HTMLElement | null>,
  { onRefresh, enabled = true, threshold = 72 }: Options,
) {
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const pullPx = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled) return;

    function onTouchStart(e: TouchEvent) {
      if (busy.current || window.scrollY > 4) return;
      startY.current = e.touches[0]?.clientY ?? 0;
      pullPx.current = 0;
    }

    function onTouchMove(e: TouchEvent) {
      if (busy.current || window.scrollY > 4) return;
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
  }, [containerRef, enabled, onRefresh, threshold]);

  return { pulling, refreshing };
}
