/**
 * Adaptive 3-Display-Mode UI Generator for Amazon Alexa+ MCP Apps.
 *
 * Designed to match the official Alexa+ Echo Show & @alexa-ai/addon-local-inspector
 * visual language:
 *   - Deep-navy Echo Show glass canvas (#0B192C / #132A46) with top drag handle
 *   - 3 circular Alexa+ top-right surface buttons (Expand, Card/Table view, Voice-only)
 *   - VR-04 Partner Attribution ("Powered by ...")
 *   - Rich visual card deck with bespoke SVG hero illustrations + Royal Blue pill CTAs
 *   - GQ-10 scroll indicator dots & GQ-11 sticky summary footer for Echo Show (small / show8)
 *   - Full statutory comparison table view in Fullscreen mode
 *   - WCAG 2.1 AA contrast (>= 4.5:1) and >= 48px far-field touch targets
 */

export const DEFAULT_ALEXA_THEME = Object.freeze({
  bgPrimary: "#0A1828",
  bgCard: "#12263F",
  textPrimary: "#F8FAFC",
  textSecondary: "#CBD5E1",
  accentBg: "#1D4ED8",
  accentText: "#FFFFFF",
  dangerBg: "#B91C1C",
  dangerText: "#FFFFFF",
  successBg: "#15803D",
  successText: "#FFFFFF",
  minTouchPx: 48
});

export function parseHexColor(hex) {
  const clean = String(hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`Invalid 6-digit hex color: ${hex}`);
  }
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

