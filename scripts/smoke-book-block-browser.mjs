/**
 * Browser smoke tests for /classes Book-block Phase 1.
 * Run: node scripts/smoke-book-block-browser.mjs
 *
 * Fully mocked APIs — no real Mindbody data or live schedule required.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const PORT = Number(process.env.SMOKE_PORT || 4322);
const BASE = `http://127.0.0.1:${PORT}`;

/** @param {string} rel */
function distFile(rel) {
  return path.join(dist, rel.replace(/^\//, ""));
}

/** Minimal static server for dist/ */
function startStaticServer() {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webp": "image/webp",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || "/", BASE);
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith("/")) p += "index.html";
    const filePath = distFile(p);
    if (!filePath.startsWith(dist) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve, reject) => {
    srv.on("error", reject);
    srv.listen(PORT, "127.0.0.1", () => resolve(srv));
  });
}

function etWallClockParts(offsetMs = 0) {
  const targetMs = Date.now() + offsetMs;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(targetMs);
  const get = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hm: `${get("hour")}:${get("minute")}`,
  };
}

/** Guaranteed upcoming class on today's ET date (+2h) — survives past-class filtering. */
function mockClassesPayload() {
  const { day, hm } = etWallClockParts(2 * 3600000);
  const start = `${day}T${hm}:00`;
  const endParts = etWallClockParts(3 * 3600000);
  const end = `${endParts.day}T${endParts.hm}:00`;
  return {
    Classes: [
      {
        Id: 900001,
        StartDateTime: start,
        EndDateTime: end,
        MaxCapacity: 12,
        TotalBooked: 2,
        ClassDescription: { Name: "Smoke Test Reformer" },
        Staff: { Name: "Test Instructor" },
      },
    ],
  };
}

/** @param {Record<string, unknown>} session */
function aydenLikeSession(session = {}) {
  return {
    authenticated: true,
    loggedIn: true,
    email: "aydenbuchwald@gmail.com",
    name: "Ayden Test",
    clientExists: true,
    clientId: 100003087,
    bookingAllowed: false,
    linkStatus: "not_associated",
    consumerAssociated: false,
    ...session,
  };
}

function emptySummaryPayload() {
  return {
    clientId: 100003087,
    clientServices: { ClientServices: [] },
    memberships: {},
  };
}

function summaryWithOneCredit() {
  return {
    clientId: 100003087,
    clientServices: {
      ClientServices: [{ Remaining: 1, Name: "Comp Class" }],
    },
    memberships: {},
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {{
 *   session: Record<string, unknown>,
 *   summaryDelayMs?: number,
 *   summaryStatus?: number,
 *   summaryBody?: unknown,
 *   classesBody?: unknown,
 *   summaryGate?: { release: () => void },
 * }} opts
 */
async function setupMocks(page, opts) {
  const {
    session,
    summaryDelayMs = 0,
    summaryStatus = 200,
    summaryBody = emptySummaryPayload(),
    classesBody = mockClassesPayload(),
    summaryGate = null,
  } = opts;

  // Catch-all first; specific routes registered after (Playwright LIFO — specific wins).
  await page.route("**/api/mindbody/**", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route("**/api/mindbody/oauth/session**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });

  await page.route("**/api/mindbody/class/classes**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(classesBody),
    });
  });

  await page.route("**/api/mindbody/member/summary**", async (route) => {
    if (summaryGate) {
      await new Promise((resolve) => {
        summaryGate.release = resolve;
      });
    }
    if (summaryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, summaryDelayMs));
    }
    if (summaryStatus >= 400) {
      await route.fulfill({ status: summaryStatus, body: "error" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(summaryBody),
    });
  });

  await page.route("**/api/mindbody/sale/services**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        Services: [{ Id: 101, Name: "Smoke Test Drop-in", OnlinePrice: 35, SellOnline: true }],
      }),
    });
  });

  await page.route("**/api/mindbody/sale/contracts**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ Contracts: [] }),
    });
  });

  await page.route("**/api/mindbody/oauth/complete-studio-profile**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        clientExists: true,
        clientId: 100003099,
        created: true,
        consumerAssociated: false,
        bookingAllowed: false,
        linkStatus: "not_associated",
      }),
    });
  });
}

