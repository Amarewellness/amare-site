/**
 * Watch src/public/build script, rebuild on change, serve dist with live reload.
 * Usage: npm run dev:static  (requires: npm install)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, execSync } from "node:child_process";
import chokidar from "chokidar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function build() {
  execSync("node scripts/build.mjs", { cwd: root, stdio: "inherit", env: process.env });
}

console.log("[dev] Initial build...");
build();

const patterns = [
  path.join(root, "src"),
  path.join(root, "public"),
  path.join(root, "scripts", "build.mjs"),
];

let timer;
const watcher = chokidar.watch(patterns, {
  ignoreInitial: true,
});

watcher.on("all", () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      console.log("[dev] Change detected — rebuilding...");
      build();
    } catch (e) {
      console.error("[dev] Build failed:", e?.message ?? e);
    }
  }, 280);
});

const liveBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "live-server.cmd" : "live-server"
);
if (!fs.existsSync(liveBin)) {
  console.error("[dev] Missing live-server. Run: npm install");
  process.exit(1);
}
const ls = spawn(liveBin, ["dist", "--port=4321"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

ls.on("error", (err) => {
  console.error("[dev] Could not start live-server. Did you run npm install?");
  console.error(err);
  process.exit(1);
});

function shutdown() {
  watcher.close().catch(() => {});
  ls.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
