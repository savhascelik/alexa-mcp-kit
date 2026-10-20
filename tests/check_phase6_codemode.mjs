import assert from "node:assert/strict";
import { AlexaMcpServer, createAlexaUiWidget } from "../src/index.mjs";

async function postRpc(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

function buildCodeModeTestServer() {
  const server = new AlexaMcpServer({
    name: "codemode-test-server",
    version: "1.0.0"
  });

  server.registerAppResource({
    uri: "ui://test/codemode-widget",
    name: "CodeMode Result Widget",
    render: ({ displayMode, voiceSummary }) =>
      createAlexaUiWidget({
        title: "CodeMode Result",
        displayMode,
        voiceSummary: voiceSummary || "Done"
      })
  });

  // 1. Atomic API lookup tool (simulates live RVU component fetch)
  server.registerAppTool({
    name: "api_fetch_rvu_components",
    title: "Fetch Procedure RVU Components",
    description: "Fetches RVU components (workRvu, peRvu, mpRvu) for a medical CPT/HCPCS code.",
    category: "api",
    domain: "medical",
    resourceUri: "ui://test/codemode-widget",
    inputSchema: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string" }
      }
    },
    handler: async ({ code }) => {
      const rvuMap = {
        "99285": { code: "99285", workRvu: 4.0, peRvu: 1.42, mpRvu: 0.5 },
        "71046": { code: "71046", workRvu: 0.22, peRvu: 0.68, mpRvu: 0.02 }
      };
      const found = rvuMap[code] || { code, workRvu: 1.0, peRvu: 0.5, mpRvu: 0.1 };
      return {
        voiceSummary: `Fetched RVU components for ${code}.`,
        structuredContent: found
      };
    }
  });

  // 2. Pure Parameterized Math Calculator Tool (zero hardcoded conversion factor!)
  server.registerAppTool({
    name: "calc_rvu_benchmark",
    title: "Calculate RVU Benchmark with Dynamic Conversion Factor",
    description:
      "Calculates total RVU multiplied by the caller-supplied conversionFactor parameter.",
    category: "math",
    domain: "medical",
    resourceUri: "ui://test/codemode-widget",
    inputSchema: {
      type: "object",
      required: ["workRvu", "peRvu", "mpRvu", "conversionFactor"],
      properties: {
        workRvu: { type: "number" },
        peRvu: { type: "number" },
        mpRvu: { type: "number" },
        conversionFactor: { type: "number" }
      }
    },
    handler: async ({ workRvu, peRvu, mpRvu, conversionFactor }) => {
      if (conversionFactor === 999999) {
        await new Promise((r) => setTimeout(r, 350));
      }
      const totalRvu = Number((workRvu + peRvu + mpRvu).toFixed(4));
      const benchmarkPrice = Number((totalRvu * conversionFactor).toFixed(2));
      return {
        voiceSummary: `Benchmark calculated at $${benchmarkPrice.toFixed(2)} using conversion factor $${conversionFactor}.`,
        structuredContent: {
          totalRvu,
          conversionFactor,
          benchmarkPrice
        }
      };
    }
  });

  server.enableProgressiveDiscovery();
  server.enableCodeMode();
  return server;
}

