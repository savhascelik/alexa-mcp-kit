import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  AlexaMcpServer,
  createAlexaUiWidget,
  runCertificationAudit
} from "../src/index.mjs";

async function buildAndAuditServer({ broken = false, outDir = null } = {}) {
  const server = new AlexaMcpServer({
    name: broken ? "broken-mcp-server" : "certified-mcp-server",
    version: "1.0.0",
    strictUiResource: !broken,
    strictVoiceSummary: !broken
  });

  server.registerAppResource({
    uri: "ui://audit/dashboard",
    name: "Audit Dashboard",
    description: "Main Alexa+ audit widget",
    render: ({ displayMode, state, voiceSummary }) => {
      if (broken) {
        // Deliberately return low-contrast, small-touch, missing fullscreen panel, no CSP HTML
        return `<html lang="en"><body data-display-mode="${displayMode}" data-contrast-ratio="2.1" data-min-touch-px="28"><section class="mode-panel" data-mode-panel="inline">Broken</section></body></html>`;
      }
      return createAlexaUiWidget({
        uri: "ui://audit/dashboard",
        title: "Certified Household Dashboard",
        subtitle: "Alexa+ 3-Mode Verified",
        displayMode,
        voiceSummary: voiceSummary || "Certified dashboard ready with $180 savings.",
        metrics: [
          { label: "Status", value: "CERTIFIED" },
          { label: "Savings", value: "$180.00" }
        ],
        rows: [
          {
            id: "r1",
            title: "CPT 99284 Audit",
            subtitle: "Verified against CMS fee schedule",
            originalLabel: "$420.00",
            fairLabel: "$240.00",
            deltaLabel: "-$180.00",
            citation: "CMS 2026"
          }
        ]
      });
    }
  });

  server.registerAppTool({
    name: "inspect_bill",
    title: "Inspect Bill",
    description: "Audits a household bill and renders the Alexa+ dashboard.",
    resourceUri: broken ? "ui://audit/non-existent-resource" : "ui://audit/dashboard",
    displayModes: broken ? ["inline"] : ["inline", "fullscreen", "voice-only"],
    inputSchema: {
      type: "object",
      required: ["billTotal"],
      properties: {
        billTotal: { type: "number" }
      }
    },
    handler: async ({ billTotal }) => ({
      voiceSummary: broken ? "" : `Audited bill of $${billTotal} and found $180 in savings.`,
      structuredContent: {
        billTotal,
        savings: 180
      }
    })
  });

  const { url } = await server.listen(0, "127.0.0.1");
  try {
    return await runCertificationAudit({
      endpointUrl: url,
      sampleToolCalls: {
        inspect_bill: { billTotal: 420 }
      },
      outDir
    });
  } finally {
    await server.close();
  }
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "alexa-mcp-cert-"));
try {
  // 1. Positive audit: compliant server must receive CERTIFIED verdict
  const { certificationVerdict, inspectionSummary } = await buildAndAuditServer({
    broken: false,
    outDir: tmpDir
  });

  assert.equal(
    certificationVerdict.verdict,
    "CERTIFIED",
    `Expected verdict CERTIFIED, got ${certificationVerdict.verdict}: ${JSON.stringify(
      inspectionSummary.failedRules
    )}`
  );
  assert.equal(certificationVerdict.failCount, 0, "Expected 0 failed rules");
  assert.equal(certificationVerdict.passCount, 7, "Expected all 7 inspector rules to PASS");

  // Verify files written on disk
  const verdictDisk = JSON.parse(
    await fs.readFile(path.join(tmpDir, "certification-verdict.json"), "utf8")
  );
  const summaryDisk = JSON.parse(
    await fs.readFile(path.join(tmpDir, "inspection-summary.json"), "utf8")
  );

  assert.equal(verdictDisk.verdict, "CERTIFIED");
  assert.equal(summaryDisk.toolsInspected, 1);
  assert.equal(summaryDisk.resourcesInspected, 1);

  // 2. Negative audit: non-compliant server must receive NOT_CERTIFIED verdict and fail VR-01..04, DL-02, SEC-01
  const brokenAudit = await buildAndAuditServer({
    broken: true
  });

  assert.equal(
    brokenAudit.certificationVerdict.verdict,
    "NOT_CERTIFIED",
    "Non-compliant MCP server MUST receive verdict NOT_CERTIFIED"
  );

  const failedIds = brokenAudit.inspectionSummary.failedRules.map((r) => r.ruleId);
  for (const expectedRule of ["VR-01", "VR-02", "VR-03", "VR-04", "DL-02", "SEC-01"]) {
    assert.ok(
      failedIds.includes(expectedRule),
      `Expected non-compliant server to fail rule ${expectedRule}, but failedIds=${JSON.stringify(failedIds)}`
    );
  }

  console.log(
    `[PASS] Phase 3 Certification Auditor passed (${certificationVerdict.passCount}/${certificationVerdict.totalRules} rules CERTIFIED, non-compliant server rejected with ${failedIds.length} violations).`
  );
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
