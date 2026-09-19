export const PLAYGROUND_ARTIFACT_PATH = ".polyth/playground/index.html";
export const PLAYGROUND_CHANNEL = "polyth-playground-v1";

export type PlaygroundViewport = "responsive" | "desktop" | "tablet" | "mobile";

export interface PlaygroundSelection {
  selector: string;
  tag: string;
  text: string;
}

export function playgroundBootstrapPrompt(hasArtifact: boolean): string {
  return [
    "Internal Polyth Playground session instruction. Do not acknowledge or answer this initialization message in prose, and do not take any action for this message alone.",
    "",
    "When the user asks about the current design, UI, page, prototype, component, interaction, layout, styling, or visual result while Playground is active, implement the request directly in " + PLAYGROUND_ARTIFACT_PATH + " instead of only describing it.",
    hasArtifact
      ? "The canonical Playground artifact already exists. Read it before editing and preserve working behavior unless the user asks to replace it."
      : "The canonical Playground artifact does not exist yet. Create it on the first relevant user request.",
    "Keep the artifact a self-contained interactive HTML document by default: semantic HTML, inline CSS, and inline JavaScript. External HTTPS images, fonts, or libraries are optional and only render when the user enables Playground network access.",
    "Make it responsive from narrow phone widths through desktop, keyboard accessible, and visually complete. Prefer real interactions and realistic content over static mock placeholders.",
    "Never read credentials, call Polyth APIs, access private/local network services, or edit unrelated project files unless the user explicitly asks.",
    "For clearly unrelated requests, behave normally and do not force them into Playground.",
    "After relevant requests, edit the artifact first. Keep any textual summary brief because the user can see the live result beside chat.",
  ].join("\n");
}

export function playgroundSelectionPrompt(selection: PlaygroundSelection): string {
  const text = selection.text.trim().replace(/\s+/g, " ").slice(0, 240);
  return [
    "[Playground selection]",
    "Artifact: " + PLAYGROUND_ARTIFACT_PATH,
    "Element: " + selection.selector,
    "Tag: " + selection.tag,
    ...(text ? ["Visible text: " + JSON.stringify(text)] : []),
    "",
    "Update this selected element: ",
  ].join("\n");
}

export function newPlaygroundOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "playground-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function bridgeMarkup(): string {
  const css = [
    "html[data-polyth-playground-inspect=\"true\"] * { cursor: crosshair !important; }",
    "[data-polyth-playground-hover=\"true\"] { outline: 2px solid #7c6cff !important; outline-offset: 2px !important; }",
  ].join("");
  const js = [
    "(() => {",
    "  const CHANNEL = " + JSON.stringify(PLAYGROUND_CHANNEL) + ";",
    "  let inspect = false;",
    "  let hovered = null;",
    "  const clean = (value) => String(value || \"\").replace(/[^a-zA-Z0-9_-]/g, (c) => \"\\\\\" + c);",
    "  const selectorFor = (node) => {",
    "    if (!(node instanceof Element)) return \"unknown\";",
    "    if (node.id) return \"#\" + clean(node.id);",
    "    const testId = node.getAttribute(\"data-testid\");",
    "    if (testId) return \"[data-testid=\\\"\" + String(testId).replace(/\\\"/g, \"\\\\\\\"\") + \"\\\"]\";",
    "    const parts = [];",
    "    let current = node;",
    "    while (current && current !== document.documentElement && parts.length < 6) {",
    "      let part = current.tagName.toLowerCase();",
    "      const classes = Array.from(current.classList).filter((name) => !name.startsWith(\"__polyth\")).slice(0, 2);",
    "      if (classes.length) part += \".\" + classes.map(clean).join(\".\");",
    "      const parent = current.parentElement;",
    "      if (parent) {",
    "        const peers = Array.from(parent.children).filter((child) => child.tagName === current.tagName);",
    "        if (peers.length > 1) part += \":nth-of-type(\" + (peers.indexOf(current) + 1) + \")\";",
    "      }",
    "      parts.unshift(part);",
    "      current = parent;",
    "    }",
    "    return parts.join(\" > \");",
    "  };",
    "  const clearHover = () => {",
    "    if (hovered instanceof Element) hovered.removeAttribute(\"data-polyth-playground-hover\");",
    "    hovered = null;",
    "  };",
    "  window.addEventListener(\"message\", (event) => {",
    "    const data = event.data;",
    "    if (!data || data.channel !== CHANNEL || data.kind !== \"inspect\") return;",
    "    inspect = data.enabled === true;",
    "    document.documentElement.setAttribute(\"data-polyth-playground-inspect\", inspect ? \"true\" : \"false\");",
    "    if (!inspect) clearHover();",
    "  });",
    "  document.addEventListener(\"pointerover\", (event) => {",
    "    if (!inspect || !(event.target instanceof Element)) return;",
    "    if (hovered === event.target) return;",
    "    clearHover();",
    "    hovered = event.target;",
    "    hovered.setAttribute(\"data-polyth-playground-hover\", \"true\");",
    "  }, true);",
    "  document.addEventListener(\"click\", (event) => {",
    "    if (!inspect || !(event.target instanceof Element)) return;",
    "    event.preventDefault();",
    "    event.stopPropagation();",
    "    const target = event.target;",
    "    parent.postMessage({",
    "      channel: CHANNEL,",
    "      kind: \"selected\",",
    "      selector: selectorFor(target),",
    "      tag: target.tagName.toLowerCase(),",
    "      text: (target.innerText || target.textContent || \"\").trim().slice(0, 240),",
    "    }, \"*\");",
    "  }, true);",
    "  parent.postMessage({ channel: CHANNEL, kind: \"ready\" }, \"*\");",
    "})();",
  ].join("\n");
  return "<meta name=\"referrer\" content=\"no-referrer\"><style>" + css + "</style><script>" + js + "</script>";
}

export function sandboxPreviewDocument(html: string, networkEnabled = false): string {
  const remote = networkEnabled ? " https:" : "";
  const connect = networkEnabled ? "https:" : "'none'";
  const policy = [
    "default-src 'none'",
    "img-src data: blob:" + remote,
    "media-src data: blob:" + remote,
    "font-src data:" + remote,
    "style-src 'unsafe-inline'" + remote,
    "script-src 'unsafe-inline' 'unsafe-eval'" + remote,
    "connect-src " + connect,
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const injection = "<meta http-equiv=\"Content-Security-Policy\" content=\"" + policy + "\">" + bridgeMarkup();
  const source = html.trim();
  if (!source) {
    return "<!doctype html><html><head>" + injection + "</head><body></body></html>";
  }
  if (/<head(?:\s[^>]*)?>/i.test(source)) {
    return source.replace(/<head(\s[^>]*)?>/i, (match) => match + injection);
  }
  if (/<html(?:\s[^>]*)?>/i.test(source)) {
    return source.replace(/<html(\s[^>]*)?>/i, (match) => match + "<head>" + injection + "</head>");
  }
  return "<!doctype html><html><head>" + injection + "</head><body>" + source + "</body></html>";
}
