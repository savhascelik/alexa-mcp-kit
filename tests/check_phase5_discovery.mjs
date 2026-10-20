import assert from "node:assert/strict";
import { AlexaMcpServer, createAlexaUiWidget } from "../src/index.mjs";

async function postRpc(url, body, sessionId = null) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json, sessionId: res.headers.get("mcp-session-id") };
}

function createSampleServer() {
  const server = new AlexaMcpServer({
    name: "discovery-test-server",
    version: "1.0.0"
  });

  server.registerAppResource({
    uri: "ui://test/widget",
    name: "Test Widget",
    render: ({ displayMode, voiceSummary }) =>
      createAlexaUiWidget({
        title: "Test Widget",
        displayMode,
        voiceSummary: voiceSummary || "Ready"
      })
  });

  const sampleTools = [
    {
      name: "api_lookup_medical_code",
      title: "Lookup Medical HCPCS/CPT Procedure via NIH API",
      category: "api",
      domain: "medical",
      tags: ["nih", "hcpcs", "cpt", "rvu", "procedure"],
      description:
        "Queries the live U.S. National Library of Medicine (NIH Clinical Tables) API for a procedure code and returns RVU components (workRvu, peRvu, mpRvu).",
      inputSchema: {
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string", description: "CPT or HCPCS procedure code" },
          includeRvu: { type: "boolean", description: "Include RVU weights" }
        }
      }
    },
    {
      name: "calc_medicare_fee_formula",
      title: "Calculate Parameterized Medicare Fee from RVU & GPCI",
      category: "math",
      domain: "medical",
      tags: ["medicare", "rvu", "gpci", "conversionFactor", "formula"],
      description:
        "Pure mathematical calculator: computes ((workRvu * gpciWork) + (peRvu * gpciPe) + (mpRvu * gpciMp)) * conversionFactor * units using caller-supplied conversionFactor.",
      compositionHints: {
        upstreamTools: ["api_lookup_medical_code", "api_lookup_locality_gpci"],
        downstreamTools: ["calc_line_item_variance"]
      },
      inputSchema: {
        type: "object",
        required: ["workRvu", "peRvu", "mpRvu", "conversionFactor"],
        properties: {
          workRvu: { type: "number", description: "Physician work RVU" },
          peRvu: { type: "number", description: "Practice expense RVU" },
          mpRvu: { type: "number", description: "Malpractice RVU" },
          gpciWork: { type: "number", description: "Geographic work index" },
          gpciPe: { type: "number", description: "Geographic PE index" },
          gpciMp: { type: "number", description: "Geographic MP index" },
          conversionFactor: {
            type: "number",
            description: "Dollar conversion factor supplied dynamically by Alexa+ (e.g. 32.35 or 40.00)"
          },
          units: { type: "number", description: "Service unit count" }
        }
      }
    },
    {
      name: "calc_line_item_variance",
      title: "Calculate Billed vs Reference Variance & Markup Ratio",
      category: "math",
      domain: "medical",
      tags: ["variance", "overcharge", "markup", "threshold"],
      description:
        "Computes overcharge amount and markup ratio comparing billedAmount against referenceAmount * allowedMultiplier.",
      inputSchema: {
        type: "object",
        required: ["billedAmount", "referenceAmount", "allowedMultiplier"],
        properties: {
          billedAmount: { type: "number" },
          referenceAmount: { type: "number" },
          allowedMultiplier: { type: "number" }
        }
      }
    },
    {
      name: "api_query_fda_enforcement",
      title: "Query Live openFDA Recall Enforcement API",
      category: "api",
      domain: "recall",
      tags: ["fda", "recall", "food", "drug", "device"],
      description: "Queries live api.fda.gov enforcement endpoint with domain and search query.",
      inputSchema: {
        type: "object",
        required: ["searchQuery"],
        properties: {
          domain: { type: "string" },
          searchQuery: { type: "string" },
          limit: { type: "number" }
        }
      }
    },
    {
      name: "api_query_cpsc_recalls",
      title: "Query Live U.S. CPSC SaferProducts Recall API",
      category: "api",
      domain: "recall",
      tags: ["cpsc", "recall", "consumer", "hazard"],
      description: "Queries live saferproducts.gov REST API for consumer product recalls.",
      inputSchema: {
        type: "object",
        required: ["productName"],
        properties: {
          productName: { type: "string" },
          hazard: { type: "string" }
        }
      }
    },
    {
      name: "api_lookup_utility_rates",
      title: "Lookup State & ZIP Utility TOU Rates",
      category: "api",
      domain: "utility",
      tags: ["eia", "openei", "electricity", "tou", "kwh"],
      description: "Fetches peak and off-peak electricity tariff rates for a U.S. ZIP code.",
      inputSchema: {
        type: "object",
        required: ["zipCode"],
        properties: {
          zipCode: { type: "string" }
        }
      }
    },
    {
      name: "calc_tou_load_shift",
      title: "Calculate Appliance Time-of-Use Load Shift Savings",
      category: "math",
      domain: "utility",
      tags: ["tou", "kwh", "appliance", "savings", "math"],
      description: "Calculates monthly and annual savings when shifting kW load from currentRatePerKwh to targetRatePerKwh.",
      inputSchema: {
        type: "object",
        required: ["kilowatts", "hoursPerRun", "runsPerMonth", "currentRatePerKwh", "targetRatePerKwh"],
        properties: {
          kilowatts: { type: "number" },
          hoursPerRun: { type: "number" },
          runsPerMonth: { type: "number" },
          currentRatePerKwh: { type: "number" },
          targetRatePerKwh: { type: "number" }
        }
      }
    },
    {
      name: "calc_income_ami_subsidy",
      title: "Calculate AMI Income Ratio & Rebate Cap",
      category: "math",
      domain: "rebate",
      tags: ["ami", "income", "subsidy", "rebate", "math"],
      description: "Calculates household income as a percentage of Area Median Income and applies coverageRate up to maxCap.",
      inputSchema: {
        type: "object",
        required: ["annualHouseholdIncome", "areaMedianIncome", "projectCost", "coverageRate", "maxCap"],
        properties: {
          annualHouseholdIncome: { type: "number" },
          areaMedianIncome: { type: "number" },
          projectCost: { type: "number" },
          coverageRate: { type: "number" },
          maxCap: { type: "number" }
        }
      }
    }
  ];

  for (const t of sampleTools) {
    server.registerAppTool({
      ...t,
      resourceUri: "ui://test/widget",
      handler: async (args) => ({
        voiceSummary: `Executed ${t.name}`,
        structuredContent: { ok: true, args }
      })
    });
  }

  server.enableProgressiveDiscovery();
  return server;
}

