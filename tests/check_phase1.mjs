import assert from "node:assert/strict";
import { AlexaMcpServer, ALEXA_MCP_PROTOCOL_VERSION, MCP_APP_MIME_TYPE } from "../src/index.mjs";

async function postRpc(url, payload, sessionId = null) {
  const headers = { "Content-Type": "application/json" };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    body: text ? JSON.parse(text) : null
  };
}

async function runPhase1Suite() {
  const server = new AlexaMcpServer({
    name: "phase1-test-server",
    version: "1.0.0"
  });

  server.registerAppResource({
    uri: "ui://test/summary-card",
    name: "Test Summary Card",
    description: "Adaptive test widget",
    render: ({ displayMode, state }) =>
      `<div data-display-mode="${displayMode}" data-total="${state ? state.total : 0}">Widget OK</div>`
  });

  server.registerAppTool({
    name: "calculate_savings",
    title: "Calculate Savings",
    description: "Calculates monthly savings from bill items.",
    resourceUri: "ui://test/summary-card",
    inputSchema: {
      type: "object",
      required: ["amount"],
      properties: {
        amount: { type: "number" }
      }
    },
    handler: async ({ amount }) => {
      const saved = Number((amount * 0.25).toFixed(2));
      return {
        voiceSummary: `We found $${saved} in potential savings out of $${amount}.`,
        structuredContent: {
          total: amount,
          saved
        }
      };
    }
  });

  const { url } = await server.listen(0, "127.0.0.1");

  try {
    // 1. Initialize handshake (2026-07-28 default + multi-revision negotiation for 2025-06-18 / 2025-11-25)
    const initRes = await postRpc(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: ALEXA_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "phase1-verifier", version: "1.0.0" }
      }
    });

    assert.equal(initRes.status, 200, "initialize must return HTTP 200");
    assert.ok(initRes.sessionId, "initialize must return Mcp-Session-Id header");
    assert.equal(
      initRes.body.result.protocolVersion,
      "2026-07-28",
      "protocolVersion must default to latest 2026-07-28"
    );

    // 1b. Verify backward-compatible negotiation for @alexa-ai/addon-local-inspector (2025-06-18 & 2025-11-25)
    for (const compatVer of ["2025-11-25", "2025-06-18"]) {
      const compatRes = await postRpc(url, {
        jsonrpc: "2.0",
        id: 10,
        method: "initialize",
        params: {
          protocolVersion: compatVer,
          capabilities: {},
          clientInfo: { name: "addon-local-inspector", version: "1.0.0" }
        }
      });
      assert.equal(compatRes.body.result.protocolVersion, compatVer, `Must negotiate ${compatVer}`);
    }

    // 1c. Verify -32022 UnsupportedProtocolVersionError on unknown version
    const badVerRes = await postRpc(url, {
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: {
        protocolVersion: "1999-01-01",
        capabilities: {}
      }
    });
    assert.equal(badVerRes.body.error.code, -32022, "Unknown protocolVersion must return -32022");

    const sessionId = initRes.sessionId;

    // 2. notifications/initialized
    const notifRes = await postRpc(
      url,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      },
      sessionId
    );
    assert.equal(notifRes.status, 202, "notifications/initialized must return HTTP 202");

    // 3. tools/list
    const listRes = await postRpc(
      url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
      },
      sessionId
    );
    const tools = listRes.body.result.tools;
    assert.equal(tools.length, 1, "tools/list must return 1 registered tool");
    assert.equal(
      tools[0]?._meta?.ui?.resourceUri,
      "ui://test/summary-card",
      "Tool definition in tools/list must include _meta.ui.resourceUri"
    );
    assert.deepEqual(
      tools[0]?._meta?.ui?.displayModes,
      ["inline", "fullscreen", "voice-only"],
      "Tool definition must declare all 3 Alexa+ display modes"
    );

    // 4. tools/call
    const callRes = await postRpc(
      url,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "calculate_savings",
          arguments: { amount: 200 }
        }
      },
      sessionId
    );
    assert.ok(!callRes.body.error, `tools/call returned unexpected error: ${JSON.stringify(callRes.body.error)}`);
    assert.equal(
      callRes.body.result?._meta?.ui?.resourceUri,
      "ui://test/summary-card",
      "tools/call result must include _meta.ui.resourceUri"
    );
    assert.equal(
      callRes.body.result?.structuredContent?.saved,
      50,
      "tools/call structuredContent.saved must equal 50"
    );
    assert.ok(
      callRes.body.result?._meta?.voice?.summary?.includes("$50"),
      "tools/call result must include spoken voice summary"
    );

    // 5. resources/read hydrated with latest state
    const readRes = await postRpc(
      url,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: {
          uri: "ui://test/summary-card",
          displayMode: "fullscreen"
        }
      },
      sessionId
    );
    const contentItem = readRes.body.result.contents[0];
    assert.equal(contentItem.mimeType, MCP_APP_MIME_TYPE, "Resource mimeType must be text/html;profile=mcp-app");
    assert.ok(
      contentItem.text.includes('data-display-mode="fullscreen"') &&
        contentItem.text.includes('data-total="200"'),
      "Hydrated resource HTML must reflect displayMode and latest tool state"
    );

    // 6. Session termination (DELETE /mcp)
    const delRes = await fetch(url, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sessionId }
    });
    assert.equal(delRes.status, 200, "DELETE /mcp must return 200");
  } finally {
    await server.close();
  }
}

await runPhase1Suite();
console.log("[PASS] Phase 1 Streamable HTTP (2026-07-28 / 2025-11-25 / 2025-06-18) & _meta.ui.resourceUri checks passed (8/8 probes).");
