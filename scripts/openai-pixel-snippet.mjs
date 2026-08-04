/**
 * OpenAI Ads Measurement Pixel — build-time head snippet.
 * @see https://developers.openai.com/ads/measurement-pixel
 */

/** Escape single quotes for safe embedding inside inline script strings. */
function escapeJsSingleQuoted(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * @param {string} pixelId
 * @param {boolean} debugEnabled
 * @returns {string}
 */
export function openaiHeadSnippet(pixelId, debugEnabled = false) {
  const id = pixelId.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return "";
  const idJs = escapeJsSingleQuoted(id);
  const debugLine = debugEnabled ? `\n    debug: true,` : "";
  return `
  <link rel="preconnect" href="https://bzrcdn.openai.com" />
  <script>
    (function (w, d, s, u) {
      if (w.oaiq) return;
      var q = function () {
        q.q.push(arguments);
      };
      q.q = [];
      w.oaiq = q;
      var js = d.createElement(s);
      js.async = true;
      js.src = u;
      var f = d.getElementsByTagName(s)[0];
      f.parentNode.insertBefore(js, f);
    })(window, document, "script", "https://bzrcdn.openai.com/sdk/oaiq.min.js");

    oaiq("init", {
      pixelId: "${idJs}",${debugLine}
    });
  </script>
`;
}

/**
 * Resolve debug flag from env — only literal "true" enables debug.
 * @param {string | undefined} raw
 */
export function openaiPixelDebugEnabled(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase() === "true";
}
