/**
 * Regression for the Android SecureStorage.then() installation-id bug.
 * Does not change production push. Does not import session-store.
 * Run: npm run test:amare-push-installation-id
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = path.join(root, "amare-app/src/push/installation-id.ts");
const ts = createRequire(path.join(root, "amare-app/package.json"))("typescript");

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const src = fs.readFileSync(srcPath, "utf8");
check("source does not return the raw Capacitor plugin", !/\breturn\s+store\s*;/.test(src));
check(
  "source wraps getItem/setItem on a plain object",
  /return\s*\{\s*getItem:\s*\(key\)\s*=>\s*store\.getItem\(key\),\s*setItem:\s*\(key,\s*value\)\s*=>\s*store\.setItem\(key,\s*value\),/.test(
    src,
  ),
);
check("source shares one in-flight initialization", /if\s*\(inflight\)\s*return\s*inflight/.test(src));
check(
  "source uses localStorage only after native secure miss",
  /if\s*\(secure\)\s*\{[\s\S]*await\s+secure\.setItem\(KEY,\s*id\);[\s\S]*return\s+id;[\s\S]*\}\s*try\s*\{\s*const existing = localStorage\.getItem\(KEY\)/.test(
    src,
  ),
);

const prepared = src.replace(
  'await import("@aparajita/capacitor-secure-storage")',
  "await globalThis.__AMARE_SECURE_STORAGE_MOD__()",
);
const transpiled = ts.transpileModule(prepared, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "installation-id.ts",
}).outputText;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHarness() {
  const kv = new Map();
  const stats = { getItem: 0, setItem: 0, then: 0, webGet: 0, webSet: 0 };
  const plugin = {
    getItem: async (key) => {
      stats.getItem += 1;
      await delay(40);
      const v = kv.get(key);
      return typeof v === "string" ? v : null;
    },
    setItem: async (key, value) => {
      stats.setItem += 1;
      kv.set(key, value);
    },
    then(resolve) {
      stats.then += 1;
      throw new Error("SecureStorage.then() is not implemented on android");
    },
  };
  return { kv, stats, plugin };
}

async function loadModule(dir, name, windowObj, localStorageObj, plugin) {
  globalThis.window = windowObj;
  globalThis.localStorage = localStorageObj;
  globalThis.__AMARE_SECURE_STORAGE_MOD__ = async () => ({ SecureStorage: plugin });
  const file = path.join(dir, name);
  fs.writeFileSync(file, transpiled);
  return import(`${pathToFileURL(file).href}?t=${name}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amare-install-id-"));
try {
  const { kv, stats, plugin } = makeHarness();
  const webStore = new Map();
  const localStorageObj = {
    getItem(key) {
      stats.webGet += 1;
      return webStore.has(key) ? webStore.get(key) : null;
    },
    setItem(key, value) {
      stats.webSet += 1;
      webStore.set(key, String(value));
    },
  };
  const windowObj = { Capacitor: { isNativePlatform: () => true } };

  const mod = await loadModule(dir, "a.mjs", windowObj, localStorageObj, plugin);
  let threw = null;
  let ids = [];
  try {
    ids = await Promise.all([
      mod.getOrCreateInstallationId(),
      mod.getOrCreateInstallationId(),
      mod.getOrCreateInstallationId(),
      mod.getOrCreateInstallationId(),
    ]);
  } catch (err) {
    threw = err;
  }

  check("thenable plugin does not throw SecureStorage.then()", threw == null, threw ? String(threw.message || threw) : "");
  check("plugin.then was never invoked", stats.then === 0, `then=${stats.then}`);
  const unique = [...new Set(ids)];
  check("concurrent requests return one durable installationId", unique.length === 1 && String(unique[0] || "").startsWith("ins_"), `ids=${JSON.stringify(ids)}`);
  check("plugin getItem wrapper invoked", stats.getItem >= 1, `getItem=${stats.getItem}`);
  check("plugin setItem wrapper invoked once for create", stats.setItem === 1, `setItem=${stats.setItem}`);
  check("native path does not fall back to localStorage", stats.webGet === 0 && stats.webSet === 0, `webGet=${stats.webGet} webSet=${stats.webSet}`);

  const again = await mod.getOrCreateInstallationId();
  check("same module returns the same cached installationId", again === unique[0]);

  const statsB = { getItem: 0, setItem: 0, then: 0, webGet: 0, webSet: 0 };
  const pluginB = {
    getItem: async (key) => {
      statsB.getItem += 1;
      const v = kv.get(key);
      return typeof v === "string" ? v : null;
    },
    setItem: async (key, value) => {
      statsB.setItem += 1;
      kv.set(key, value);
    },
    then() {
      statsB.then += 1;
      throw new Error("SecureStorage.then() is not implemented on android");
    },
  };
  const webB = {
    getItem() {
      statsB.webGet += 1;
      return null;
    },
    setItem() {
      statsB.webSet += 1;
    },
  };
  const modB = await loadModule(dir, "b.mjs", windowObj, webB, pluginB);
  const restored = await modB.getOrCreateInstallationId();
  check("second native load restores the Keystore installationId", restored === unique[0], `got=${restored}`);
  check("restored load uses getItem not setItem", statsB.getItem >= 1 && statsB.setItem === 0, `getItem=${statsB.getItem} setItem=${statsB.setItem}`);
  check("restored load does not use localStorage", statsB.webGet === 0 && statsB.webSet === 0);
  check("restored load does not await the raw plugin", statsB.then === 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.log(`\nRESULT: FAIL (${failed})`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
