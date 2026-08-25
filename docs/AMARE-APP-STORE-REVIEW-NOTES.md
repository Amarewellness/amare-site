# AMARÉ App — Store Review Notes

Paste-ready copy for **App Store Connect** (App Review Information → Notes) and **Google Play Console** (App content → App access / review notes).

Related: [`AMARE-APP-PLAN.md`](./AMARE-APP-PLAN.md) §10, [`../src/content/privacy.html`](../src/content/privacy.html) §7.

---

## Account deletion (required)

```text
Account deletion is available in the app at Profile → Delete AMARÉ app account.

The user re-verifies with a one-time code sent to their sign-in email before deletion is completed.

When deletion is confirmed:
- The AMARÉ app account is deleted/deactivated and AMARÉ app sign-in access is removed.
- Active AMARÉ app sessions and mobile access tokens are revoked.
- Push notification tokens and in-app notification preferences for that account are deleted.
- The user is signed out of the app.

Deleting the AMARÉ app account does NOT cancel memberships, billing, class credits, or upcoming bookings. Mindbody studio records (client profile, visits, reservations) are handled separately by the studio and may be retained. For billing, membership, or booking changes, users should contact the studio via the in-app Contact screen or info@amarewellness.com.
```

---

## Full review notes (MVP)

```text
Sign-in uses email one-time passcode (OTP) through AMARÉ’s backend. The app does not offer standalone Google or Apple login buttons.

Account deletion is available at Profile → Delete AMARÉ app account. The user re-verifies with email OTP before deletion. AMARÉ app access, sessions, mobile tokens, and push tokens are removed; the user is signed out. Deletion does not cancel memberships, billing, credits, or bookings. Mindbody studio records are handled separately by the studio.

The app does not process payments for digital content. Class packages and memberships are physical in-studio services. Purchase flows use Stripe where enabled for in-studio services.

Push notifications are optional and used for booking confirmations and class reminders when the user opts in.

Privacy Policy: https://www.amarewellness.com/privacy
Support / Contact: https://www.amarewellness.com/contact
Google Play account deletion URL: https://www.amarewellness.com/mobile-account-deletion
(alternate: https://www.amarewellness.com/account-deletion)
```

---

## Checklist (pre-submission)

- [x] In-app account deletion path — Profile → Delete AMARÉ app account
- [x] Privacy Policy §7 — mobile app account deletion
- [x] Public account deletion info page — `/mobile-account-deletion` (alias `/account-deletion`)
- [ ] App Privacy labels (App Store Connect)
- [ ] Google Play Data safety form
- [ ] Staging E2E — delete → sign-in → same-email re-register → re-link