/** @param {import('playwright').Page} page */
async function expectInlinePackagesInDialog(page) {
  await waitForDialogMatching(page, /Packages & memberships · buy online/, 15000);
  await page.getByRole("button", { name: /^Buy$/i }).first().waitFor({ state: "visible", timeout: 15000 });
}

/** @param {import('playwright').Page} page */
function enabledBookButtonLocator(page) {
  return page
    .locator('[data-testid="class-book-button"]:not([disabled])')
    .or(page.getByRole("button", { name: /^Book$/i }).and(page.locator(":not([disabled])")));
}

/** @param {import('playwright').Page} page */
async function waitForScheduleShell(page) {
  await page.waitForFunction(
    () => {
      const status = document.getElementById("mb-schedule-status");
      const cal = document.getElementById("mb-schedule-calendar");
      if (!status) return false;
      const loading = /loading classes/i.test(status.textContent || "");
      if (loading) return false;
      return cal && !cal.hasAttribute("hidden");
    },
    { timeout: 20000 },
  );
}

/** @param {import('playwright').Page} page */
async function findEnabledBookButton(page) {
  await waitForScheduleShell(page);

  const book = enabledBookButtonLocator(page).first();
  if (await book.isVisible().catch(() => false)) {
    return book;
  }

  // Walk day strip — pick first day that exposes an enabled Book button.
  const dayButtons = page.locator("#mb-day-strip button");
  const count = await dayButtons.count();
  for (let i = 0; i < count; i += 1) {
    await dayButtons.nth(i).click();
    const candidate = enabledBookButtonLocator(page).first();
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  const status = await page.locator("#mb-schedule-status").innerText().catch(() => "");
  const content = await page.locator("#mb-schedule-content").innerText().catch(() => "");
  throw new Error(
    `No enabled Book button found.\nstatus: ${status}\ncontent: ${content.slice(0, 300)}`,
  );
}

/** @param {import('playwright').Page} page */
async function openClassesPage(page) {
  await page.goto(`${BASE}/classes.html`, { waitUntil: "domcontentloaded" });
}

/** @param {import('playwright').Page} page */
async function readBookDialogText(page) {
  const dlg = page.locator("#mb-book-dialog");
  await dlg.waitFor({ state: "visible", timeout: 10000 });
  const title = (await page.locator("#mb-book-dialog-title").innerText()).trim();
  const body = (await page.locator("#mb-book-dialog-actions").innerText()).trim();
  return `${title}\n${body}`;
}

/**
 * @param {import('playwright').Page} page
 * @param {RegExp} pattern
 * @param {number} timeoutMs
 */
async function waitForDialogMatching(page, pattern, timeoutMs = 10000) {
  const reSource = pattern.source;
  await page.waitForFunction(
    (src) => {
      const re = new RegExp(src, "i");
      const title = document.getElementById("mb-book-dialog-title");
      const actions = document.getElementById("mb-book-dialog-actions");
      const combined = `${title?.textContent || ""}\n${actions?.textContent || ""}`;
      return re.test(combined);
    },
    reSource,
    { timeout: timeoutMs },
  );
}

/** @param {string} name @param {() => Promise<void>} fn */
async function runCheck(name, fn) {
  process.stdout.write(`\n▶ ${name} … `);
  try {
    await fn();
    console.log("PASS");
    return true;
  } catch (err) {
    console.log("FAIL");
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const srv = await startStaticServer();
let browser;
let failed = 0;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  if (
    !(await runCheck("1. Ayden-like → Purchase first (not Contact studio)", async () => {
      const page = await context.newPage();
      await setupMocks(page, { session: aydenLikeSession() });
      await openClassesPage(page);
      await (await findEnabledBookButton(page)).click();
      const text = await readBookDialogText(page);
      if (!/Purchase a package first/i.test(text)) {
        throw new Error(`Expected "Purchase a package first", got:\n${text}`);
      }
      await expectInlinePackagesInDialog(page);
      if (/^View Packages$/m.test(text)) {
        throw new Error(`Primary CTA should be inline Buy catalog, not standalone View Packages:\n${text}`);
      }
      if (/Contact studio/i.test(text)) {
        throw new Error(`Must NOT show Contact studio as primary block, got:\n${text}`);
      }
      await page.close();
    }))
  ) {
    failed += 1;
  }

  if (
    !(await runCheck(
      "2. Slow wallet → Checking credits immediately, then Purchase first",
      async () => {
        const page = await context.newPage();
        /** @type {{ release: (() => void) | null }} */
        const summaryGate = { release: null };
        await setupMocks(page, {
          session: aydenLikeSession(),
          summaryDelayMs: 2000,
          summaryGate,
        });
        await openClassesPage(page);
        const bookBtn = await findEnabledBookButton(page);

        const clickAt = Date.now();
        await bookBtn.click();

        await page.getByText(/Checking your AMARÉ credits/i).waitFor({
          state: "visible",
          timeout: 3000,
        });
        const msToChecking = Date.now() - clickAt;
        if (msToChecking > 3000) {
          throw new Error(
            `Checking modal took ${msToChecking}ms — likely waited silently before showing loading UI`,
          );
        }

        if (typeof summaryGate.release === "function") {
          summaryGate.release();
        }

        await waitForDialogMatching(page, /Purchase a package first/, 15000);
        await page.close();
      },
    ))
  ) {
    failed += 1;
  }

  if (
    !(await runCheck(
      "3. snir30-like: bookingAllowed=true + no credits → Purchase first",
      async () => {
        const page = await context.newPage();
        await setupMocks(page, {
          session: aydenLikeSession({
            bookingAllowed: true,
            linkStatus: "ready",
            consumerAssociated: true,
          }),
          summaryBody: emptySummaryPayload(),
        });
        await openClassesPage(page);
        await (await findEnabledBookButton(page)).click();
        const text = await readBookDialogText(page);
        if (!/Purchase a package first/i.test(text)) {
          throw new Error(`Expected Purchase a package first, got:\n${text}`);
        }
        await expectInlinePackagesInDialog(page);
        if (/Confirm booking/i.test(text)) {
          throw new Error(`Must NOT show Confirm booking without credits, got:\n${text}`);
        }
        await page.close();
      },
    ))
  ) {
    failed += 1;
  }

  if (
    !(await runCheck(
      "4. bookingAllowed=true + wallet error → Couldn't confirm credits",
      async () => {
        const page = await context.newPage();
        await setupMocks(page, {
          session: aydenLikeSession({
            bookingAllowed: true,
            linkStatus: "ready",
            consumerAssociated: true,
          }),
          summaryStatus: 500,
        });
        await openClassesPage(page);
        await (await findEnabledBookButton(page)).click();
        const text = await readBookDialogText(page);
        if (!/confirm your AMARÉ package/i.test(text)) {
          throw new Error(`Expected wallet_unknown modal, got:\n${text}`);
        }
        if (/Confirm booking/i.test(text)) {
          throw new Error(`Must NOT show Confirm booking on wallet error, got:\n${text}`);
        }
        await page.close();
      },
    ))
  ) {
    failed += 1;
  }

  if (
    !(await runCheck(
      "5. bookingAllowed=true + active credits → Confirm booking",
      async () => {
        const page = await context.newPage();
        await setupMocks(page, {
          session: aydenLikeSession({
            bookingAllowed: true,
            linkStatus: "ready",
            consumerAssociated: true,
          }),
          summaryBody: summaryWithOneCredit(),
        });
        await openClassesPage(page);
        await (await findEnabledBookButton(page)).click();
        const text = await readBookDialogText(page);
        if (!/Confirm booking/i.test(text)) {
          throw new Error(`Expected Confirm booking, got:\n${text}`);
        }
        if (/Purchase a package first|Checking your AMARÉ credits|Couldn't confirm/i.test(text)) {
          throw new Error(`Must NOT show wallet block when credits exist, got:\n${text}`);
        }
        await page.close();
      },
    ))
  ) {
    failed += 1;
  }
} finally {
  if (browser) await browser.close();
  srv.close();
}

if (failed) {
  console.log(`\n${failed} browser smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll 5 browser smoke checks passed.");
