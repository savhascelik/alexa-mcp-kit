import http from "node:http";
import crypto from "node:crypto";
import { createAlexaUiWidget } from "./ui-shell.mjs";
import {
  searchToolsCatalog,
  describeToolSchema,
  estimateTokenCount
} from "./tool-discovery.mjs";
import { executeCodeModePlan } from "./codemode-sandbox.mjs";

export const ALEXA_MCP_PROTOCOL_VERSION = "2026-07-28";
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26"
]);
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const REQUIRED_DISPLAY_MODES = Object.freeze(["inline", "fullscreen", "voice-only"]);

/**
 * AlexaMcpServer implements universal Model Context Protocol Streamable HTTP
 * supporting both the latest 2026-07-28 stateless revision (MCP-Protocol-Version header
 * & io.modelcontextprotocol/protocolVersion _meta) and the stateful 2025-11-25 / 2025-06-18
 * revisions used by @alexa-ai/addon-local-inspector (Mcp-Session-Id handshake).
 *
 * Why this exists:
 * Standard MCP servers often break when switching between modern 2026-07-28 stateless clients
 * and @alexa-ai/addon-local-inspector (which sends 2025-06-18 / 2025-11-25 stateful handshakes),
 * omit _meta.ui.resourceUri on either tools/list or tools/call, or fail to provide a concise
 * voiceSummary for hands-free Echo devices (Voice-only mode).
 */
export class AlexaMcpServer {
  constructor(options = {}) {
    this.name = options.name || "alexa-mcp-server";
    this.version = options.version || "1.0.0";
    this.protocolVersion = options.protocolVersion || ALEXA_MCP_PROTOCOL_VERSION;
    this.supportedProtocolVersions = Array.isArray(options.supportedProtocolVersions)
      ? [...options.supportedProtocolVersions]
      : [...SUPPORTED_MCP_PROTOCOL_VERSIONS];
    this.endpointPath = options.endpointPath || "/mcp";
    this.strictVoiceSummary = options.strictVoiceSummary !== false;
    this.strictUiResource = options.strictUiResource !== false;

    this.tools = new Map();
    this.resources = new Map();
    this.sessions = new Map();
    this.customRoutes = [];
    this.httpServer = null;
  }

  /**
   * Registers an Alexa+ MCP App Resource under the ui:// scheme.
   */
  registerAppResource(config) {
    if (!config || typeof config.uri !== "string" || !config.uri.startsWith("ui://")) {
      throw new Error("Alexa+ MCP resource URI must start with ui://");
    }
    if (typeof config.render !== "function" && typeof config.html !== "string") {
      throw new Error(`Resource ${config.uri} requires a render() function or html string.`);
    }

    const resourceRecord = {
      uri: config.uri,
      name: config.name || config.uri.replace("ui://", ""),
      description: config.description || `Interactive Alexa+ widget for ${config.uri}`,
      mimeType: config.mimeType || MCP_APP_MIME_TYPE,
      displayModes: Array.isArray(config.displayModes)
        ? [...config.displayModes]
        : [...REQUIRED_DISPLAY_MODES],
      render: config.render || (() => config.html)
    };

    this.resources.set(config.uri, resourceRecord);
    return resourceRecord;
  }

