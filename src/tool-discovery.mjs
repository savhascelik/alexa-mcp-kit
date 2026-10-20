/**
 * Progressive Tool Discovery Engine (search_tools & describe_tool) for Alexa+ MCP Servers.
 *
 * Why this exists:
 * Instead of hardcoding monolithic if/else handlers or dumping 20+ full JSON Schemas into
 * every LLM prompt turn, Progressive Discovery lets Alexa+ search atomic API tools (api_*),
 * parameterized math/formula tools (calc_*), and UI surface tools (render_*) on demand,
 * then inspect the exact inputSchema and composition hints only for the tools it chooses to chain.
 */

export function estimateTokenCount(objOrString) {
  const raw = typeof objOrString === "string" ? objOrString : JSON.stringify(objOrString);
  return Math.max(1, Math.ceil(raw.length / 4));
}

/**
 * Searches the registered MCP tools catalog by keyword query, category, and domain.
 */
export function searchToolsCatalog(toolsMap, params = {}) {
  const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
  const categoryFilter =
    typeof params.category === "string" && params.category.trim() !== ""
      ? params.category.trim().toLowerCase()
      : null;
  const domainFilter =
    typeof params.domain === "string" && params.domain.trim() !== ""
      ? params.domain.trim().toLowerCase()
      : null;
  const limit =
    typeof params.limit === "number" && params.limit > 0
      ? Math.min(50, Math.floor(params.limit))
      : 10;

  const queryTokens = query
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter(Boolean);

  const allToolsArray = Array.from(toolsMap.values());
  const fullCatalogSchemaPayload = allToolsArray.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    _meta: t._meta
  }));
  const fullCatalogTokens = estimateTokenCount(fullCatalogSchemaPayload);

  const matches = [];

  for (const tool of allToolsArray) {
    // Skip meta-discovery tools themselves unless specifically queried
    if (
      (tool.name === "search_tools" || tool.name === "describe_tool") &&
      !query.includes("search") &&
      !query.includes("describe")
    ) {
      continue;
    }

    const toolCategory = String(tool.category || "general").toLowerCase();
    const toolDomain = String(tool.domain || "general").toLowerCase();
    const toolTags = Array.isArray(tool.tags) ? tool.tags.map((t) => String(t).toLowerCase()) : [];

    if (categoryFilter && toolCategory !== categoryFilter) {
      continue;
    }
    if (domainFilter && toolDomain !== domainFilter) {
      continue;
    }

    const propNames =
      tool.inputSchema && tool.inputSchema.properties
        ? Object.keys(tool.inputSchema.properties)
        : [];
    const requiredParams =
      tool.inputSchema && Array.isArray(tool.inputSchema.required)
        ? tool.inputSchema.required
        : [];

    let score = 0;
    if (queryTokens.length === 0) {
      score = 10;
    } else {
      const nameLower = tool.name.toLowerCase();
      const titleLower = String(tool.title || "").toLowerCase();
      const descLower = String(tool.description || "").toLowerCase();
      const propsLower = propNames.join(" ").toLowerCase();

      for (const tok of queryTokens) {
        if (nameLower === tok) score += 50;
        else if (nameLower.includes(tok)) score += 25;
        if (toolCategory === tok || toolDomain === tok) score += 20;
        if (toolTags.some((tag) => tag === tok || tag.includes(tok))) score += 18;
        if (titleLower.includes(tok)) score += 12;
        if (propsLower.includes(tok)) score += 10;
        if (descLower.includes(tok)) score += 6;
      }
    }

    if (score > 0) {
      matches.push({
        name: tool.name,
        title: tool.title || tool.name,
        category: toolCategory,
        domain: toolDomain,
        tags: toolTags,
        shortDescription:
          tool.description.length > 140
            ? `${tool.description.slice(0, 137)}...`
            : tool.description,
        requiredParams,
        optionalParams: propNames.filter((p) => !requiredParams.includes(p)),
        score
      });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const topMatches = matches.slice(0, limit);

  const compactTokens = estimateTokenCount(topMatches);
  const tokenSavingsPct =
    fullCatalogTokens > 0
      ? Number(
          Math.max(
            0,
            ((fullCatalogTokens - compactTokens) / fullCatalogTokens) * 100
          ).toFixed(1)
        )
      : 0;

  return {
    query: query || "*",
    categoryFilter,
    domainFilter,
    totalToolsInCatalog: allToolsArray.length,
    matchCount: topMatches.length,
    metrics: {
      fullCatalogEstimatedTokens: fullCatalogTokens,
      discoveryResponseTokens: compactTokens,
      tokenSavingsPct
    },
    tools: topMatches
  };
}

/**
 * Returns the full JSON Schema, parameter semantics, and composition hints for a specific tool.
 */
export function describeToolSchema(toolsMap, params = {}) {
  const toolName = typeof params.toolName === "string" ? params.toolName.trim() : "";
  const tool = toolsMap.get(toolName);

  if (!tool) {
    throw new Error(
      `Tool '${toolName}' not found in catalog. Call search_tools first to discover valid tool names.`
    );
  }

  const inputSchema = tool.inputSchema;

  return {
    name: tool.name,
    title: tool.title || tool.name,
    category: tool.category || "general",
    domain: tool.domain || "general",
    tags: Array.isArray(tool.tags) ? tool.tags : [],
    description: tool.description,
    inputSchema,
    compositionHints: tool.compositionHints || {
      usageNote:
        "Pass outputs from atomic api_* tools as explicit parameter inputs into calc_* tools or execute_codemode."
    },
    resourceUri: tool.resourceUri
  };
}
