import assert from "node:assert/strict";
import {
  createAlexaUiWidget,
  getContrastRatio,
  auditThemeAccessibility,
  inspectHtmlAccessibility,
  DEFAULT_ALEXA_THEME
} from "../src/ui-shell.mjs";

function verifyHtmlWidgetContract(html) {
  assert.ok(html.includes("<!DOCTYPE html>"), "Widget must be a full HTML5 document");
  assert.ok(
    html.includes("http-equiv=\"Content-Security-Policy\""),
    "Widget must include a Content-Security-Policy meta tag"
  );

  // Verify all 3 Alexa+ display modes are rendered as actual section elements and switchable
  for (const mode of ["inline", "fullscreen", "voice-only"]) {
    assert.ok(
      html.includes(`<section class="mode-panel" data-mode-panel="${mode}"`),
      `Widget must include adaptive <section> panel for display mode '${mode}'`
    );
    assert.ok(
      html.includes(`data-target-mode="${mode}"`),
      `Widget must include mode switcher button for '${mode}'`
    );
  }

  // Verify real CSS touch target dimensions >= 44px and WCAG AA contrast >= 4.5 computed from <style>
  const a11y = inspectHtmlAccessibility(html);
  assert.ok(
    a11y.validTouch && a11y.minTouchPx >= 44,
    `Touch target size in CSS must be >= 44px for Alexa+ screens, got ${a11y.minTouchPx}px`
  );
  assert.ok(
    a11y.validContrast && a11y.minContrastRatio >= 4.5,
    `Minimum computed WCAG contrast ratio from CSS must be >= 4.5:1, got ${a11y.minContrastRatio}:1`
  );

  // Verify MCP Apps postMessage bridge
  assert.ok(
    html.includes("method: \"ui/initialize\"") && html.includes("method: \"tools/call\""),
    "Widget must include MCP Apps postMessage RPC bridge (ui/initialize & tools/call)"
  );
}

// 1. Mathematical check on WCAG 2.1 contrast calculation
const bwContrast = getContrastRatio("#FFFFFF", "#000000");
assert.equal(bwContrast, 21, "Pure white on pure black must equal 21:1 contrast");

const defaultAudit = auditThemeAccessibility(DEFAULT_ALEXA_THEME);
assert.equal(defaultAudit.valid, true, "Default Alexa+ theme must pass all WCAG AA & touch checks");
assert.ok(
  defaultAudit.minContrastRatio >= 4.5,
  `Default theme min contrast (${defaultAudit.minContrastRatio}:1) must be >= 4.5:1`
);

// 2. Render widget across all 3 initial modes and verify contract
for (const mode of ["inline", "fullscreen", "voice-only"]) {
  const html = createAlexaUiWidget({
    uri: "ui://test/adaptive-board",
    title: "Household Audit Summary",
    subtitle: "CMS & OpenEI verified analysis",
    displayMode: mode,
    voiceSummary: "You have $412 in recoverable charges across two items.",
    metrics: [
      { label: "Total Billed", value: "$1,240.00" },
      { label: "Fair Benchmark", value: "$828.00" },
      { label: "Recoverable", value: "$412.00", tone: "danger" }
    ],
    rows: [
      {
        id: "item-1",
        title: "CPT 99285 Emergency Visit",
        subtitle: "Upcoded from Level 3",
        originalLabel: "$980.00",
        fairLabel: "$568.00",
        deltaLabel: "-$412.00",
        citation: "CMS PFS 2026",
        actionTool: "generate_dispute",
        actionLabel: "Dispute Item",
        actionArgs: { itemId: "item-1" }
      }
    ],
    actions: [
      {
        id: "act-1",
        label: "Generate Official Dispute Packet",
        toolName: "generate_dispute",
        toolArgs: { all: true },
        primary: true
      }
    ]
  });

  assert.ok(
    html.includes(`data-display-mode="${mode}"`),
    `Initial displayMode must be set to '${mode}'`
  );
  verifyHtmlWidgetContract(html);
}

// 3. Negative accessibility validation checks (low contrast, undersized touch target, missing display mode)
assert.throws(
  () =>
    createAlexaUiWidget({
      uri: "ui://test/broken-contrast",
      title: "Broken Contrast",
      theme: {
        textSecondary: "#334155",
        bgCard: "#111C33"
      }
    }),
  /Accessibility Audit Failed/,
  "Low contrast theme (< 4.5:1) must be rejected at build time"
);

assert.throws(
  () =>
    createAlexaUiWidget({
      uri: "ui://test/broken-touch",
      title: "Broken Touch",
      theme: {
        minTouchPx: 30
      }
    }),
  /Accessibility Audit Failed/,
  "Undersized touch target (< 44px) must be rejected at build time"
);

const validHtml = createAlexaUiWidget({
  uri: "ui://test/valid",
  title: "Valid"
});
const corruptedHtml = validHtml.replaceAll(
  'data-mode-panel="voice-only"',
  'data-mode-panel="missing"'
);
assert.throws(
  () => verifyHtmlWidgetContract(corruptedHtml),
  /voice-only/,
  "Missing voice-only display mode panel must be caught"
);

console.log(
  `[PASS] Phase 2 Adaptive 3-Mode UI Generator & WCAG Contrast checks passed (minContrast=${defaultAudit.minContrastRatio}:1, minTouch=${defaultAudit.minTouchPx}px, 3/3 negative boundary checks passed).`
);
