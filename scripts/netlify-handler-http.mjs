/**
 * Adapters Node HTTP <-> Netlify Lambda-style event/response for local dev.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {URL} url
 */
export async function toNetlifyEvent(req, url) {
  const buf = await readBody(req);
  const bodyStr = buf.length ? buf.toString("utf8") : "";
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
    else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
  }
  const qp = Object.fromEntries(url.searchParams.entries());
  return {
    httpMethod: req.method || "GET",
    path: url.pathname,
    rawQuery: url.search.replace(/^\?/, ""),
    queryStringParameters: Object.keys(qp).length ? qp : null,
    headers,
    body: bodyStr || null,
    isBase64Encoded: false,
  };
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {import("@netlify/functions").HandlerResponse} out
 */
export function sendLambdaHttpResponse(res, out) {
  if (!out) {
    res.statusCode = 500;
    res.end();
    return;
  }
  res.statusCode = out.statusCode ?? 200;
  if (out.headers) {
    for (const [k, v] of Object.entries(out.headers)) {
      if (v !== undefined) res.setHeader(k, v);
    }
  }
  if (out.multiValueHeaders) {
    for (const [k, vals] of Object.entries(out.multiValueHeaders)) {
      for (const v of vals) res.appendHeader(k, v);
    }
  }
  res.end(out.body ?? "");
}
