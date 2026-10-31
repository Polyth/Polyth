import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readWebStylesSync } from "./webStyles.ts";

interface ProviderLogoProps {
  providerID?: string;
  providerName?: string;
  harnessId?: string;
  size?: "compact" | "regular";
  className?: string;
  tint?: string;
}

const source = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

// Discover provider-logo surfaces instead of naming removable packages.
const packagesDir = resolve(import.meta.dirname, "../../../packages");
const packageWidgetDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")))
  .map((entry) => join(packagesDir, entry.name, "widgets"))
  .filter((dir) => existsSync(dir));

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
  for (const directory of [
    resolve(import.meta.dirname, "../src"),
    ...packageWidgetDirs,
  ]) {
    visit(directory);
  }
  return [...classes].sort();
}

const providerModule = build({
  entryPoints: [resolve(import.meta.dirname, "../../../packages/models/widgets/ProviderLogo.tsx")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
  // ProviderLogo ships its own stylesheet; markup is what these cases render.
  loader: { ".css": "empty" },
}).then(async (result) => {
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`;
  return await import(url) as {
    default: ComponentType<ProviderLogoProps>;
    isProviderMarkKey: (value: string | undefined) => boolean;
  };
});

async function render(props: ProviderLogoProps): Promise<string> {
  const ProviderLogo = (await providerModule).default;
  return renderToStaticMarkup(createElement(ProviderLogo, props));
}

test("known providers render decorative SVG marks", async () => {
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
    "cursor",
    "antigravity",
    "pi",
  ];

  for (const providerID of providers) {
    const html = await render({ providerID });
    assert.match(html, /aria-hidden="true"/, `${providerID} is hidden beside visible provider text`);
    assert.doesNotMatch(html, /role="img"/, `${providerID} does not duplicate the adjacent name`);
    assert.doesNotMatch(html, /aria-label=/, `${providerID} does not duplicate the adjacent name`);
    assert.match(html, /<svg\b/, `${providerID} renders an SVG`);
    assert.doesNotMatch(html, /data-provider="other"/, `${providerID} resolves to a known mark`);
    assert.match(html, /(?:fill|stroke)="currentColor"/, `${providerID} inherits the theme color`);
    assert.doesNotMatch(html, /#[\da-f]{3,8}\b/i, `${providerID} does not render a palette color`);
  }

  const namedAlias = await render({ providerID: "private-endpoint", providerName: "Claude Enterprise" });
  assert.match(namedAlias, /data-provider="claude"/);

  const kimiEndpoint = await render({ providerID: "kimi-for-coding" });
  assert.match(kimiEndpoint, /data-provider="zai"/);
});

test("Command Code uses the shared monochrome transparent logo treatment", async () => {
  const html = await render({ providerID: "command-code", providerName: "Command Code" });
  assert.match(html, /data-provider="commandcode"/);
  assert.match(html, /viewBox="20 20 96 96"/);
  assert.match(html, /fill="currentColor"/);
  assert.match(html, /m93\.6604 26\.1784/);
  assert.doesNotMatch(html, /m0 66\.7959c0-31\.4879/);
  assert.doesNotMatch(html, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(html, /M8\.128 14\.099/);

  const harnessModel = await render({
    providerID: "moonshotai",
    providerName: "Moonshot AI",
    harnessId: "commandcode",
  });
  assert.match(harnessModel, /data-provider="commandcode"/);
  assert.match(harnessModel, /fill="currentColor"/);
  assert.doesNotMatch(harnessModel, /#[\da-f]{3,8}\b/i);
});

test("registered harness identities reuse the shared provider marks", async () => {
  const harnesses = [
    { providerID: "claude", providerName: "Claude Code", provider: "claude" },
    { providerID: "opencode", providerName: "OpenCode", provider: "opencode" },
    { providerID: "codex", providerName: "Codex", provider: "openai" },
    { providerID: "commandcode", providerName: "Command Code", provider: "commandcode" },
    { providerID: "cursor", providerName: "Cursor", provider: "cursor" },
    { providerID: "antigravity", providerName: "Antigravity", provider: "antigravity" },
    { providerID: "pi", providerName: "Pi", provider: "pi" },
  ];
  for (const { provider, ...props } of harnesses) {
    const html = await render(props);
    assert.match(html, new RegExp(`data-provider="${provider}"`));
    assert.match(html, /<svg\b/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /(?:fill|stroke)="currentColor"/);
    assert.doesNotMatch(html, /#[\da-f]{3,8}\b/i);
  }
  const cursorMark = await render({ providerID: "cursor", providerName: "Cursor" });
  assert.match(cursorMark, /M11\.503\.131/);
  assert.doesNotMatch(cursorMark, /M4 5\.5 12 12 4 18\.5/);
});

test("brand harness models keep the harness mark beside provider identity", async () => {
  const spark = /M4\.709 15\.955/;
  const letterA = /M3\.7 19 10 4\.8/;

  const anthropicOnly = await render({
    providerID: "anthropic",
    providerName: "Anthropic",
  });
  assert.match(anthropicOnly, /data-provider="anthropic"/);
  assert.match(anthropicOnly, spark);
  assert.doesNotMatch(anthropicOnly, letterA);

  const claudeModel = await render({
    providerID: "anthropic",
    providerName: "Anthropic",
    harnessId: "claude",
  });
  assert.match(claudeModel, /data-provider="claude"/);
  assert.match(claudeModel, spark);
  assert.doesNotMatch(claudeModel, /data-provider="anthropic"/);

  const acpModel = await render({
    providerID: "anthropic",
    providerName: "Anthropic",
    harnessId: "cursor",
  });
  assert.match(acpModel, /data-provider="cursor"/);
  assert.match(acpModel, /M11\.503\.131/);

  const routedAnthropic = await render({
    providerID: "anthropic",
    providerName: "Anthropic",
    harnessId: "opencode",
  });
  assert.match(routedAnthropic, /data-provider="anthropic"/);
  assert.match(routedAnthropic, spark);
  assert.doesNotMatch(routedAnthropic, /data-provider="opencode"/);
  assert.doesNotMatch(routedAnthropic, letterA);

  const routedNamedClaude = await render({
    providerID: "anthropic",
    providerName: "Claude 4 Sonnet",
    harnessId: "opencode",
  });
  assert.match(routedNamedClaude, /data-provider="claude"/);
  assert.match(routedNamedClaude, spark);
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

test("Antigravity keeps its own distinct brand mark", async () => {
  const html = await render({ providerID: "antigravity", providerName: "Antigravity", harnessId: "antigravity" });
  assert.match(html, /data-provider="antigravity"/);
  assert.match(html, /provider-antigravity/);
  assert.match(html, /<svg\b/);
  assert.match(html, /fill="currentColor"/);
  assert.match(html, /M21\.751 22\.607c1\.34/);
  assert.doesNotMatch(html, /#(?:[\da-f]{3,8})\b/i);

  const gemini = await render({ providerID: "gemini", providerName: "Gemini" });
  assert.match(gemini, /data-provider="gemini"/);
  assert.match(gemini, /M12 2\.8c\.65 5\.15/);
  assert.doesNotMatch(gemini, /M21\.751 22\.607/);
});

test("DeepSeek uses the official whale mark", async () => {
  const html = await render({ providerID: "deepseek", providerName: "DeepSeek", harnessId: "deepseek" });
  assert.match(html, /data-provider="deepseek"/);
  assert.match(html, /viewBox="0 0 24 24"/);
  assert.match(html, /fill="currentColor"/);
  assert.match(html, /M23\.748 4\.651/);
  assert.doesNotMatch(html, /M3 14\.2c3\.2/);
  assert.doesNotMatch(html, /#(?:[\da-f]{3,8})\b/i);
});

test("Pi harness keeps its own monochrome brand mark", async () => {
  const html = await render({ providerID: "pi", providerName: "Pi", harnessId: "pi" });
  assert.match(html, /data-provider="pi"/);
  assert.match(html, /provider-pi/);
  assert.match(html, /viewBox="0 0 800 800"/);
  assert.match(html, /M165\.29 165\.29H517\.36V400/);
  assert.match(html, /M517\.36 400H634\.72/);
  assert.match(html, /fill="currentColor"/);
  assert.doesNotMatch(html, /#(?:[\da-f]{3,8})\b/i);

  // The two-letter key is a full token, never a substring of another name.
  const spicy = await render({ providerName: "Spicy AI" });
  assert.match(spicy, /data-provider="other"/);
  const bare = await render({ providerName: "Pi" });
  assert.match(bare, /data-provider="pi"/);
});

test("only canonical provider keys are brand marks for package tiles", async () => {
  const { isProviderMarkKey } = await providerModule;
  for (const key of ["cursor", "antigravity", "pi", "opencode", "claude", "commandcode", "gemini"]) {
    assert.equal(isProviderMarkKey(key), true, `${key} is a canonical brand key`);
  }
  // Aliases and semantic package icons must not be mistaken for brand keys.
  for (const value of ["github", "google", "codex", "files", "pointer", "sparkles", "", undefined]) {
    assert.equal(isProviderMarkKey(value), false, `${String(value)} is not a canonical brand key`);
  }
});

test("unknown providers retain a short theme-colored fallback", async () => {
  const html = await render({ providerID: "zeta-x", providerName: "Zeta" });
  assert.match(html, /data-provider="other"/);
  assert.match(html, /class="provider-logo-fallback">ZE<\/span>/);
  assert.doesNotMatch(html, /<svg\b/);
});

test("provider logos own compact and regular bounding boxes", async () => {
  assert.match(await render({ providerID: "openai", size: "compact" }), /provider-logo--compact/);
  assert.match(await render({ providerID: "openai" }), /provider-logo--regular/);
  const css = readWebStylesSync();
  assert.match(css, /\.provider-logo--compact\s*\{[^}]*width:\s*var\(--icon-sm\);[^}]*height:\s*var\(--icon-sm\)/s);
  assert.match(css, /\.provider-logo--regular\s*\{[^}]*width:\s*var\(--icon-md\);[^}]*height:\s*var\(--icon-md\)/s);
});

test("provider surfaces use ProviderLogo without accidental brand palette rules", () => {
  const logo = source("../../../packages/models/widgets/ProviderLogo.tsx");
  const css = [readWebStylesSync(), source("../src/components/ChatChrome.css")].join("\n");
  const models = source("../../../packages/models/widgets/ModelsPage.tsx");
  const picker = source("../../../packages/models/widgets/ModelPicker.tsx");
  const harnesses = [
    source("../../../packages/harness-runtime/widgets/runtime.tsx"),
    source("../../../packages/harness-runtime/widgets/HarnessSettingsPage.tsx"),
  ].join("\n");

  const logoHexes = [...new Set([...logo.matchAll(/#[\da-f]{3,8}\b/gi)].map((match) => match[0]!.toLowerCase()))].sort();
  assert.deepEqual(logoHexes, [], "provider marks inherit Polyth's theme color instead of shipping fixed palettes");
  assert.doesNotMatch(
    css,
    /\.provider-(?:anthropic|claude|openai|google|gemini|github|copilot|commandcode)\s*[,{}]/,
  );
  for (const brandHex of ["#d97757", "#101820", "#eaf1ff", "#315acb", "#24292f"]) {
    assert.ok(!css.toLowerCase().includes(brandHex), `${brandHex} brand rule is removed`);
  }
  assert.match(css, /\.provider-logo > svg\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%/s);
  const bareLogoClasses = providerLogoClassNames();
  // The framework packages and the shell ship in every build, so this audit is
  // never vacuous when the removable packages are absent.
  for (const className of [
    "provider-logo",
    "model-provider-logo",
    "model-row-provider-logo",
    "model-trigger-logo",
    "chat-response-logo",
    "set-provider-logo",
  ]) {
    assert.ok(bareLogoClasses.includes(className), `${className} is discovered and audited`);
  }
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
    harnesses,
  })) {
    assert.match(contents, /<ProviderLogo/, `${name} renders provider logos`);
  }
  assert.match(harnesses, /providerID=\{row\.identity\.id\}/);
  assert.match(harnesses, /providerID=\{detail\.identity\.id\}/);
  // A Space may retitle a harness; its logo still resolves from the original name.
  assert.match(harnesses, /providerName=\{row\.identity\.defaultName \?\? row\.identity\.name\}/);
  assert.match(picker, /harnessId=\{model\.harnessId\}/);
  assert.match(picker, /harnessId=\{triggerModel\.harnessId\}/);
  assert.match(picker, /harnessId=\{unanimousHarnessId\(provider\.models\)\}/);
});

test("a harness profile's color tints the mark wherever the composer shows it", async () => {
  const tinted = await render({ providerID: "claude", harnessId: "claude-work", tint: "#7253e8" });
  assert.match(tinted, /data-tinted="true"/);
  assert.match(tinted, /style="--provider-logo-tint:#7253e8"/);
  const plain = await render({ providerID: "claude" });
  assert.doesNotMatch(plain, /data-tinted|style=/, "no profile color keeps the theme color");
  assert.match(readWebStylesSync(), /\.provider-logo\[data-tinted\]\s*\{\s*color:\s*var\(--provider-logo-tint\);/);
  // The model chip and the agent's live and idle status lines.
  assert.match(source("../../../packages/models/widgets/ModelPicker.tsx"), /tint=\{harnessColors\?\.get\(triggerModel\.harnessId \?\? harnessId/);
  assert.match(source("../src/components/Composer.tsx"), /harnessColors=\{harnessColors\}/);
  assert.match(source("../src/components/AgentLiveStatusDock.tsx"), /tint=\{tint\}/);
  assert.match(source("../src/components/SubagentActivityDock.tsx"), /tint=\{profileId \? branch\.harnessColors\.get\(profileId\) : undefined\}/);
});

test("an account harness keeps its family mark whatever the account is called", async () => {
  // `<family>-<account>` ids carry user text; it must never select the mark.
  assert.match(await render({ providerID: "pi-work", providerName: "Pi · Work" }), /data-provider="pi"/);
  assert.match(await render({ providerID: "pi-work" }), /data-provider="pi"/);
  assert.match(await render({ providerID: "codex-cursor-team", providerName: "Codex · Cursor team" }), /data-provider="openai"/);
  assert.match(await render({ providerID: "claude-openai", providerName: "Claude Code · OpenAI" }), /data-provider="claude"/);
  assert.match(await render({ providerID: "grok-claude" }), /data-provider="xai"/);
  assert.match(await render({ providerID: "x", harnessId: "antigravity-pi" }), /data-provider="antigravity"/);
  // Provider ids that merely contain a hyphen are untouched.
  assert.match(await render({ providerID: "amazon-bedrock" }), /data-provider="bedrock"/);
  assert.match(await render({ providerID: "opencode-go" }), /data-provider="opencode-go"/);
});