async function runCodeModeAudit() {
  const server = buildCodeModeTestServer();
  const { url } = await server.listen(0);

  try {
    // Probe 1: Execute multi-step plan chaining api_fetch_rvu_components -> calc_rvu_benchmark
    // with TWO different conversion factors ($32.35 and $40.00) chosen dynamically by the agent!
    const planCode = `
      async ({ codemode, inputs }) => {
        const proc = await codemode.callTool("api_fetch_rvu_components", { code: inputs.code });
        const calcToday = await codemode.callTool("calc_rvu_benchmark", {
          workRvu: proc.workRvu,
          peRvu: proc.peRvu,
          mpRvu: proc.mpRvu,
          conversionFactor: inputs.factorToday
        });
        const calcTomorrow = await codemode.callTool("calc_rvu_benchmark", {
          workRvu: proc.workRvu,
          peRvu: proc.peRvu,
          mpRvu: proc.mpRvu,
          conversionFactor: inputs.factorTomorrow
        });
        return {
          code: proc.code,
          totalRvu: calcToday.totalRvu,
          priceAt32_35: calcToday.benchmarkPrice,
          priceAt40_00: calcTomorrow.benchmarkPrice,
          processType: typeof process,
          requireType: typeof require,
          fetchType: typeof fetch,
          voiceSummary: \`Dynamic RVU calculation: $\${calcToday.benchmarkPrice} at factor \${inputs.factorToday}, and $\${calcTomorrow.benchmarkPrice} at factor \${inputs.factorTomorrow}.\`
        };
      }
    `;

    const res1 = await postRpc(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "execute_codemode",
        arguments: {
          code: planCode,
          inputs: {
            code: "99285",
            factorToday: 32.35,
            factorTomorrow: 40.0
          }
        }
      }
    });

    assert.equal(res1.status, 200);
    assert.ok(!res1.json.error, `Unexpected RPC error: ${res1.json.error?.message}`);
    const data = res1.json.result.structuredContent;
    assert.equal(data.status, "COMPLETED");
    assert.equal(data.stepsCount, 3, "Expected 3 RPC tool calls recorded in steps[]");
    assert.equal(data.result.totalRvu, 5.92);
    // 5.92 * 32.35 = 191.512 -> 191.51
    assert.equal(
      data.result.priceAt32_35,
      191.51,
      `Expected priceAt32_35=191.51, got ${data.result.priceAt32_35}`
    );
    // 5.92 * 40.00 = 236.80
    assert.equal(
      data.result.priceAt40_00,
      236.8,
      `Expected priceAt40_00=236.8, got ${data.result.priceAt40_00}`
    );

    // Probe 2: Verify strict sandbox isolation (no process, require, or fetch leak)
    assert.equal(
      data.result.processType,
      "undefined",
      "Security violation: 'process' leaked into Code Mode VM sandbox!"
    );
    assert.equal(
      data.result.requireType,
      "undefined",
      "Security violation: 'require' leaked into Code Mode VM sandbox!"
    );
    assert.equal(
      data.result.fetchType,
      "undefined",
      "Security violation: raw 'fetch' leaked into Code Mode VM sandbox!"
    );

    // Probe 3: Verify timeout protection on slow/hanging plan (350ms tool call vs 100ms timeout)
    const hangStart = Date.now();
    const resHang = await postRpc(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "execute_codemode",
        arguments: {
          code: `async ({ codemode }) => { return await codemode.callTool("calc_rvu_benchmark", { workRvu: 1, peRvu: 1, mpRvu: 1, conversionFactor: 999999 }); }`,
          timeoutMs: 100
        }
      }
    });
    const hangElapsed = Date.now() - hangStart;
    assert.ok(
      resHang.json.error &&
        resHang.json.error.message.includes("CodeModeTimeoutError"),
      "Slow/hanging Code Mode plan must return CodeModeTimeoutError when exceeding timeoutMs"
    );
    assert.ok(
      hangElapsed < 300,
      `Timeout enforcement took too long (${hangElapsed}ms >= 300ms)`
    );

    return {
      stepsCount: data.stepsCount,
      priceAt32_35: data.result.priceAt32_35,
      priceAt40_00: data.result.priceAt40_00,
      hangElapsedMs: hangElapsed
    };
  } finally {
    await server.close();
  }
}

async function main() {
  const metrics = await runCodeModeAudit();
  console.log(
    `[PASS] Phase 6 Code Mode Sandbox verified (steps=${metrics.stepsCount}, $32.35->$${metrics.priceAt32_35}, $40.00->$${metrics.priceAt40_00}, timeoutCaughtIn=${metrics.hangElapsedMs}ms)`
  );
}

main().catch((err) => {
  console.error("[FAIL] Phase 6 check failed:", err);
  process.exit(1);
});
