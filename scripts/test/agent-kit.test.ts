import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
// mjs is intentional: toolkit tests need no workspace dependencies or transpiler.
import { createKit, relativePath, safePath, gitBlob, frontmatter, globMatch, runCli } from '../agent-kit.mjs';

const BASE = 'a'.repeat(40);
const source = 'export const value = 1;\n';
function write(root: string, path: string, data: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
}
function writeJson(root: string, path: string, data: unknown): void { write(root, path, JSON.stringify(data)); }
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture(t: { after: (fn: () => void) => void }, initGit = false): string {
  const root = mkdtempSync(join(tmpdir(), 'polyth-agent-kit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['AGENTS.md', 'GEMINI.md', 'CONTRIBUTING_AGENT_OVERVIEW.md', 'docs/dev/README.md', '.github/copilot-instructions.md']) write(root, path, '# Fixture policy\n');
  write(root, 'CLAUDE.md', '@AGENTS.md\n');
  write(root, '.cursor/rules/polyth.mdc', '---\ndescription: Fixture rule\nalwaysApply: true\n---\nRead AGENTS.md\n');
  write(root, '.opencode/skill/polyth-control/SKILL.md', '---\nname: polyth-control\ndescription: Fixture legacy control\n---\nNo live operation.\n');
  write(root, '.agents/skills/polyth-feature/SKILL.md', '---\nname: polyth-feature\ndescription: Test fixture skill\n---\nRead current source.\n');
  write(root, '.agents/skills/polyth-contracts/SKILL.md', '---\nname: polyth-contracts\ndescription: Test fixture contracts\n---\nReview consumers.\n');
  for (const path of ['guide', 'evidence', 'verification']) write(root, `docs/agents/${path}.md`, '# Fixture reference\n');
  writeJson(root, 'docs/agents/task-map.json', { schemaVersion: 1, baseline: BASE, areas: [
    { id: 'feature', title: 'Feature', risk: 'normal', skill: '.agents/skills/polyth-feature/SKILL.md', match: ['packages/feature/**'], entrypoints: ['packages/feature/src/index.ts'], references: ['docs/agents/guide.md'], testHints: ['packages/feature/test/feature.test.ts'] },
    { id: 'contracts', title: 'Contracts', risk: 'critical', skill: '.agents/skills/polyth-contracts/SKILL.md', match: ['packages/contracts/**'], entrypoints: ['packages/contracts/src/index.ts'], references: [], testHints: [] },
  ] });
  writeJson(root, 'docs/agents/evidence.json', { schemaVersion: 1, baseline: BASE, reviewDate: '2026-09-09', sources: [
    { path: 'packages/feature/src/index.ts', gitBlob: gitBlob(source), reviewCoverage: 'full', observation: 'Fixture only, not Polyth behavior' },
  ] });
  writeJson(root, 'package.json', { name: 'polyth', type: 'module', workspaces: ['packages/*', 'apps/*'], scripts: { test: 'DO_NOT_EXECUTE_THIS_SCRIPT' } });
  writeJson(root, 'packages/feature/package.json', { name: '@polyth/feature', exports: { '.': './src/index.ts' }, dependencies: { '@polyth/contracts': '0.1.0' }, polyth: { serverEntry: './src/serverEntry.ts' }, scripts: { dangerous: 'DO_NOT_EXECUTE' } });
  writeJson(root, 'packages/contracts/package.json', { name: '@polyth/contracts', exports: './src/index.ts' });
  writeJson(root, 'apps/client/package.json', { name: '@polyth/client', dependencies: { '@polyth/feature': '0.1.0' } });
  write(root, 'packages/feature/src/index.ts', source);
  write(root, 'packages/contracts/src/index.ts', 'export type Value = number;\n');
  write(root, 'packages/feature/test/feature.test.ts', '// fixture path only\n');
  if (initGit) {
    git(root, 'init', '--quiet');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--no-verify', '-m', 'fixture');
  }
  return root;
}
function mutateJson(root: string, path: string, fn: (value: any) => void): void {
  const value = JSON.parse(readFileSync(join(root, path), 'utf8'));
  fn(value); writeJson(root, path, value);
}

test('git blob hash matches known Git object calculation', t => {
  const root = fixture(t, true);
  assert.equal(gitBlob(source), git(root, 'hash-object', '--', 'packages/feature/src/index.ts'));
});
test('safe relative paths allow ordinary repository files', () => {
  assert.equal(relativePath('packages/feature/src/file name.ts'), 'packages/feature/src/file name.ts');
});
test('safe relative paths reject traversal and platform absolute variants', () => {
  for (const p of ['', '../x', 'a/../x', '/tmp/x', 'C:/x', 'a\\x', 'a//b', './x', '.git/config', 'x\0y', 'x\ny']) assert.throws(() => relativePath(p));
});
test('safe path does not follow an external symlink', t => {
  const root = fixture(t);
  try { symlinkSync(tmpdir(), join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e: any) { if (e.code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw e; }
  assert.throws(() => safePath(root, 'outside/file.md', true), /Symlinks/);
});
test('a non-directory cannot become a safe path parent', t => {
  const root = fixture(t);
  assert.throws(() => safePath(root, 'AGENTS.md/child', true), /Not a directory/);
});
test('glob semantics distinguish * from ** and allow zero nested levels', () => {
  assert.equal(globMatch('packages/*/widgets/**/*.css', 'packages/a/widgets/styles.css'), true);
  assert.equal(globMatch('packages/*/widgets/**/*.css', 'packages/a/widgets/deep/styles.css'), true);
  assert.equal(globMatch('packages/*/src/*.ts', 'packages/a/src/deep/a.ts'), false);
  assert.equal(globMatch('apps/web/*.tsx', 'apps/web/x.ts'), false);
});
test('malformed or unsupported globs are rejected', () => {
  assert.throws(() => globMatch('../**', 'x'));
  assert.throws(() => globMatch('packages/{x,y}/**', 'x'));
});
test('frontmatter accepts scalar and quoted values', () => {
  assert.equal(frontmatter('---\nname: x\ndescription: "one: two"\n---\ntext').description, 'one: two');
});
test('frontmatter rejects duplicates, complex YAML and missing closing delimiter', () => {
  for (const s of ['---\nname: a\nname: b\n---', '---\ndescription: >\n  hi\n---', '---\nname: a']) assert.throws(() => frontmatter(s));
});
test('unknown schemas fail before producing plausible context', t => {
  const root = fixture(t);
  mutateJson(root, 'docs/agents/task-map.json', v => v.schemaVersion = 2);
  assert.throws(() => createKit(root), /schema/);
});
test('duplicate area identities are rejected', t => {
  const root = fixture(t);
  mutateJson(root, 'docs/agents/task-map.json', v => v.areas.push(v.areas[0]));
  assert.throws(() => createKit(root), /duplicate/);
});
test('evidence sources require valid unique path and blob hash', t => {
  const root = fixture(t);
  mutateJson(root, 'docs/agents/evidence.json', v => v.sources[0].gitBlob = 'not-a-hash');
  assert.throws(() => createKit(root), /evidence/);
});
test('current source hashes report unchanged without a runtime verification claim', t => {
  const root = fixture(t);
  const d = createKit(root).doctor('feature');
  assert.equal(d.summary.unchanged, 1);
  assert.match(d.warning, /do not prove/);
});
test('CRLF text checkout is considered unchanged with LF evidence', t => {
  const root = fixture(t);
  write(root, 'packages/feature/src/index.ts', source.replace(/\n/g, '\r\n'));
  assert.equal(createKit(root).doctor('feature').summary.unchanged, 1);
});
test('changed source does not silently refresh evidence', t => {
  const root = fixture(t);
  const old = readFileSync(join(root, 'docs/agents/evidence.json'), 'utf8');
  write(root, 'packages/feature/src/index.ts', 'export const value = 2;\n');
  assert.equal(createKit(root).doctor('feature').summary.changed, 1);
  assert.equal(readFileSync(join(root, 'docs/agents/evidence.json'), 'utf8'), old);
});
test('missing source is distinct from unchanged or unsupported', t => {
  const root = fixture(t);
  rmSync(join(root, 'packages/feature/src/index.ts'));
  assert.equal(createKit(root).doctor('feature').sources[0].state, 'missing-or-unreadable');
});
test('unrecorded areas explicitly report no coverage', t => {
  const root = fixture(t);
  assert.equal(createKit(root).doctor('contracts').noRecordedAnchors, true);
  assert.equal(runCli(['doctor', 'contracts', '--strict'], root).code, 2);
});
test('doctor strict fails for drift but default remains advisory', t => {
  const root = fixture(t);
  write(root, 'packages/feature/src/index.ts', 'changed');
  assert.equal(runCli(['doctor', 'feature'], root).code, 0);
  assert.equal(runCli(['doctor', 'feature', '--strict'], root).code, 2);
});
test('context routes a known path and leaves unknown paths explicitly unmapped', t => {
  const root = fixture(t); const kit = createKit(root);
  assert.deepEqual(kit.context({ path: 'packages/feature/src/new.ts' }).areas.map(a => a.id), ['feature']);
  assert.equal(kit.context({ path: 'unknown/new.ts' }).unmatched, true);
});
test('unknown area and conflicting selectors fail', t => {
  const root = fixture(t); const kit = createKit(root);
  assert.throws(() => kit.context({ id: 'imaginary' }), /Unknown area/);
  assert.throws(() => kit.context({ id: 'feature', path: 'x' }), /exactly one/);
});
test('complete fixture passes full structural check', t => {
  const root = fixture(t);
  const r = createKit(root).check();
  assert.deepEqual(r.errors, []); assert.equal(r.ok, true);
});
test('kit-only mode explicitly skips missing application source paths', t => {
  const root = fixture(t);
  rmSync(join(root, 'packages'), { recursive: true });
  assert.equal(createKit(root).check({ kitOnly: true }).ok, true);
  assert.equal(createKit(root).check().ok, false);
});
test('a broken local documentation link fails structural check', t => {
  const root = fixture(t);
  write(root, 'docs/agents/guide.md', '[broken](missing.md)\n');
  assert.equal(createKit(root).check({ kitOnly: true }).ok, false);
});
test('an escaping Markdown link is rejected', t => {
  const root = fixture(t);
  write(root, 'AGENTS.md', '[outside](../outside.md)');
  assert.equal(createKit(root).check({ kitOnly: true }).ok, false);
});
test('duplicate owned skill in another native discovery directory fails', t => {
  const root = fixture(t);
  write(root, '.cursor/skills/polyth-feature/SKILL.md', '---\nname: polyth-feature\ndescription: duplicate\n---\n');
  assert.equal(createKit(root).check().ok, false);
});
test('missing canonical Claude import fails', t => {
  const root = fixture(t); write(root, 'CLAUDE.md', '# independent policy');
  assert.equal(createKit(root).check().ok, false);
});
test('inventory reads manifest metadata and reverse declared dependencies only', t => {
  const root = fixture(t, true); const inv = createKit(root).inventory();
  assert.equal(inv.packages.length, 3);
  assert.deepEqual(inv.reverseDependencies['@polyth/contracts'], ['@polyth/feature']);
  assert.equal(inv.packages.find(p => p.name === '@polyth/feature').serverEntry, './src/serverEntry.ts');
  assert.equal(JSON.stringify(inv).includes('DO_NOT_EXECUTE'), false);
  assert.deepEqual(inv.rootScripts, ['test']);
});
test('package-filtered inventory avoids dumping every workspace', t => {
  const root = fixture(t, true); const kit = createKit(root);
  assert.equal(kit.inventory('@polyth/feature').packages.length, 1);
  assert.equal(kit.inventory('packages/feature').packages[0].name, '@polyth/feature');
  assert.throws(() => kit.inventory('missing'), /Unknown workspace/);
});
test('unsupported workspace patterns fail rather than silently omit packages', t => {
  const root = fixture(t, true);
  mutateJson(root, 'package.json', v => v.workspaces.push('extensions/**'));
  assert.throws(() => createKit(root).inventory(), /one-level/);
});
test('inventory without Git is not reported as a complete inventory', t => {
  const root = fixture(t);
  assert.throws(() => createKit(root).inventory(), /Git operation failed/);
});
test('impact includes staged, unstaged and untracked paths and reverse consumers', t => {
  const root = fixture(t, true);
  write(root, 'packages/feature/src/index.ts', 'changed');
  write(root, 'packages/feature/staged.ts', 'staged'); git(root, 'add', 'packages/feature/staged.ts');
  write(root, 'packages/feature/new.ts', 'untracked');
  const r = createKit(root).impact('HEAD');
  assert.ok(r.changed.includes('packages/feature/src/index.ts'));
  assert.ok(r.changed.includes('packages/feature/staged.ts'));
  assert.ok(r.changed.includes('packages/feature/new.ts'));
  assert.ok(r.affectedDeclaredConsumers.includes('@polyth/client'));
});
test('impact reports both rename paths and deleted paths', t => {
  const root = fixture(t, true);
  renameSync(join(root, 'packages/feature/src/index.ts'), join(root, 'packages/feature/src/renamed.ts'));
  git(root, 'add', '-A'); rmSync(join(root, 'packages/feature/test/feature.test.ts'));
  const r = createKit(root).impact('HEAD');
  for (const p of ['packages/feature/src/index.ts', 'packages/feature/src/renamed.ts', 'packages/feature/test/feature.test.ts']) assert.ok(r.changed.includes(p), p);
});
test('global manifest changes conservatively expand consumer review', t => {
  const root = fixture(t, true);
  mutateJson(root, 'package.json', v => v.version = '0.2.0');
  const r = createKit(root).impact('HEAD');
  assert.deepEqual(r.globalReviewTriggers, ['package.json']);
  assert.equal(r.affectedDeclaredConsumers.length, 3);
});
test('invalid Git revision does not become a diff option', t => {
  const root = fixture(t, true);
  assert.throws(() => createKit(root).impact('--output=/tmp/agent-kit-must-not-write'), /Git operation failed/);
});
test('Git metadata queries leave checkout content unchanged', t => {
  const root = fixture(t, true);
  const before = git(root, 'status', '--porcelain');
  createKit(root).inventory(); createKit(root).impact('HEAD');
  assert.equal(git(root, 'status', '--porcelain'), before);
});
test('bundle contains policy and selected knowledge, never application source bodies', t => {
  const root = fixture(t);
  write(root, '.env', 'DO_NOT_BUNDLE_SECRET');
  const b = createKit(root).bundle('feature');
  assert.match(b, /Fixture policy/); assert.match(b, /polyth-feature\/SKILL.md/);
  assert.equal(b.includes(source.trim()), false); assert.equal(b.includes('DO_NOT_BUNDLE_SECRET'), false);
});
test('oversized bundle fails rather than silently truncating policy', t => {
  const root = fixture(t); write(root, 'docs/agents/guide.md', 'x'.repeat(41000));
  assert.throws(() => createKit(root).bundle('feature'), /exceeds/);
});
test('tool does not read oversized evidence sources', t => {
  const root = fixture(t); write(root, 'packages/feature/src/index.ts', 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(createKit(root).doctor('feature').summary.missing, 1);
});
test('invalid CLI flags, missing values and extra arguments fail', t => {
  const root = fixture(t);
  for (const argv of [['nope'], ['context'], ['context', '--path'], ['map', 'extra'], ['check', '--force'], ['map', '--json', '--json'], ['impact']]) assert.throws(() => runCli(argv, root));
});
test('help works without a repository and JSON mode is parseable', t => {
  assert.match(runCli(['help'], '/does/not/exist').output, /read-only/);
  const root = fixture(t);
  const out = JSON.parse(runCli(['context', 'feature', '--json'], root).output);
  assert.equal(out.areas[0].id, 'feature');
});
test('CLI works from an unrelated current working directory', t => {
  const root = fixture(t);
  write(root, 'scripts/agent-kit.mjs', readFileSync(new URL('../agent-kit.mjs', import.meta.url), 'utf8'));
  const r = spawnSync(process.execPath, [join(root, 'scripts/agent-kit.mjs'), 'map', '--json'], { cwd: tmpdir(), encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).length, 2);
});


test('evidence cannot be redirected to a root credential file', t => {
  const root = fixture(t);
  write(root, '.env', 'private-value');
  mutateJson(root, 'docs/agents/evidence.json', v => v.sources[0].path = '.env');
  assert.throws(() => createKit(root), /outside supported/);
});
test('portable paths reject Windows alternate-stream syntax', () => {
  assert.throws(() => relativePath('docs/file.md:stream'));
});
test('malformed JSON diagnostics do not echo private file values', t => {
  const root = fixture(t);
  write(root, 'docs/agents/task-map.json', '{"secret":"DO_NOT_ECHO_THIS"');
  try { createKit(root); assert.fail('must reject invalid JSON'); }
  catch (e) { assert.equal(String(e).includes('DO_NOT_ECHO_THIS'), false); }
});
