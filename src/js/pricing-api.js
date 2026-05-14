/**
 * /pricing-api — Mirrors standard pricing layout; catalog from Mindbody GET sale/services + GET sale/contracts (proxied).
 *
 * **`PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED`** — modal + POST `/checkout` / `purchase-contract` (Mindbody/API express).
 * **`false`** (Classic): Subscribe/Buy opens Mindbody Classic in a **new tab** (`buyHref`), no intermediate dialog when the URL is built.
 */

(function pricingApiBootstrap() {
  const root = document.getElementById("mb-pricing-root");
  const cfgEl = document.getElementById("mb-pricing-config");
  const statusEl = document.getElementById("mb-pricing-api-status");
  const mountNew = document.getElementById("mb-pricing-mount-new-client");
  const mountMonthly = document.getElementById("mb-pricing-mount-monthlies");
  const mountPacks = document.getElementById("mb-pricing-mount-packs");
  const mountDrop = document.getElementById("mb-pricing-mount-dropins");
  const dlg = /** @type {HTMLDialogElement | null} */ (document.getElementById("mb-pricing-checkout-dialog"));
  const dlgBody = document.getElementById("mb-pricing-checkout-body");
  const dlgActions = document.getElementById("mb-pricing-checkout-actions");

  /**
   * Required scaffolding: the JSON config blob, the root container, the status banner,
   * and the shared checkout dialog. Section mounts are optional so the page can render
   * any subset of categories statically — currently `/pricing` ships the New Client
   * Special card as static HTML (instant render; no API roundtrip for the
   * above-the-fold card) while monthly / packs / drop-ins still come from the live
   * Mindbody catalog. The static button uses `data-mb-checkout="<serviceId>"` so the
   * existing click delegation below picks it up the same way as a dynamically rendered
   * button.
   */
  if (!root || !cfgEl || !statusEl || !dlg || !dlgBody || !dlgActions) return;
  if (!mountNew && !mountMonthly && !mountPacks && !mountDrop) return;

  /** Full API row keyed by Subscribe/Buy buttons (dataset trims contract terms); used for checkout dialog. */
  const checkoutBtnRowRef = new WeakMap();

  /** @type {{ classicStudioId: string; packageSaleType: string; contractSaleType: string; staticPricingHref: string; monthlyProductIds?: string[]; saleLocationId?: string; monthlyContractFallback?: unknown[] }} */
  let cfg;
  /** Default monthly rows — same IDs as Mindbody Contracts API for Amare; used if build omits `monthlyContractFallback`. */
  const defaultMonthlyFallback = [
    { name: "Recurring 5", contractProductId: 101, checkoutServiceId: 100129, price: 125 },
    { name: "Recurring 8", contractProductId: 102, checkoutServiceId: 100130, price: 179 },
    { name: "Unlimited", contractProductId: 100, checkoutServiceId: 100056, price: 229 },
  ];
  try {
    cfg = JSON.parse(cfgEl.textContent || "{}");
  } catch {
    cfg = {
      classicStudioId: "",
      packageSaleType: "43",
      contractSaleType: "40",
      staticPricingHref: "pricing.html",
      monthlyProductIds: ["100", "101", "102"],
      saleLocationId: "1",
      monthlyContractFallback: defaultMonthlyFallback,
    };
  }
  if (!Array.isArray(cfg.monthlyProductIds)) {
    cfg.monthlyProductIds = ["100", "101", "102"];
  }
  if (!(typeof cfg.saleLocationId === "string" && cfg.saleLocationId.trim())) {
    cfg.saleLocationId = "1";
  }
  if (!Array.isArray(cfg.monthlyContractFallback)) {
    cfg.monthlyContractFallback = defaultMonthlyFallback;
  }

  const termsCfgEl = document.getElementById("mb-contract-terms-config");
  /** @type {{ byMindbodyProductId?: Record<string, Record<string, unknown>>, byCheckoutServiceId?: Record<string, Record<string, unknown>>, aliasesByNormalizedName?: Record<string, string> }} */
  let mbContractTerms = {};
  try {
    mbContractTerms = JSON.parse(termsCfgEl?.textContent || "{}");
  } catch {
    mbContractTerms = {};
  }

  /**
   * Stripe → Mindbody one-time express checkout config (build-time embed from
   * `netlify/functions/_embedded/stripe-mindbody-catalog.config.json`).
   * Server is the source of truth for amount + Mindbody item type — this client config only
   * decides whether to render an Express CTA on the row.
   */
  /** @type {{ enabled: boolean; apiPath: string; successPath: string; cancelPath: string; expressEnabledServiceIds: number[]; expressEnabledSkus: { localSku: string; displayName: string; mindbodyServiceId: number | null; nameMatchAny: string[]; nameMatchExclude: string[]; kind: string }[] }} */
  let stripeOneTimeCfg = {
    enabled: false,
    apiPath: "/api/stripe/checkout/create-session",
    successPath: "/checkout/success",
    cancelPath: "/checkout/cancel",
    expressEnabledServiceIds: [],
    expressEnabledSkus: [],
  };
  try {
    const sEl = document.getElementById("mb-stripe-onetime-config");
    if (sEl?.textContent) {
      const parsed = JSON.parse(sEl.textContent);
      if (parsed && typeof parsed === "object") stripeOneTimeCfg = { ...stripeOneTimeCfg, ...parsed };
    }
  } catch {
    /* keep defaults */
  }
  const stripeExpressEnabledIds = new Set(
    (stripeOneTimeCfg.expressEnabledServiceIds || []).filter((n) => typeof n === "number" && Number.isFinite(n)),
  );

  /**
   * Stripe → Mindbody recurring monthly memberships config (Option A — Stripe handles
   * billing, Mindbody syncs as Pricing Option grants on every `invoice.paid`).
   *
   * Build-time embed from the same `stripe-mindbody-catalog.config.json` used by the
   * one-time flow, but filtered to only include `kind: monthlyMembership` rows that are
   * `enabled: true` AND `stripeMode: subscription`. Frontend kill switch
   * `ENABLE_STRIPE_RECURRING_CHECKOUT_FRONTEND=1` (defaults OFF). With either flag OFF
   * the membership purchase falls through to the existing Mindbody Classic flow,
   * byte-identical to the pre-recurring code path.
   *
   * Both this frontend flag AND the server-side `ENABLE_STRIPE_RECURRING_CHECKOUT=1`
   * must be ON for the new flow to fire — the server does its own gate so a stale
   * frontend can never start a Stripe Subscription.
   */
  /** @type {{ enabled: boolean; apiPath: string; successPath: string; cancelPath: string; byMindbodyServiceId: Record<string, { localSku: string; displayName: string; monthlyAmountCents: number; mindbodyContractProductId: string | null; minimumCommitmentMonths: number | null; earlyCancellationFeePercent: number | null }> }} */
  let stripeRecurringCfg = {
    enabled: false,
    apiPath: "/api/stripe/checkout/create-session",
    successPath: "/checkout/success",
    cancelPath: "/checkout/cancel",
    byMindbodyServiceId: {},
  };
  try {
    const rEl = document.getElementById("mb-stripe-recurring-config");
    if (rEl?.textContent) {
      const parsed = JSON.parse(rEl.textContent);
      if (parsed && typeof parsed === "object") stripeRecurringCfg = { ...stripeRecurringCfg, ...parsed };
    }
  } catch {
    /* keep defaults */
  }

  /**
   * Resolve a Stripe recurring membership SKU for a given Mindbody Pricing Option id.
   * Returns null when:
   *   • The frontend flag is off, OR
   *   • The id is not in the `byMindbodyServiceId` map (legacy services / disabled SKUs).
   *
   * Either condition makes the click handler fall through to Mindbody Classic — exact
   * pre-recurring behaviour. No partial-state UX.
   *
   * @param {number | string | null | undefined} svcId
   * @returns {{ localSku: string; displayName: string; monthlyAmountCents: number; mindbodyContractProductId: string | null; minimumCommitmentMonths: number | null; earlyCancellationFeePercent: number | null } | null}
   */
  function lookupStripeRecurringSku(svcId) {
    if (!stripeRecurringCfg.enabled) return null;
    if (svcId == null) return null;
    const key = String(svcId).trim();
    if (!key) return null;
    const entry = stripeRecurringCfg.byMindbodyServiceId?.[key];
    if (!entry || typeof entry !== "object" || typeof entry.localSku !== "string" || !entry.localSku)
      return null;
    return entry;
  }

  const MSG_MEMBERSHIP_UNAVAILABLE_ONLINE =
    "This membership is temporarily unavailable online. Please contact us and we'll help you complete your purchase.";

  const DEFAULT_CHECKBOX_AGREEMENT =
    "I have read and agree to the Membership Agreement, cancellation policy, and recurring billing terms.";
  const DEFAULT_CHECKBOX_BILLING_AUTH =
    "I authorize Amaré Wellness Studio to charge my selected payment method monthly until I cancel according to the membership terms.";
  /** When terms are shown from Mindbody API only (no canonical `contractVersion` row in config). Server must accept this token. */
  const MEMBERSHIP_API_CONTRACT_VERSION_MARKER = "mindbody-api-v1";

  const DEFAULT_API_MEMBERSHIP_SUMMARY = [
    "Renews monthly until canceled — your card is charged on each billing date.",
    "Class allowance matches the plan you selected for each billing period.",
    "Cancellation, no-show, and commitment rules are described in the agreement below.",
  ];

  /**
   * Mindbody on-domain CheckoutShoppingCart + PurchaseContract (saved wallet / `/client/stored-cards` preflight).
   * Set **`true`** for EXPRESS: Subscribe/Buy opens the modal (OAuth → optional on-site Mindbody APIs).
   * While **`false`** (Classic): Subscribe/Buy opens `buyHref()` in a **new tab** immediately — **no modal** —
   * same URL pattern (`studioid` + `stype` + `prodid`). Modal + POST handlers stay in this file for future EXPRESS.
   */
  const PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED = false;

  /** Static rows (`pricing.html` parity) when `/api/mindbody/sale/contracts` returns 404 or no contracts. */
  function fallbackMonthlyRowsFromConfig() {
    /** @type {Record<string, unknown>[]} */
    const out = [];
    for (const raw of /** @type {unknown[]} */ (cfg.monthlyContractFallback || [])) {
      if (!raw || typeof raw !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (raw);
      const name = String(r.name ?? r.Name ?? "").trim();
      const pid = Number(r.contractProductId ?? r.contractProductID ?? r.ProductId);
      const sid = Number(r.checkoutServiceId ?? r.CheckoutServiceId ?? r.Id);
      const price = Number(r.price ?? r.Price);
      if (!name || !Number.isFinite(pid) || !Number.isFinite(sid)) continue;
      /** @type {Record<string, unknown>} */
      const row = {
        Name: name,
        ProductId: pid,
        Id: sid,
        MembershipTerms: [{ __fromPricingFallbackRow: true }],
        __mbContract: true,
        __pricingFallback: true,
      };
      if (Number.isFinite(price)) {
        row.OnlinePrice = price;
        row.Price = price;
      }
      out.push(row);
    }
    return out;
  }

  /** Tunnels outside production often omit `/api/*` → 404; helps avoid chasing “Mindbody bugs”. */
  function isTunnelOrEphemeralHostname() {
    try {
      const h = window.location.hostname;
      return /ngrok/i.test(h) || /trycloudflare\.com$/i.test(h) || /loca\.lt$/i.test(h) || /\.serveo\.net$/i.test(h);
    } catch {
      return false;
    }
  }

  /** GA4 — parity with delegated `trackEvent` in `main.js`; never throws. */
  function ga4Event(eventName, /** @type {Record<string, string | undefined>} */ params) {
    if (typeof window.gtag !== "function") return;
    /** @type {Record<string, string>} */
    const payload = {
      page_location: typeof window.location !== "undefined" ? window.location.href : "",
      page_title: typeof document !== "undefined" ? document.title || "" : "",
    };
    if (params)
      Object.keys(params).forEach((k) => {
        const v = params[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") payload[k] = String(v).trim();
      });
    try {
      window.gtag("event", eventName, payload);
    } catch {
      /* noop */
    }
  }

  /**
   * Fires when Pricing dialog detects zero stored-wallet cards (`GET …/stored-cards`).
   * @param {{ skuLabel: string; isRecurring: boolean; checkoutServiceId?: number|null }} meta
   */
  function trackPricingWalletEmptyPreflight(meta) {
    ga4Event("no_stored_card", {
      checkout_stage: "preflight_modal",
      cta_location: "pricing_api_checkout_modal",
      sku_label: meta.skuLabel,
      sku_type: meta.isRecurring ? "membership" : "package",
      checkout_service_id:
        typeof meta.checkoutServiceId === "number" && Number.isFinite(meta.checkoutServiceId)
          ? String(meta.checkoutServiceId)
          : undefined,
    });
  }

  /**
   * Delegated `main.js` emits buy_package_click / buy_membership_click from `data-track`.
   * Explicit `data-track` suppresses host-based mindbody_click — add mindbody_click once here.
   * @param {string} href
   */
  function trackHostedMindbodyClickOnly(href) {
    ga4Event("mindbody_click", {
      link_url: href,
      button_text: "Continue to Mindbody checkout",
      cta_location: "pricing_api_hosted_checkout_no_stored_card",
    });
  }

  /** From a live click handler only — call before any `await` so the tab opens (Classic mode). */
  function openMindbodyClassicInNewTab(href) {
    try {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      window.open(href, "_blank");
    }
  }

  /** Explain 404 + manifest red herring for ngrok free. */
  function tunnelUpstream404HintInner() {
    return (
      `<strong>Setup:</strong> <code>/api/mindbody/…</code> returned <strong>404</strong> — the URL in front of this page is usually <em>not</em> forwarding to a server that runs site + Netlify-style API routes. ` +
      `Point your tunnel at <strong>npm run dev:full</strong>’s HTTP port (<strong>4321</strong> by default), not the Mindbody-only proxy (<strong>8787</strong>), not plain static/<code>dist</code>-only hosts, and deploy production on Netlify with Functions. ` +
      `<code>site.webmanifest</code> “syntax error” on ngrok Free is usually the HTML interstitial page served instead of JSON.`
    );
  }

  function tunnelUpstream404HintPlain() {
    return (
      `Setup: /api/mindbody/* returned 404 — the host in front of this page usually is not forwarding to a server that runs the site plus Netlify-style API routes.\n\n` +
      `→ Run \`npm run dev\` (same as dev:full — unified server, default port 4321) and point your tunnel at **that** HTTP port. Not: Mindbody-only proxy 8787 alone, not \`npm run dev:static\` / \`serve dist\` / live-server without Functions.\n\n` +
      `Production: Netlify deploy with Functions (latest \`netlify.toml\` must include \`/api/mindbody/sale/checkout\` and \`/api/mindbody/sale/purchase-contract\`). Trigger a new deploy after pulling contract checkout code.\n\n` +
      `site.webmanifest "syntax error" on ngrok Free is often the HTML interstitial served instead of JSON (same root cause).`
    );
  }

  /**
   * Plain "Not found" / HTML responses on POST /api/mindbody/sale/* usually mean static hosting or wrong upstream.
   * @param {string} postPath e.g. `/api/mindbody/sale/purchase-contract`
   * @param {string} responseText
   */
  function apiMindbodyPost404Hint(postPath, responseText) {
    const t = (responseText || "").trim();
    const tl = t.toLowerCase();
    const looksStatic =
      tl === "not found" ||
      tl === "404 not found" ||
      /^not found\s*$/i.test(t) ||
      /<html[\s>]|<!doctype html/i.test(t);
    return (
      `You posted to: ${postPath}\n\n` +
      `HTTP 404 here usually means the process serving this page **does not implement** Netlify-style API routes — not a Mindbody business error.\n\n` +
      (looksStatic
        ? `A plain "Not found" (or HTML) body is typical of static file servers. Use \`npm run dev\` on port 4321 with your tunnel, or a full Netlify deployment with Functions.\n\n`
        : "") +
      `If you are already on Netlify, **redeploy** so the \`mindbody-sale-purchase-contract\` function and its redirect are live.\n\n`
    );
  }

  /** Numeric ids on a service row (product + service) for allowlist matching — see `MINDBODY_CONTRACT_PRODUCT_IDS` / `pricing.html`. */
  /** @param {unknown} row */
  function rowPricingOptionIds(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    /** @type {string[]} */
    const out = [];
    for (const k of ["ProductId", "productId", "ProductID", "Id", "ID", "ServiceId", "ServiceID"]) {
      const v = r[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out.push(String(Math.trunc(v)));
      else if (typeof v === "string" && /^\d+$/.test(v.trim())) out.push(v.trim());
    }
    return [...new Set(out)];
  }

  /** Matches Mindbody Classic **stype=40** rows (recurring / contract checkout) like `pricing.html` prodid links. */
  /** @param {unknown} row */
  function matchesMonthlyProductAllowlist(row) {
    const allow = cfg.monthlyProductIds || [];
    if (!allow.length) return false;
    const set = new Set(allow.map(String));
    for (const id of rowPricingOptionIds(row)) {
      if (set.has(id)) return true;
    }
    return false;
  }

  /** @param {unknown} row */
  function guessContract(row) {
    const r = /** @type {Record<string, unknown>} */ (row);

    if (matchesMonthlyProductAllowlist(row)) return true;

    const mt = r.MembershipTerms ?? r.membershipTerms;
    if (Array.isArray(mt) && mt.length > 0) return true;

    const bits = [
      rowName(row),
      typeof r.Description === "string" ? r.Description : "",
      typeof r.ShortDescription === "string" ? r.ShortDescription : "",
    ];
    const prog = r.Program ?? r.program;
    if (prog && typeof prog === "object") {
      const p = /** @type {Record<string, unknown>} */ (prog);
      bits.push(String(p.Name ?? p.name ?? ""));
    }
    const blob = bits.join(" ").toLowerCase();

    if (
      /\b(recurring|unlimited|monthly|membership|subscription|autopay|auto-?pay|month\s*to\s*month|month-to-month|contract\s+plan|studio\s+membership)\b/.test(
        blob,
      )
    )
      return true;

    if (/\b\d+\s+classes?\s+(each\s+)?(per\s+)?month\b/.test(blob)) return true;
    if (/\bunlimited\s+(monthly\s+)?classes?\b/.test(blob)) return true;

    const ft = String(r.FrequencyType ?? r.frequencyType ?? r.Frequency ?? "").toLowerCase();
    if (ft && /\b(month|week|year|billing)/.test(ft)) return true;

    const nameOnly = rowName(row);
    // Do NOT use `\bmonth\b` alone — it matches inside "months" (pack validity).
    return /\b(monthly|membership|recurring|subscription|unlimited|per\s*month)\b/i.test(nameOnly);
  }

  /** Conservative strip for Mindbody terms HTML snippets. */
  function stripScriptsHtml(html) {
    return String(html).replace(
      /<\/(?:script|iframe)\b[\s\S]*?>|<(?:script|iframe)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/(?:script|iframe)>)/gi,
      "",
    );
  }

  /**
   * @param {unknown} node
   * @param {string[]} bucket
   * @param {Set<string>} sig
   * @param {number} depth
   */
  function collectLongStringsFromMindbodyNode(node, bucket, sig, depth) {
    if (depth > 8 || node == null) return;
    if (typeof node === "string") {
      const s = node.trim();
      if (s.length < 24) return;
      const k = s.slice(0, 160);
      if (sig.has(k)) return;
      sig.add(k);
      bucket.push(s);
      return;
    }
    if (Array.isArray(node)) {
      for (const x of node) collectLongStringsFromMindbodyNode(x, bucket, sig, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = /** @type {Record<string, unknown>} */ (node);
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith("__")) continue;
      collectLongStringsFromMindbodyNode(v, bucket, sig, depth + 1);
    }
  }

  /**
   * @param {unknown} term
   * @returns {string}
   */
  function membershipTermsDeepFallbackText(term) {
    if (!term || typeof term !== "object") return "";
    /** @type {string[]} */
    const bucket = [];
    collectLongStringsFromMindbodyNode(term, bucket, new Set(), 0);
    const joined = bucket.join("\n\n");
    if (joined.length > 14000) return `${joined.slice(0, 13800)}\n\n…`;
    return joined;
  }

  /** @param {unknown} row */
  function rowTermsAndConditionsString(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    for (const key of [
      "TermsAndConditions",
      "termsAndConditions",
      "ContractTermsAndConditions",
      "Agreement",
      "agreement",
    ]) {
      const v = r[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  /** @param {unknown} term @param {{ noDeepFallback?: boolean }} [opts] */
  function membershipTermChunkHtml(term, opts) {
    if (!term || typeof term !== "object") return "";
    const o = /** @type {Record<string, unknown>} */ (term);
    const realKeys = Object.keys(o).filter((k) => !k.startsWith("__"));
    if (realKeys.length === 0) return "";

    /** @type {string} */
    let raw = "";
    for (const k of [
      "TermsHtml",
      "termsHtml",
      "Html",
      "html",
      "TermsAndConditions",
      "termsAndConditions",
      "Agreement",
      "agreement",
      "AgreementText",
      "agreementText",
      "AgreementTerms",
      "agreementTerms",
      "WaiverTerms",
      "waiverTerms",
      "RichTextTerms",
      "richTextTerms",
      "MembershipTermsAgreement",
      "membershipTermsAgreement",
      "Terms",
      "terms",
      "ContractText",
      "contractText",
      "Body",
      "body",
      "Text",
      "text",
      "Content",
      "content",
      "Description",
      "description",
      "LongDescription",
      "longDescription",
    ]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) {
        raw = v.trim();
        break;
      }
    }
    if (!raw) {
      const cap =
        typeof o.Caption === "string"
          ? o.Caption.trim()
          : typeof o.Title === "string"
            ? o.Title.trim()
            : typeof o.Name === "string"
              ? o.Name.trim()
              : "";
      const sd =
        typeof o.ShortDescription === "string"
          ? o.ShortDescription.trim()
          : typeof o.Subtitle === "string"
            ? o.Subtitle.trim()
            : "";
      if (cap && sd) raw = `${cap}: ${sd}`;
      else raw = cap || sd;
    }
    if (!raw) {
      if (!opts?.noDeepFallback) raw = membershipTermsDeepFallbackText(term);
    }
    if (!raw.trim()) return "";
    if (/</.test(raw) && />/.test(raw)) return `<div class="mb-pricing-contract-html">${stripScriptsHtml(raw)}</div>`;
    return `<p class="mb-pricing-contract-plain">${escapeHtml(raw).replace(/\r\n|\n|\r/g, "<br/>")}</p>`;
  }

  function mbApiPrefix() {
    const raw = typeof root.dataset.mbProxy === "string" ? root.dataset.mbProxy.trim() : "";
    return raw.replace(/\/$/, "");
  }

  function mbApiPath(path) {
    const p = path.startsWith("/") ? path : `/${path}`;
    const prefix = mbApiPrefix();
    return prefix ? `${prefix}${p}` : p;
  }

  function ngrokBypassHeaders(extra = {}) {
    const out = { ...extra };
    let host = "";
    try {
      host = mbApiPrefix()
        ? new URL(mbApiPrefix(), window.location.href).hostname
        : window.location.hostname;
    } catch {
      host = "";
    }
    if (host.includes("ngrok")) out["ngrok-skip-browser-warning"] = "true";
    return out;
  }

  function servicesUrl() {
    const qs = "SellOnline=true&Limit=200&Offset=0";
    const prefix = mbApiPrefix();
    return prefix ? `${prefix}/api/mindbody/sale/services?${qs}` : `/api/mindbody/sale/services?${qs}`;
  }

  /** Monthly autopay memberships — Mindbody lists these under `/sale/contracts`, not `/sale/services`. */
  function contractsUrl() {
    const loc = encodeURIComponent(cfg.saleLocationId.trim() || "1");
    const qs = `Limit=100&Offset=0&request.locationId=${loc}&request.soldOnline=true`;
    const prefix = mbApiPrefix();
    return prefix ? `${prefix}/api/mindbody/sale/contracts?${qs}` : `/api/mindbody/sale/contracts?${qs}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function roughAsciiLen(s) {
    return String(s)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim().length;
  }

  /** Rich snippets Mindbody may return for memberships (`sale/contracts`, echoed onto unified rows). */
  /** @param {unknown} row */
  function collectApiMembershipHtmlBlocks(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    /** @type {string[]} */
    const blocks = [];
    const tac = rowTermsAndConditionsString(row);
    if (tac.length >= 12) {
      if (/</.test(tac) && />/.test(tac)) blocks.push(`<div class="mb-pricing-contract-html">${stripScriptsHtml(tac)}</div>`);
      else blocks.push(`<p class="mb-pricing-contract-plain">${escapeHtml(tac).replace(/\r\n|\n|\r/g, "<br/>")}</p>`);
    }
    const mt = r.MembershipTerms ?? r.membershipTerms;
    if (Array.isArray(mt)) {
      for (const term of mt) {
        const h = membershipTermChunkHtml(term);
        if (h) blocks.push(h);
      }
    }
    return blocks;
  }

  /** Substantial textual membership clauses returned directly by Mindbody (not UI fluff placeholders alone). */
  /** @param {unknown} row */
  function hasStrictApiMembershipTerms(row) {
    const tac = rowTermsAndConditionsString(row);
    if (roughAsciiLen(tac) >= 45) return true;
    const r = /** @type {Record<string, unknown>} */ (row);
    const mt = r.MembershipTerms ?? r.membershipTerms;
    if (!Array.isArray(mt)) return false;
    for (const term of mt) {
      const chunkNoDeep = membershipTermChunkHtml(term, { noDeepFallback: true });
      if (roughAsciiLen(chunkNoDeep) >= 55) return true;
    }
    return false;
  }

  /** @param {unknown} o */
  function isValidManualContractEntry(o) {
    if (!o || typeof o !== "object") return false;
    const m = /** @type {Record<string, unknown>} */ (o);
    const th = typeof m.termsHtml === "string" ? m.termsHtml.trim() : "";
    const lines = Array.isArray(m.summaryLines) ? m.summaryLines : [];
    return th.length >= 40 || (lines.length >= 2 && th.length >= 20);
  }

  /**
   * Resolve manual entry + stable product key (`byMindbodyProductId`) for consent + version checks.
   * @param {unknown} row
   * @returns {{ manual: Record<string, unknown>; productKey: string } | null}
   */
  function lookupManualContractMeta(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    const byP = mbContractTerms.byMindbodyProductId;
    const byS = mbContractTerms.byCheckoutServiceId;
    const aliases = mbContractTerms.aliasesByNormalizedName;

    const pid = r.ProductId ?? r.productId ?? r.ProductID;
    if (typeof pid === "number" && Number.isFinite(pid) && byP?.[String(Math.trunc(pid))]) {
      const key = String(Math.trunc(pid));
      const hit = byP[key];
      if (isValidManualContractEntry(hit)) return { manual: /** @type {Record<string, unknown>} */ (hit), productKey: key };
    }
    if (typeof pid === "string" && /^\d+$/.test(pid.trim()) && byP?.[pid.trim()]) {
      const key = pid.trim();
      const hit = byP[key];
      if (isValidManualContractEntry(hit)) return { manual: /** @type {Record<string, unknown>} */ (hit), productKey: key };
    }

    const svc = checkoutServiceId(row);
    if (svc != null && byS?.[String(svc)]) {
      const ref = /** @type {unknown} */ (byS[String(svc)]);
      if (typeof ref === "string" && byP?.[ref]) {
        const hit = byP[ref];
        if (isValidManualContractEntry(hit)) return { manual: /** @type {Record<string, unknown>} */ (hit), productKey: ref };
      }
      if (ref && typeof ref === "object" && isValidManualContractEntry(ref)) {
        return { manual: /** @type {Record<string, unknown>} */ (ref), productKey: String(svc) };
      }
    }

    const nk = rowName(row).toLowerCase().replace(/\s+/g, " ").trim();
    if (aliases && nk && typeof aliases === "object") {
      const directRef = aliases[nk];
      if (typeof directRef === "string" && byP?.[directRef]) {
        const hit = byP[directRef];
        if (isValidManualContractEntry(hit)) return { manual: /** @type {Record<string, unknown>} */ (hit), productKey: directRef };
      }
      for (const [aliasKey, idRef] of Object.entries(aliases)) {
        if (typeof idRef !== "string") continue;
        if (!aliasKey.trim()) continue;
        if (nk.includes(aliasKey) || aliasKey.includes(nk)) {
          const hit = byP?.[idRef];
          if (hit && isValidManualContractEntry(hit)) return { manual: /** @type {Record<string, unknown>} */ (hit), productKey: idRef };
        }
      }
    }
    return null;
  }

  /** @param {unknown} row */
  function lookupManualContractEntry(row) {
    return lookupManualContractMeta(row)?.manual ?? null;
  }

  /** Hybrid resolver: Mindbody textual API terms first; else mapped manual copy (`mb-contract-terms.config.json`). Only call when `guessContract(row)`. */
  /** @param {unknown} row */
  function resolveRecurringMembershipTerms(row) {
    /** @typedef {{ hasValidTerms: boolean; source: "api"|"manual"|"none"; sectionTitle: string; summaryLines: string[]; displayHtmlBlocks: string[]; termsSnapshotHtml: string; contractVersion: string; marketingPlanName: string; mindbodyContractProductId: string; checkboxAgreementLabel: string; checkboxBillingAuthLabel: string }} MemResolved */
    /** @type {MemResolved} */
    const stale = {
      hasValidTerms: false,
      source: "none",
      sectionTitle: "Membership terms",
      summaryLines: [],
      displayHtmlBlocks: [],
      termsSnapshotHtml: "",
      contractVersion: "",
      marketingPlanName: "",
      mindbodyContractProductId: "",
      checkboxAgreementLabel: DEFAULT_CHECKBOX_AGREEMENT,
      checkboxBillingAuthLabel: DEFAULT_CHECKBOX_BILLING_AUTH,
    };

    const meta = lookupManualContractMeta(row);
    const manual = meta?.manual ?? null;
    const productKey = meta?.productKey ?? "";
    const manualOk = !!manual && isValidManualContractEntry(manual);
    const strictApi = hasStrictApiMembershipTerms(row);

    const source = strictApi ? /** @type {const} */ ("api") : manualOk ? /** @type {const} */ ("manual") : /** @type {const} */ ("none");
    const hasValidTerms = strictApi || manualOk;

    if (!hasValidTerms) return { ...stale, source: "none", hasValidTerms: false };

    /** @type {string[]} */
    let displayHtmlBlocks = [];
    if (strictApi) displayHtmlBlocks = [...collectApiMembershipHtmlBlocks(row)];
    else if (manualOk && typeof manual?.termsHtml === "string" && manual.termsHtml.trim()) {
      displayHtmlBlocks = [`<div class="mb-pricing-contract-html">${stripScriptsHtml(manual.termsHtml.trim())}</div>`];
    }

    /** @type {string[]} */
    let summaryLines = [];
    if (manualOk && manual && Array.isArray(manual.summaryLines)) {
      summaryLines = manual.summaryLines
        .filter((x) => typeof x === "string" && x.trim())
        /** @type {(x: unknown) => string} */
        .map((x) => /** @type {string} */ (x).trim());
    }
    if (!summaryLines.length) summaryLines = [...DEFAULT_API_MEMBERSHIP_SUMMARY];

    const sectionTitle =
      manualOk && typeof manual?.title === "string" && manual.title.trim()
        ? manual.title.trim()
        : "Membership terms";

    const mid =
      manualOk && typeof manual?.mindbodyContractProductId === "string" && manual.mindbodyContractProductId.trim()
        ? manual.mindbodyContractProductId.trim()
        : productKey;
    const marketingPlanName =
      manualOk && typeof manual?.marketingPlanName === "string" && manual.marketingPlanName.trim()
        ? manual.marketingPlanName.trim()
        : rowName(row);

    const checkboxAgreementLabel =
      manualOk && typeof manual?.checkboxAgreementLabel === "string" && manual.checkboxAgreementLabel.trim()
        ? manual.checkboxAgreementLabel.trim()
        : typeof manual?.checkboxLabel === "string" && manual.checkboxLabel.trim()
          ? manual.checkboxLabel.trim()
          : DEFAULT_CHECKBOX_AGREEMENT;

    const checkboxBillingAuthLabel =
      manualOk && typeof manual?.checkboxBillingAuthLabel === "string" && manual.checkboxBillingAuthLabel.trim()
        ? manual.checkboxBillingAuthLabel.trim()
        : DEFAULT_CHECKBOX_BILLING_AUTH;

    const contractVersion =
      manualOk && typeof manual?.contractVersion === "string" && manual.contractVersion.trim()
        ? manual.contractVersion.trim()
        : strictApi
          ? MEMBERSHIP_API_CONTRACT_VERSION_MARKER
          : "";

    const termsSnapshotHtml = displayHtmlBlocks.join("");

    return {
      hasValidTerms: displayHtmlBlocks.length > 0,
      source,
      sectionTitle,
      summaryLines,
      displayHtmlBlocks,
      termsSnapshotHtml,
      contractVersion,
      marketingPlanName,
      mindbodyContractProductId: mid,
      checkboxAgreementLabel,
      checkboxBillingAuthLabel,
    };
  }

  /**
   * @param {{
   *   hasValidTerms: boolean;
   *   sectionTitle: string;
   *   summaryLines: string[];
   *   displayHtmlBlocks: string[];
   *   checkboxAgreementLabel: string;
   *   checkboxBillingAuthLabel: string;
   *   marketingPlanName: string;
   * }} resolved
   * @param {string} monthlyPriceLine e.g. `$125.00` → shown as `$125.00/month`
   */
  function buildMembershipTermsDialogHtml(resolved, monthlyPriceLine) {
    if (!resolved.hasValidTerms || !resolved.displayHtmlBlocks.length) return "";
    const priceRow =
      monthlyPriceLine.trim().length > 0
        ? `<div class="mb-pricing-membership-planprice">${escapeHtml(monthlyPriceLine.trim())}/month</div>`
        : "";
    const scroll =
      `<div class="mb-pricing-contract-scroll" tabindex="0">` +
      resolved.displayHtmlBlocks.map((h) => `<div class="mb-pricing-contract-block">${h}</div>`).join("") +
      `</div>`;
    const details =
      `<details class="mb-pricing-contract-details">` +
      `<summary class="mb-pricing-contract-details-sum">Full membership agreement (scroll to read)</summary>` +
      scroll +
      `</details>`;
    const agreeChk =
      `<label class="mb-pricing-checkbox mb-pricing-membership-ack">` +
      `<input type="checkbox" id="mb-pricing-membership-agree" autocomplete="off" />` +
      `<span>${escapeHtml(resolved.checkboxAgreementLabel)}</span>` +
      `</label>`;
    const billChk =
      `<label class="mb-pricing-checkbox mb-pricing-membership-ack">` +
      `<input type="checkbox" id="mb-pricing-membership-bill" autocomplete="off" />` +
      `<span>${escapeHtml(resolved.checkboxBillingAuthLabel)}</span>` +
      `</label>`;
    return (
      `<section class="mb-pricing-contract-wrap mb-pricing-contract-wrap--membership" aria-labelledby="mb-pricing-mem-h">` +
      `<h3 id="mb-pricing-mem-h" class="mb-pricing-contract-title">Membership contract</h3>` +
      `<div class="mb-pricing-membership-planhead">` +
      `<div class="mb-pricing-membership-planname">${escapeHtml(resolved.marketingPlanName)}</div>` +
      priceRow +
      `</div>` +
      `<p class="mb-book-dialog__sub">Everything you agree to is in the full agreement below.</p>` +
      details +
      agreeChk +
      billChk +
      `</section>`
    );
  }

  /**
   * @param {unknown} data
   * @returns {Record<string, unknown>[]}
   */
  function rowsFromPayload(data) {
    if (!data || typeof data !== "object") return [];
    const d = /** @type {Record<string, unknown>} */ (data);
    for (const key of ["Services", "services"]) {
      const v = d[key];
      if (Array.isArray(v)) return /** @type {Record<string, unknown>[]} */ (v);
    }
    return [];
  }

  /**
   * @param {unknown} data
   * @returns {Record<string, unknown>[]}
   */
  function rowsFromContractsPayload(data) {
    if (!data || typeof data !== "object") return [];
    const d = /** @type {Record<string, unknown>} */ (data);
    for (const key of ["Contracts", "contracts"]) {
      const v = d[key];
      if (Array.isArray(v)) return /** @type {Record<string, unknown>[]} */ (v);
    }
    return [];
  }

  /**
   * Map a `/sale/contracts` row into `/sale/services`-like fields for rendering + CheckoutShoppingCart
   * (service id from first `ContractItems` pricing-option; Classic `prodid` = contract `Id`).
   * @param {unknown} c
   * @returns {Record<string, unknown> | null}
   */
  function normalizeContractRow(c) {
    const r = /** @type {Record<string, unknown>} */ (c);
    const items = Array.isArray(r.ContractItems) ? r.ContractItems : [];
    const first = items[0] && typeof items[0] === "object" ? /** @type {Record<string, unknown>} */ (items[0]) : null;
    const optIdRaw = first?.Id ?? first?.ID ?? null;
    let optId = null;
    if (typeof optIdRaw === "string" && /^\d+$/.test(optIdRaw.trim())) optId = parseInt(optIdRaw.trim(), 10);
    else if (typeof optIdRaw === "number" && Number.isFinite(optIdRaw) && optIdRaw > 0) optId = optIdRaw;

    const cidRaw = r.Id ?? r.id;
    let contractSaleId = null;
    if (typeof cidRaw === "number" && Number.isFinite(cidRaw) && cidRaw > 0) contractSaleId = cidRaw;
    else if (typeof cidRaw === "string" && /^\d+$/.test(cidRaw.trim())) contractSaleId = parseInt(cidRaw.trim(), 10);

    if (optId == null || contractSaleId == null) return null;

    let price =
      typeof r.RecurringPaymentAmountTotal === "number" && Number.isFinite(r.RecurringPaymentAmountTotal)
        ? r.RecurringPaymentAmountTotal
        : typeof r.FirstPaymentAmountTotal === "number" && Number.isFinite(r.FirstPaymentAmountTotal)
          ? r.FirstPaymentAmountTotal
          : first && typeof first.Price === "number" && Number.isFinite(first.Price)
            ? /** @type {number} */ (first.Price)
            : null;

    const assignMem =
      typeof r.AssignsMembershipName === "string" && r.AssignsMembershipName.trim()
        ? r.AssignsMembershipName.trim()
        : "";
    const rawName = String(r.Name ?? r.name ?? "").trim();
    const label = assignMem || rawName || "Membership";
    const name = label.charAt(0).toUpperCase() + label.slice(1);

    const preservedMt = Array.isArray(r.MembershipTerms)
      ? r.MembershipTerms
      : Array.isArray(r.membershipTerms)
        ? r.membershipTerms
        : [];

    /** Mindbody Contract often exposes global terms separately from MembershipTerms[]. */
    const tac =
      typeof r.TermsAndConditions === "string" && r.TermsAndConditions.trim()
        ? r.TermsAndConditions.trim()
        : typeof r.termsAndConditions === "string" && r.termsAndConditions.trim()
          ? r.termsAndConditions.trim()
          : typeof r.ContractTermsAndConditions === "string" && r.ContractTermsAndConditions.trim()
            ? r.ContractTermsAndConditions.trim()
            : "";

    /** @type {Record<string, unknown>} */
    const out = {
      Name: name,
      Id: optId,
      ProductId: contractSaleId,
      OnlinePrice: price,
      Price: price,
      Description: typeof r.Description === "string" ? r.Description : "",
      ShortDescription:
        typeof r.ShortDescription === "string"
          ? r.ShortDescription
          : typeof first?.Description === "string"
            ? /** @type {string} */ (first.Description)
            : "",
      MembershipTerms: preservedMt.length ? preservedMt : [{ __fromMindbodyContract: true }],
      __mbContract: true,
    };
    if (tac) out.TermsAndConditions = tac;
    else if (typeof r.Agreement === "string" && r.Agreement.trim()) out.TermsAndConditions = r.Agreement.trim();

    return out;
  }

  /**
   * @param {Record<string, unknown>[]} svcMonthly
   * @param {Record<string, unknown>[]} fromContracts
   */
  function mergeMonthlyRows(svcMonthly, fromContracts) {
    /** @type {Record<string, unknown>[]} */
    const out = [];
    const seen = new Set();

    /** @param {unknown} row */
    function bump(row) {
      const ids = rowPricingOptionIds(row);
      const key = ids.length ? ids.sort().join("|") : `n:${rowName(row).toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(/** @type {Record<string, unknown>} */ (row));
    }

    for (const row of svcMonthly) bump(row);
    for (const row of fromContracts) bump(row);
    return out;
  }

  /** @param {unknown} row */
  function rowName(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    return String(r.Name ?? r.name ?? "Service").trim();
  }

  /** @param {unknown} row */
  function rowPrice(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    const candidates = [
      "OnlinePrice",
      "onlinePrice",
      "Price",
      "price",
      "CurrentPrice",
      "RetailPrice",
      "retailPrice",
      "RegularPrice",
      "Amount",
      "amount",
    ];
    for (const k of candidates) {
      const v = r[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const n = Number.parseFloat(v);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  }

  /** @param {unknown} row */
  function checkoutServiceId(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    const sid = r.Id ?? r.ID ?? r.ServiceId ?? r.ServiceID;
    if (typeof sid === "number" && Number.isFinite(sid) && sid > 0) return sid;
    if (typeof sid === "string" && /^\d+$/.test(sid.trim())) return parseInt(sid.trim(), 10);
    const fallback = r.ProductId ?? r.productId ?? r.ProductID;
    if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
    if (typeof fallback === "string" && /^\d+$/.test(fallback.trim())) return parseInt(fallback.trim(), 10);
    return null;
  }

  /** Contract id for `POST …/sale/purchasecontract` — `ProductId` on merged `/sale/contracts` rows (Classic prodid). */
  /** @param {unknown} row */
  function contractPurchaseId(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    const pid = r.ProductId ?? r.productId ?? r.ProductID;
    if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) return pid;
    if (typeof pid === "string" && /^\d+$/.test(pid.trim())) return parseInt(pid.trim(), 10);
    return null;
  }

  /** @param {unknown} row */
  function productOrServiceId(row) {
    const r = /** @type {Record<string, unknown>} */ (row);
    const pid = r.ProductId ?? r.productId ?? r.ProductID;
    const sid = r.Id ?? r.ID ?? r.ServiceId ?? r.ServiceID;
    if (typeof pid === "number" && Number.isFinite(pid)) return pid;
    if (typeof pid === "string" && /^\d+$/.test(pid)) return pid;
    if (typeof sid === "number" && Number.isFinite(sid)) return sid;
    if (typeof sid === "string" && /^\d+$/.test(sid)) return sid;
    return null;
  }

  /** @param {unknown} row */
  function buyHref(row) {
    const sid = cfg.classicStudioId?.trim();
    const prod = productOrServiceId(row);
    if (!sid || prod == null) return null;
    const stype = guessContract(row) ? cfg.contractSaleType : cfg.packageSaleType;
    return (
      `https://clients.mindbodyonline.com/classic/ws?studioid=${encodeURIComponent(sid)}` +
      `&stype=${encodeURIComponent(stype)}&prodid=${encodeURIComponent(String(prod))}`
    );
  }

  function formatMoney(n) {
    if (n == null || !Number.isFinite(n)) return "";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(n);
    } catch {
      return `$${n.toFixed(2)}`;
    }
  }

  /**
   * @param {unknown} row
   * @returns {"newClient"|"monthly"|"packs"|"dropin"}
   */
  function bucketForRow(row) {
    const name = rowName(row).toLowerCase();
    if (/new\s*client|3\s*pack|first.{0,8}time|triple/.test(name)) return "newClient";
    if (/drop|same\s*day|single\s*class|singel/.test(name)) return "dropin";
    // Route multi-visit packs before contract heuristic — names often include "6 months" validity.
    if (/\b(10|20)\s*[-–]?\s*(class\s*)?pack\b|\b(10|20)\s+class\b.*\bpack\b|\b\d+\s*pack\s*-\s*\d+\s*month/i.test(rowName(row)))
      return "packs";
    if (guessContract(row)) return "monthly";
    if (/\b10\b|\b20\b|\bpack\b|class\s*pack/.test(name)) return "packs";
    return "packs";
  }

  /** @param {unknown} row @param {"newClient"|"monthly"|"packs"|"dropin"} bucket */
  function defaultFeatures(row, bucket) {
    const r = /** @type {Record<string, unknown>} */ (row);
    const desc = r.Description ?? r.ShortDescription ?? r.description;
    if (typeof desc === "string" && desc.trim()) {
      return desc
        .split(/\n+|•+|;\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6);
    }
    const name = rowName(row).toLowerCase();
    if (bucket === "newClient")
      return ["3 class access", "Valid for 21 days", "One-time use only"];
    if (bucket === "dropin") {
      if (/same\s*day/.test(name))
        return ["One class", "Valid for 24 hours", "Book same day only", "Subject to availability"];
      return ["One class", "Valid for 1 month", "No commitment"];
    }
    if (bucket === "monthly") {
      return ["Monthly billing", "3-month minimum", "Grip socks gift (see desk)", "Policies apply"];
    }
    return ["Flexible visits", "6-month expiry on packs"];
  }

  /** @param {unknown} row @param {"newClient"|"monthly"|"packs"|"dropin"} bucket */
  function planPeriod(row, bucket) {
    const name = rowName(row).toLowerCase();
    if (bucket === "dropin") return /same\s*day/.test(name) ? "same-day visit" : "per visit";
    if (bucket === "newClient") return "one-time purchase";
    if (bucket === "monthly") return "per month";
    if (/6\s*mo|6\s*month/.test(name)) return "per pack · 6 months";
    return "per pack";
  }

  /** @param {unknown} row @param {"newClient"|"monthly"|"packs"|"dropin"} bucket */
  function perClassHint(row, price, bucket) {
    const name = rowName(row).toLowerCase();
    if (price == null || !Number.isFinite(price)) return "";
    if (bucket === "newClient") {
      const n = /\b3\b/.test(name) ? 3 : null;
      if (n != null) {
        const per = price / n;
        return `~ ${formatMoney(per)} per class`;
      }
      return "";
    }
    if (bucket === "packs") {
      const m = name.match(/(\d+)\s*class/);
      const n = m?.[1] ?? (/\b10\b/.test(name) ? "10" : /\b20\b/.test(name) ? "20" : null);
      if (n != null && Number(n) > 0) {
        const per = price / Number(n);
        return `~ ${formatMoney(per)} per class`;
      }
      return "";
    }
    if (bucket === "monthly") {
      const n = /\b8\b/.test(name) ? "8" : /\b5\b/.test(name) ? "5" : null;
      if (n != null) {
        const per = price / Number(n);
        return `~ ${formatMoney(per)} per class <span class="per-class-sub">(at ${n} classes/mo)</span>`;
      }
    }
    return "";
  }

  /**
   * Display title aligned with static pricing.html (e.g. new client \"3 Classes\").
   * @param {unknown} row
   * @param {"newClient"|"monthly"|"packs"|"dropin"} bucket
   */
  function displayPlanName(row, bucket) {
    const raw = rowName(row);
    if (bucket !== "newClient") return raw;
    const n = raw.toLowerCase();
    if (/\b3\s*(classes|class|pack)\b/.test(n) || (/\bnew\b.*\bclient\b/.test(n) && /\b3\b/.test(n)))
      return "3 Classes";
    return raw;
  }

  /** CTA label — same capitalization as pricing.html (`Buy Now` / `Subscribe`). */
  /** @param {unknown} row */
  function ctaLabel(row) {
    return guessContract(row) ? "Subscribe" : "Buy Now";
  }

  /** @param {unknown} row @param {"newClient"|"monthly"|"packs"|"dropin"} bucket */
  function badgeFor(row, bucket) {
    const name = rowName(row).toLowerCase();
    if (bucket === "newClient") return { text: "First-time clients only", highlight: true };
    if (bucket === "monthly") {
      if (/unlimited/.test(name)) return { text: ".", highlight: false };
      if (/\b8\b|recurring\s*8/.test(name)) return { text: "Most Popular", highlight: true };
      if (/\b5\b|recurring\s*5/.test(name)) return { text: ".", highlight: false };
    }
    if (bucket === "packs" && /20/.test(name)) return { text: "Best Value", highlight: true };
    if (bucket === "packs" && /10/.test(name)) return { text: ".", highlight: false };
    return { text: ".", highlight: false };
  }

  /** @param {HTMLElement} mount */
  function renderEmpty(mount, msg) {
    mount.innerHTML = `<p class="pricing-api-empty">${escapeHtml(msg)}</p>`;
  }

  /**
   * @param {HTMLElement} mount
   * @param {Record<string, unknown>[]} rows
   * @param {"newClient"|"monthly"|"packs"|"dropin"} bucket
   */
  function renderSection(mount, rows, bucket) {
    if (!mount) return;
    mount.innerHTML = "";
    if (!rows.length) {
      renderEmpty(mount, "No matching items in this category from Mindbody.");
      return;
    }
    rows.sort((a, b) => rowName(a).localeCompare(rowName(b), undefined, { sensitivity: "base" }));

    const rowWrap = document.createElement("div");
    rowWrap.className = bucket === "newClient" ? "cards-row new-client-row" : "cards-row";

    for (const row of rows) {
      const price = rowPrice(row);
      const href = buyHref(row);
      const svcId = checkoutServiceId(row);
      const { text: badgeText, highlight } = badgeFor(row, bucket);
      const period = planPeriod(row, bucket);
      const features = defaultFeatures(row, bucket);
      const perLine = perClassHint(row, price, bucket);
      const showName = displayPlanName(row, bucket);

      const card = document.createElement("div");
      /** Match pricing.html: `no-badge` only when the badge is a dot placeholder */
      /** @type {string[]} */
      const cardClasses = ["pkg-card"];
      if (badgeText === ".") cardClasses.push("no-badge");
      if (highlight) cardClasses.push("highlight");
      card.className = cardClasses.join(" ");

      const badge = document.createElement("div");
      badge.className = "badge";
      badge.textContent = badgeText;

      const nameEl = document.createElement("div");
      nameEl.className = "plan-name";
      nameEl.textContent = showName;

      const priceEl = document.createElement("div");
      priceEl.className = "plan-price";
      priceEl.textContent = formatMoney(price) || "See Mindbody";

      card.append(badge, nameEl, priceEl);

      if (period) {
        const periodEl = document.createElement("div");
        periodEl.className = "plan-period";
        periodEl.textContent = period;
        card.append(periodEl);
      }

      if (perLine) {
        const pcl = document.createElement("div");
        pcl.className = "per-class";
        pcl.innerHTML = perLine;
        card.append(pcl);
      }

      if (bucket === "monthly") {
        const gift = document.createElement("div");
        gift.className = /unlimited/i.test(rowName(row))
          ? "plan-gift plan-gift--after-period"
          : "plan-gift";
        gift.textContent = "Gift included";
        gift.setAttribute("aria-label", "A complimentary gift is included with this plan");
        card.append(gift);
      }

      const ul = document.createElement("ul");
      ul.className = "features";
      for (const f of features) {
        const li = document.createElement("li");
        li.textContent = f;
        ul.append(li);
      }
      card.append(ul);

      const recurring = guessContract(row);
      const memResolved = recurring ? resolveRecurringMembershipTerms(row) : null;
      if (recurring && memResolved && !memResolved.hasValidTerms) {
        const unavail = document.createElement("p");
        unavail.className = "pricing-api-membership-unavail-msg";
        unavail.textContent = MSG_MEMBERSHIP_UNAVAILABLE_ONLINE;
        card.append(unavail);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cta";
        btn.textContent = ctaLabel(row);
        btn.setAttribute(
          "data-mb-checkout",
          svcId != null ? String(svcId) : "",
        );
        if (href) btn.dataset.mbClassicHref = href;
        btn.dataset.mbLabel = showName;
        if (price != null && Number.isFinite(price)) btn.dataset.mbPrice = String(price);
        checkoutBtnRowRef.set(btn, /** @type {Record<string, unknown>} */ (row));
        card.append(btn);
      }

      rowWrap.append(card);
    }

    mount.append(rowWrap);
  }

  /** @param {unknown} j */
  function isLoggedInPayload(j) {
    if (!j || typeof j !== "object") return false;
    if (j.authenticated === false || j.loggedIn === false) return false;
    return !!(j.email || j.name || j.displayName || j.authenticated === true || j.loggedIn === true);
  }

  /**
   * `/oauth/session` only checks the sealed cookie — it does **not** call Mindbody refresh.
   * Stale refresh tokens (`invalid_grant`) still show “logged in” until an API tries to refresh.
   * @param {number} httpStatus
   * @param {unknown} jsonBody
   */
  function mindbodyApiRequiresReauth(httpStatus, jsonBody) {
    if (httpStatus !== 401) return false;
    if (!jsonBody || typeof jsonBody !== "object") return true;
    const o = /** @type {Record<string, unknown>} */ (jsonBody);
    const err = typeof o.error === "string" ? o.error : "";
    if (
      err === "token_refresh_failed" ||
      err === "invalid_session" ||
      err === "missing_refresh_token" ||
      err === "not_authenticated"
    ) {
      return true;
    }
    const detail = o.detail;
    if (typeof detail === "string" && /invalid_grant/i.test(detail)) return true;
    return false;
  }

  async function fetchSession() {
    try {
      const res = await fetch(mbApiPath("/api/mindbody/oauth/session"), {
        credentials: "include",
        headers: ngrokBypassHeaders({ Accept: "application/json" }),
      });
      const txt = await res.text();
      let data = null;
      try {
        data = txt ? JSON.parse(txt) : null;
      } catch {
        data = null;
      }
      if (!res.ok) return { ok: false, data };
      return { ok: true, data };
    } catch {
      return { ok: false, data: null };
    }
  }

  /** Must match `MB_PENDING_PRICING_CHECKOUT_SERVICE` in `classes-schedule.js`. */
  const MB_PENDING_SIGNUP_SALE_SERVICE_KEY = "mb_pending_signup_sale_service";

  /** Schedule/booking modal queued a SKU — open matching checkout once catalog renders (already signed in). */
  function maybeAutoOpenPendingPricingCheckoutAfterRender() {
    void (async () => {
      /** @type {string | null} */
      let raw = null;
      try {
        raw = sessionStorage.getItem(MB_PENDING_SIGNUP_SALE_SERVICE_KEY);
      } catch {
        return;
      }
      if (!raw || !String(raw).trim()) return;

      const sess = await fetchSession();
      if (!sess.ok || !sess.data || !isLoggedInPayload(sess.data)) return;

      /** @type {{ serviceId?: unknown } | null} */
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        try {
          sessionStorage.removeItem(MB_PENDING_SIGNUP_SALE_SERVICE_KEY);
        } catch {
          /* noop */
        }
        return;
      }

      const sid = parsed?.serviceId;
      /** @type {number} */
      let n = NaN;
      if (typeof sid === "number" && Number.isFinite(sid)) n = sid;
      else if (typeof sid === "string" && /^\d+$/.test(sid.trim())) n = parseInt(sid.trim(), 10);

      if (!Number.isFinite(n) || n <= 0) {
        try {
          sessionStorage.removeItem(MB_PENDING_SIGNUP_SALE_SERVICE_KEY);
        } catch {
          /* noop */
        }
        return;
      }

      const selector = `[data-mb-checkout="${String(n)}"]`;
      const btn = root.querySelector(selector);

      if (!(btn instanceof HTMLElement)) {
        try {
          sessionStorage.removeItem(MB_PENDING_SIGNUP_SALE_SERVICE_KEY);
        } catch {
          /* noop */
        }
        statusEl.insertAdjacentHTML(
          "afterbegin",
          `<span class="pricing-api-muted">We couldn’t match that package row — choose it manually from the list.</span> `,
        );
        return;
      }

      try {
        sessionStorage.removeItem(MB_PENDING_SIGNUP_SALE_SERVICE_KEY);
      } catch {
        /* noop */
      }
      requestAnimationFrame(() => {
        btn.click();
      });
    })();
  }

  function closeDialog() {
    dlg.close();
  }

  dlg.querySelectorAll("[data-mb-pricing-close]").forEach((x) => {
    x.addEventListener("click", () => closeDialog());
  });
  dlg.addEventListener("click", (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    if (t.nodeName === "DIALOG") closeDialog();
  });

  /**
   * @param {string} msg
   * @param {unknown} [extra]
   */
  function mindbodyErrText(msg, extra) {
    if (extra && typeof extra === "object") {
      const e = /** @type {Record<string, unknown>} */ (extra).Error;
      if (e && typeof e === "object" && typeof (/** @type {Record<string, unknown>} */ (e).Message) === "string") {
        return String((/** @type {Record<string, unknown>} */ (e).Message));
      }
      const d = /** @type {Record<string, unknown>} */ (extra).detail;
      if (typeof d === "string") return d;
    }
    return msg;
  }

  /**
   * CheckoutShoppingCart returns this when upstream used consumer OAuth instead of staff User Token.
   * @param {unknown} body
   */
  function checkoutDeniedStaffAccessMindbody(body) {
    if (!body || typeof body !== "object") return false;
    const mb = /** @type {{ mindbody?: unknown }} */ (body).mindbody;
    if (!mb || typeof mb !== "object") return false;
    const err = /** @type {{ Error?: unknown }} */ (mb).Error;
    if (!err || typeof err !== "object") return false;
    const o = /** @type {Record<string, unknown>} */ (err);
    return (
      o.Code === "DeniedAccess" &&
      typeof o.Message === "string" &&
      /staff level or higher/i.test(o.Message)
    );
  }

  /**
   * Decide if this row (a /sale/services Pricing Option) is eligible for the Stripe Express
   * Checkout CTA: feature flag is on AND service id is in the build-time enabled list AND row
   * is NOT a recurring contract. Recurring memberships always use Mindbody classic.
   *
   * `kind` is also returned so callers can branch UX by SKU family (e.g. show a soft sign-in
   * gate for `dropin` / `packs` while `newClient` flows straight to anonymous Stripe).
   *
   * @param {Record<string, unknown>} row
   * @returns {{ eligible: boolean; localSku: string | null; displayName: string | null; serviceId: number | null; kind: string | null }}
   */
  function stripeExpressEligibilityForRow(row) {
    if (!stripeOneTimeCfg.enabled) return { eligible: false, localSku: null, displayName: null, serviceId: null, kind: null };
    if (guessContract(row)) return { eligible: false, localSku: null, displayName: null, serviceId: null, kind: null };
    const sid = checkoutServiceId(row);
    /** @type {{ localSku: string; displayName: string; mindbodyServiceId: number | null; nameMatchAny: string[]; nameMatchExclude: string[]; kind: string } | null} */
    let match = null;
    if (sid != null && stripeExpressEnabledIds.has(sid)) {
      match =
        (stripeOneTimeCfg.expressEnabledSkus || []).find(
          (entry) => entry && typeof entry === "object" && entry.mindbodyServiceId === sid,
        ) || null;
    }
    if (!match) {
      const name = rowName(row).toLowerCase();
      for (const entry of stripeOneTimeCfg.expressEnabledSkus || []) {
        if (!entry || typeof entry !== "object") continue;
        const matchAny = Array.isArray(entry.nameMatchAny) ? entry.nameMatchAny : [];
        const matchExclude = Array.isArray(entry.nameMatchExclude) ? entry.nameMatchExclude : [];
        if (matchExclude.some((bad) => bad && name.includes(bad))) continue;
        if (matchAny.some((needle) => needle && name.includes(needle))) {
          match = entry;
          break;
        }
      }
    }
    if (!match || !match.localSku) {
      return { eligible: false, localSku: null, displayName: null, serviceId: sid, kind: null };
    }
    return {
      eligible: true,
      localSku: match.localSku,
      displayName: match.displayName || rowName(row),
      serviceId: sid,
      kind: typeof match.kind === "string" && match.kind ? match.kind : null,
    };
  }

  /**
   * Lightweight check whether the visitor has an active Mindbody member session. Used by the
   * soft sign-in gate to decide whether to show the prompt at all.
   *
   * @returns {Promise<boolean>}
   */
  async function isMindbodyMemberSignedIn() {
    try {
      const sess = await fetchSession();
      return !!(sess.ok && sess.data && isLoggedInPayload(sess.data));
    } catch {
      return false;
    }
  }

  /**
   * Build the `?return=…` parameter for `/api/mindbody/oauth/start` so that after a successful
   * Mindbody sign-in the user lands back on the same page and section they came from.
   *
   * @returns {string}
   */
  function oauthReturnParamForCurrent() {
    try {
      const ret = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
      return `return=${ret}`;
    } catch {
      return "";
    }
  }

  /**
   * Unified pre-checkout dialog for **anonymous** Express buyers (NCS / drop-in / packs).
   *
   * Why a single dialog for every Express SKU instead of the old soft-sign-in gate:
   *   • Stripe Checkout's `customer_details.name` is a single string (cardholder, Apple Pay
   *     wallet, Link, etc.) that often arrives without a space, breaking the FirstName/LastName
   *     split that Mindbody Identity needs to auto-link the Studio Client we create on the
   *     buyer's behalf. This was the root cause behind `mrsmccombs1@yahoo.com` and
   *     `marialejandradosorio@gmail.com` showing up as "not linked" after their NCS purchase.
   *   • Stripe `custom_fields` cannot be pre-filled — they always force the buyer to retype
   *     even if we already know the answer. Collecting first/last + email + phone on our own
   *     page lets us drive Stripe Customer prefill and skip Stripe's custom_fields entirely.
   *   • Collecting email up-front also enables the NCS duplicate pre-check
   *     (`block_before_checkout_if_known`) for anonymous buyers — preventing the
   *     `paid_but_not_synced` outcome we hit on `ord_AXZTQ5MT90416NHF` where Stripe charged
   *     $65 but Mindbody refused the sale because the buyer had already used the Intro.
   *
   * Logged-in members skip this dialog entirely — `showStripeExpressChooser` handles them
   * with full Mindbody contact prefill.
   *
   * The dialog reuses `.mb-book-dialog__signup-form` / `.mb-book-dialog__field` styling
   * defined in `components-mindbody.css` (originally meant for a signup form). The submit
   * button doubles as the loader — disabled + label switch to "Opening Stripe…" while the
   * `/api/stripe/checkout/create-session` round-trip runs.
   *
   * @param {Record<string, unknown>} row
   * @param {{ localSku: string; displayName: string }} match
   * @param {string} ctaLocation
   */
  function showExpressDetailsDialog(row, match, ctaLocation) {
    const label = match.displayName || rowName(row);
    const price = rowPrice(row);
    const priceLine = formatMoney(price);
    const classic = buyHref(row);
    const oauthHref = mbApiPath(`/api/mindbody/oauth/start?${oauthReturnParamForCurrent()}`);

    dlgBody.innerHTML =
      `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong>${
        priceLine ? ` · ${escapeHtml(priceLine)}` : ""
      }</p>` +
      `<p class="mb-book-dialog__sub">Add a few quick details so this purchase lands on your studio account.</p>` +
      `<form class="mb-book-dialog__signup-form" data-mb-express-form="1" novalidate>` +
        `<label class="mb-book-dialog__field">` +
          `<span class="mb-book-dialog__field-label">First name</span>` +
          `<input type="text" name="firstName" autocomplete="given-name" maxlength="80" required />` +
        `</label>` +
        `<label class="mb-book-dialog__field">` +
          `<span class="mb-book-dialog__field-label">Last name</span>` +
          `<input type="text" name="lastName" autocomplete="family-name" maxlength="80" required />` +
        `</label>` +
        `<label class="mb-book-dialog__field">` +
          `<span class="mb-book-dialog__field-label">Email</span>` +
          `<input type="email" name="email" autocomplete="email" inputmode="email" maxlength="254" required />` +
        `</label>` +
        `<label class="mb-book-dialog__field">` +
          `<span class="mb-book-dialog__field-label">Phone</span>` +
          `<input type="tel" name="phone" autocomplete="tel" inputmode="tel" maxlength="32" required />` +
        `</label>` +
        `<p class="mb-book-dialog__signup-status mb-book-dialog__signup-status--err" data-mb-express-status hidden></p>` +
      `</form>`;

    dlgActions.innerHTML =
      `<div class="mb-book-dialog__signup-actions">` +
        `<button type="button" class="btn btn--cream mb-book-dialog__signup-submit mb-book-dialog__cta-stack" data-mb-express-submit>` +
          `<span class="mb-book-dialog__cta-title" data-mb-express-submit-title>Continue to Express checkout</span>` +
          `<span class="mb-book-dialog__cta-meta">Apple Pay, Google Pay or card</span>` +
        `</button>` +
      `</div>` +
      `<p class="mb-book-dialog__signup-alt">Already have an AMARÉ account? <a href="${escapeHtml(oauthHref)}" data-mb-express-signin>Sign in with Mindbody</a></p>` +
      (classic
        ? `<p class="mb-book-dialog__quiet">Or <a href="${escapeHtml(classic)}" target="_blank" rel="noopener noreferrer" data-mb-express-classic>use Mindbody classic checkout</a>.</p>`
        : "");

    dlg.showModal();

    ga4Event("stripe_express_dialog_shown", {
      local_sku: match.localSku,
      cta_location: ctaLocation || "pricing_api_express_dialog",
      sku_label: match.displayName,
    });

    const form = /** @type {HTMLFormElement | null} */ (dlgBody.querySelector('[data-mb-express-form]'));
    const statusEl = /** @type {HTMLElement | null} */ (dlgBody.querySelector('[data-mb-express-status]'));
    const submitBtn = /** @type {HTMLButtonElement | null} */ (dlgActions.querySelector('[data-mb-express-submit]'));
    const signInLink = /** @type {HTMLAnchorElement | null} */ (dlgActions.querySelector('[data-mb-express-signin]'));
    const classicLink = /** @type {HTMLAnchorElement | null} */ (dlgActions.querySelector('[data-mb-express-classic]'));

    if (signInLink) {
      signInLink.addEventListener("click", () => {
        ga4Event("stripe_express_dialog_signin_clicked", {
          local_sku: match.localSku,
          cta_location: ctaLocation || "pricing_api_express_dialog",
          sku_label: match.displayName,
        });
      });
    }
    if (classicLink && typeof classic === "string" && classic) {
      classicLink.addEventListener("click", () => {
        trackHostedMindbodyClickOnly(classic);
      });
    }

    /**
     * @param {string} msg
     */
    function setError(msg) {
      if (!(statusEl instanceof HTMLElement)) return;
      if (!msg) {
        statusEl.hidden = true;
        statusEl.textContent = "";
      } else {
        statusEl.hidden = false;
        statusEl.textContent = msg;
      }
    }

    /**
     * @param {string} name
     */
    function readField(name) {
      if (!form) return "";
      const el = form.querySelector(`[name="${name}"]`);
      return el instanceof HTMLInputElement ? el.value.trim() : "";
    }

    /**
     * Replace the form with a friendly NCS-already-used screen. The duplicate check on the
     * server matched their email to an existing Mindbody client who has already redeemed the
     * Intro Special — the only sensible next action is sign in (so they can pick a different
     * package on their existing account).
     */
    function renderNcsAlreadyUsed() {
      dlgBody.innerHTML =
        `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong></p>` +
        `<p class="mb-book-dialog__sub">It looks like an AMARÉ account with this email has already used the New Client Special. Sign in to your existing account and choose a different package.</p>`;
      dlgActions.innerHTML =
        `<div class="mb-book-dialog__cta-row mb-book-dialog__cta-row--single">` +
          `<a class="btn btn--cream" href="${escapeHtml(oauthHref)}">Sign in with Mindbody</a>` +
        `</div>` +
        (classic
          ? `<p class="mb-book-dialog__quiet">Or <a href="${escapeHtml(classic)}" target="_blank" rel="noopener noreferrer">use Mindbody classic checkout</a> to pick a different package.</p>`
          : "");
    }

    async function handleSubmit() {
      setError("");
      const firstName = readField("firstName").slice(0, 80);
      const lastName = readField("lastName").slice(0, 80);
      const email = readField("email").slice(0, 254).toLowerCase();
      const phone = readField("phone").slice(0, 32);

      if (!firstName) {
        setError("Please enter your first name.");
        return;
      }
      if (!lastName) {
        setError("Please enter your last name.");
        return;
      }
      /** Same regex as the server's `isReasonableEmail` — keep them in sync. */
      if (!/^[^\s@]{1,200}@[^\s@]{1,64}\.[A-Za-z0-9.-]{2,24}$/.test(email)) {
        setError("Please enter a valid email address.");
        return;
      }
      if (phone.replace(/\D/g, "").length < 7) {
        setError("Please enter a valid phone number.");
        return;
      }

      /**
       * Loading state: keep the stacked layout (title + meta) so the button doesn't jump
       * between one-line and two-line. Only the title swaps to the progress label; the
       * "Apple Pay, Google Pay or card" meta stays so the buyer still sees what they're
       * being taken to even while we wait on Stripe.
       */
      const submitTitle = /** @type {HTMLElement | null} */ (
        submitBtn ? submitBtn.querySelector('[data-mb-express-submit-title]') : null
      );
      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;
      if (submitTitle instanceof HTMLElement) submitTitle.textContent = "Opening Express checkout…";

      ga4Event("stripe_checkout_started", {
        local_sku: match.localSku,
        cta_location: ctaLocation || "pricing_api_express_dialog",
        sku_label: match.displayName,
        sku_type: "package",
        mindbody_logged_in: "0",
      });

      let res;
      try {
        res = await fetch(mbApiPath(stripeOneTimeCfg.apiPath || "/api/stripe/checkout/create-session"), {
          method: "POST",
          credentials: "include",
          headers: ngrokBypassHeaders({
            "Content-Type": "application/json",
            Accept: "application/json",
          }),
          body: JSON.stringify({
            localSku: match.localSku,
            ctaLocation: ctaLocation || "pricing_api_express_dialog",
            pageLocation: (window.location.href || "").slice(0, 200),
            firstName,
            lastName,
            email,
            phone,
          }),
        });
      } catch (e) {
        ga4Event("stripe_checkout_failed_to_start", {
          local_sku: match.localSku,
          error: "network_error",
        });
        setError("We couldn't reach the express checkout service. Please check your connection and try again.");
        if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
        if (submitTitle instanceof HTMLElement) submitTitle.textContent = "Continue to Express checkout";
        return;
      }

      let txt = "";
      try {
        txt = await res.text();
      } catch {
        txt = "";
      }
      /** @type {unknown} */
      let json = null;
      try {
        json = txt ? JSON.parse(txt) : null;
      } catch {
        json = null;
      }
      const obj = json && typeof json === "object" ? /** @type {Record<string, unknown>} */ (json) : null;

      if (!res.ok || !obj || obj.ok !== true || typeof obj.url !== "string" || !obj.url) {
        const errCode = obj && typeof obj.error === "string" ? obj.error : "unknown";
        ga4Event("stripe_checkout_failed_to_start", {
          local_sku: match.localSku,
          error: errCode,
          http_status: String(res.status || 0),
        });
        if (errCode === "ncs_already_used") {
          renderNcsAlreadyUsed();
          return;
        }
        let humanMsg = "We couldn't start express checkout right now. Please try again.";
        if (errCode === "stripe_one_time_checkout_disabled") {
          humanMsg = "Express checkout is not active right now. Use Mindbody classic checkout below.";
        } else if (errCode === "sku_not_enabled_for_express_checkout") {
          humanMsg = "Express checkout is not available for this package. Use Mindbody classic below.";
        }
        setError(humanMsg);
        if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
        if (submitTitle instanceof HTMLElement) submitTitle.textContent = "Continue to Express checkout";
        return;
      }

      ga4Event("stripe_checkout_redirected", {
        local_sku: match.localSku,
        order_id: typeof obj.orderId === "string" ? obj.orderId : undefined,
      });
      window.location.assign(String(obj.url));
    }

    if (submitBtn instanceof HTMLButtonElement) {
      submitBtn.addEventListener("click", () => {
        void handleSubmit();
      });
    }
    if (form instanceof HTMLFormElement) {
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        void handleSubmit();
      });
    }
  }

  /**
   * Read a logged-in Mindbody clientId from the same `/oauth/session` endpoint already used by
   * the wallet preflight. Returns `null` for anonymous users — Stripe checkout is still allowed
   * for anonymous customers per Q3.
   *
   * @returns {Promise<number | null>}
   */
  async function readKnownMindbodyClientIdSafely() {
    try {
      const sess = await fetchSession();
      if (!sess.ok || !sess.data || !isLoggedInPayload(sess.data)) return null;
      const o = /** @type {Record<string, unknown>} */ (sess.data);
      const candidates = [
        o.mindbodyClientId,
        o.mindbody_client_id,
        o.clientId,
        o.client_id,
        o.mbClientId,
      ];
      for (const raw of candidates) {
        if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
        if (typeof raw === "string" && /^\d{1,18}$/.test(raw.trim())) {
          const n = parseInt(raw.trim(), 10);
          if (n > 0) return n;
        }
      }
    } catch {
      /* anonymous */
    }
    return null;
  }

  /**
   * Stripe Express Checkout flow. POST /api/stripe/checkout/create-session, then redirect the
   * top-level browser to Stripe's hosted checkout (Apple Pay / Google Pay / Card / Link). The
   * webhook is the source of truth for fulfillment.
   *
   * @param {Record<string, unknown>} row
   * @param {{ localSku: string; displayName: string }} match
   * @param {string} ctaLocation
   */
  async function startStripeExpressCheckout(row, match, ctaLocation) {
    const knownClientId = await readKnownMindbodyClientIdSafely();
    const url = window.location && typeof window.location.href === "string" ? window.location.href : "";
    /** @type {Record<string, unknown>} */
    const payload = {
      localSku: match.localSku,
      ctaLocation: ctaLocation || "pricing_api_modal",
      pageLocation: url.slice(0, 200),
    };
    if (knownClientId != null) payload.knownMindbodyClientId = knownClientId;

    ga4Event("stripe_checkout_started", {
      local_sku: match.localSku,
      cta_location: ctaLocation,
      sku_label: match.displayName,
      sku_type: "package",
      mindbody_logged_in: knownClientId != null ? "1" : "0",
    });

    let res;
    try {
      res = await fetch(mbApiPath(stripeOneTimeCfg.apiPath || "/api/stripe/checkout/create-session"), {
        method: "POST",
        credentials: "include",
        headers: ngrokBypassHeaders({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      ga4Event("stripe_checkout_failed_to_start", {
        local_sku: match.localSku,
        error: "network_error",
      });
      dlgBody.innerHTML =
        `<p class="mb-book-dialog__lead"><strong>${escapeHtml(match.displayName)}</strong></p>` +
        `<p class="mb-book-dialog__sub">We couldn't reach the express checkout service. Please try again or use Mindbody classic checkout below.</p>`;
      const classicEarly = buyHref(row);
      dlgActions.innerHTML = classicEarly
        ? `<div class="mb-book-dialog__cta-row"><a class="btn btn--cream" href="${escapeHtml(classicEarly)}" target="_blank" rel="noopener noreferrer">Mindbody classic checkout</a></div>`
        : "";
      return;
    }

    /** @type {string} */
    let txt = "";
    /** @type {unknown} */
    let json = null;
    try {
      txt = await res.text();
    } catch {
      txt = "";
    }
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      json = null;
    }
    const obj = json && typeof json === "object" ? /** @type {Record<string, unknown>} */ (json) : null;
    if (!res.ok || !obj || obj.ok !== true || typeof obj.url !== "string" || !obj.url) {
      const errCode = obj && typeof obj.error === "string" ? obj.error : "unknown";
      ga4Event("stripe_checkout_failed_to_start", {
        local_sku: match.localSku,
        error: errCode,
        http_status: String(res.status || 0),
      });
      let humanMsg = "We couldn't start express checkout right now.";
      if (errCode === "ncs_already_used") {
        humanMsg = "This studio account already has a New Client Special on file. Please choose a different package.";
      } else if (errCode === "stripe_one_time_checkout_disabled") {
        humanMsg = "Express checkout is not active right now. Use Mindbody classic checkout below.";
      } else if (errCode === "sku_not_enabled_for_express_checkout") {
        humanMsg = "Express checkout is not available for this package. Use Mindbody classic below.";
      }
      const classicEarly = buyHref(row);
      dlgBody.innerHTML =
        `<p class="mb-book-dialog__lead"><strong>${escapeHtml(match.displayName)}</strong></p>` +
        `<p class="mb-book-dialog__sub">${escapeHtml(humanMsg)}</p>`;
      dlgActions.innerHTML = classicEarly
        ? `<div class="mb-book-dialog__cta-row"><a class="btn btn--cream" href="${escapeHtml(classicEarly)}" target="_blank" rel="noopener noreferrer">Mindbody classic checkout</a></div>`
        : "";
      return;
    }

    ga4Event("stripe_checkout_redirected", {
      local_sku: match.localSku,
      order_id: typeof obj.orderId === "string" ? obj.orderId : undefined,
    });
    const redirect = String(obj.url);
    /** Top-level redirect — Stripe hosted Checkout shows Apple Pay / Google Pay / Card / Link. */
    window.location.assign(redirect);
  }

  /**
   * Render a small dialog offering Stripe Express + Mindbody classic for an eligible row.
   * Always allow Mindbody classic as the fallback, per spec (Q4).
   *
   * @param {Record<string, unknown>} row
   * @param {{ localSku: string; displayName: string }} match
   */
  function showStripeExpressChooser(row, match) {
    const label = rowName(row);
    const price = rowPrice(row);
    const classic = buyHref(row);
    const priceLine = formatMoney(price);
    dlgBody.innerHTML =
      `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong>${
        priceLine ? ` · ${escapeHtml(priceLine)}` : ""
      }</p>` +
      `<p class="mb-book-dialog__sub">Pay easily with Apple Pay, Google Pay, Link, or card.</p>`;
    /**
     * Single primary CTA (Stripe Express) spanning full width — Express is the recommended
     * path for every one-time SKU. Mindbody classic is demoted to a quiet text link below
     * so the primary action is unambiguous and the layout stays balanced regardless of
     * which SKU the user picked. Discoverable for power users without competing visually.
     */
    dlgActions.innerHTML =
      `<div class="mb-book-dialog__cta-row mb-book-dialog__cta-row--single">` +
      `<button type="button" class="btn btn--cream mb-book-dialog__cta-stack" data-mb-stripe-express="1">` +
      `<span class="mb-book-dialog__cta-title">Express checkout</span>` +
      `<span class="mb-book-dialog__cta-meta">Apple Pay, Google Pay or card</span>` +
      `</button>` +
      `</div>` +
      (classic
        ? `<p class="mb-book-dialog__quiet">Prefer the classic flow? <a href="${escapeHtml(classic)}" target="_blank" rel="noopener noreferrer" data-mb-classic-fallback="1">Continue to Mindbody</a>.</p>`
        : "");
    dlg.showModal();
    const expressBtn = dlgActions.querySelector("[data-mb-stripe-express]");
    if (expressBtn instanceof HTMLElement) {
      expressBtn.addEventListener(
        "click",
        () => {
          dlgBody.innerHTML =
            `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong>${
              priceLine ? ` · ${escapeHtml(priceLine)}` : ""
            }</p>` +
            `<div class="mb-pricing-checkout-loader" role="status" aria-live="polite" aria-busy="true">` +
            `<span class="mb-pricing-checkout-loader__spinner" aria-hidden="true"></span>` +
            `<p class="mb-pricing-checkout-loader__label">Opening Stripe…</p>` +
            `</div>`;
          dlgActions.innerHTML = "";
          void startStripeExpressCheckout(row, match, "pricing_api_modal_express");
        },
        { once: true },
      );
    }
    const classicBtn = dlgActions.querySelector("[data-mb-classic-fallback]");
    if (classicBtn instanceof HTMLElement) {
      classicBtn.addEventListener("click", () => {
        if (typeof classic === "string" && classic) trackHostedMindbodyClickOnly(classic);
      });
    }
  }

  /** @param {Record<string, unknown>} row */
  async function openCheckoutFlow(row) {
    const classicEarly = buyHref(row);

    /** Stripe one-time express checkout — only for eligible non-recurring SKUs (Q4). */
    const stripeMatch = stripeExpressEligibilityForRow(row);
    if (stripeMatch.eligible && stripeMatch.localSku && stripeMatch.displayName) {
      const expressMatch = {
        localSku: stripeMatch.localSku,
        displayName: stripeMatch.displayName,
      };
      /**
       * Unified pre-checkout dialog for ALL Express SKUs (NCS / drop-in / packs):
       *   • Logged-in members → straight to `showStripeExpressChooser`. The server already
       *     prefills their Stripe Checkout from Mindbody contact (email + name + phone),
       *     so asking them to retype on a dialog would be needless friction.
       *   • Anonymous buyers → `showExpressDetailsDialog`, which collects first/last/email/
       *     phone before posting to `/api/stripe/checkout/create-session`. This is what
       *     enables (a) the email-based NCS duplicate pre-check that prevents
       *     `paid_but_not_synced` outcomes on re-purchases, and (b) clean Mindbody
       *     `addclient` payloads so Identity can auto-link the new Studio Client on the
       *     buyer's first OAuth sign-in.
       */
      const loggedIn = await isMindbodyMemberSignedIn();
      if (!loggedIn) {
        showExpressDetailsDialog(row, expressMatch, "pricing_api_express_dialog");
        return;
      }
      showStripeExpressChooser(row, expressMatch);
      return;
    }

    /**
     * Stripe Recurring Membership opt-in: when the user is clicking Subscribe on a monthly
     * SKU AND we have a Stripe recurring mapping for it AND the frontend flag is on, fall
     * through to the dialog flow (which collects the agreement consent and then dispatches
     * to `/api/stripe/checkout/create-session` via the Submit handler). Without this branch
     * the Classic short-circuit below would open Mindbody Classic in a new tab and the
     * Stripe path would never run.
     *
     * Note: this evaluation MUST happen before the `PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED`
     * gate. The Stripe recurring fork lives inside the dialog, not on the Subscribe click
     * itself, so we need the dialog to actually open.
     */
    const earlyIsRecurring = guessContract(row);
    const earlyStripeRecurring = earlyIsRecurring
      ? lookupStripeRecurringSku(checkoutServiceId(row))
      : null;

    if (
      !earlyStripeRecurring &&
      !PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED &&
      typeof classicEarly === "string" &&
      classicEarly.trim()
    ) {
      const href = classicEarly.trim();
      trackHostedMindbodyClickOnly(href);
      openMindbodyClassicInNewTab(href);
      return;
    }

    const label = rowName(row);
    const price = rowPrice(row);
    const svcId = checkoutServiceId(row);
    const classic = classicEarly;
    const isRecurring = earlyIsRecurring;
    /** Recurring memberships need hybrid API + mapped terms — no Subscribe without displayable agreement. */
    const memTerms = isRecurring ? resolveRecurringMembershipTerms(row) : null;

    if (isRecurring && (!memTerms || !memTerms.hasValidTerms || !memTerms.displayHtmlBlocks.length)) {
      dlgBody.innerHTML =
        `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong> · ${escapeHtml(formatMoney(price) || "")}</p>` +
        `<p class="mb-book-dialog__sub">${escapeHtml(MSG_MEMBERSHIP_UNAVAILABLE_ONLINE)}</p>` +
        `<p class="mb-book-dialog__quiet">Questions? Email or call us — we'll help complete your signup.</p>`;
      dlgActions.innerHTML = classic
        ? `<div class="mb-book-dialog__cta-row"><a class="btn btn--cream" href="${escapeHtml(classic)}" target="_blank" rel="noopener noreferrer">Mindbody checkout</a></div>`
        : "";
      dlg.showModal();
      return;
    }

    const membershipContractInset =
      memTerms && memTerms.hasValidTerms ? buildMembershipTermsDialogHtml(memTerms, formatMoney(price) || "") : "";

    if (svcId == null) {
      dlgBody.innerHTML = `<p class="mb-book-dialog__lead">This item is missing a Mindbody service id — open classic checkout.</p>`;
      dlgActions.innerHTML = classic
        ? `<a class="btn btn--cream" href="${escapeHtml(classic)}" target="_blank" rel="noopener noreferrer">Mindbody checkout</a>`
        : "";
      dlg.showModal();
      return;
    }

    dlgBody.innerHTML =
      `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong> · ${escapeHtml(formatMoney(price) || "")}</p>` +
      `<div class="mb-pricing-checkout-loader" role="status" aria-live="polite" aria-busy="true">` +
      `<span class="mb-pricing-checkout-loader__spinner" aria-hidden="true"></span>` +
      `<p class="mb-pricing-checkout-loader__label">Checking your account…</p>` +
      `</div>`;
    dlgActions.innerHTML = "";
    dlg.showModal();

    /**
     * Do **not** run `/oauth/session` and `/client/stored-cards` in parallel — both refresh the same
     * Mindbody token; parallel requests → `invalid_grant` / flaky ngrok. Session first, then wallet (only when
     * `PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED`). When express is off, skip `stored-cards` and use Classic checkout.
     */
    const sess = await fetchSession();
    const sessionBannerSaysLoggedIn = sess.ok && isLoggedInPayload(sess.data);

    /** @type {Response} */
    let cr;

    /** @type {string} */
    let cRaw = "";
    /** @type {unknown} */
    let cj = null;

    if (sessionBannerSaysLoggedIn) {
      if (PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED) {
        cr = await fetch(mbApiPath("/api/mindbody/client/stored-cards"), {
          credentials: "include",
          headers: ngrokBypassHeaders({ Accept: "application/json" }),
        });
        try {
          cRaw = await cr.text();
        } catch {
          cRaw = "";
        }
        try {
          cj = cRaw ? JSON.parse(cRaw) : null;
        } catch {
          cj = null;
        }
      } else {
        cr = new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
        cRaw = '{"ok":true}';
        cj = /** @type {unknown} */ ({ ok: true });
      }
    } else {
      cr = new Response('{"ok":false,"skipped":"signed_out"}', {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
      cRaw = '{"ok":false,"skipped":"signed_out"}';
      cj = /** @type {unknown} */ ({ ok: false, skipped: "signed_out" });
    }

    /** @type {string} */
    let tunnelApi404 = "";
    if (cr.status === 404 && isTunnelOrEphemeralHostname()) {
      tunnelApi404 = `<div class="mb-book-dialog__hint mb-book-dialog__hint--tunnel">${tunnelUpstream404HintInner()}</div>`;
    }

    /** When express is enabled, `GET …/stored-cards` refreshes Mindbody OAuth — authoritative alongside checkout. `/oauth/session` reads cookie first. Synthetic `{ ok:true }` when Classic-only (`!PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED`). */
    const consumerApisAuthenticated =
      cr.ok &&
      cj &&
      typeof cj === "object" &&
      /** @type {{ ok?: unknown }} */ (cj).ok === true;

    const staleSessionLooksLoggedIn =
      sessionBannerSaysLoggedIn && mindbodyApiRequiresReauth(cr.status, cj);

    if (staleSessionLooksLoggedIn) {
      dlgBody.innerHTML = `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong> · ${escapeHtml(formatMoney(price) || "")}</p>`;
      const retSign = encodeURIComponent(window.location.pathname + window.location.search);
      const retLogout = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
      dlgBody.innerHTML += `<p class="mb-book-dialog__sub">${escapeHtml(
        "Your browser still has a sign-in cookie, but Mindbody refused to refresh it (often invalid_grant). That usually means the refresh token expired, was revoked, or you signed in on a different hostname than this page URL — typical when an ngrok subdomain changes.",
      )}</p>`;
      dlgBody.innerHTML +=
        `<p class="mb-book-dialog__quiet">Register this callback in the Mindbody OAuth client if needed: <code>${escapeHtml(
          `${window.location.origin}/api/mindbody/oauth/callback`,
        )}</code>, then sign in again on this same tab.</p>`;
      dlgActions.innerHTML =
        `<div class="mb-book-dialog__cta-row">` +
        `<a class="btn btn--cream" href="${escapeHtml(mbApiPath(`/api/mindbody/oauth/start?return=${retSign}`))}">Sign in with Mindbody</a>` +
        `</div>` +
        `<p class="mb-book-dialog__quiet"><a href="${escapeHtml(mbApiPath(`/api/mindbody/oauth/logout?return=${retLogout}`))}">Clear site session cookie</a> first if sign-in loops.</p>` +
        (classic
          ? `<p class="mb-book-dialog__quiet">Or continue in Mindbody: <a href="${escapeHtml(classic)}" target="_blank" rel="noopener noreferrer">classic checkout</a></p>`
          : "");
      return;
    }

    if (!consumerApisAuthenticated && !sessionBannerSaysLoggedIn) {
      dlgBody.innerHTML = `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong> · ${escapeHtml(formatMoney(price) || "")}</p>`;
      const retSign = encodeURIComponent(window.location.pathname + window.location.search);
      dlgBody.innerHTML += `<p class="mb-book-dialog__sub">Sign in with your Mindbody member login to use checkout on this page.</p>`;
      dlgActions.innerHTML =
        `<div class="mb-book-dialog__cta-row">` +
        `<a class="btn btn--cream" href="${escapeHtml(mbApiPath(`/api/mindbody/oauth/start?return=${retSign}`))}">Sign in with Mindbody</a>` +
        `</div>` +
        (classic
          ? `<p class="mb-book-dialog__quiet">Or continue in Mindbody: <a href="${escapeHtml(classic)}" target="_blank" rel="noopener noreferrer">classic checkout</a></p>`
          : "");
      return;
    }

    /** API returns `hasStoredCard` only — no card PAN / last-four in the browser (`/client/stored-cards`, only when express is enabled). */
    const hasStoredCardFromApi =
      PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED &&
      consumerApisAuthenticated &&
      cj &&
      typeof cj === "object" &&
      /** @type {{ hasStoredCard?: unknown }} */ (cj).hasStoredCard === true;

    /**
     * Stripe Recurring Membership: the actual card capture happens on Stripe's hosted page,
     * so we don't need a Mindbody stored card for the dialog to render the consent + Submit
     * button. Force `expressOnSiteAllowed = true` for Stripe-recurring rows so we fall through
     * to the runBtn flow (the Submit click handler hijacks dispatch to `/api/stripe/checkout/
     * create-session` before any Mindbody call).
     */
    const stripeRecurringSubscriptionAllowed = !!earlyStripeRecurring && consumerApisAuthenticated;

    const expressOnSiteAllowed = hasStoredCardFromApi === true || stripeRecurringSubscriptionAllowed;

    if (!expressOnSiteAllowed) {
      if (PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED) {
        const o = cj && typeof cj === "object" ? /** @type {Record<string, unknown>} */ (cj) : null;
        if (consumerApisAuthenticated && !hasStoredCardFromApi) {
          console.warn(
            "[pricing-api] No saved Mindbody payment method for this login (hosted Mindbody checkout only — no on-site Complete purchase)",
            {
              httpStatus: cr.status,
              responseOk: cr.ok,
              probe: {
                ok: o?.ok,
                hasStoredCard: o?.hasStoredCard,
                cardCount: o?.cardCount,
                clientId: o?.clientId,
                error: o?.error,
                detail: o?.detail,
                walletHint: o?.walletHint,
                staffProbe: o?.staffProbe,
              },
            },
          );
        } else if (!consumerApisAuthenticated) {
          console.warn(
            "[pricing-api] Could not confirm stored payment method — hosted Mindbody checkout only (stored-cards unavailable or HTTP error)",
            { httpStatus: cr.status, responseOk: cr.ok },
          );
        }

        trackPricingWalletEmptyPreflight({
          skuLabel: label,
          isRecurring,
          checkoutServiceId: svcId,
        });
      }

      const sub =
        !PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED && consumerApisAuthenticated
          ? "Complete your purchase in Mindbody checkout (Classic). Opens in a new tab — card entry stays on Mindbody."
          : !consumerApisAuthenticated && cr.status !== 401
            ? `We couldn't verify saved payment eligibility just now (HTTP ${cr.status}). Pay securely through Mindbody.`
            : "Billing visible in Mindbody Manager is not always available to this site's API. Pay securely through Mindbody — you'll use the checkout you know.";

      dlgBody.innerHTML =
        tunnelApi404 +
        `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong> · ${escapeHtml(formatMoney(price) || "")}</p>` +
        `<p class="mb-book-dialog__sub">${escapeHtml(sub)}</p>` +
        `<p class="mb-book-dialog__quiet">${escapeHtml(
          "You'll open Mindbody checkout in a new tab. This page does not collect card numbers.",
        )}</p>` +
        membershipContractInset;

      if (classic && typeof classic === "string") {
        dlgActions.innerHTML =
          `<div class="mb-book-dialog__cta-row">` +
          `<a class="btn btn--cream mb-pricing-hosted-mindbody" href="${escapeHtml(classic)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            "Continue to Mindbody to complete your purchase securely",
          )}</a>` +
          `</div>`;
        const hostedA = dlgActions.querySelector("a.mb-pricing-hosted-mindbody");
        hostedA?.addEventListener("click", () => {
          trackHostedMindbodyClickOnly(classic);
        });
      } else {
        dlgActions.innerHTML =
          `<p class="mb-book-dialog__quiet">${escapeHtml(
            "Mindbody checkout isn't linked for this item — contact the studio to purchase.",
          )}</p>`;
      }
      return;
    }

    /*
     * — Mindbody on-site CheckoutShoppingCart / PurchaseContract (dry-run + live) —
     * Re-enabled when PRICING_MINDBODY_EXPRESS_CHECKOUT_ENABLED is true and wallet preflight succeeds.
     * UI + POST payloads kept for reuse with future non-Mindbody payment backends.
     */
    const hasStoredCard = true;

    dlgActions.innerHTML = "";

    dlgBody.innerHTML =
      tunnelApi404 +
      `<p class="mb-book-dialog__lead"><strong>${escapeHtml(label)}</strong> · ${escapeHtml(formatMoney(price) || "")}</p>` +
      membershipContractInset;

    /**
     * Stripe Recurring fork hides the Mindbody-specific dialog controls (promo code, dry-run
     * Test:true checkbox, live-charge confirmation) since none of them apply to Stripe
     * Subscription signup — Stripe collects the card on its own hosted page and selects
     * test/live mode from the configured Stripe secret. The buyer only needs the membership
     * agreement consent + Submit. We still render `<pre id="mb-pricing-checkout-log">` so the
     * Stripe fork can surface server-side error messages inline.
     */
    if (earlyStripeRecurring) {
      dlgBody.innerHTML += `
      <pre id="mb-pricing-checkout-log" class="mb-pricing-log" aria-live="polite"></pre>`;
    } else {
      dlgBody.innerHTML += `
      <label class="mb-pricing-field">
        <span>Promotion code <span class="pricing-api-muted">(optional)</span></span>
        <input type="text" id="mb-pricing-promo" class="mb-pricing-text-input" maxlength="80" autocomplete="off" spellcheck="false" placeholder="Mindbody promo / coupon" aria-label="Promotion code" />
      </label>
      <label class="mb-pricing-checkbox">
        <input type="checkbox" id="mb-pricing-dry-run" checked />
        <span>Dry run — Mindbody Test mode (<strong>no charge</strong>)</span>
      </label>
      <label class="mb-pricing-checkbox" id="mb-pricing-live-row" hidden>
        <input type="checkbox" id="mb-pricing-live-confirm" />
        <span>I understand this may charge the card Mindbody keeps on file for my login.</span>
      </label>
      <pre id="mb-pricing-checkout-log" class="mb-pricing-log" aria-live="polite"></pre>`;

      void fetch(mbApiPath("/api/mindbody/sale/checkout-warmup"), {
        method: "POST",
        credentials: "include",
        headers: ngrokBypassHeaders({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: "{}",
      }).catch(() => {});
    }

    const dryCk = /** @type {HTMLInputElement} */ (document.getElementById("mb-pricing-dry-run"));
    const liveRow = document.getElementById("mb-pricing-live-row");
    const liveCk = /** @type {HTMLInputElement} */ (document.getElementById("mb-pricing-live-confirm"));

    const membershipAckGate = !!(memTerms && memTerms.displayHtmlBlocks.length);
    const memAgreeCk = /** @type {HTMLInputElement | null} */ (document.getElementById("mb-pricing-membership-agree"));
    const memBillCk = /** @type {HTMLInputElement | null} */ (document.getElementById("mb-pricing-membership-bill"));

    dryCk?.addEventListener("change", () => {
      if (!liveRow || !liveCk) return;
      liveRow.hidden = !!dryCk.checked;
      liveCk.checked = false;
      syncPrimaryCheckoutBtnLabel();
    });

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "btn btn--cream";
    /** @returns {void} */
    function syncPrimaryCheckoutBtnLabel() {
      if (membershipAckGate) runBtn.textContent = "Agree & Complete Purchase";
      else if (hasStoredCard)
        runBtn.textContent = dryCk?.checked ? "Run test checkout (no charge)" : "Complete purchase";
      else runBtn.textContent = "Submit";
    }
    if (membershipAckGate) runBtn.disabled = true;
    syncPrimaryCheckoutBtnLabel();

    /** @returns {boolean} */
    function membershipConsentFormOk() {
      if (!membershipAckGate || !memTerms) return true;
      return !!memAgreeCk?.checked && !!memBillCk?.checked;
    }

    function syncMembershipSubmitEnabled() {
      if (!membershipAckGate) return;
      runBtn.disabled = !membershipConsentFormOk();
    }
    memAgreeCk?.addEventListener("change", syncMembershipSubmitEnabled);
    memBillCk?.addEventListener("change", syncMembershipSubmitEnabled);

    runBtn.addEventListener("click", async () => {
      if (runBtn.getAttribute("data-checkout-submitting") === "1") return;
      runBtn.setAttribute("data-checkout-submitting", "1");

      try {
      const log = document.getElementById("mb-pricing-checkout-log");
      /** Browser wait ceiling — keep slightly above server `MINDBODY_CHECKOUT_TIMEOUT_MS` (default 20s). */
      const checkoutClientWaitMs = 26000;
      if (log) log.textContent = isRecurring ? "Processing membership contract…" : "Processing your package purchase…";

      if (membershipAckGate && !membershipConsentFormOk()) {
        if (log) {
          log.textContent =
            "Complete membership consent before purchase: check both boxes (agreement + billing authorization), then try again.";
        }
        syncMembershipSubmitEnabled();
        return;
      }

      /** One id per Submit press — pairs with optional Netlify Blobs idempotency on the server. */
      const purchaseAttemptId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      /**
       * Browser wait ceiling for both the Stripe fork and the Mindbody on-site fallback —
       * declared up here so both paths can share the same `AbortController`.
       */
      const ac = new AbortController();
      const abortT = setTimeout(() => ac.abort(), checkoutClientWaitMs);

      /* ---------------- Stripe Recurring fork (Option A) ------------------ */
      /**
       * For monthly memberships only: when the frontend flag is ON AND this SKU is in the
       * Stripe recurring catalog, redirect the buyer to a Stripe-hosted Checkout Session in
       * `subscription` mode instead of POST-ing to Mindbody Classic. The server validates
       * the same consent fields collected by the membership terms dialog and creates a
       * SubscriptionRecord before returning the Stripe Checkout URL.
       *
       * Dry-run is intentionally bypassed here — Stripe's own test mode (selected by the
       * configured Stripe secret) is the canonical "dry run" for subscriptions, so we engage
       * this fork regardless of the dry-run / live-confirm checkbox state. The Mindbody
       * Classic Test:true path is only reachable when the SKU is NOT in the Stripe recurring
       * catalog or the Stripe call fails.
       *
       * If the flag is OFF, the SKU is not in the recurring catalog, or the server returns
       * an unknown / 5xx error, the buyer falls through to the existing Mindbody Classic
       * flow — no partial state.
       */
      const recurringSkuEntry = isRecurring ? lookupStripeRecurringSku(svcId) : null;
      if (recurringSkuEntry) {
        runBtn.disabled = true;
        if (log) log.textContent = "Preparing secure Stripe checkout…";
        /** @type {Record<string, unknown>} */
        const stripePayload = {
          localSku: recurringSkuEntry.localSku,
          ctaLocation: "pricing_api_membership_submit",
          pageLocation: typeof window !== "undefined" ? window.location.href.slice(0, 200) : undefined,
          idempotencyKey: purchaseAttemptId,
          requiresMembershipAgreement: true,
          membershipAgreementAccepted: true,
          membershipBillingAuthorized: true,
        };
        if (memTerms && memTerms.contractVersion) {
          stripePayload.membershipTermsContractVersion = memTerms.contractVersion;
        }
        if (memTerms && memTerms.termsSnapshotHtml) {
          stripePayload.membershipTermsDisplayedHtml = stripScriptsHtml(memTerms.termsSnapshotHtml);
        }
        const memNameEl = /** @type {HTMLInputElement | null} */ (
          document.getElementById("mb-pricing-membership-name")
        );
        const fullLegalName = (memNameEl?.value ?? "").trim();
        if (fullLegalName) stripePayload.membershipFullLegalName = fullLegalName;
        try {
          const stripeRes = await fetch(
            mbApiPath(stripeRecurringCfg.apiPath || "/api/stripe/checkout/create-session"),
            {
              method: "POST",
              credentials: "include",
              signal: ac.signal,
              headers: ngrokBypassHeaders({
                Accept: "application/json",
                "Content-Type": "application/json",
              }),
              body: JSON.stringify(stripePayload),
            },
          );
          const stripeText = await stripeRes.text();
          /** @type {Record<string, unknown> | null} */
          let stripeJson = null;
          try {
            stripeJson = stripeText ? JSON.parse(stripeText) : null;
          } catch {
            stripeJson = null;
          }
          if (stripeRes.ok && stripeJson && typeof stripeJson === "object" && typeof stripeJson.url === "string" && stripeJson.url) {
            ga4Event("begin_checkout", {
              checkout_stage: "stripe_recurring_redirect",
              cta_location: "pricing_api_membership_submit",
              sku_label: recurringSkuEntry.displayName || recurringSkuEntry.localSku,
              sku_type: "membership",
              checkout_service_id: svcId != null ? String(svcId) : undefined,
            });
            window.location.href = stripeJson.url;
            return;
          }
          /**
           * Server rejected — surface the structured error inside the dialog. The most
           * common failure modes during sandbox testing:
           *   • `stripe_recurring_checkout_disabled` — server flag is off; ops needs to enable.
           *   • `subscription_already_active` — the buyer already has an active sub on Mindbody.
           *   • `membership_consent_*` — terms version mismatch / missing acceptance.
           *
           * For ALL other 5xx / network errors we soft-fall-through to the existing Mindbody
           * Classic path so a transient Stripe outage does not block a member from purchasing.
           */
          const stripeErr =
            stripeJson && typeof /** @type {{ error?: unknown }} */ (stripeJson).error === "string"
              ? String(/** @type {{ error: string }} */ (stripeJson).error)
              : "";
          if (stripeRes.status >= 400 && stripeRes.status < 500 && stripeErr) {
            const friendly =
              stripeErr === "subscription_already_active"
                ? "You already have an active Amaré monthly membership. Please contact us to change plans."
                : stripeErr === "stripe_recurring_checkout_disabled"
                  ? "Recurring membership checkout is not available yet. Please use the Mindbody flow."
                  : stripeErr === "multiple_client_matches"
                    ? "Your email matches multiple Mindbody profiles — please contact us to merge them before starting a membership."
                    : stripeErr.startsWith("membership_")
                      ? "Membership consent could not be validated. Refresh the page, reopen the dialog, and try again."
                      : `Could not start the Stripe membership checkout (${stripeErr}).`;
            if (log) log.textContent = friendly;
            return;
          }
          /** Unknown / 5xx → soft fall-through. */
          console.warn("[pricing-api] Stripe recurring fork failed; falling back to Mindbody Classic", {
            status: stripeRes.status,
            error: stripeErr,
          });
        } catch (e) {
          /** Network error — fall through to Mindbody Classic silently. */
          console.warn("[pricing-api] Stripe recurring fetch threw; falling back to Mindbody Classic", e);
        } finally {
          /**
           * Re-enable Submit on every fallback / friendly-error path. The 2xx success path
           * also enters this `finally` but the subsequent `window.location.href = …` redirect
           * makes the disabled state irrelevant (page is unloading).
           */
          runBtn.disabled = false;
        }
      }

      /* ---------------- Mindbody Classic / on-site fallback path ---------------- */
      const dry = !!dryCk?.checked;
      const liveOk = !!liveCk?.checked;

      const rRow = /** @type {Record<string, unknown>} */ (row);
      const contractId =
        isRecurring && (rRow.__mbContract === true || rRow.__pricingFallback === true)
          ? contractPurchaseId(row)
          : null;
      const usePurchaseContract = contractId != null;

      /** @type {Record<string, unknown>} */
      const payload = {
        purchaseAttemptId,
      };
      if (usePurchaseContract) {
        payload.contractId = contractId;
        payload.serviceId = svcId;
      } else {
        payload.serviceId = svcId;
      }
      if (price != null && Number.isFinite(price) && price > 0) {
        payload.amount = price;
      }
      if (dry) {
        payload.test = true;
      } else {
        if (!liveOk) {
          if (log) log.textContent = "Check the confirmation box for a live charge, or enable dry run.";
          clearTimeout(abortT);
          return;
        }
        payload.test = false;
        payload.confirmPurchase = true;
      }

      const promoEl = /** @type {HTMLInputElement | null} */ (document.getElementById("mb-pricing-promo"));
      const promo = (promoEl?.value ?? "").trim();
      if (promo) payload.promotionCode = promo;

      if (membershipAckGate && memTerms && memTerms.contractVersion && memTerms.termsSnapshotHtml) {
        payload.requiresMembershipAgreement = true;
        payload.membershipAgreementAccepted = true;
        payload.membershipBillingAuthorized = true;
        payload.membershipTermsContractVersion = memTerms.contractVersion;
        payload.membershipTermsDisplayedHtml = stripScriptsHtml(memTerms.termsSnapshotHtml);
      }

      const started = Date.now();
      let done = false;
      let phase = 0;
      const phaseTimer = setInterval(() => {
        if (done || !log) return;
        const elapsed = Date.now() - started;
        if (elapsed >= 6000 && phase < 1) {
          phase = 1;
          log.textContent =
            "Processing your package purchase…\n\nStill working — please don't close this page.";
        }
        if (elapsed >= 15000 && phase < 2) {
          phase = 2;
          log.textContent =
            "Processing your package purchase…\n\nStill working — please don't close this page.\n\nThis is taking longer than usual. If nothing changes after a minute, close this dialog and try again—or contact us for help.";
        }
      }, 500);

      runBtn.disabled = true;

      try {
        const res = await fetch(
          mbApiPath(usePurchaseContract ? "/api/mindbody/sale/purchase-contract" : "/api/mindbody/sale/checkout"),
          {
            method: "POST",
            credentials: "include",
            signal: ac.signal,
            headers: ngrokBypassHeaders({
              Accept: "application/json",
              "Content-Type": "application/json",
            }),
            body: JSON.stringify(payload),
          },
        );
        const txt = await res.text();
        let j = null;
        try {
          j = txt ? JSON.parse(txt) : null;
        } catch {
          j = null;
        }
        const prefix =
          !res.ok && res.status === 404 && isTunnelOrEphemeralHostname()
            ? `${tunnelUpstream404HintPlain()}\n\n--- Response ---\n\n`
            : "";
        const postPath = usePurchaseContract
          ? "/api/mindbody/sale/purchase-contract"
          : "/api/mindbody/sale/checkout";
        const infra404 =
          res.status === 404
            ? apiMindbodyPost404Hint(postPath, txt)
            : "";
        if (log)
          log.textContent =
            prefix + infra404 + (txt ? txt.slice(0, 4800) : String(res.status));
        if (!(j && typeof j === "object")) {
          if (log) {
            log.textContent =
              prefix +
              infra404 +
              `The server returned HTTP ${res.status} without readable JSON — the outcome is unknown. Do not retry immediately; check your Mindbody purchases or ask the studio before paying again.\n\n` +
              (txt ? txt.slice(0, 4800) : "");
          }
          return;
        }
        if (!res.ok || j.ok === false) {
          let extra = "";
          if (typeof j.error === "string") {
            if (j.error === "missing_service_id") {
              extra =
                "The checkout request had no usable service id — try refreshing the pricing page.";
            } else if (j.error === "missing_comp_amount") {
              extra =
                "Dry run needs an item amount: open this page directly on your dev URL (fresh build) so cards show numeric prices; or ensure GET /sale/services lists this service.";
            } else if (j.error === "invalid_json") {
              extra =
                "The server could not parse the POST body — ad blockers / tunnel middleware sometimes strip POST bodies.";
            } else if (
              j.error === "checkout_staff_token_not_configured" ||
              j.error === "checkout_staff_credentials_not_configured"
            ) {
              extra =
                "Set MINDBODY_STAFF_USERNAME + MINDBODY_STAFF_PASSWORD (integration staff; server issues Mindbody staff tokens with warm-instance cache), or legacy MINDBODY_STAFF_USER_TOKEN. Consumer OAuth only identifies the buyer.";
            } else if (
              j.error === "staff_token_issue_failed" ||
              j.error === "staff_token_issue_malformed" ||
              j.error === "staff_token_issue_timeout"
            ) {
              extra =
                "The server could not issue a Mindbody staff User Token in time or Mindbody rejected it. Check staff username/password, API key, SiteId, and try again.";
            } else if (j.error === "checkout_timeout") {
              extra =
                "The purchase request timed out. You may not have been charged — check your Mindbody account or wallet before trying again.";
            } else if (j.error === "checkout_attempt_in_progress") {
              extra =
                "This submit is already running on the server — wait for the first result; do not click Submit again.";
            } else if (j.error === "checkout_attempt_id_stale") {
              extra =
                "This attempt id cannot be replayed — close the dialog and open checkout again (a new attempt id will be created).";
            } else if (
              j.error === "membership_terms_ack_required" ||
              j.error === "membership_consent_incomplete"
            ) {
              extra =
                "Complete all membership consent steps: tick both agreement boxes (terms + billing authorization), then submit again.";
            } else if (j.error === "membership_legal_name_invalid") {
              extra = "Enter your full legal name (at least first and last name) as it appears on your ID.";
            } else if (j.error === "membership_contract_version_mismatch") {
              extra =
                "This page is out of date — refresh pricing, re-open checkout, and agree to the latest membership terms.";
            } else if (j.error === "membership_terms_snapshot_invalid") {
              extra = "Membership agreement text was missing from the request — refresh the page and try again.";
            } else if (j.error === "no_stored_card") {
              extra =
                "No saved payment method on this Mindbody login — finish in Mindbody checkout to add a card securely.\n\n";
              ga4Event("no_stored_card", {
                checkout_stage: "api_response",
                cta_location: "pricing_api_checkout_submit",
                sku_label: label,
                sku_type: isRecurring ? "membership" : "package",
                checkout_service_id: svcId != null ? String(svcId) : undefined,
              });
            } else if (j.error === "membership_consent_storage_unavailable") {
              extra =
                "The server could not store your membership consent record — try again later or use Mindbody checkout. (Operator: enable Netlify Blobs and set MINDBODY_MEMBERSHIP_CONSENT_BLOBS=1.)";
            } else if (j.error === "invalid_cart_lines") {
              extra =
                "The server rejected the cart shape (only one line item is supported in this flow).";
            } else if (j.error === "client_payments_forbidden") {
              extra =
                "Unexpected payment rows in the request — use the page controls only; the server builds Mindbody payments.";
            } else if (j.error === "checkout_upstream_throw") {
              extra =
                "Mindbody or the network dropped the request before a response — you were likely not charged. Try again in a moment.";
            } else if (
              j.error === "token_refresh_failed" ||
              j.error === "invalid_session" ||
              j.error === "missing_refresh_token" ||
              (typeof j.detail === "string" && /invalid_grant/i.test(j.detail))
            ) {
              extra =
                "Mindbody rejected refreshing your member session (often invalid_grant). Close this dialog and sign in again on this exact site URL — required if your tunnel hostname changed (ngrok) or the refresh token expired.";
            }
            if (extra) extra += "\n\n";
          }
          const mbUpstreamDetail = mindbodyErrText("", j.mindbody);
          if (
            !extra &&
            j.error === "checkout_failed" &&
            /promotion may not be used online/i.test(mbUpstreamDetail)
          ) {
            extra =
              "Mindbody declined this promo for online checkout — the promotion exists but online use is not enabled for it in Mindbody Manager. Allow online redemption on that promotion, use classic Mindbody checkout, or retry with an empty promo field.\n\n";
          } else if (
            !extra &&
            j.error === "checkout_failed" &&
            mbUpstreamDetail &&
            /promotion|promo code|coupon/i.test(mbUpstreamDetail) &&
            /invalid|may not|not valid|cannot|unable|expired/i.test(mbUpstreamDetail)
          ) {
            extra =
              "Mindbody rejected the promotion for this sale (code, dates, channels, or item eligibility). Try without a promo, adjust the promotion in Mindbody, or finish in Mindbody checkout.\n\n";
          } else if (
            !extra &&
            j.error === "checkout_failed" &&
            /may only be sold in memberships or contracts/i.test(mbUpstreamDetail)
          ) {
            extra =
              "In Mindbody this item is flagged as membership/contract-only — a normal online package checkout is not accepted for this SKU. Sell it through Mindbody’s membership/Subscribe or contract checkout, confirm the Sell Online pricing option maps to what the API sends, retry without incompatible promos, or use classic Mindbody checkout below.\n\n";
          } else if (
            !extra &&
            j.error === "checkout_failed" &&
            /intro item may be sold at a time|only 1 of the same intro/i.test(mbUpstreamDetail)
          ) {
            extra =
              "Mindbody rejected the cart: only one intro-priced item of this type is allowed at a time. That often happens when a **promotion** adds another intro line on top of the package, or when this client profile **already redeemed** an intro for that product series. Clear the promo field and try again; if it still fails, the studio should check Mindbody promotions, client purchase history, and “intro pack” limits — or complete the sale in classic Mindbody checkout.\n\n";
          } else if (
            !extra &&
            j.error === "checkout_failed" &&
            /payments is a required parameter|missingrequiredfields/i.test(mbUpstreamDetail)
          ) {
            extra =
              "Mindbody expects at least one row in **Payments**. After a promo that zeros the cart, checkout uses a zero-amount payment row — if you still see this, redeploy/update the checkout function or try classic Mindbody checkout.\n\n";
          } else if (
            !extra &&
            j.error === "checkout_failed" &&
            /payment total\s*\([^)]+\)\s*does not match the calculated total/i.test(mbUpstreamDetail)
          ) {
            extra =
              "Mindbody compared the **sum of payment rows** to the cart **after** your promotion. A **100% off** code makes the cart total **$0** while the page shows list price — the server retries dry-run with a matching payment sum (including a **$0 Comp** row when required).\n\n";
          }
          if (!extra && checkoutDeniedStaffAccessMindbody(j)) {
            extra =
              "Mindbody requires a staff User Token on the server for this sale call. Prefer MINDBODY_STAFF_USERNAME + MINDBODY_STAFF_PASSWORD so tokens are issued automatically.\n\n";
          }
          if (!extra) {
            extra =
              res.status === 504 || res.status === 502
                ? "Gateway timeout or upstream error — Mindbody may still be working on the sale. Wait before retrying; confirm whether you were charged before submitting again.\n\n"
                : "Unexpected error — do not assume the charge succeeded. Check your Mindbody purchases or use classic checkout below.\n\n";
          }
          const msg = mindbodyErrText(
            typeof j.message === "string" ? j.message : mbUpstreamDetail || "Checkout failed",
            j.mindbody,
          );
          if (log) log.textContent = `${extra}${msg}\n\n${log.textContent}`;
        }
      } catch (e) {
        const aborted = e && typeof e === "object" && "name" in e && /** @type {{ name?: string }} */ (e).name === "AbortError";
        if (log) {
          log.textContent = aborted
            ? "This is taking too long — the request was stopped to avoid hanging forever. You may not have been charged. Please try again in a moment or use Mindbody checkout below, or contact us if you are unsure."
            : "Could not complete the checkout request — the outcome is unknown. Check your Mindbody account before paying again. (" +
              String(/** @type {{ message?: string }} */ (e)?.message ?? e).slice(0, 200) +
              ")";
        }
      } finally {
        done = true;
        clearInterval(phaseTimer);
        clearTimeout(abortT);
        syncMembershipSubmitEnabled();
        if (!membershipAckGate) runBtn.disabled = false;
      }
      } finally {
        runBtn.removeAttribute("data-checkout-submitting");
      }
    });

    const rowAct = document.createElement("div");
    rowAct.className = "mb-book-dialog__cta-row";
    rowAct.append(runBtn);
    dlgActions.append(rowAct);

    if (classic) {
      const quiet = document.createElement("p");
      quiet.className = "mb-book-dialog__quiet";
      quiet.innerHTML = `Prefer Mindbody’s checkout? <a href="${escapeHtml(classic)}" target="_blank" rel="noopener noreferrer">Open Mindbody checkout</a> (classic).`;
      dlgActions.append(quiet);
    }
  }

  root.addEventListener("click", (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const btn = t.closest?.("[data-mb-checkout]");
    if (!btn) return;
    const raw = btn.getAttribute("data-mb-checkout");
    if (!raw) return;
    const el = /** @type {HTMLElement} */ (btn);
    const fromMap = checkoutBtnRowRef.get(el);

    /** @type {Record<string, unknown>} */
    let rowPayload;
    if (fromMap && typeof fromMap === "object") {
      rowPayload = /** @type {Record<string, unknown>} */ (fromMap);
    } else {
      rowPayload = { Name: btn.dataset.mbLabel || "Package" };
      const priceNum = btn.dataset.mbPrice ? Number(btn.dataset.mbPrice) : NaN;
      if (Number.isFinite(priceNum)) rowPayload.OnlinePrice = priceNum;
      const idNum = parseInt(raw, 10);
      if (Number.isFinite(idNum)) rowPayload.Id = idNum;
    }

    ev.preventDefault();
    void openCheckoutFlow(rowPayload);
  });

  /** @param {Record<string, unknown>[]} rows */
  function distribute(rows) {
    /** @type {Record<string, Record<string, unknown>[]>} */
    const buckets = { newClient: [], monthly: [], packs: [], dropin: [] };
    for (const row of rows) {
      buckets[bucketForRow(row)].push(row);
    }
    return buckets;
  }

  async function load() {
    statusEl.textContent = "Loading prices from Mindbody…";
    try {
      const [res, cres] = await Promise.all([
        fetch(servicesUrl(), {
          credentials: "same-origin",
          headers: ngrokBypassHeaders({ Accept: "application/json" }),
        }),
        fetch(contractsUrl(), {
          credentials: "same-origin",
          headers: ngrokBypassHeaders({ Accept: "application/json" }),
        }),
      ]);
      const text = await res.text();
      /** @type {unknown} */
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        const looksHtml = /^\s*</.test(text);
        statusEl.innerHTML = looksHtml
          ? `<span class="pricing-api-status pricing-api-status--error">` +
            `Got HTML instead of JSON (HTTP ${res.status}). ` +
            `If you use <strong>ngrok Free</strong>, that can be the browser warning page — ` +
            `add header <code>ngrok-skip-browser-warning: true</code> on API routes, or restart ` +
            `<code>npm run dev:full</code> so <code>/api/mindbody/sale/services</code> is handled locally. ` +
            `If you use <code>dev:static</code> (live-server), switch to <code>npm run dev:full</code> — ` +
            `static servers return 404 for API paths.</span>` +
            (isTunnelOrEphemeralHostname() ? `<span class="pricing-api-status pricing-api-status--tunnel">${tunnelUpstream404HintInner()}</span>` : "")
          : `<span class="pricing-api-status pricing-api-status--error">Mindbody returned non-JSON (HTTP ${res.status}).</span>` +
              (res.status === 404 && isTunnelOrEphemeralHostname()
                ? `<span class="pricing-api-status pricing-api-status--tunnel">${tunnelUpstream404HintInner()}</span>`
                : "");
        return;
      }
      const rows = rowsFromPayload(data);

      if (!res.ok) {
        const errBag = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
        const nested =
          errBag.Error && typeof errBag.Error === "object"
            ? /** @type {Record<string, unknown>} */ (errBag.Error)
            : null;
        const msg =
          (nested && typeof nested.Message === "string" && nested.Message) ||
          (typeof errBag.detail === "string" && errBag.detail) ||
          (typeof errBag.message === "string" && errBag.message) ||
          `Mindbody responded HTTP ${res.status}`;
        statusEl.innerHTML =
          `<span class="pricing-api-status pricing-api-status--error">${escapeHtml(msg)}</span>` +
          (res.status === 404 && isTunnelOrEphemeralHostname()
            ? `<span class="pricing-api-status pricing-api-status--tunnel">${tunnelUpstream404HintInner()}</span>`
            : "");
        for (const m of [mountNew, mountMonthly, mountPacks, mountDrop]) {
          if (m) m.innerHTML = "";
        }
        return;
      }

      const ctext = await cres.text();
      /** @type {unknown} */
      let cdata = null;
      try {
        cdata = ctext ? JSON.parse(ctext) : null;
      } catch {
        cdata = null;
      }
      /** @type {Record<string, unknown>[]} */
      let contractUnified = [];
      if (cres.ok && cdata) {
        contractUnified = rowsFromContractsPayload(cdata)
          .map((c) => normalizeContractRow(c))
          .filter((x) => x != null);
      }
      if (!contractUnified.length) {
        contractUnified = fallbackMonthlyRowsFromConfig();
      }

      /** @type {string} */
      let statusExtra = "";
      if (!cres.ok && contractUnified.length) {
        statusExtra =
          ` <span class="pricing-api-muted">Monthly plans: fallback list (contracts API unavailable — HTTP ${cres.status}). ` +
          `Ensure <code>/api/mindbody/sale/contracts</code> is deployed and your tunnel hits the full dev server (port <code>4321</code>), not static-only hosting.</span>`;
        if (cres.status === 404 && isTunnelOrEphemeralHostname()) {
          statusExtra += `<span class="pricing-api-status pricing-api-status--tunnel">${tunnelUpstream404HintInner()}</span>`;
        }
      } else if (cres.ok && contractUnified.length && contractUnified.every((r) => r.__pricingFallback === true)) {
        statusExtra =
          ` <span class="pricing-api-muted">Monthly plans use built-in fallback (Mindbody returned no sell-online contracts for this query).</span>`;
      }

      const b = distribute(rows);
      const monthlyMerged = mergeMonthlyRows(b.monthly, contractUnified);
      statusEl.innerHTML = statusExtra || "";
      renderSection(mountNew, b.newClient, "newClient");
      renderSection(mountMonthly, monthlyMerged, "monthly");
      renderSection(mountPacks, b.packs, "packs");
      renderSection(mountDrop, b.dropin, "dropin");
      maybeAutoOpenPendingPricingCheckoutAfterRender();
    } catch (e) {
      statusEl.innerHTML = `<span class="pricing-api-status pricing-api-status--error">${escapeHtml(String(e))}</span>`;
    }
  }

  void load();
})();
