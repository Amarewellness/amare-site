/**
 * Source-controlled product features (stable, not rollout kill switches).
 * Operational toggles (auth master, mobile bearer, commerce, etc.) stay on env.
 */

export const AMARE_FEATURES = Object.freeze({
  /** Google OIDC login — permanently off; product is Email + OTP. */
  googleAuth: false,
});

/** Local/CI QA only (`npm run test:amare-auth-2a3`). Never set in Netlify Functions production. */
export function qaGoogleAuthOverrideEnabled() {
  return (process.env.QA_AMARE_GOOGLE_AUTH || "").trim() === "1";
}

export function amareGoogleAuthFeatureEnabled() {
  return AMARE_FEATURES.googleAuth === true || qaGoogleAuthOverrideEnabled();
}
