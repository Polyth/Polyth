#!/usr/bin/env node
/** Read-only, dependency-free navigation and evidence checks. Never executes repository scripts. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';

const MAX_FILE = 2 * 1024 * 1024;
const MAX_GIT = 12 * 1024 * 1024;
const MAX_BUNDLE = 40000;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{40}$/;
const MAP = 'docs/agents/task-map.json';
const EVIDENCE = 'docs/agents/evidence.json';
const ROOT_DOCS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CONTRIBUTING_AGENT_OVERVIEW.md'];
const EXTRA_DOCS = ['docs/dev/README.md', '.github/copilot-instructions.md', '.opencode/skill/polyth-control/SKILL.md'];
const KIT_DIRS = ['docs/agents', '.agents/skills', '.claude/skills', '.cursor/rules', '.cursor/agents'];
const HELP = `Polyth agent knowledge (read-only)
  map [--json]
  context <area> [--json]
  context --path <repo-relative-path> [--json]
  doctor [area] [--strict] [--json]
  inventory [--package <workspace-name-or-path>] [--json]
  impact --base <git-ref> [--json]
  check [--kit-only] [--json]
  bundle <area>
No installation, network, live operations, git mutation or script execution.
Source hashes are drift hints, not verification. inventory/impact require Git.
`;

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || isAbsolute(value)
      || /:/.test(value) || /[\\\0\r\n]/.test(value)
      || value.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) {
    throw new Error('Expected a safe repository-relative path without traversal or symlink indirection');
  }
  return value;
}

export function safePath(root, value, allowMissing = false) {
  relativePath(value);
  let current = root;
  const parts = value.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return join(root, ...parts);
      throw new Error(`Missing or unreadable path: ${value}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not followed: ${value}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory in path: ${value}`);
  }
  return current;
}

function bytes(root, path) {
  const file = safePath(root, path);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error(`Not a bounded regular file: ${path}`);
  return readFileSync(file);
}
const text = (root, path) => bytes(root, path).toString('utf8');
function json(root, path) {
  try { return JSON.parse(text(root, path)); }
  catch { throw new Error(`Cannot read valid bounded JSON: ${path}`); }
}
export function gitBlob(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

/** Validates the intentionally scalar-only frontmatter used by this kit, not arbitrary YAML. */
export function frontmatter(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (lines.shift() !== '---') throw new Error('Missing opening YAML frontmatter delimiter');
  const end = lines.indexOf('---');
  if (end < 0) throw new Error('Missing closing YAML frontmatter delimiter');
  const result = {};
  for (const line of lines.slice(0, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([a-zA-Z][\w-]*):\s*(.+)$/.exec(line);
    if (!m || Object.hasOwn(result, m[1])) throw new Error('Use unique scalar frontmatter keys');
    let value = m[2].trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error('Invalid quoted frontmatter scalar'); }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error('Unclosed frontmatter scalar');
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (/^[&*!|>\[\{]/.test(value) || /:\s/.test(value) || /\s#/.test(value)) {
      throw new Error('Quote special frontmatter values; complex YAML is not supported by this validator');
    }
    result[m[1]] = value;
  }
  return result;
}

export function globMatch(pattern, path) {
  // Supported route vocabulary: *, **, ?; no brace/extglob/regex evaluation.
  relativePath(pattern);
  relativePath(path);
  if (/[{}[\]]/.test(pattern)) throw new Error('Unsupported route glob syntax');
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; }
      else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$').test(path);
}

function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', `core.hooksPath=${devNull}`, '-C', root, ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer: MAX_GIT,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull },
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    // Do not emit arbitrary git config/subprocess diagnostics or credentials.
    throw new Error(`Read-only Git operation failed (${args[0]}); check Git availability, repository and revision`);
  }
  return result.stdout;
}
const unique = values => [...new Set(values)].sort();
const nulPaths = value => value.split('\0').filter(Boolean);
function directory(root, path) {
  const file = safePath(root, path, true);
  if (!existsSync(file)) return [];
  if (!lstatSync(file).isDirectory()) throw new Error(`Expected directory: ${path}`);
  return readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
function walk(root, dir, result = []) {
  for (const entry of directory(root, dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in managed knowledge: ${path}`);
    if (entry.isDirectory()) walk(root, path, result);
    else if (entry.isFile()) result.push(path);
    if (result.length > 3000) throw new Error('Managed knowledge file limit exceeded');
  }
  return result;
}
function inKit(path) {
  return ROOT_DOCS.includes(path) || EXTRA_DOCS.includes(path)
    || KIT_DIRS.some(dir => path.startsWith(dir + '/'));
}

export function createKit(inputRoot) {
  const root = realpathSync(inputRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('Repository root must be a directory');
  const map = json(root, MAP);
  const evidence = json(root, EVIDENCE);
  if (map.schemaVersion !== 1 || evidence.schemaVersion !== 1 || !SHA.test(map.baseline)
      || !SHA.test(evidence.baseline) || !Array.isArray(map.areas) || !Array.isArray(evidence.sources)) {
    throw new Error('Unsupported or malformed task/evidence schema');
  }
  const ids = new Set();
  for (const area of map.areas) {
    if (typeof area.id !== 'string' || !ID.test(area.id) || area.id.length > 55 || ids.has(area.id)
        || typeof area.title !== 'string' || !['normal', 'high', 'critical'].includes(area.risk)
        || area.skill !== `.agents/skills/polyth-${area.id}/SKILL.md`) {
      throw new Error('Invalid or duplicate area identity');
    }
    ids.add(area.id);
    for (const field of ['match', 'entrypoints', 'references', 'testHints']) {
      if (!Array.isArray(area[field]) || area[field].some(p => typeof p !== 'string')) throw new Error(`Invalid ${field} in ${area.id}`);
      for (const path of area[field]) {
        relativePath(path);
        if (field === 'match') globMatch(path, 'schema-check');
        else if (/[?*]/.test(path)) throw new Error(`Use concrete paths outside match: ${area.id}`);
      }
    }
  }
  const sourcePaths = new Set();
  for (const source of evidence.sources) {
    relativePath(source.path);
    if (!(/^(?:packages|apps|scripts|crates|docs)\/.+\.(?:[cm]?[jt]sx?|md|mdc|json|ya?ml|toml|rs|css|py)$/.test(source.path)
      || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(source.path)
      || ['package.json', 'Cargo.toml', 'codemagic.yaml', '.opencode/opencode.json'].includes(source.path))) {
      throw new Error('Evidence source is outside supported code/document/config anchors');
    }
    if (!SHA.test(source.gitBlob) || typeof source.reviewCoverage !== 'string'
        || typeof source.observation !== 'string' || sourcePaths.has(source.path)) throw new Error('Invalid or duplicate evidence source');
    sourcePaths.add(source.path);
  }
  function areaById(id) {
    const found = map.areas.find(a => a.id === id);
    if (!found) throw new Error(`Unknown area: ${String(id).slice(0, 80)}. Use map.`);
    return found;
  }
  function sourcesFor(areas) {
    if (!areas) return evidence.sources;
    return evidence.sources.filter(s => areas.some(a =>
      [...a.entrypoints, ...a.references, ...a.testHints].some(p => s.path === p || s.path.startsWith(p + '/'))
      || a.match.some(pattern => globMatch(pattern, s.path))));
  }
  function status(source) {
    try {
      const data = bytes(root, source.path);
      const raw = gitBlob(data);
      const normalized = gitBlob(data.toString('utf8').replace(/\r\n/g, '\n'));
      return { ...source, state: raw === source.gitBlob || normalized === source.gitBlob ? 'unchanged' : 'changed', currentGitBlob: raw };
    } catch (error) {
      return { ...source, state: 'missing-or-unreadable', reason: error.message };
    }
  }
  function doctor(id) {
    const areas = id ? [areaById(id)] : null;
    const sources = sourcesFor(areas).map(status);
    return {
      area: id ?? 'all', baseline: evidence.baseline, reviewDate: evidence.reviewDate,
      warning: 'Anchor hashes only. Unchanged bytes do not prove correctness, complete coverage or runtime readiness.',
      noRecordedAnchors: sources.length === 0,
      sources,
      summary: {
        checked: sources.length,
        unchanged: sources.filter(s => s.state === 'unchanged').length,
        changed: sources.filter(s => s.state === 'changed').length,
        missing: sources.filter(s => s.state === 'missing-or-unreadable').length,
      },
    };
  }
  function areasForPath(path) {
    relativePath(path);
    return map.areas.filter(a => a.match.some(pattern => globMatch(pattern, path))
      || a.entrypoints.some(p => path === p || path.startsWith(p + '/')));
  }
  function context({ id, path } = {}) {
    if ((id ? 1 : 0) + (path ? 1 : 0) !== 1) throw new Error('Choose exactly one area or --path');
    const areas = id ? [areaById(id)] : areasForPath(path);
    return {
      baseline: map.baseline, path: path ?? null,
      instruction: 'Read AGENTS once, select the smallest applicable skill set, then current definitions/callers/tests. No automatic code audit was performed.',
      unmatched: areas.length === 0,
      fallback: areas.length ? null : 'Use orientation, inspect the owning manifest and add a route when justified. Unknown is not low risk.',
      areas,
      evidence: sourcesFor(areas).map(status),
      coverageWarning: 'Only recorded anchors are checked; directories and dynamic consumers are not comprehensively verified.',
    };
  }
  function inventory(selected) {
    const manifest = json(root, 'package.json');
    const globs = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
    if (!Array.isArray(globs) || globs.some(p => !['packages/*', 'apps/*'].includes(p))) {
      throw new Error('Inventory supports this repository\'s one-level packages/* and apps/* workspaces only');
    }
    const paths = nulPaths(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages', 'apps', 'scripts/test']));
    const tests = unique(paths.filter(p => /\.test\.[cm]?[jt]sx?$/.test(p)
      && !p.split('/').some(c => ['node_modules', 'dist', 'build', 'target'].includes(c))));
    const packages = [];
    for (const dir of unique(globs.map(p => p.slice(0, -2)))) {
      for (const entry of directory(root, dir)) {
        if (entry.isSymbolicLink()) throw new Error(`Workspace symlink is not inspected: ${dir}/${entry.name}`);
        if (!entry.isDirectory()) continue;
        const path = `${dir}/${entry.name}`;
        if (!existsSync(safePath(root, `${path}/package.json`, true))) continue;
        const m = json(root, `${path}/package.json`);
        if (typeof m.name !== 'string' || !m.name) throw new Error(`Missing package name in ${path}`);
        const deps = {};
        for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
          for (const [name, version] of Object.entries(m[section] ?? {})) {
            (deps[name] ??= []).push({ section, version });
          }
        }
        packages.push({ path, name: m.name, exports: m.exports ?? null,
          serverEntry: m.polyth?.serverEntry ?? null, webEntry: m.polyth?.webEntry ?? null,
          scripts: Object.keys(m.scripts ?? {}).sort(), dependencies: deps,
          tests: tests.filter(t => t.startsWith(path + '/')) });
      }
    }
    packages.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    if (new Set(packages.map(p => p.name)).size !== packages.length) throw new Error('Duplicate workspace package names');
    const names = new Set(packages.map(p => p.name));
    const reverseDependencies = Object.fromEntries([...names].sort().map(n => [n, []]));
    for (const pkg of packages) {
      pkg.workspaceDependencies = Object.keys(pkg.dependencies).filter(d => names.has(d)).sort();
      for (const d of pkg.workspaceDependencies) reverseDependencies[d].push(pkg.name);
    }
    for (const list of Object.values(reverseDependencies)) list.sort();
    if (selected && !packages.some(p => p.name === selected || p.path === selected)) throw new Error('Unknown workspace package; inspect map or full inventory');
    const chosen = selected ? packages.filter(p => p.name === selected || p.path === selected) : packages;
    return { kind: 'mechanical-inventory', baseline: map.baseline,
      warning: 'Declared manifest dependencies and Git path metadata only; not a complete import/service graph or readiness assessment. Script names, not commands, are emitted.',
      rootScripts: Object.keys(manifest.scripts ?? {}).sort(), packages: chosen,
      reverseDependencies: Object.fromEntries(chosen.map(p => [p.name, reverseDependencies[p.name]])),
      tests: selected ? chosen.flatMap(p => p.tests) : tests };
  }
  function impact(base) {
    if (typeof base !== 'string' || !base || base.length > 200 || /[\0\r\n]/.test(base)) throw new Error('A valid explicit --base is required');
    const commit = git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
    if (!SHA.test(commit)) throw new Error('Base did not resolve to a commit');
    const changed = unique([
      ...nulPaths(git(root, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', commit, '--'])),
      ...nulPaths(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
    ]);
    const inv = inventory();
    const global = changed.filter(p => /^(package(?:-lock)?\.json|Cargo\.(?:toml|lock)|rust-toolchain\.toml|tsconfig\.base\.json|\.nvmrc)$/.test(p)
      || /^(packages\/(contracts|web-sdk|plugins)\/|apps\/web\/build)/.test(p));
    const directlyAffected = inv.packages.filter(p => changed.some(f => f.startsWith(p.path + '/'))).map(p => p.name);
    const affected = new Set(global.length ? inv.packages.map(p => p.name) : directlyAffected);
    const queue = [...affected];
    for (let i = 0; i < queue.length; i++) {
      for (const consumer of inv.reverseDependencies[queue[i]] ?? []) {
        if (!affected.has(consumer)) { affected.add(consumer); queue.push(consumer); }
      }
    }
    const routes = changed.map(path => ({ path, areas: areasForPath(path).map(a => a.id) }));
    return { base: commit, comparison: 'base commit to current worktree, plus untracked files; renames include both paths',
      warning: 'Advisory only. Dynamic registry links, undeclared imports, generated/native bindings and external consumers are not proven covered.',
      changed, routes, unmapped: routes.filter(r => !r.areas.length).map(r => r.path),
      globalReviewTriggers: global, directlyAffected: unique(directlyAffected), affectedDeclaredConsumers: [...affected].sort(),
      candidateTests: unique(inv.packages.filter(p => affected.has(p.name)).flatMap(p => p.tests)),
      next: 'Read the owner skill and current consumers; use risk-based verification. No tests were run.' };
  }
  function check({ kitOnly = false } = {}) {
    const errors = [], warnings = [];
    let linksChecked = 0, externalReferencesSkipped = 0;
    const capture = (path, fn) => { try { fn(); } catch (e) { errors.push(`${path}: ${e.message}`); } };
    const required = [...ROOT_DOCS, ...EXTRA_DOCS];
    for (const p of required) capture(p, () => bytes(root, p));
    const managed = unique([...required, ...KIT_DIRS.flatMap(p => walk(root, p))]);
    const skills = managed.filter(p => p.endsWith('/SKILL.md'));
    const names = new Map();
    for (const path of skills) capture(path, () => {
      const fm = frontmatter(text(root, path));
      if (typeof fm.name !== 'string' || !ID.test(fm.name) || fm.name.length > 64 || fm.name !== path.split('/').at(-2)) throw new Error('Invalid skill name or directory mismatch');
      if (typeof fm.description !== 'string' || fm.description.length < 1 || fm.description.length > 1024) throw new Error('Invalid skill description');
      if (names.has(fm.name)) throw new Error(`Duplicate skill name also in ${names.get(fm.name)}`);
      names.set(fm.name, path);
    });
    // Also detect native mirrors of owned skill names without changing unrelated files.
    for (const dir of ['.cursor/skills', '.codex/skills', '.opencode/skills']) {
      for (const path of walk(root, dir).filter(p => p.endsWith('/SKILL.md'))) capture(path, () => {
        const fm = frontmatter(text(root, path));
        if (names.has(fm.name)) throw new Error(`Duplicate owned skill in discovery root: ${fm.name}`);
      });
    }
    for (const a of map.areas) {
      capture(a.skill, () => {
        if (frontmatter(text(root, a.skill)).name !== `polyth-${a.id}`) throw new Error('Mapped skill identity mismatch');
      });
      for (const p of [...a.entrypoints, ...a.references]) capture(p, () => {
        if (kitOnly && !inKit(p)) { externalReferencesSkipped++; return; }
        safePath(root, p);
      });
      if (!kitOnly) for (const p of a.testHints) {
        try { safePath(root, p); } catch { warnings.push(`Test hint must be relocated before use: ${p}`); }
      }
    }
    for (const path of managed.filter(p => /\.(md|mdc)$/.test(p))) capture(path, () => {
      const content = text(root, path);
      for (const m of content.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+['"][^)]*)?\)/g)) {
        const target = m[1].split('#')[0];
        if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
        const decoded = decodeURIComponent(target);
        if (decoded.startsWith('/')) throw new Error('Use portable relative links, not absolute filesystem links');
        const normalized = posix.normalize(posix.join(posix.dirname(path), decoded));
        relativePath(normalized);
        if (kitOnly && !inKit(normalized)) { externalReferencesSkipped++; continue; }
        safePath(root, normalized); linksChecked++;
      }
    });
    capture('CLAUDE.md', () => { if (!/^@AGENTS\.md\s*$/m.test(text(root, 'CLAUDE.md'))) throw new Error('Missing canonical import'); });
    capture('.cursor/rules/polyth.mdc', () => {
      const s = text(root, '.cursor/rules/polyth.mdc');
      if (frontmatter(s).alwaysApply !== 'true' || !s.includes('AGENTS.md')) throw new Error('Missing always-on canonical adapter');
    });
    capture('AGENTS.md', () => { if (text(root, 'AGENTS.md').length > 10000) warnings.push('AGENTS is growing beyond the intended small startup budget'); });
    return { mode: kitOnly ? 'kit-only; application source paths NOT validated' : 'full-checkout structure; application behavior NOT tested',
      ok: errors.length === 0, errors: unique(errors), warnings: unique(warnings),
      counts: { areas: map.areas.length, skills: skills.length, managedFiles: managed.length, linksChecked, externalReferencesSkipped },
      limitation: 'Validates owned structure, supported scalar frontmatter, mapped paths and local Markdown link targets; not every inline code path, heading anchor or arbitrary YAML/TypeScript semantic.' };
  }
  function bundle(id) {
    const a = areaById(id);
    const files = unique(['AGENTS.md', a.skill, 'docs/agents/evidence.md', 'docs/agents/verification.md',
      ...a.references.filter(p => p.startsWith('docs/agents/') && p.endsWith('.md'))]);
    files.sort((x, y) => x === 'AGENTS.md' ? -1 : y === 'AGENTS.md' ? 1 : x.localeCompare(y, 'en'));
    const c = context({ id });
    let output = `# Polyth task context: ${id}\n\nHistorical baseline: ${map.baseline}.\nThis is a bounded private-project context packet, not a live audit or task authorization. Review before sharing.\n\n`;
    output += `Entry points to fetch from CURRENT source:\n${a.entrypoints.map(p => `- ${p}`).join('\n')}\n\n`;
    output += `References not automatically included:\n${a.references.filter(p => !files.includes(p)).map(p => `- ${p}`).join('\n') || '- none'}\n\n`;
    output += `Recorded source anchors (not comprehensive coverage):\n${c.evidence.map(s => `- ${s.path}: ${s.state}; historical coverage: ${s.reviewCoverage}`).join('\n') || '- No recorded anchors; inspect source.'}\n\n`;
    for (const path of files) {
      if (!(path === 'AGENTS.md' || path === a.skill || (path.startsWith('docs/agents/') && path.endsWith('.md')))) throw new Error('Bundle path is outside the allowed knowledge set');
      output += `\n---\n## File: ${path}\n\n${text(root, path)}\n`;
      if (output.length > MAX_BUNDLE) throw new Error(`Bundle exceeds ${MAX_BUNDLE} characters; narrow reference documents instead of truncating instructions silently`);
    }
    return output;
  }
  return { root, map, evidence, doctor, context, areasForPath, inventory, impact, check, bundle };
}

export function runCli(argv, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    if (args.length) throw new Error('help takes no arguments');
    return { output: HELP, code: 0 };
  }
  const allowed = {
    map: ['--json'], context: ['--path', '--json'], doctor: ['--strict', '--json'],
    inventory: ['--package', '--json'], impact: ['--base', '--json'], check: ['--kit-only', '--json'], bundle: [],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown command; use help');
  const opts = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (!allowed[command].includes(arg) || Object.hasOwn(opts, arg)) throw new Error(`Invalid or duplicate option: ${arg}`);
      if (['--base', '--path', '--package'].includes(arg)) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
        opts[arg] = args[++i];
      } else opts[arg] = true;
    } else positional.push(arg);
  }
  const acceptsOne = ['context', 'doctor', 'bundle'].includes(command);
  if (positional.length > (acceptsOne ? 1 : 0)) throw new Error('Unexpected positional arguments');
  const kit = createKit(root);
  let result, code = 0;
  if (command === 'map') {
    result = kit.map.areas.map(({ id, title, risk, skill }) => ({ id, title, risk, skill }));
    if (!opts['--json']) return { output: result.map(a => `${a.id.padEnd(15)} ${a.risk.padEnd(8)} ${a.title}`).join('\n') + '\n', code };
  } else if (command === 'context') result = kit.context({ id: positional[0], path: opts['--path'] });
  else if (command === 'doctor') {
    result = kit.doctor(positional[0]);
    if (opts['--strict'] && (result.noRecordedAnchors || result.summary.changed || result.summary.missing)) code = 2;
  } else if (command === 'inventory') result = kit.inventory(opts['--package']);
  else if (command === 'impact') result = kit.impact(opts['--base']);
  else if (command === 'check') {
    result = kit.check({ kitOnly: Boolean(opts['--kit-only']) });
    if (!result.ok) code = 1;
  } else if (command === 'bundle') return { output: kit.bundle(positional[0]), code: 0 };
  if (!opts['--json'] && command === 'context') {
    let output = `Baseline: ${result.baseline}\n${result.instruction}\n`;
    for (const a of result.areas) output += `\n${a.id} [${a.risk}]\nSkill: ${a.skill}\nEntry points: ${a.entrypoints.join(', ')}\nReferences: ${a.references.join(', ')}\nTest hints: ${a.testHints.join(', ') || 'Select from owning package and verification matrix'}\n`;
    output += `\nRecorded anchors only (not complete coverage):\n${result.evidence.map(s => `${s.state}: ${s.path} [${s.reviewCoverage}]`).join('\n') || 'No recorded anchors'}\n`;
    if (result.unmatched) output += `UNMAPPED: ${result.fallback}\n`;
    return { output, code };
  }
  if (!opts['--json'] && command === 'doctor') {
    const output = `Area: ${result.area}; baseline ${result.baseline}\n${result.warning}\n`
      + result.sources.map(s => `${s.state}: ${s.path} [${s.reviewCoverage}]`).join('\n')
      + `\nChecked ${result.summary.checked}; unchanged ${result.summary.unchanged}; changed ${result.summary.changed}; missing ${result.summary.missing}.\n`
      + (result.noRecordedAnchors ? 'NO RECORDED ANCHORS: inspect the owning source.\n' : '');
    return { output, code };
  }
  return { output: JSON.stringify(result, null, 2) + '\n', code };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 14)) throw new Error('Use Node >=22.14');
    const result = runCli(process.argv.slice(2));
    process.stdout.write(result.output);
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`agent-kit: ${error.message}\n`);
    process.exitCode = 1;
  }
}