async function runAudit() {
  const server = createSampleServer();
  const { url } = await server.listen(0);
  try {
    // 1. Search for math tool related to medicare rvu conversionFactor
    const searchRes = await postRpc(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_tools",
        arguments: {
          query: "medicare rvu conversionFactor",
          category: "math",
          limit: 3
        }
      }
    });

    assert.equal(searchRes.status, 200);
    const searchData = searchRes.json.result.structuredContent;
    assert.ok(searchData.matchCount >= 1, "search_tools must return at least 1 match");
    assert.equal(
      searchData.tools[0].name,
      "calc_medicare_fee_formula",
      `Expected top match to be calc_medicare_fee_formula, got ${searchData.tools[0].name}`
    );
    assert.ok(
      searchData.tools[0].score > 0,
      `Expected positive relevance score, got ${searchData.tools[0].score}`
    );

    // Ensure category filter strictly excluded 'api' tools
    const nonMath = searchData.tools.filter((t) => t.category !== "math");
    assert.equal(
      nonMath.length,
      0,
      `Category filter 'math' leaked non-math tools: ${nonMath.map((t) => t.name).join(", ")}`
    );

    // Verify token savings >= 65%
    assert.ok(
      searchData.metrics.tokenSavingsPct >= 65,
      `Expected >=65% token savings, got ${searchData.metrics.tokenSavingsPct}%`
    );

    // 2. Describe calc_medicare_fee_formula schema
    const descRes = await postRpc(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "describe_tool",
        arguments: {
          toolName: "calc_medicare_fee_formula"
        }
      }
    });

    assert.equal(descRes.status, 200);
    const descData = descRes.json.result.structuredContent;
    assert.ok(
      descData.inputSchema && descData.inputSchema.properties,
      "describe_tool must return full inputSchema.properties"
    );
    assert.ok(
      descData.inputSchema.properties.conversionFactor,
      "describe_tool schema must expose dynamic conversionFactor parameter"
    );
    assert.ok(
      Array.isArray(descData.compositionHints?.upstreamTools),
      "describe_tool must include compositionHints.upstreamTools"
    );

    return {
      topMatch: searchData.tools[0].name,
      topScore: searchData.tools[0].score,
      tokenSavingsPct: searchData.metrics.tokenSavingsPct,
      describedProps: Object.keys(descData.inputSchema.properties).length
    };
  } finally {
    await server.close();
  }
}

async function main() {
  const metrics = await runAudit();
  console.log(
    `[PASS] Phase 5 Progressive Tool Discovery verified (topMatch=${metrics.topMatch}, score=${metrics.topScore}, tokenSavings=${metrics.tokenSavingsPct}%, schemaProps=${metrics.describedProps})`
  );
}

main().catch((err) => {
  console.error("[FAIL] Phase 5 check failed:", err);
  process.exit(1);
});
