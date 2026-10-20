import fs from "node:fs/promises";
import path from "node:path";
import { ALEXA_MCP_PROTOCOL_VERSION, MCP_APP_MIME_TYPE } from "./index.mjs";
import { inspectHtmlAccessibility } from "./ui-shell.mjs";

/**
 * Pre-Flight Readiness Linter & Protocol Auditor for Alexa+ MCP Servers.
 *
 * Connects to a live Streamable HTTP MCP endpoint, inspects every registered tool
 * and ui:// resource across Inline, Fullscreen, and Voice-only display modes,
 * computes real WCAG 2.1 AA contrast ratios from <style> CSS color declarations,
 * verifies CSS touch-target rules, and emits certification-verdict.json +
 * inspection-summary.json compatible with @alexa-ai/addon-local-inspector.
 */
export async function runCertificationAudit(options = {}) {
  const endpointUrl = options.endpointUrl;
  if (!endpointUrl) {
    throw new Error("runCertificationAudit requires an endpointUrl (e.g. http://127.0.0.1:3000/mcp)");
  }

  const sampleToolCalls = options.sampleToolCalls || {};
  const outDir = options.outDir || null;

  const rules = [];
  const toolReports = [];
  const resourceReports = [];
  let sessionId = null;

  async function rpcCall(id, method, params = {}) {
    const headers = { "Content-Type": "application/json" };
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }
    const res = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params
      })
    });
    const headerSid = res.headers.get("mcp-session-id");
    if (headerSid) {
      sessionId = headerSid;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, sessionId, json };
  }

  // 1. DL-01: Protocol & Handshake Check
  const initResp = await rpcCall(1, "initialize", {
    protocolVersion: ALEXA_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "alexa-mcp-inspector-audit", version: "1.0.0" }
  });

  const protoVersion = initResp.json?.result?.protocolVersion;
  const hasSessionId = Boolean(initResp.sessionId);
  const toolsListResp = await rpcCall(2, "tools/list", {});
  const tools = toolsListResp.json?.result?.tools || [];
  const resourcesListResp = await rpcCall(3, "resources/list", {});
  const resources = resourcesListResp.json?.result?.resources || [];

  const dl01Passed =
    initResp.status === 200 &&
    protoVersion === ALEXA_MCP_PROTOCOL_VERSION &&
    hasSessionId &&
    tools.length > 0 &&
    tools.every((t) => t.name && t.description && t.inputSchema?.type === "object");

  rules.push({
    id: "DL-01",
    ruleId: "DL-01",
    category: "Protocol & Schema",
    title: "Streamable HTTP (2026-07-28 / 2025-11-25 / 2025-06-18) Handshake & JSON Schema Integrity",
    status: dl01Passed ? "PASS" : "FAIL",
    details: dl01Passed
      ? `Verified protocolVersion=${protoVersion}, Mcp-Session-Id=${sessionId.slice(0, 8)}..., ${tools.length} tool schemas valid.`
      : `Handshake or schema check failed (status=${initResp.status}, protocolVersion=${protoVersion}, tools=${tools.length}).`
  });

  // 2. VR-01: Visual Resource URI Mapping (_meta.ui.resourceUri -> ui://)
  const resourceMap = new Map(resources.map((r) => [r.uri, r]));
  const vr01Failures = [];

  for (const tool of tools) {
    const uri = tool?._meta?.ui?.resourceUri;
    if (!uri || typeof uri !== "string" || !uri.startsWith("ui://")) {
      vr01Failures.push(`Tool '${tool.name}' missing valid _meta.ui.resourceUri (got ${uri})`);
    } else if (!resourceMap.has(uri)) {
      vr01Failures.push(`Tool '${tool.name}' references unregistered resource '${uri}'`);
    }
    toolReports.push({
      name: tool.name,
      resourceUri: uri || null,
      displayModes: tool?._meta?.ui?.displayModes || []
    });
  }

  rules.push({
    id: "VR-01",
    ruleId: "VR-01",
    category: "Visual Resource Binding",
    title: "Every Alexa+ Tool Maps to a Valid ui:// MCP App Resource",
    status: vr01Failures.length === 0 ? "PASS" : "FAIL",
    details:
      vr01Failures.length === 0
        ? `All ${tools.length} tools map to registered ui:// resources.`
        : vr01Failures.join("; ")
  });

  // Optional: Execute sample tool calls to verify live tool execution and voiceSummary
  const dl02Failures = [];
  for (const tool of tools) {
    const modes = tool?._meta?.ui?.displayModes || [];
    if (!modes.includes("voice-only")) {
      dl02Failures.push(`Tool '${tool.name}' does not declare 'voice-only' in _meta.ui.displayModes`);
    }
    if (sampleToolCalls[tool.name]) {
      const callResp = await rpcCall(100, "tools/call", {
        name: tool.name,
        arguments: sampleToolCalls[tool.name]
      });
      const voiceSummary = callResp.json?.result?._meta?.voice?.summary;
      const callResourceUri = callResp.json?.result?._meta?.ui?.resourceUri;
      if (!voiceSummary || typeof voiceSummary !== "string" || !voiceSummary.trim()) {
        dl02Failures.push(`Tool '${tool.name}' call did not return _meta.voice.summary`);
      }
      if (callResourceUri !== tool?._meta?.ui?.resourceUri) {
        vr01Failures.push(
          `Tool '${tool.name}' call _meta.ui.resourceUri (${callResourceUri}) mismatched definition`
        );
      }
    }
  }

  // Update VR-01 if tool call broke resourceUri
  if (vr01Failures.length > 0) {
    const vr01Rule = rules.find((r) => r.ruleId === "VR-01");
    vr01Rule.status = "FAIL";
    vr01Rule.details = vr01Failures.join("; ");
  }

  // Inspect each registered ui:// resource across all 3 display modes
  const vr02Failures = [];
  const vr03Failures = [];
  const vr04Failures = [];
  const sec01Failures = [];

  for (const res of resources) {
    const uri = res.uri;
    const readResp = await rpcCall(200, "resources/read", {
      uri,
      displayMode: "inline"
    });
    const content = readResp.json?.result?.contents?.[0];
    const html = content?.text || "";
    const mimeType = content?.mimeType || "";

    if (mimeType !== MCP_APP_MIME_TYPE) {
      vr02Failures.push(`Resource '${uri}' has invalid mimeType '${mimeType}' (expected '${MCP_APP_MIME_TYPE}')`);
    }

    for (const mode of ["inline", "fullscreen", "voice-only"]) {
      if (!html.includes(`<section class="mode-panel" data-mode-panel="${mode}"`)) {
        vr02Failures.push(`Resource '${uri}' is missing <section> panel for displayMode='${mode}'`);
      }
    }

    if (
      !html.includes('id="voice-summary-text"') ||
      (!html.includes("<speak>") && !html.includes("&lt;speak&gt;"))
    ) {
      dl02Failures.push(`Resource '${uri}' is missing Voice-only spoken summary or SSML <speak> block`);
    }

    const a11y = inspectHtmlAccessibility(html);
    const contrastRatio = a11y.minContrastRatio;
    if (!a11y.validContrast) {
      vr03Failures.push(
        `Resource '${uri}' failed WCAG AA CSS contrast calculation (measured ${contrastRatio}:1, required >= 4.5:1)`
      );
    }

    const minTouchPx = a11y.minTouchPx;
    if (!a11y.validTouch) {
      vr04Failures.push(
        `Resource '${uri}' failed Alexa+ CSS touch target rule (measured ${minTouchPx}px, required >= 44px with .touch-target rule)`
      );
    }

    const hasCsp = html.includes('http-equiv="Content-Security-Policy"') && html.includes("default-src 'none'");
    const hasRpcBridge = html.includes('method: "ui/initialize"') && html.includes('method: "tools/call"');
    if (!hasCsp || !hasRpcBridge) {
      sec01Failures.push(
        `Resource '${uri}' failed security/bridge check (CSP=${hasCsp}, postMessageBridge=${hasRpcBridge})`
      );
    }

    resourceReports.push({
      uri,
      mimeType,
      contrastRatio,
      minTouchPx,
      hasPartnerAttribution: a11y.hasPartnerAttribution,
      hasStickySummaryFooter: a11y.hasStickySummaryFooter,
      hasCsp,
      hasRpcBridge
    });
  }

  rules.push({
    id: "VR-02",
    ruleId: "VR-02",
    category: "Adaptive Multimodal Layout",
    title: "All 3 Alexa+ Display Modes (Inline, Fullscreen, Voice-only) Supported",
    status: vr02Failures.length === 0 && resources.length > 0 ? "PASS" : "FAIL",
    details:
      vr02Failures.length === 0
        ? `Verified Inline, Fullscreen, and Voice-only panels across ${resources.length} ui:// resources.`
        : vr02Failures.join("; ")
  });

  rules.push({
    id: "VR-03",
    ruleId: "VR-03",
    category: "Accessibility & Contrast",
    title: "WCAG 2.1 AA Minimum Contrast Ratio (>= 4.5:1 Computed from CSS)",
    status: vr03Failures.length === 0 && resources.length > 0 ? "PASS" : "FAIL",
    details:
      vr03Failures.length === 0
        ? `All ${resources.length} resources meet or exceed 4.5:1 computed WCAG contrast ratio.`
        : vr03Failures.join("; ")
  });

  rules.push({
    id: "VR-04",
    ruleId: "VR-04",
    category: "Far-Field Touch Ergonomics",
    title: "Interactive Touch Targets >= 44x44px (CSS Enforced)",
    status: vr04Failures.length === 0 && resources.length > 0 ? "PASS" : "FAIL",
    details:
      vr04Failures.length === 0
        ? `All ${resources.length} resources enforce >= 44x44px touch targets in CSS.`
        : vr04Failures.join("; ")
  });

  rules.push({
    id: "DL-02",
    ruleId: "DL-02",
    category: "Voice-First Fallback",
    title: "Voice-Only Spoken Summary & SSML Prosody Readiness",
    status: dl02Failures.length === 0 && tools.length > 0 ? "PASS" : "FAIL",
    details:
      dl02Failures.length === 0
        ? `All ${tools.length} tools and ${resources.length} resources provide Voice-only summaries and SSML.`
        : dl02Failures.join("; ")
  });

  rules.push({
    id: "SEC-01",
    ruleId: "SEC-01",
    category: "Sandbox Security & RPC Bridge",
    title: "Strict Content-Security-Policy & MCP Apps postMessage Bridge",
    status: sec01Failures.length === 0 && resources.length > 0 ? "PASS" : "FAIL",
    details:
      sec01Failures.length === 0
        ? `All ${resources.length} resources enforce strict CSP and MCP Apps postMessage RPC.`
        : sec01Failures.join("; ")
  });

  const passCount = rules.filter((r) => r.status === "PASS").length;
  const failCount = rules.filter((r) => r.status === "FAIL").length;
  const verdict = failCount === 0 ? "CERTIFIED" : "NOT_CERTIFIED";

  const certificationVerdict = {
    schemaVersion: "1.0.0",
    inspector: "alexa-mcp-kit Pre-Flight Readiness Linter (compatible with @alexa-ai/addon-local-inspector)",
    evaluatedAt: new Date().toISOString(),
    endpointUrl,
    protocolVersion: protoVersion || null,
    verdict,
    readinessStatus: failCount === 0 ? "PREFLIGHT_READY" : "ACTION_REQUIRED",
    surfaces: ["show8", "show15", "firetv"],
    passCount,
    failCount,
    warnCount: 0,
    totalRules: rules.length,
    rules,
    notes: [
      "Static CSS WCAG 2.1 AA contrast & live JSON-RPC protocol readiness verified.",
      "Pair with official 'npx @alexa-ai/addon-local-inspector' for live Playwright viewport certification."
    ]
  };

  const inspectionSummary = {
    evaluatedAt: certificationVerdict.evaluatedAt,
    verdict,
    serverInfo: initResp.json?.result?.serverInfo || null,
    toolsInspected: toolReports.length,
    resourcesInspected: resourceReports.length,
    tools: toolReports,
    resources: resourceReports,
    failedRules: rules.filter((r) => r.status === "FAIL")
  };

  if (outDir) {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "certification-verdict.json"),
      JSON.stringify(certificationVerdict, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(outDir, "inspection-summary.json"),
      JSON.stringify(inspectionSummary, null, 2),
      "utf8"
    );
  }

  return {
    certificationVerdict,
    inspectionSummary
  };
}
