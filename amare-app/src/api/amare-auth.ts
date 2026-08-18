import { apiBase, applyTunnelHeaders, saveAuth, saveProfileTxToken, saveSessionKind } from "../config";

export type AmareAuthResponse = {
  ok?: boolean;
  error?: string;
  signedIn?: boolean;
  amareUserId?: string;
  claimStatus?: string;
  status?: string;
  maskedEmail?: string | null;
  purchaseConnected?: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  sessionKind?: "amare" | "mindbody";
  profileTxToken?: string | null;
  field?: string;
};

function persistTokens(data: AmareAuthResponse) {
  if (data.accessToken && data.refreshToken) {
    saveAuth(data.accessToken, data.refreshToken, data.sessionKind || "amare");
  }
  if (data.profileTxToken) saveProfileTxToken(data.profileTxToken);
  else if (data.claimStatus && data.claimStatus !== "needs_profile") {
    saveProfileTxToken(null);
  }
  if (data.accessToken) saveSessionKind("amare");
}

async function postAmare(path: string, body: Record<string, unknown>, accessToken?: string | null) {
  const url = `${apiBase()}${path}`;
  const headers = applyTunnelHeaders(new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  }), url);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as AmareAuthResponse;
  if (!res.ok) {
    throw new Error(data.error || `amare_auth_${res.status}`);
  }
  persistTokens(data);
  return data;
}

export function sanitizeOrderIdHint(raw: string | null | undefined): string {
  const value = String(raw || "").trim();
  return /^ord_[A-Z0-9]{8,40}$/i.test(value) ? value : "";
}

export async function requestEmailOtp(email: string) {
  return postAmare("/api/amare/auth/email/request-code", { email });
}

export async function verifyEmailOtp(email: string, code: string, orderId?: string) {
  const body: Record<string, unknown> = { email, code };
  const hint = sanitizeOrderIdHint(orderId);
  if (hint) body.orderId = hint;
  return postAmare("/api/amare/auth/email/verify-code", body);
}

export async function confirmCandidateProfile(accessToken: string) {
  return postAmare("/api/amare/auth/claim/confirm", { explicitConfirm: true }, accessToken);
}

export async function beginProfileTx(accessToken: string) {
  return postAmare("/api/amare/auth/profile/begin", {}, accessToken);
}

export async function createStudioProfile(
  accessToken: string,
  fields: { firstName: string; lastName: string; mobilePhone: string; profileTx?: string | null },
) {
  return postAmare(
    "/api/amare/auth/profile/create",
    {
      firstName: fields.firstName,
      lastName: fields.lastName,
      mobilePhone: fields.mobilePhone,
      explicitCreate: true,
      profileTx: fields.profileTx || undefined,
    },
    accessToken,
  );
}

export type MemberAccess = {
  signedIn: boolean;
  studioAccess?: string;
  studioOperations?: boolean;
  email?: string | null;
  displayName?: string | null;
};

export async function fetchMemberAccess(accessToken: string): Promise<MemberAccess> {
  const url = `${apiBase()}/api/amare/auth/member-access`;
  const res = await fetch(url, {
    headers: applyTunnelHeaders(
      new Headers({ Accept: "application/json", Authorization: `Bearer ${accessToken}` }),
      url,
    ),
  });
  const data = (await res.json().catch(() => ({}))) as MemberAccess & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `member_access_${res.status}`);
  }
  return data;
}
