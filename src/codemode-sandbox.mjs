import vm from "node:vm";
import { searchToolsCatalog, describeToolSchema } from "./tool-discovery.mjs";

/**
 * Deterministic Code Mode Sandbox (execute_codemode) for Alexa+ MCP Servers.
 *
 * Why this exists:
 * Instead of hardcoding domain-specific if/else workflows or static conversion factors
 * inside the MCP server, Alexa+ can compose atomic API tools (api_*) and parameterized
 * mathematical tools (calc_*) dynamically by writing a short JavaScript plan.
 *
 * Security & Determinism Guarantees:
 * 1. Isolated V8 Context via node:vm with { codeGeneration: { strings: false, wasm: false } }
 *    blocking eval(), new Function(), process, require, fs, and raw network access.
 * 2. Deep-cloned JSON boundary on every RPC call so sandbox code cannot pollute host objects.
 * 3. Hard execution timeout (default 5000ms) protecting both sync loops and async promises.
 * 4. Full audit trail of every tool call (steps[], logs[], durationMs).
 */

export async function executeCodeModePlan({
  server,
  code,
  inputs = {},
  timeoutMs = 5000,
  session = null
}) {
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("Code Mode requires a non-empty JavaScript 'code' string.");
  }

  const effectiveTimeoutMs = Math.max(50, Math.min(10000, Number(timeoutMs) || 5000));

  const steps = [];
  const logs = [];
  const startedAt = Date.now();

  const safeClone = (val) => {
    if (val === undefined) return null;
    return JSON.parse(JSON.stringify(val));
  };

  const codemodeBridge = Object.freeze({
    inputs: safeClone(inputs),

    log: (...args) => {
      const formatted = args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" ");
      logs.push(formatted);
    },

    searchTools: async (query, opts = {}) => {
      const stepStart = Date.now();
      const res = searchToolsCatalog(server.tools, { query, ...opts });
      const cloned = safeClone(res);
      steps.push({
        stepIndex: steps.length + 1,
        type: "searchTools",
        query,
        durationMs: Date.now() - stepStart,
        matchCount: cloned.matchCount
      });
      return cloned;
    },

    describeTool: async (toolName) => {
      const stepStart = Date.now();
      const res = describeToolSchema(server.tools, { toolName });
      const cloned = safeClone(res);
      steps.push({
        stepIndex: steps.length + 1,
        type: "describeTool",
        toolName,
        durationMs: Date.now() - stepStart
      });
      return cloned;
    },

    callTool: async (toolName, rawArgs = {}) => {
      if (toolName === "execute_codemode") {
        throw new Error("Recursive execute_codemode calls are forbidden inside the sandbox.");
      }
      const tool = server.tools.get(toolName);
      if (!tool) {
        throw new Error(`Code Mode RPC Error: Unknown tool '${toolName}'.`);
      }

      const args = safeClone(rawArgs || {});

      const validation = server.validateToolInput(tool, args);
      if (!validation.valid) {
        throw new Error(`Code Mode RPC Validation Error (${toolName}): ${validation.message}`);
      }

      const stepStart = Date.now();
      const execResult = await tool.handler(args, { session, fromCodeMode: true });
      const output = safeClone(
        (execResult && execResult.structuredContent) ||
          (execResult && execResult.data) ||
          execResult ||
          {}
      );

      // Update associated ui:// resource state if the tool has one
      if (tool.resourceUri) {
        const resRecord = server.resources.get(tool.resourceUri);
        if (resRecord) {
          resRecord.lastState = output;
          if (execResult && execResult.voiceSummary) {
            resRecord.lastVoiceSummary = execResult.voiceSummary;
          }
        }
      }

      steps.push({
        stepIndex: steps.length + 1,
        type: "callTool",
        toolName,
        arguments: args,
        durationMs: Date.now() - stepStart,
        voiceSummary: (execResult && execResult.voiceSummary) || null,
        outputPreview: summarizeOutput(output)
      });

      return output;
    },

    step: async (label, asyncFn) => {
      const stepStart = Date.now();
      const out = await asyncFn();
      const cloned = safeClone(out);
      steps.push({
        stepIndex: steps.length + 1,
        type: "customStep",
        label: String(label || `Step ${steps.length + 1}`),
        durationMs: Date.now() - stepStart,
        outputPreview: summarizeOutput(cloned)
      });
      return cloned;
    }
  });

  const sandboxGlobals = {
    codemode: codemodeBridge,
    inputs: codemodeBridge.inputs,
    console: Object.freeze({
      log: (...a) => codemodeBridge.log(...a),
      info: (...a) => codemodeBridge.log(...a),
      warn: (...a) => codemodeBridge.log("[WARN]", ...a),
      error: (...a) => codemodeBridge.log("[ERROR]", ...a)
    }),
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Date,
    RegExp,
    Map,
    Set,
    Promise,
    Error,
    TypeError,
    RangeError,
    parseFloat,
    parseInt,
    isNaN,
    isFinite,
    process: undefined,
    require: undefined,
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebSocket: undefined
  };

  const context = vm.createContext(sandboxGlobals, {
    name: "AlexaMcpCodeModeSandbox",
    codeGeneration: {
      strings: false,
      wasm: false
    }
  });

  // Support both full async function expressions and top-level statements with return/await
  const trimmedCode = code.trim();
  const wrappedSource =
    trimmedCode.startsWith("async") || trimmedCode.startsWith("(")
      ? `
        (async () => {
          const __planFn = ${trimmedCode};
          if (typeof __planFn === "function") {
            return await __planFn({ codemode, inputs });
          }
          return __planFn;
        })()
      `
      : `
        (async () => {
          ${trimmedCode}
        })()
      `;

  const script = new vm.Script(wrappedSource, {
    filename: "codemode-plan.vm.js"
  });

  let timerId = null;
  try {
    const executionPromise = script.runInContext(context, {
      timeout: effectiveTimeoutMs,
      breakOnSigint: true
    });

    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        reject(
          new Error(
            `CodeModeTimeoutError: Plan execution exceeded ${effectiveTimeoutMs}ms limit.`
          )
        );
      }, effectiveTimeoutMs);
    });

    const rawResult = await Promise.race([executionPromise, timeoutPromise]);
    const finalResult = safeClone(rawResult !== undefined ? rawResult : { completed: true });

    return {
      status: "COMPLETED",
      totalDurationMs: Date.now() - startedAt,
      stepsCount: steps.length,
      steps,
      logs,
      result: finalResult
    };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const isTimeout =
      message.includes("CodeModeTimeoutError") ||
      message.includes("Script execution timed out");
    throw new Error(
      isTimeout
        ? `CodeModeTimeoutError: Execution timed out after ${effectiveTimeoutMs}ms.`
        : `CodeModeExecutionError: ${message}`
    );
  } finally {
    if (timerId) {
      clearTimeout(timerId);
    }
  }
}

function summarizeOutput(val) {
  if (val === null || val === undefined) return null;
  if (typeof val !== "object") return val;
  const raw = JSON.stringify(val);
  if (raw.length <= 240) return val;
  return `${raw.slice(0, 237)}...`;
}
