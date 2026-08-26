/**
 * One-shot local Play Store keystore + signed AAB build.
 * Never prints passwords. Writes credentials outside the git repo.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(root, "android");
const releaseDir = path.join(androidRoot, "release");
const keystorePath = path.join(releaseDir, "amare-release.jks");
const alias = "amare";
const handoffPath = path.join(os.homedir(), "amare-android-upload-keystore-handoff.txt");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    ...opts,
  });
  return { status: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex").toUpperCase();
}

function parseCertFingerprints(listOutput) {
  const sha1 = (listOutput.match(/SHA1:\s*([^\n]+)/i) || [])[1]?.trim() || null;
  const sha256 = (listOutput.match(/SHA256:\s*([^\n]+)/i) || [])[1]?.trim() || null;
  return { sha1, sha256 };
}

const keystoreExisted = fs.existsSync(keystorePath);
let storePassword = process.env.AMARE_ANDROID_KEYSTORE_PASSWORD || "";
let keyPassword = process.env.AMARE_ANDROID_KEY_PASSWORD || "";

if (keystoreExisted && !storePassword && fs.existsSync(handoffPath)) {
  const handoff = fs.readFileSync(handoffPath, "utf8");
  storePassword = (handoff.match(/^Store password: (.+)$/m) || [])[1] || "";
  keyPassword = (handoff.match(/^Key password: (.+)$/m) || [])[1] || storePassword;
}

if (!keystoreExisted) {
  fs.mkdirSync(releaseDir, { recursive: true });
  if (!storePassword) storePassword = crypto.randomBytes(18).toString("base64url");
  if (!keyPassword) keyPassword = storePassword;

  const keytool = process.env.KEYTOOL_PATH || "keytool";
  const gen = run(keytool, [
    "-genkeypair",
    "-v",
    "-storetype",
    "JKS",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-alias",
    alias,
    "-keystore",
    keystorePath,
    "-storepass",
    storePassword,
    "-keypass",
    keyPassword,
    "-dname",
    "CN=AMARE Wellness, OU=Mobile, O=AMARE Wellness, L=New York, ST=NY, C=US",
  ]);
  if (gen.status !== 0) {
    console.error("FAIL keystore generation");
    process.exit(1);
  }

  const list = run(keytool, ["-list", "-v", "-keystore", keystorePath, "-alias", alias, "-storepass", storePassword]);
  const fps = parseCertFingerprints(list.stdout + list.stderr);
  const handoff = [
    "AMARE Android upload keystore — store outside git / password manager",
    `Created: ${new Date().toISOString()}`,
    `Keystore path: ${keystorePath}`,
    `Alias: ${alias}`,
    `Store password: ${storePassword}`,
    `Key password: ${keyPassword}`,
    `Certificate SHA-1: ${fps.sha1 || "(see keytool -list)"}`,
    `Certificate SHA-256: ${fps.sha256 || "(see keytool -list)"}`,
    "",
    "After copying to your password manager, delete this file.",
    "",
  ].join("\n");
  fs.writeFileSync(handoffPath, handoff, { mode: 0o600 });
} else {
  if (!storePassword || !keyPassword) {
    console.error("Existing keystore found. Set AMARE_ANDROID_* env vars or create handoff file.");
    process.exit(1);
  }
}

process.env.AMARE_ANDROID_KEYSTORE_PATH = "release/amare-release.jks";
process.env.AMARE_ANDROID_KEYSTORE_PASSWORD = storePassword;
process.env.AMARE_ANDROID_KEY_ALIAS = alias;
process.env.AMARE_ANDROID_KEY_PASSWORD = keyPassword;

const propsScript = path.join(root, "scripts", "write-android-keystore-properties.mjs");
let r = spawnSync(process.execPath, [propsScript], { cwd: root, encoding: "utf8", windowsHide: true });
if (r.status !== 0) {
  console.error("FAIL write-android-keystore-properties");
  process.exit(r.status || 1);
}

r = spawnSync("npm", ["run", "android:bundle-release"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  shell: true,
});
if (r.status !== 0) {
  console.error("FAIL android:bundle-release");
  process.exit(r.status || 1);
}

const aabPath = path.join(androidRoot, "app", "build", "outputs", "bundle", "release", "app-release.aab");
if (!fs.existsSync(aabPath)) {
  console.error("FAIL AAB not found");
  process.exit(1);
}

const keytool = process.env.KEYTOOL_PATH || "keytool";
const list = run(keytool, ["-list", "-v", "-keystore", keystorePath, "-alias", alias, "-storepass", storePassword]);
const cert = parseCertFingerprints(list.stdout + list.stderr);

const verify = run("jarsigner", ["-verify", "-verbose", "-certs", aabPath]);
const signedBy = `${verify.stdout}\n${verify.stderr}`;
const isDebugSigned = /CN=Android Debug/i.test(signedBy);
const isReleaseSigned = verify.status === 0 && !isDebugSigned;

const gitIgnoreJks = run("git", ["check-ignore", "-v", keystorePath], { cwd: root });
const gitIgnoreProps = run("git", ["check-ignore", "-v", path.join(androidRoot, "keystore.properties")], {
  cwd: root,
});
const gitStatus = run("git", ["status", "--porcelain", keystorePath, path.join(androidRoot, "keystore.properties")], {
  cwd: root,
});

console.log(
  JSON.stringify(
    {
      keystoreAction: keystoreExisted ? "existing_used" : "new_generated",
      handoffPath: keystoreExisted ? null : handoffPath,
      keystorePath,
      keystoreGitignored: gitIgnoreJks.status === 0,
      keystoreNotTracked: gitStatus.stdout.trim() === "",
      keystorePropertiesGitignored: gitIgnoreProps.status === 0,
      aabPath,
      aabSha256: sha256File(aabPath),
      applicationId: "com.amarewellness.app",
      versionCode: 1,
      versionName: "1.0",
      signingCertSha1: cert.sha1,
      signingCertSha256: cert.sha256,
      releaseSigned: isReleaseSigned,
      debugSigned: isDebugSigned,
      readyForPlayInternalTesting: isReleaseSigned,
    },
    null,
    2,
  ),
);
