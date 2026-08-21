import { Capacitor } from "@capacitor/core";

function readEnvInset(side: "top" | "bottom"): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;" +
    (side === "top"
      ? "padding-top:env(safe-area-inset-top,0px)"
      : "padding-bottom:env(safe-area-inset-bottom,0px)");
  document.documentElement.appendChild(probe);
  const value = Number.parseFloat(getComputedStyle(probe)[side === "top" ? "paddingTop" : "paddingBottom"]) || 0;
  probe.remove();
  return value;
}

function isFullBleedViewport(): boolean {
  return window.innerHeight >= window.screen.height * 0.93;
}

/** Apply CSS safe-area vars. Android WebView sometimes reports env() as 0 while drawing under the status bar. */
export function applySafeAreaInsets() {
  const root = document.documentElement;
  const top = readEnvInset("top");
  const bottom = readEnvInset("bottom");
  if (top > 0) {
    root.style.setProperty("--safe-top", `${top}px`);
  } else if (Capacitor.getPlatform() === "android" && isFullBleedViewport()) {
    root.style.setProperty("--safe-top", "47px");
  }
  if (bottom > 0) {
    root.style.setProperty("--safe-bottom", `${bottom}px`);
  } else if (Capacitor.getPlatform() === "android" && isFullBleedViewport()) {
    root.style.setProperty("--safe-bottom", "32px");
  }
}
