import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const scripts = [
  "check_phase1.mjs",
  "check_phase2.mjs",
  "check_phase3.mjs",
  "check_phase5_discovery.mjs",
  "check_phase6_codemode.mjs"
];

for (const script of scripts) {
  const scriptPath = path.join(__dirname, script);
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: rootDir,
    stdio: "inherit"
  });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

const requiredFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "src/index.mjs",
  "src/ui-shell.mjs",
  "src/inspector-audit.mjs",
  "src/tool-discovery.mjs",
  "src/codemode-sandbox.mjs",
  "bin/alexa-mcp-audit.mjs"
];

for (const file of requiredFiles) {
  const fullPath = path.join(rootDir, file);
  if (!fs.existsSync(fullPath)) {
    console.error(`[FAIL] Missing required artifact: ${file}`);
    process.exit(1);
  }
}

console.log("[ALL PASS] alexa-mcp-kit verification suite succeeded.");