export function getRelativeLuminance(hex) {
  const { r, g, b } = parseHexColor(hex);
  const toLinear = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function getContrastRatio(foregroundHex, backgroundHex) {
  const l1 = getRelativeLuminance(foregroundHex);
  const l2 = getRelativeLuminance(backgroundHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export function auditThemeAccessibility(theme = DEFAULT_ALEXA_THEME) {
  const merged = { ...DEFAULT_ALEXA_THEME, ...theme };
  const checks = [
    {
      pair: "textPrimary on bgPrimary",
      fg: merged.textPrimary,
      bg: merged.bgPrimary,
      ratio: getContrastRatio(merged.textPrimary, merged.bgPrimary),
      minRequired: 4.5
    },
    {
      pair: "textPrimary on bgCard",
      fg: merged.textPrimary,
      bg: merged.bgCard,
      ratio: getContrastRatio(merged.textPrimary, merged.bgCard),
      minRequired: 4.5
    },
    {
      pair: "textSecondary on bgCard",
      fg: merged.textSecondary,
      bg: merged.bgCard,
      ratio: getContrastRatio(merged.textSecondary, merged.bgCard),
      minRequired: 4.5
    },
    {
      pair: "accentText on accentBg",
      fg: merged.accentText,
      bg: merged.accentBg,
      ratio: getContrastRatio(merged.accentText, merged.accentBg),
      minRequired: 4.5
    },
    {
      pair: "dangerText on dangerBg",
      fg: merged.dangerText,
      bg: merged.dangerBg,
      ratio: getContrastRatio(merged.dangerText, merged.dangerBg),
      minRequired: 4.5
    }
  ];

  const minContrastRatio = Math.min(...checks.map((c) => c.ratio));
  const failedChecks = checks.filter((c) => c.ratio < c.minRequired);
  const touchOk = Number(merged.minTouchPx) >= 44;

  return {
    valid: failedChecks.length === 0 && touchOk,
    minContrastRatio,
    minTouchPx: Number(merged.minTouchPx),
    checks,
    failedChecks
  };
}

/**
 * Parses actual <style> CSS declarations from a rendered HTML widget and computes
 * true WCAG 2.1 AA contrast ratios and touch-target ergonomics without relying on
 * self-declared HTML data-* attributes.
 */
export function inspectHtmlAccessibility(html = "") {
  const styleBlocks = [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n");

  const extractCssVar = (varName) => {
    const match = styleBlocks.match(new RegExp(`${varName}\\s*:\\s*(#[0-9a-fA-F]{6})`, "i"));
    return match ? match[1] : null;
  };

  const bgPrimary = extractCssVar("--bg-primary");
  const bgCard = extractCssVar("--bg-card");
  const textPrimary = extractCssVar("--text-primary");
  const textSecondary = extractCssVar("--text-secondary");
  const accentBg = extractCssVar("--accent-bg");
  const accentText = extractCssVar("--accent-text");
  const dangerBg = extractCssVar("--danger-bg");
  const dangerText = extractCssVar("--danger-text");

  const requiredColorsPresent = Boolean(
    bgPrimary && bgCard && textPrimary && textSecondary && accentBg && accentText && dangerBg && dangerText
  );

  let minContrastRatio = 0;
  let contrastChecks = [];
  let failedContrastChecks = [];

  if (requiredColorsPresent) {
    try {
      const themeAudit = auditThemeAccessibility({
        bgPrimary,
        bgCard,
        textPrimary,
        textSecondary,
        accentBg,
        accentText,
        dangerBg,
        dangerText,
        minTouchPx: 48
      });
      minContrastRatio = themeAudit.minContrastRatio;
      contrastChecks = themeAudit.checks;
      failedContrastChecks = themeAudit.failedChecks;
    } catch {
      minContrastRatio = 0;
    }
  }

  const minTouchVarMatch = styleBlocks.match(/--min-touch\s*:\s*(\d+)px/i);
  const hasTouchTargetClass =
    /\.touch-target\s*\{[\s\S]*?min-height\s*:\s*(?:var\(--min-touch\)|(\d+)px)/i.test(styleBlocks) &&
    /\.touch-target\s*\{[\s\S]*?min-width\s*:\s*(?:var\(--min-touch\)|(\d+)px)/i.test(styleBlocks);

  const minTouchPx = minTouchVarMatch && hasTouchTargetClass ? Number(minTouchVarMatch[1]) : 0;

  return {
    validContrast: requiredColorsPresent && failedContrastChecks.length === 0 && minContrastRatio >= 4.5,
    minContrastRatio,
    contrastChecks,
    failedContrastChecks,
    validTouch: minTouchPx >= 44 && hasTouchTargetClass,
    minTouchPx,
    hasPartnerAttribution: html.includes('class="vr04-attribution"') || html.includes("Powered by "),
    hasStickySummaryFooter: html.includes('class="gq11-sticky-footer"')
  };
}

/**
 * Generates a rich, domain-aware SVG artwork banner for each Echo Show card
 * without violating the strict CSP (default-src 'none').
 */
function renderCardArtworkSvg(row, idx) {
  const raw = `${row.id || ""} ${row.title || ""} ${row.subtitle || ""} ${row.citation || ""}`.toLowerCase();
  const isFlagged = row.status && row.status !== "VERIFIED_FAIR";

  // Choose visual palette and vector illustration by item semantics
  let gradStart = "#1E3A8A";
  let gradEnd = "#0F172A";
  let accentStroke = "#60A5FA";
  let badgeBg = "rgba(30, 64, 175, 0.85)";
  let iconSvg = "";

  if (raw.includes("9928") || raw.includes("emergency") || raw.includes("hospital")) {
    gradStart = "#7F1D1D";
    gradEnd = "#1E1B4B";
    accentStroke = "#FCA5A5";
    badgeBg = "rgba(185, 28, 28, 0.9)";
    iconSvg = `
      <rect x="112" y="22" width="56" height="56" rx="14" fill="rgba(255,255,255,0.12)" stroke="${accentStroke}" stroke-width="2"/>
      <path d="M140 34v32M124 50h32" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round"/>
      <path d="M32 68 L68 68 L78 44 L90 80 L100 58 L112 68" fill="none" stroke="#F87171" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  } else if (raw.includes("71046") || raw.includes("x-ray") || raw.includes("duplicate")) {
    gradStart = "#581C87";
    gradEnd = "#0F172A";
    accentStroke = "#D8B4FE";
    badgeBg = "rgba(126, 34, 206, 0.9)";
    iconSvg = `
      <rect x="96" y="18" width="52" height="62" rx="8" fill="rgba(255,255,255,0.1)" stroke="${accentStroke}" stroke-width="2"/>
      <rect x="122" y="26" width="52" height="62" rx="8" fill="rgba(255,255,255,0.16)" stroke="#FFFFFF" stroke-width="2"/>
      <path d="M136 42h24M136 52h24M136 62h16" stroke="#E9D5FF" stroke-width="3" stroke-linecap="round"/>
    `;
  } else if (raw.includes("36415") || raw.includes("80053") || raw.includes("blood") || raw.includes("metabolic")) {
    gradStart = "#0F766E";
    gradEnd = "#0F172A";
    accentStroke = "#5EEAD4";
    badgeBg = "rgba(15, 118, 110, 0.9)";
    iconSvg = `
      <path d="M130 22h20M135 22v20l-15 26a8 8 0 0 0 7 12h26a8 8 0 0 0 7-12l-15-26V22" fill="rgba(94,234,212,0.18)" stroke="#FFFFFF" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="136" cy="64" r="4" fill="#5EEAD4"/>
      <circle cx="146" cy="58" r="3" fill="#FFFFFF"/>
    `;
  } else if (raw.includes("modem") || raw.includes("router") || raw.includes("isp")) {
    gradStart = "#9A3412";
    gradEnd = "#1E293B";
    accentStroke = "#FDBA74";
    badgeBg = "rgba(194, 65, 12, 0.9)";
    iconSvg = `
      <rect x="104" y="48" width="72" height="26" rx="6" fill="rgba(255,255,255,0.15)" stroke="#FFFFFF" stroke-width="2.5"/>
      <line x1="118" y1="48" x2="112" y2="24" stroke="${accentStroke}" stroke-width="3" stroke-linecap="round"/>
      <line x1="162" y1="48" x2="168" y2="24" stroke="${accentStroke}" stroke-width="3" stroke-linecap="round"/>
      <circle cx="120" cy="61" r="3" fill="#4ADE80"/>
      <circle cx="134" cy="61" r="3" fill="#FDBA74"/>
      <path d="M126 30 a22 22 0 0 1 28 0" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round"/>
    `;
  } else if (raw.includes("ev") || raw.includes("dryer") || raw.includes("dishwasher") || raw.includes("kwh") || raw.includes("peak") || raw.includes("water") || raw.includes("hvac")) {
    gradStart = "#0369A1";
    gradEnd = "#0F172A";
    accentStroke = "#38BDF8";
    badgeBg = "rgba(2, 132, 199, 0.9)";
    iconSvg = `
      <circle cx="140" cy="50" r="30" fill="rgba(56,189,248,0.15)" stroke="${accentStroke}" stroke-width="2"/>
      <path d="M144 26 L126 52 H142 L136 74 L156 46 H140 Z" fill="#FDE047" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round"/>
    `;
  } else if (raw.includes("rebate") || raw.includes("solar") || raw.includes("heat pump") || raw.includes("induction") || raw.includes("ira") || raw.includes("smart")) {
    gradStart = "#065F46";
    gradEnd = "#0F172A";
    accentStroke = "#34D399";
    badgeBg = "rgba(5, 150, 105, 0.9)";
    iconSvg = `
      <rect x="102" y="28" width="76" height="44" rx="10" fill="rgba(52,211,153,0.16)" stroke="#34D399" stroke-width="2"/>
      <circle cx="140" cy="50" r="12" fill="rgba(255,255,255,0.2)" stroke="#FFFFFF" stroke-width="2"/>
      <text x="140" y="55" text-anchor="middle" fill="#FFFFFF" font-size="14" font-weight="800" font-family="sans-serif">$</text>
    `;
  } else if (raw.includes("recall") || raw.includes("cpsc") || raw.includes("fda") || raw.includes("hazard")) {
    gradStart = "#991B1B";
    gradEnd = "#1E1B4B";
    accentStroke = "#FCA5A5";
    badgeBg = "rgba(185, 28, 28, 0.92)";
    iconSvg = `
      <path d="M140 22 L172 74 H108 Z" fill="rgba(248,113,113,0.2)" stroke="#FFFFFF" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="140" y1="40" x2="140" y2="56" stroke="#FEF08A" stroke-width="4" stroke-linecap="round"/>
      <circle cx="140" cy="65" r="2.8" fill="#FEF08A"/>
    `;
  } else {
    const palettes = [
      ["#1E3A8A", "#0F172A", "#60A5FA"],
      ["#0F766E", "#0F172A", "#5EEAD4"],
      ["#4C1D95", "#0F172A", "#C4B5FD"],
      ["#0369A1", "#0F172A", "#38BDF8"]
    ];
    const p = palettes[idx % palettes.length];
    gradStart = p[0];
    gradEnd = p[1];
    accentStroke = p[2];
    iconSvg = `
      <rect x="108" y="24" width="64" height="52" rx="10" fill="rgba(255,255,255,0.14)" stroke="#FFFFFF" stroke-width="2"/>
      <path d="M122 42h36M122 52h24M122 62h30" stroke="${accentStroke}" stroke-width="3" stroke-linecap="round"/>
    `;
  }

  const statusText = escapeHtml(row.status || (isFlagged ? "ACTIONABLE" : "VERIFIED"));
  const citationText = escapeHtml((row.citation || "STATUTORY AUDIT").slice(0, 26));

  return `
    <svg viewBox="0 0 280 104" width="100%" height="104" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${escapeHtml(row.title || "Card Visual")}">
      <defs>
        <linearGradient id="cardGrad-${idx}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${gradStart}"/>
          <stop offset="100%" stop-color="${gradEnd}"/>
        </linearGradient>
      </defs>
      <rect width="280" height="104" fill="url(#cardGrad-${idx})"/>
      <circle cx="245" cy="18" r="54" fill="rgba(255,255,255,0.05)"/>
      <circle cx="30" cy="95" r="45" fill="rgba(255,255,255,0.04)"/>
      ${iconSvg}
      <rect x="12" y="12" width="${Math.min(148, statusText.length * 7 + 20)}" height="22" rx="11" fill="${badgeBg}"/>
      <text x="22" y="27" fill="#FFFFFF" font-size="10" font-weight="800" font-family="system-ui, sans-serif" letter-spacing="0.05em">${statusText}</text>
      <text x="14" y="92" fill="rgba(255,255,255,0.78)" font-size="10" font-weight="600" font-family="system-ui, sans-serif">${citationText}</text>
    </svg>
  `;
}

/**
 * Generates an adaptive, self-contained HTML5 MCP App widget (text/html;profile=mcp-app)
 * that supports Inline, Fullscreen, and Voice-only display modes.
 */
export function createAlexaUiWidget(config = {}) {
  const {
    uri = "ui://alexa-mcp-kit/widget",
    title = "Alexa+ MCP Widget",
    subtitle = "",
    badge = "ALEXA+ VERIFIED",
    partnerName = "BillShield Statutory Engine",
    displayMode = "inline",
    voiceSummary = "Here is your result.",
    ssml = "",
    metrics = [],
    rows = [],
    actions = [],
    theme: customTheme = {}
  } = config;

  const theme = { ...DEFAULT_ALEXA_THEME, ...customTheme };
  const audit = auditThemeAccessibility(theme);
  if (!audit.valid) {
    const reasons = audit.failedChecks
      .map((c) => `${c.pair} (${c.ratio}:1 < ${c.minRequired}:1)`)
      .join(", ");
    throw new Error(
      `Alexa+ UI Accessibility Audit Failed: ${reasons || `minTouchPx=${theme.minTouchPx} < 44`}`
    );
  }

  const initialMode = ["inline", "fullscreen", "voice-only"].includes(displayMode)
    ? displayMode
    : "inline";

  const safeSsml = ssml || `<speak>${escapeHtml(voiceSummary)}</speak>`;

  // Render rich Echo Show visual cards (matching the official Alexa+ Inspector card carousel)
  const visualCardsHtml = rows
    .map((row, idx) => {
      const defaultPrimaryAction = actions[0] || null;
      const toolToCall = row.actionTool || (defaultPrimaryAction ? defaultPrimaryAction.toolName : "");
      const toolLabel =
        row.actionLabel ||
        (row.status === "VERIFIED_FAIR"
          ? "Verified Fair Rate"
          : defaultPrimaryAction
            ? "Select & Claim"
            : "Inspect Item");
      const toolArgs = row.actionArgs || (defaultPrimaryAction ? defaultPrimaryAction.toolArgs : {});

      const actionBtnHtml = toolToCall
        ? `<button type="button" class="touch-target alexa-pill-btn" data-mcp-tool="${escapeHtml(toolToCall)}" data-mcp-args="${escapeHtml(JSON.stringify(toolArgs || {}))}">${escapeHtml(toolLabel)}</button>`
        : `<span class="status-pill">${escapeHtml(row.status || "VERIFIED")}</span>`;

      return `
        <article class="echo-visual-card" data-row-id="${escapeHtml(row.id || String(idx))}">
          <div class="echo-card-hero">
            ${renderCardArtworkSvg(row, idx)}
          </div>
          <div class="echo-card-body">
            <div class="echo-card-title" title="${escapeHtml(row.title || "")}">${escapeHtml(row.title || "")}</div>
            <div class="echo-card-subtitle">${escapeHtml(row.subtitle || "")}</div>
            <div class="echo-card-price-block">
              <div class="echo-price-primary">${escapeHtml(row.deltaLabel ?? "")}</div>
              <div class="echo-price-comparison">
                <span>${escapeHtml(row.originalLabel ?? "")}</span>
                <span class="echo-arrow">→</span>
                <span class="echo-fair-val">${escapeHtml(row.fairLabel ?? "")}</span>
              </div>
            </div>
            <div class="echo-card-cta">
              ${actionBtnHtml}
            </div>
          </div>
        </article>
      `;
    })
    .join("\n");

  const scrollDotsHtml = rows
    .slice(0, 8)
    .map(
      (_, i) =>
        `<span class="gq10-dot ${i === 0 ? "active" : ""}" aria-hidden="true"></span>`
    )
    .join("");

  const metricsHtml = metrics
    .slice(0, 4)
    .map(
      (m) => `
      <div class="metric-card" data-metric-label="${escapeHtml(m.label)}">
        <span class="metric-label">${escapeHtml(m.label)}</span>
        <strong class="metric-value ${m.tone === "danger" ? "tone-danger" : m.tone === "success" ? "tone-success" : ""}">${escapeHtml(String(m.value))}</strong>
      </div>`
    )
    .join("\n");

  const rowsHtml = rows
    .map((row, idx) => {
      const actionBtn = row.actionTool
        ? `<button type="button" class="touch-target action-btn row-action-btn" data-mcp-tool="${escapeHtml(row.actionTool)}" data-mcp-args="${escapeHtml(JSON.stringify(row.actionArgs || {}))}">${escapeHtml(row.actionLabel || "Apply")}</button>`
        : `<span class="status-pill">${escapeHtml(row.status || "VERIFIED")}</span>`;

      return `
      <tr class="audit-row" data-row-id="${escapeHtml(row.id || String(idx))}">
        <td>
          <div class="row-title">${escapeHtml(row.title || "")}</div>
          <div class="row-subtitle">${escapeHtml(row.subtitle || "")}</div>
        </td>
        <td class="num-col">${escapeHtml(row.originalLabel ?? "")}</td>
        <td class="num-col">${escapeHtml(row.fairLabel ?? "")}</td>
        <td class="num-col delta-col">${escapeHtml(row.deltaLabel ?? "")}</td>
        <td>
          <div class="citation-tag">${escapeHtml(row.citation || "Statutory Rule")}</div>
        </td>
        <td class="action-col">${actionBtn}</td>
      </tr>`;
    })
    .join("\n");

  const actionsHtml = actions
    .map(
      (act, idx) => `
      <button
        type="button"
        class="touch-target action-btn ${act.primary ? "primary-btn" : "secondary-btn"}"
        data-action-id="${escapeHtml(act.id || String(idx))}"
        data-mcp-tool="${escapeHtml(act.toolName || "")}"
        data-mcp-args="${escapeHtml(JSON.stringify(act.toolArgs || {}))}"
      >
        ${escapeHtml(act.label)}
      </button>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en" data-alexa-widget-uri="${escapeHtml(uri)}" data-display-mode="${escapeHtml(initialMode)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg-primary: ${theme.bgPrimary};
      --bg-card: ${theme.bgCard};
      --text-primary: ${theme.textPrimary};
      --text-secondary: ${theme.textSecondary};
      --accent-bg: ${theme.accentBg};
      --accent-text: ${theme.accentText};
      --danger-bg: ${theme.dangerBg};
      --danger-text: ${theme.dangerText};
      --success-bg: ${theme.successBg};
      --success-text: ${theme.successText};
      --min-touch: ${theme.minTouchPx}px;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 14px 18px 16px;
      font-family: "Amazon Ember", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 50% 0%, #163354 0%, var(--bg-primary) 72%);
      color: var(--text-primary);
      line-height: 1.4;
      min-height: 100vh;
    }
    .widget-shell {
      max-width: 1180px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    /* Official Echo Show Top Drag Handle */
    .echo-top-handle-wrap {
      display: flex;
      justify-content: center;
      padding-top: 2px;
    }
    .echo-top-handle {
      width: 42px;
      height: 5px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.32);
    }
    .widget-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }
    .title-group {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .header-meta-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      background: var(--accent-bg);
      color: var(--accent-text);
    }
    /* VR-04 Official Partner Attribution */
    .vr04-attribution {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.07);
      padding: 2px 9px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }
    h1 {
      margin: 0;
      font-size: 21px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text-primary);
    }
    .subtitle {
      margin: 0;
      font-size: 12.5px;
      color: var(--text-secondary);
    }
    .header-controls-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    /* Official 3 Circular Alexa+ Action Buttons from Screenshot */
    .echo-circle-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .echo-circle-btn {
      width: var(--min-touch);
      height: var(--min-touch);
      min-width: var(--min-touch);
      min-height: var(--min-touch);
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: var(--text-primary);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.12s ease;
    }
    .echo-circle-btn:hover {
      background: rgba(255, 255, 255, 0.2);
      transform: translateY(-1px);
    }
    .mode-switcher {
      display: flex;
      gap: 6px;
      background: rgba(10, 24, 40, 0.75);
      padding: 4px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.14);
    }
    .touch-target {
      min-height: var(--min-touch);
      min-width: var(--min-touch);
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      border: 1px solid transparent;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: transform 0.12s ease, opacity 0.12s ease, background 0.15s ease;
    }
    .touch-target:focus-visible {
      outline: 3px solid #38BDF8;
      outline-offset: 2px;
    }
    .mode-btn {
      background: transparent;
      color: var(--text-secondary);
      padding: 6px 12px;
    }
    .mode-btn.active {
      background: var(--accent-bg);
      color: var(--accent-text);
    }
    /* Rich Horizontal Visual Card Carousel (Matching Alexa+ Inspector Screenshot) */
    .echo-card-carousel {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(215px, 1fr));
      gap: 14px;
      align-items: stretch;
    }
    .echo-visual-card {
      background: linear-gradient(180deg, rgba(24, 52, 86, 0.95) 0%, var(--bg-card) 100%);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 16px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .echo-visual-card:hover {
      transform: translateY(-2px);
      border-color: rgba(96, 165, 250, 0.55);
    }
    .echo-card-hero {
      width: 100%;
      height: 104px;
      background: #0F172A;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      overflow: hidden;
    }
    .echo-card-body {
      padding: 12px 14px 14px;
      display: flex;
      flex-direction: column;
      flex: 1;
      gap: 6px;
    }
    .echo-card-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      min-height: 40px;
    }
    .echo-card-subtitle {
      font-size: 12px;
      color: var(--text-secondary);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      min-height: 33px;
    }
    .echo-card-price-block {
      margin-top: auto;
      padding-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .echo-price-primary {
      font-size: 19px;
      font-weight: 800;
      color: var(--text-primary);
      letter-spacing: -0.01em;
    }
    .echo-price-comparison {
      font-size: 11.5px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .echo-arrow {
      opacity: 0.7;
    }
    .echo-fair-val {
      font-weight: 700;
      color: #93C5FD;
    }
    .echo-card-cta {
      margin-top: 8px;
    }
    /* Official Alexa+ Royal Blue Pill Button */
    .alexa-pill-btn {
      width: 100%;
      border-radius: 999px;
      background: #1D4ED8;
      color: #FFFFFF;
      font-size: 13px;
      font-weight: 700;
      padding: 10px 16px;
      border: 1px solid rgba(147, 197, 253, 0.35);
      box-shadow: 0 4px 12px rgba(29, 78, 216, 0.35);
    }
    .alexa-pill-btn:hover {
      background: #2563EB;
    }
    /* GQ-10 Scroll Indicator Dots */
    .gq10-scroll-indicator {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      font-size: 11.5px;
      color: var(--text-secondary);
    }
    .gq10-dots {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .gq10-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.25);
    }
    .gq10-dot.active {
      width: 20px;
      border-radius: 999px;
      background: #60A5FA;
    }
    /* GQ-11 Sticky Summary Footer for Echo Show (small / show8) */
    .gq11-sticky-footer {
      position: sticky;
      bottom: 0;
      z-index: 10;
      background: rgba(12, 28, 48, 0.96);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 14px;
      padding: 10px 14px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.35);
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
      gap: 8px;
      flex: 1;
    }
    .metric-card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      padding: 7px 11px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .metric-label {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .metric-value {
      font-size: 17px;
      font-weight: 800;
      color: var(--text-primary);
    }
    .metric-value.tone-danger {
      background: var(--danger-bg);
      color: var(--danger-text);
      padding: 1px 8px;
      border-radius: 6px;
      align-self: flex-start;
    }
    .metric-value.tone-success {
      background: var(--success-bg);
      color: var(--success-text);
      padding: 1px 8px;
      border-radius: 6px;
      align-self: flex-start;
    }
    .mode-panel {
      display: none;
      flex-direction: column;
      gap: 12px;
    }
    html[data-display-mode="inline"] .mode-panel[data-mode-panel="inline"],
    html[data-display-mode="fullscreen"] .mode-panel[data-mode-panel="fullscreen"],
    html[data-display-mode="voice-only"] .mode-panel[data-mode-panel="voice-only"] {
      display: flex;
    }
    .table-card {
      background: var(--bg-card);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th, td {
      padding: 10px 13px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    th {
      font-size: 11.5px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.04);
    }
    .row-title {
      font-weight: 700;
      font-size: 14px;
      color: var(--text-primary);
    }
    .row-subtitle {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
    }
    .num-col {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
      white-space: nowrap;
    }
    .delta-col {
      font-weight: 800;
    }
    .citation-tag {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 11.5px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-secondary);
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: var(--success-bg);
      color: var(--success-text);
    }
    .actions-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .primary-btn {
      background: var(--accent-bg);
      color: var(--accent-text);
      border-radius: 999px;
      padding: 10px 18px;
      box-shadow: 0 4px 14px rgba(29, 78, 216, 0.4);
    }
    .secondary-btn, .row-action-btn {
      background: rgba(255, 255, 255, 0.12);
      color: var(--text-primary);
      border-color: rgba(255, 255, 255, 0.2);
      border-radius: 999px;
    }
    .voice-card {
      background: var(--bg-card);
      border: 2px solid var(--accent-bg);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .voice-Wave {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary);
    }
    .voice-script {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }
    .ssml-box {
      margin: 0;
      padding: 12px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.35);
      color: var(--text-secondary);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .rpc-status {
      font-size: 11.5px;
      color: var(--text-secondary);
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 2px;
    }
  </style>
</head>
<body>
  <main class="widget-shell">
    <div class="echo-top-handle-wrap" aria-hidden="true">
      <div class="echo-top-handle"></div>
    </div>

    <header class="widget-header">
      <div class="title-group">
        <div class="header-meta-row">
          <span class="badge">${escapeHtml(badge)}</span>
          <span class="vr04-attribution" data-vr04="partner-attribution">Powered by ${escapeHtml(partnerName)}</span>
        </div>
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
      </div>

      <div class="header-controls-right">
        <nav class="mode-switcher" aria-label="Alexa+ Display Mode Switcher">
          <button type="button" class="touch-target mode-btn ${initialMode === "inline" ? "active" : ""}" data-target-mode="inline">Inline</button>
          <button type="button" class="touch-target mode-btn ${initialMode === "fullscreen" ? "active" : ""}" data-target-mode="fullscreen">Fullscreen</button>
          <button type="button" class="touch-target mode-btn ${initialMode === "voice-only" ? "active" : ""}" data-target-mode="voice-only">Voice-Only</button>
        </nav>
        <div class="echo-circle-actions" aria-label="Alexa+ Surface Quick Actions">
          <button type="button" class="echo-circle-btn" id="echo-expand-btn" title="Toggle Fullscreen / Inline Surface" aria-label="Toggle Fullscreen Surface">↗</button>
          <button type="button" class="echo-circle-btn" id="echo-voice-btn" title="Switch to Voice-Only SSML" aria-label="Switch to Voice-Only SSML">🔊</button>
        </div>
      </div>
    </header>

    <!-- 1. INLINE MODE: Echo Show Visual Card Deck + GQ-10 Scroll Indicator + GQ-11 Sticky Footer -->
    <section class="mode-panel" data-mode-panel="inline" aria-label="Inline Display Mode">
      <div class="echo-card-carousel">
        ${visualCardsHtml}
      </div>
      <div class="gq10-scroll-indicator" data-gq10="scroll-indicator">
        <span>Showing ${rows.length} verified items • Tap any blue pill to execute via MCP</span>
        <div class="gq10-dots">${scrollDotsHtml}</div>
      </div>
      <footer class="gq11-sticky-footer" data-gq11="sticky-footer">
        <div class="metrics-grid">
          ${metricsHtml}
        </div>
        <div class="actions-bar">
          ${actionsHtml}
          <button type="button" class="touch-target secondary-btn" data-switch-fullscreen="true">
            Statutory Table (${rows.length})
          </button>
        </div>
      </footer>
    </section>

    <!-- 2. FULLSCREEN MODE: Visual Card Deck + Complete Statutory Redline Table -->
    <section class="mode-panel" data-mode-panel="fullscreen" aria-label="Fullscreen Display Mode">
      <div class="echo-card-carousel">
        ${visualCardsHtml}
      </div>
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Line Item / Scope</th>
              <th>Current / Billed</th>
              <th>Benchmark / Optimal</th>
              <th>Recoverable / Savings</th>
              <th>Statutory Basis</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
      <footer class="gq11-sticky-footer" data-gq11="sticky-footer">
        <div class="metrics-grid">
          ${metricsHtml}
        </div>
        <div class="actions-bar">
          ${actionsHtml}
        </div>
      </footer>
    </section>

    <!-- 3. VOICE-ONLY MODE: Spoken response & SSML prosody preview for headless Echo devices -->
    <section class="mode-panel" data-mode-panel="voice-only" aria-label="Voice-Only Display Mode">
      <div class="voice-card">
        <span class="voice-Wave">Alexa+ Spoken Response (Voice-Only Fallback)</span>
        <p class="voice-script" id="voice-summary-text">${escapeHtml(voiceSummary)}</p>
        <pre class="ssml-box" id="voice-ssml-code">${escapeHtml(safeSsml)}</pre>
      </div>
    </section>

    <footer class="rpc-status">
      <span id="bridge-status">MCP App Bridge: Ready (${escapeHtml(uri)})</span>
      <span>WCAG AA Contrast: ${audit.minContrastRatio}:1 | Touch >= ${theme.minTouchPx}px</span>
    </footer>
  </main>

  <script>
    (function () {
      const htmlEl = document.documentElement;
      const statusEl = document.getElementById("bridge-status");
      const modeButtons = document.querySelectorAll(".mode-btn");

      function setDisplayMode(mode) {
        if (!["inline", "fullscreen", "voice-only"].includes(mode)) return;
        htmlEl.setAttribute("data-display-mode", mode);
        modeButtons.forEach((btn) => {
          btn.classList.toggle("active", btn.getAttribute("data-target-mode") === mode);
        });
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            jsonrpc: "2.0",
            method: "ui/displayModeChanged",
            params: { displayMode: mode, uri: htmlEl.getAttribute("data-alexa-widget-uri") }
          }, "*");
        }
      }

      modeButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          setDisplayMode(btn.getAttribute("data-target-mode"));
        });
      });

      document.querySelectorAll("[data-switch-fullscreen]").forEach((btn) => {
        btn.addEventListener("click", () => setDisplayMode("fullscreen"));
      });

      const expandBtn = document.getElementById("echo-expand-btn");
      if (expandBtn) {
        expandBtn.addEventListener("click", () => {
          const cur = htmlEl.getAttribute("data-display-mode");
          setDisplayMode(cur === "fullscreen" ? "inline" : "fullscreen");
        });
      }

      const voiceBtn = document.getElementById("echo-voice-btn");
      if (voiceBtn) {
        voiceBtn.addEventListener("click", () => {
          const cur = htmlEl.getAttribute("data-display-mode");
          setDisplayMode(cur === "voice-only" ? "inline" : "voice-only");
        });
      }

      function callMcpTool(toolName, args) {
        if (!toolName) return;
        const reqId = "ui-call-" + Date.now();
        if (statusEl) {
          statusEl.textContent = "Invoking MCP tool: " + toolName + "...";
        }
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            jsonrpc: "2.0",
            id: reqId,
            method: "tools/call",
            params: { name: toolName, arguments: args || {} }
          }, "*");
        }
      }

      document.querySelectorAll("[data-mcp-tool]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const toolName = btn.getAttribute("data-mcp-tool");
          if (!toolName) return;
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(btn.getAttribute("data-mcp-args") || "{}");
          } catch {}
          callMcpTool(toolName, parsedArgs);
        });
      });

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.method === "ui/setDisplayMode" && msg.params && msg.params.displayMode) {
          setDisplayMode(msg.params.displayMode);
        }
        if (msg.method === "ui/toolResult" && statusEl) {
          statusEl.textContent = "MCP Tool Completed: " + (msg.params?.toolName || "ok");
        }
      });

      window.AlexaMcpBridge = {
        setDisplayMode,
        callTool: callMcpTool
      };

      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: "ui/initialize",
          params: {
            uri: htmlEl.getAttribute("data-alexa-widget-uri"),
            displayMode: htmlEl.getAttribute("data-display-mode")
          }
        }, "*");
      }
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
