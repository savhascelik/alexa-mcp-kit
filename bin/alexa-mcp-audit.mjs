#!/usr/bin/env node
import { runCertificationAudit } from "../src/inspector-audit.mjs";

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith("--url="))?.split("=")[1] || args[0];
const outDir = args.find((a) => a.startsWith("--out="))?.split("=")[1] || process.cwd();

if (!urlArg || urlArg === "--help" || urlArg === "-h") {
  console.log("Usage: alexa-mcp-audit <http://127.0.0.1:PORT/mcp> [--out=./directory]");
  process.exit(urlArg ? 0 : 1);
}

const { certificationVerdict } = await runCertificationAudit({
  endpointUrl: urlArg,
  outDir
});

console.log(
  `[Alexa+ MCP Audit] Verdict: ${certificationVerdict.verdict} (${certificationVerdict.passCount}/${certificationVerdict.totalRules} rules passed)`
);
for (const rule of certificationVerdict.rules) {
  console.log(`  [${rule.status}] ${rule.ruleId} — ${rule.title}: ${rule.details}`);
}

process.exit(certificationVerdict.verdict === "CERTIFIED" ? 0 : 1);
