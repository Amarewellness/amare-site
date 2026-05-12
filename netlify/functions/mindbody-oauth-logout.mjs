import { cookieSecureFlag, safeReturnPath } from "./oauth-lib.mjs";

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const ret = safeReturnPath(qs.return || "/classes");
  const clear = "mb_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + cookieSecureFlag(event.headers);
  return {
    statusCode: 302,
    headers: {
      Location: ret,
      "Set-Cookie": clear,
      "Cache-Control": "no-store",
    },
  };
}
