import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

interface ProviderLogoProps {
  providerID?: string;
  providerName?: string;
  className?: string;
}

const source = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

function providerLogoClassNames(): string[] {
  const classes = new Set(["provider-logo"]);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.name.endsWith(".tsx")) continue;
      const contents = readFileSync(path, "utf8");
      for (const match of contents.matchAll(/<ProviderLogo\b[\s\S]*?\/>/g)) {
        const tag = match[0];
        const className = /\bclassName="([^"]+)"/.exec(tag)?.[1];
        if (tag.includes("className=")) {
          assert.ok(className, `ProviderLogo className is a static CSS class list in ${path}`);
        }
        for (const item of className?.split(/\s+/) ?? []) classes.add(item);
      }
    }
  };
  visit(resolve(import.meta.dirname, "../src"));
  return [...classes].sort();
}

const component = build({
  entryPoints: [resolve(import.meta.dirname, "../src/components/ProviderLogo.tsx")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
}).then(async (result) => {
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`;
  const loaded = await import(url) as { default: ComponentType<ProviderLogoProps> };
  return loaded.default;
});

async function render(props: ProviderLogoProps): Promise<string> {
  const ProviderLogo = await component;
  return renderToStaticMarkup(createElement(ProviderLogo, props));
}

test("known providers render decorative monochrome SVG marks", async () => {
  const providers = [
    "claude",
    "anthropic",
    "openai",
    "google",
    "gemini",
    "github",
    "copilot",
    "xai",
    "groq",
    "mistral",
    "openrouter",
    "vertex",
    "llama",
    "meta",
    "amazon-bedrock",
    "azure",
    "together",
    "fireworks",
    "deepseek",
    "ollama",
    "nvidia",
    "huggingface",
    "cohere",
    "cerebras",
    "kimi-for-coding",
    "codex",
    "command-code",
  ];

  for (const providerID of providers) {
    const html = await render({ providerID });
    assert.match(html, /aria-hidden="true"/, `${providerID} is hidden beside visible provider text`);
    assert.doesNotMatch(html, /role="img"/, `${providerID} does not duplicate the adjacent name`);
    assert.doesNotMatch(html, /aria-label=/, `${providerID} does not duplicate the adjacent name`);
    assert.match(html, /<svg\b/, `${providerID} renders an SVG`);
    assert.match(html, /(?:fill|stroke)="currentColor"/, `${providerID} inherits the theme color`);
    assert.doesNotMatch(html, /#[\da-f]{3,8}\b/i, `${providerID} does not render a palette color`);
    assert.doesNotMatch(html, /data-provider="other"/, `${providerID} resolves to a known mark`);
  }

  const namedAlias = await render({ providerID: "private-endpoint", providerName: "Claude Enterprise" });
  assert.match(namedAlias, /data-provider="claude"/);

  const kimiEndpoint = await render({ providerID: "kimi-for-coding" });
  assert.match(kimiEndpoint, /data-provider="zai"/);
});

test("OpenCode variants use the OpenCode brand mark", async () => {
  const variants: Array<{ props: ProviderLogoProps; provider: string }> = [
    { props: { providerID: "opencode-zen" }, provider: "opencode-zen" },
    { props: { providerID: "private-endpoint", providerName: "OpenCode Zen" }, provider: "opencode-zen" },
    { props: { providerID: "opencode", providerName: "Zen" }, provider: "opencode-zen" },
    { props: { providerID: "opencode-go" }, provider: "opencode-go" },
    { props: { providerID: "private-endpoint", providerName: "OpenCode Go" }, provider: "opencode-go" },
    { props: { providerID: "opencode" }, provider: "opencode" },
  ];

  for (const { props, provider } of variants) {
    const html = await render(props);
    assert.match(html, new RegExp(`data-provider="${provider}"`));
    assert.match(html, /<svg\b/);
    assert.match(html, /fill="currentColor"/);
    assert.doesNotMatch(html, /#[\da-f]{3,8}\b/i);
  }

  const unrelatedZen = await render({ providerName: "Zen Browser" });
  assert.match(unrelatedZen, /data-provider="other"/);
});

test("unknown providers retain a short theme-colored fallback", async () => {
  const html = await render({ providerID: "zeta-x", providerName: "Zeta" });
  assert.match(html, /data-provider="other"/);
  assert.match(html, /class="provider-logo-fallback">ZE<\/span>/);
  assert.doesNotMatch(html, /<svg\b/);
});

test("provider surfaces use ProviderLogo without brand palette rules", () => {
  const logo = source("../src/components/ProviderLogo.tsx");
  const css = source("../src/styles.css");
  const models = source("../src/components/settings/ModelsPage.tsx");
  const picker = source("../src/components/ModelPicker.tsx");
  const usage = source("../src/usage/UsageDashboard.tsx");
  const quota = source("../src/usage/quotaUi.tsx");
  const projectUsage = source("../src/usage/projectUi.tsx");
  const usageWidget = source("../src/widgets/usagePlugin.tsx");
  const fusion = source("../src/components/FusionView.tsx");

  assert.doesNotMatch(logo, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(
    css,
    /\.provider-(?:anthropic|claude|openai|google|gemini|github|copilot)\s*[,{}]/,
  );
  for (const brandHex of ["#d97757", "#101820", "#eaf1ff", "#315acb", "#24292f"]) {
    assert.ok(!css.toLowerCase().includes(brandHex), `${brandHex} brand rule is removed`);
  }
  assert.match(css, /\.provider-logo > svg\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%/s);
  const expectedLogoClasses = [
    "agent-reply-mark",
    "model-chip-provider-logo",
    "model-provider-logo",
    "model-trigger-logo",
    "provider-logo",
    "provider-share-logo",
    "quota-provider-logo",
    "run-provider-logo",
    "set-provider-logo",
    "usage-legend-logo",
    "usage-model-logo",
    "usage-provider-mark",
    "usage-provider-mark-large",
    "usage-provider-mark-regular",
  ].sort();
  const bareLogoClasses = providerLogoClassNames();
  assert.deepEqual(bareLogoClasses, expectedLogoClasses, "every ProviderLogo CSS class is audited");
  const chromeProperty = /(?:^|;)\s*(?:border(?:-[\w-]+)?|background(?:-[\w-]+)?|box-shadow|padding(?:-[\w-]+)?)\s*:/m;
  for (const className of bareLogoClasses) {
    const rules = [...css.matchAll(new RegExp(
      `[^{}]*\\.${className}(?![\\w-])[^{}]*\\{([^}]*)\\}`,
      "g",
    ))];
    assert.ok(rules.length > 0, `.${className} has a CSS rule`);
    for (const rule of rules) {
      assert.doesNotMatch(rule[1] ?? "", chromeProperty, `.${className} has no badge chrome`);
    }
  }
  assert.doesNotMatch(css, /\.prov-logo(?![\w-])/, "unused boxed legacy logo rule is removed");
  assert.doesNotMatch(models, /providerColor|set-model-dot/);
  for (const [name, contents] of Object.entries({
    models,
    picker,
    usage,
    quota,
    projectUsage,
    usageWidget,
    fusion,
  })) {
    assert.match(contents, /<ProviderLogo/, `${name} renders provider logos`);
  }
});