  /**
   * Registers an Alexa+ MCP Tool paired with a ui:// widget resource and mandatory voiceSummary.
   */
  registerAppTool(config) {
    if (!config || typeof config.name !== "string" || !config.name.trim()) {
      throw new Error("Tool registration requires a non-empty name.");
    }
    if (typeof config.description !== "string" || !config.description.trim()) {
      throw new Error(`Tool ${config.name} requires a human-readable description.`);
    }
    if (typeof config.handler !== "function") {
      throw new Error(`Tool ${config.name} requires an async handler(args, context) function.`);
    }
    if (this.strictUiResource) {
      if (typeof config.resourceUri !== "string" || !config.resourceUri.startsWith("ui://")) {
        throw new Error(
          `Tool ${config.name} must specify a valid resourceUri starting with ui:// for Alexa+ Local Inspector.`
        );
      }
    }

    const displayModes = Array.isArray(config.displayModes)
      ? [...config.displayModes]
      : [...REQUIRED_DISPLAY_MODES];

    const metaUi = {
      resourceUri: config.resourceUri,
      displayModes
    };

    const toolRecord = {
      name: config.name,
      title: config.title || config.name,
      description: config.description,
      category: config.category || "general",
      domain: config.domain || "general",
      tags: Array.isArray(config.tags) ? [...config.tags] : [],
      compositionHints: config.compositionHints || config.compositionHint || null,
      inputSchema: config.inputSchema || {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      resourceUri: config.resourceUri,
      displayModes,
      _meta: {
        ui: metaUi
      },
      handler: config.handler
    };

    this.tools.set(config.name, toolRecord);
    return toolRecord;
  }

  /**
   * Registers Progressive Tool Discovery meta-tools (search_tools & describe_tool)
   * so Alexa+ can discover atomic API and math tools on demand with ~85-94% token savings.
   */
  enableProgressiveDiscovery(options = {}) {
    const resourceUri = options.resourceUri || "ui://alexa-mcp-kit/tool-discovery";
    if (!this.resources.has(resourceUri)) {
      this.registerAppResource({
        uri: resourceUri,
        name: "Alexa+ Progressive Tool Discovery Explorer",
        description: "Interactive catalog view for search_tools and describe_tool.",
        render: ({ displayMode, state, voiceSummary }) =>
          createAlexaUiWidget({
            uri: resourceUri,
            title: "MCP Progressive Tool Discovery",
            subtitle: state?.toolName
              ? `Schema Inspector • ${state.name || state.toolName}`
              : `Query: "${state?.query || "*"}" • ${state?.matchCount ?? 0} matching tools`,
            badge: state?.metrics
              ? `${state.metrics.tokenSavingsPct}% Token Saved`
              : "SCHEMA READY",
            displayMode,
            voiceSummary:
              voiceSummary ||
              "Use search_tools to find atomic API or math tools, and describe_tool to inspect their parameter schemas.",
            heroMetric: {
              label: state?.metrics ? "Prompt Token Savings" : "Inspected Tool",
              value: state?.metrics
                ? `${state.metrics.tokenSavingsPct}%`
                : state?.name || "Ready",
              delta: state?.metrics
                ? `${state.metrics.discoveryResponseTokens} vs ${state.metrics.fullCatalogEstimatedTokens} tokens`
                : `Category: ${state?.category || "general"}`
            },
            rows: Array.isArray(state?.tools)
              ? state.tools.map((t) => ({
                  id: t.name,
                  code: t.category.toUpperCase(),
                  title: `${t.name} — ${t.title}`,
                  billed: `${t.requiredParams.length} req`,
                  benchmark: `${t.optionalParams.length} opt`,
                  savings: `Score ${t.score}`,
                  status: t.domain.toUpperCase(),
                  reason: t.shortDescription
                }))
              : state?.inputSchema?.properties
              ? Object.entries(state.inputSchema.properties).map(([pName, pSpec]) => ({
                  id: pName,
                  code: String(pSpec.type || "any").toUpperCase(),
                  title: pName,
                  billed: Array.isArray(state.inputSchema.required) &&
                    state.inputSchema.required.includes(pName)
                    ? "REQUIRED"
                    : "OPTIONAL",
                  benchmark: pSpec.default !== undefined ? String(pSpec.default) : "dynamic",
                  savings: state.category.toUpperCase(),
                  status: "PARAMETER",
                  reason: pSpec.description || "Agent-controlled parameter"
                }))
              : [],
            actions: [
              {
                id: "act-search-api",
                label: "Search API Tools",
                toolName: "search_tools",
                primary: true,
                args: { query: "api", category: "api" }
              },
              {
                id: "act-search-math",
                label: "Search Math Tools",
                toolName: "search_tools",
                primary: false,
                args: { query: "calc", category: "math" }
              }
            ]
          })
      });
    }

    this.registerAppTool({
      name: "search_tools",
      title: "Search Atomic API & Calculation Tools",
      category: "discovery",
      domain: "meta",
      tags: ["discovery", "search", "catalog", "schema"],
      description:
        "Searches the MCP server catalog for atomic live API tools (category='api'), parameterized math/formula calculators (category='math'), and UI renderers (category='ui') by keyword, category, or domain.",
      resourceUri,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keywords (e.g. 'medicare rvu', 'fda recall', 'utility tou', 'ami subsidy')."
          },
          category: {
            type: "string",
            description: "Optional filter: 'api' (live external data fetchers), 'math' (parameterized formulas), or 'ui'."
          },
          domain: {
            type: "string",
            description: "Optional domain filter: 'medical', 'utility', 'recall', 'rebate'."
          },
          limit: {
            type: "number",
            description: "Maximum number of matching tools to return (default 10)."
          }
        }
      },
      handler: async (args) => {
        const res = searchToolsCatalog(this.tools, args);
        const topNames = res.tools.slice(0, 3).map((t) => t.name).join(", ");
        return {
          voiceSummary:
            res.matchCount > 0
              ? `Found ${res.matchCount} matching tools (${topNames}), saving ${res.metrics.tokenSavingsPct} percent of prompt schema tokens.`
              : `No tools matched query '${res.query}'. Try searching by category 'api' or 'math'.`,
          structuredContent: res
        };
      }
    });

    this.registerAppTool({
      name: "describe_tool",
      title: "Describe Tool JSON Schema & Composition Hints",
      category: "discovery",
      domain: "meta",
      tags: ["discovery", "describe", "schema", "parameters"],
      description:
        "Returns the complete JSON Schema, parameter descriptions, and upstream/downstream composition hints for a specific tool name discovered via search_tools.",
      resourceUri,
      inputSchema: {
        type: "object",
        required: ["toolName"],
        properties: {
          toolName: {
            type: "string",
            description: "Exact name of the tool to inspect (e.g. 'api_lookup_medical_code' or 'calc_medicare_fee_formula')."
          }
        }
      },
      handler: async (args) => {
        const res = describeToolSchema(this.tools, args);
        const propCount =
          res.inputSchema && res.inputSchema.properties
            ? Object.keys(res.inputSchema.properties).length
            : 0;
        return {
          voiceSummary: `Loaded schema for ${res.name} in category ${res.category} with ${propCount} configurable parameters.`,
          structuredContent: res
        };
      }
    });
  }

  /**
   * Registers the deterministic Code Mode sandbox tool (execute_codemode) so Alexa+ can write
   * multi-step JavaScript plans chaining api_* tools -> calc_* tools with custom parameters.
   */
  enableCodeMode(options = {}) {
    const resourceUri = options.resourceUri || "ui://alexa-mcp-kit/codemode-console";
    if (!this.resources.has(resourceUri)) {
      this.registerAppResource({
        uri: resourceUri,
        name: "Alexa+ Code Mode Execution Trace",
        description: "Step-by-step deterministic execution trace for execute_codemode plans.",
        render: ({ displayMode, state, voiceSummary }) =>
          createAlexaUiWidget({
            uri: resourceUri,
            title: "Code Mode Deterministic Sandbox",
            subtitle: `${state?.stepsCount ?? 0} RPC Steps • ${state?.totalDurationMs ?? 0}ms Total`,
            badge: state?.status || "SANDBOX READY",
            displayMode,
            voiceSummary:
              voiceSummary ||
              "Code Mode executes multi-step JavaScript plans chaining live API tools and parameterized calculation tools inside an isolated sandbox.",
            heroMetric: {
              label: "Sandbox Execution",
              value: `${state?.stepsCount ?? 0} Steps`,
              delta: `Completed in ${state?.totalDurationMs ?? 0}ms`
            },
            rows: Array.isArray(state?.steps)
              ? state.steps.map((s) => ({
                  id: `step-${s.stepIndex}`,
                  code: `STEP ${s.stepIndex}`,
                  title: s.toolName || s.label || s.type,
                  billed: `${s.durationMs}ms`,
                  benchmark: s.type,
                  savings: "OK",
                  status: "VERIFIED",
                  reason:
                    typeof s.outputPreview === "string"
                      ? s.outputPreview
                      : JSON.stringify(s.outputPreview || s.arguments || {})
                }))
              : [],
            actions: [
              {
                id: "act-discover-tools",
                label: "Explore Tools",
                toolName: "search_tools",
                primary: true,
                args: { query: "" }
              }
            ]
          })
      });
    }

    this.registerAppTool({
      name: "execute_codemode",
      title: "Execute Multi-Step Code Mode Plan (Isolated VM Sandbox)",
      category: "orchestration",
      domain: "meta",
      tags: ["codemode", "sandbox", "workflow", "chain", "javascript"],
      description:
        "Executes an agent-authored JavaScript workflow inside a deterministic isolated V8 sandbox. Use `await codemode.callTool(name, args)` to invoke atomic `api_*` tools, extract live data fields, and pass them with agent-chosen parameters (e.g. conversionFactor, allowedMultiplier, peakRate) into `calc_*` formula tools.",
      resourceUri,
      inputSchema: {
        type: "object",
        required: ["code"],
        properties: {
          code: {
            type: "string",
            description:
              "JavaScript async plan using `await codemode.callTool(toolName, args)` and returning a structured result object."
          },
          inputs: {
            type: "object",
            description:
              "Optional input parameters object accessible inside the sandbox as `inputs` or `codemode.inputs`."
          },
          timeoutMs: {
            type: "number",
            description: "Execution timeout in milliseconds (default 5000, max 10000)."
          }
        }
      },
      handler: async (args, context) => {
        const res = await executeCodeModePlan({
          server: this,
          code: args.code,
          inputs: args.inputs || {},
          timeoutMs: args.timeoutMs || 5000,
          session: context?.session || null
        });
        const customVoice =
          res.result && typeof res.result.voiceSummary === "string" && res.result.voiceSummary.trim()
            ? res.result.voiceSummary.trim()
            : `Code Mode plan executed ${res.stepsCount} atomic tool steps in ${res.totalDurationMs} milliseconds.`;
        return {
          voiceSummary: customVoice,
          structuredContent: res
        };
      }
    });
  }

  /**
   * Registers an additional HTTP handler (e.g. for local device simulator or health check).
   */
  addCustomRoute(method, pathPrefix, handler) {
    this.customRoutes.push({
      method: method.toUpperCase(),
      pathPrefix,
      handler
    });
  }

  /**
   * Validates user input arguments against the tool's JSON schema required fields and primitive types.
   */
  validateToolInput(tool, args) {
    const schema = tool.inputSchema;
    if (!schema || schema.type !== "object") {
      return { valid: true };
    }
    const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (safeArgs[reqKey] === undefined || safeArgs[reqKey] === null || safeArgs[reqKey] === "") {
          return {
            valid: false,
            message: `Missing required parameter '${reqKey}' for tool '${tool.name}'.`
          };
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [propName, propSpec] of Object.entries(schema.properties)) {
        if (safeArgs[propName] !== undefined && propSpec && propSpec.type) {
          const val = safeArgs[propName];
          if (propSpec.type === "array" && !Array.isArray(val)) {
            return {
              valid: false,
              message: `Parameter '${propName}' must be an array.`
            };
          }
          if (propSpec.type === "number" && typeof val !== "number") {
            return {
              valid: false,
              message: `Parameter '${propName}' must be a number.`
            };
          }
          if (propSpec.type === "string" && typeof val !== "string") {
            return {
              valid: false,
              message: `Parameter '${propName}' must be a string.`
            };
          }
          if (propSpec.type === "boolean" && typeof val !== "boolean") {
            return {
              valid: false,
              message: `Parameter '${propName}' must be a boolean.`
            };
          }
        }
      }
    }
    return { valid: true };
  }

  /**
   * Processes a single JSON-RPC 2.0 request object and returns a JSON-RPC response (or null for notifications).
   */
  async handleRpcMessage(msg, session) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: msg && msg.id !== undefined ? msg.id : null,
        error: {
          code: -32600,
          message: "Invalid Request: jsonrpc must be '2.0'"
        }
      };
    }

    // Notifications do not have an id and do not return a JSON-RPC response body
    if (msg.id === undefined) {
      if (msg.method === "notifications/initialized" && session) {
        session.initialized = true;
      }
      return null;
    }

    const { id, method, params } = msg;

    try {
      if (method === "initialize") {
        const requestedVersion = params?.protocolVersion;
        if (
          requestedVersion &&
          !this.supportedProtocolVersions.includes(requestedVersion)
        ) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32022,
              message: `UnsupportedProtocolVersionError: Unsupported protocol version '${requestedVersion}'`,
              data: {
                requestedVersion,
                supportedVersions: this.supportedProtocolVersions
              }
            }
          };
        }
        const negotiatedVersion = requestedVersion || this.protocolVersion;
        if (session) {
          session.protocolVersion = negotiatedVersion;
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiatedVersion,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": negotiatedVersion
            },
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              experimental: {
                alexaPlusUi: {
                  displayModes: [...REQUIRED_DISPLAY_MODES],
                  inspectorVersion: "1.0.0"
                }
              }
            },
            serverInfo: {
              name: this.name,
              version: this.version
            }
          }
        };
      }

      if (method === "ping") {
        return {
          jsonrpc: "2.0",
          id,
          result: {}
        };
      }

      if (method === "tools/list") {
        const toolsList = [];
        for (const tool of this.tools.values()) {
          toolsList.push({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            _meta: tool._meta
          });
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: toolsList
          }
        };
      }

      if (method === "tools/call") {
        const toolName = params && params.name;
        const toolArgs = (params && params.arguments) || {};
        const tool = this.tools.get(toolName);

        if (!tool) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Unknown tool: ${toolName}`
            }
          };
        }

        const validation = this.validateToolInput(tool, toolArgs);
        if (!validation.valid) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: validation.message
            }
          };
        }

        const executionResult = await tool.handler(toolArgs, { session });
        const voiceSummary = executionResult && executionResult.voiceSummary;

        if (this.strictVoiceSummary && (typeof voiceSummary !== "string" || !voiceSummary.trim())) {
          throw new Error(
            `Tool '${toolName}' failed Alexa+ Voice-only contract: handler must return a non-empty voiceSummary string.`
          );
        }

        const structuredContent =
          (executionResult && executionResult.structuredContent) ||
          (executionResult && executionResult.data) ||
          {};

        // Cache latest tool output in session and on resource so live inspector previews can hydrate
        const targetResource = this.resources.get(tool.resourceUri);
        if (targetResource) {
          targetResource.lastState = structuredContent;
          targetResource.lastVoiceSummary = voiceSummary;
        }

        const responseMeta = {
          ui: {
            resourceUri: tool.resourceUri,
            displayModes: tool.displayModes
          },
          voice: {
            summary: voiceSummary,
            ssml: `<speak>${escapeXml(voiceSummary)}</speak>`
          }
        };

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: voiceSummary
              },
              {
                type: "text",
                text: JSON.stringify(structuredContent)
              }
            ],
            structuredContent,
            _meta: responseMeta,
            isError: false
          }
        };
      }

      if (method === "resources/list") {
        const resourcesList = [];
        for (const res of this.resources.values()) {
          resourcesList.push({
            uri: res.uri,
            name: res.name,
            description: res.description,
            mimeType: res.mimeType,
            _meta: {
              ui: {
                displayModes: res.displayModes
              }
            }
          });
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resources: resourcesList
          }
        };
      }

      if (method === "resources/read") {
        const uri = params && params.uri;
        const displayMode = (params && params.displayMode) || "inline";
        const res = this.resources.get(uri);

        if (!res) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32002,
              message: `Resource not found: ${uri}`
            }
          };
        }

        const htmlText = await res.render({
          uri: res.uri,
          displayMode,
          state: res.lastState || null,
          voiceSummary: res.lastVoiceSummary || null
        });

        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri: res.uri,
                mimeType: res.mimeType,
                text: htmlText
              }
            ]
          }
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`
        }
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err && err.message ? err.message : "Internal MCP server error"
        }
      };
    }
  }

  /**
   * HTTP request router supporting Streamable HTTP (POST/GET/DELETE /mcp) and custom routes.
   */
  async handleHttpRequest(req, res) {
    // Standard CORS headers for Local Inspector & Web Simulator
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    // Check custom routes first
    for (const route of this.customRoutes) {
      if (
        req.method === route.method &&
        (parsedUrl.pathname === route.pathPrefix ||
          parsedUrl.pathname.startsWith(route.pathPrefix + "/"))
      ) {
        await route.handler(req, res, parsedUrl);
        return;
      }
    }

    if (parsedUrl.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          name: this.name,
          version: this.version,
          protocolVersion: this.protocolVersion,
          toolsCount: this.tools.size,
          resourcesCount: this.resources.size
        })
      );
      return;
    }

    if (parsedUrl.pathname !== this.endpointPath) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Not Found", path: parsedUrl.pathname }));
      return;
    }

    const incomingSessionId = req.headers["mcp-session-id"];
    const incomingProtoHeader = req.headers["mcp-protocol-version"];
    let session = incomingSessionId ? this.sessions.get(incomingSessionId) : null;
    if (!session) {
      const newSessionId = incomingSessionId || crypto.randomUUID();
      session = {
        id: newSessionId,
        createdAt: Date.now(),
        initialized: false,
        protocolVersion:
          incomingProtoHeader && this.supportedProtocolVersions.includes(incomingProtoHeader)
            ? incomingProtoHeader
            : this.protocolVersion
      };
      this.sessions.set(newSessionId, session);
    }
    res.setHeader("Mcp-Session-Id", session.id);
    res.setHeader("MCP-Protocol-Version", session.protocolVersion || this.protocolVersion);

    if (req.method === "DELETE") {
      this.sessions.delete(session.id);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ terminated: true, sessionId: session.id }));
      return;
    }

    if (req.method === "GET") {
      // Streamable HTTP GET endpoint for server-to-client SSE stream
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write(`event: endpoint\ndata: ${this.endpointPath}\n\n`);
      req.on("close", () => {
        res.end();
      });
      return;
    }

    if (req.method === "POST") {
      const rawBody = await readRequestBody(req);
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error: invalid JSON payload" }
          })
        );
        return;
      }

      if (Array.isArray(parsed)) {
        const responses = [];
        for (const item of parsed) {
          const r = await this.handleRpcMessage(item, session);
          if (r !== null) {
            responses.push(r);
          }
        }
        res.setHeader("MCP-Protocol-Version", session.protocolVersion || this.protocolVersion);
        if (responses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(responses));
        return;
      }

      const rpcResponse = await this.handleRpcMessage(parsed, session);
      res.setHeader("MCP-Protocol-Version", session.protocolVersion || this.protocolVersion);
      if (rpcResponse === null) {
        res.writeHead(202);
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rpcResponse));
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
  }

  /**
   * Starts listening on the given host and port. Pass port=0 for an ephemeral free port.
   */
  async listen(port = 0, host = "127.0.0.1") {
    if (this.httpServer) {
      throw new Error("Server is already listening.");
    }
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ error: err.message }));
      });
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(port, host, resolve);
    });

    const addr = this.httpServer.address();
    return {
      host: addr.address,
      port: addr.port,
      url: `http://${addr.address}:${addr.port}${this.endpointPath}`,
      baseUrl: `http://${addr.address}:${addr.port}`
    };
  }

  /**
   * Cleanly closes the underlying HTTP server.
   */
  async close() {
    if (!this.httpServer) {
      return;
    }
    const srv = this.httpServer;
    this.httpServer = null;
    await new Promise((resolve) => srv.close(() => resolve()));
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export {
  createAlexaUiWidget,
  getContrastRatio,
  auditThemeAccessibility,
  inspectHtmlAccessibility,
  DEFAULT_ALEXA_THEME
} from "./ui-shell.mjs";
export { runCertificationAudit } from "./inspector-audit.mjs";
export {
  searchToolsCatalog,
  describeToolSchema,
  estimateTokenCount
} from "./tool-discovery.mjs";
export { executeCodeModePlan } from "./codemode-sandbox.mjs";


