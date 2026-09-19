#!/usr/bin/env python3
"""Safely apply the Polyth knowledge overlay. Dry run by default. Python >=3.10."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile

MANIFEST = 'docs/agents/overlay-manifest.json'
MAX_TOTAL = 20 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
ALLOWED_ROOTS = {'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CONTRIBUTING_AGENT_OVERVIEW.md'}
ALLOWED_PREFIXES = ('.agents/skills/', '.claude/skills/', '.cursor/rules/', '.cursor/agents/', 'docs/agents/')
ALLOWED_FILES = {
    '.github/copilot-instructions.md',
    '.opencode/skill/polyth-control/SKILL.md', 'docs/dev/README.md',
    'scripts/agent-kit.mjs', 'scripts/agent-kit-install.py',
    'scripts/test/agent-kit.test.ts', 'scripts/test/agent_kit_install_test.py',
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_blob(data: bytes) -> str:
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def safe_name(name: str) -> str:
    if not isinstance(name, str) or not name or len(name) > 2048 or re.search(r'[\\:*?\[\]\"<>|\x00-\x1f]', name):
        raise ValueError('Unsafe or nonportable archive path')
    parts = name.split('/')
    if any(not part or part in ('.', '..', '.git') or part.endswith((' ', '.'))
           or len(part) > 255 or re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part)
           for part in parts):
        raise ValueError('Unsafe or nonportable archive path')
    if not (name in ALLOWED_ROOTS or name in ALLOWED_FILES or name.startswith(ALLOWED_PREFIXES)):
        raise ValueError(f'Path outside the knowledge-overlay scope: {name}')
    return name


def destination(repo: Path, name: str) -> Path:
    safe_name(name)
    current = repo
    parts = PurePosixPath(name).parts
    for i, part in enumerate(parts):
        current = current / part
        if current.is_symlink():
            raise ValueError(f'Refusing symlink target/parent: {name}')
        if current.exists() and i < len(parts) - 1 and not current.is_dir():
            raise ValueError(f'Non-directory parent: {name}')
    if current.exists() and not current.is_file():
        raise ValueError(f'Target is not a regular file: {name}')
    return current


def read_archive(archive: Path) -> tuple[dict, dict[str, bytes]]:
    payload: dict[str, bytes] = {}
    if not archive.is_file() or archive.stat().st_size > MAX_TOTAL:
        raise ValueError('Archive is not a bounded regular ZIP file')
    with zipfile.ZipFile(archive) as z:
        infos = z.infolist()
        if len(infos) > 2000 or sum(i.file_size for i in infos) > MAX_TOTAL:
            raise ValueError('Archive exceeds the knowledge-kit size limit')
        folded: set[str] = set()
        for info in infos:
            if info.is_dir():
                raise ValueError('Expected a files-only overlay ZIP')
            name = safe_name(info.filename)
            folded_name = unicodedata.normalize('NFC', name).casefold()
            if folded_name in folded:
                raise ValueError('Duplicate or case-colliding archive path')
            folded.add(folded_name)
            kind = stat.S_IFMT(info.external_attr >> 16)
            if kind not in (0, stat.S_IFREG):
                raise ValueError(f'Non-regular archive entry: {name}')
            if info.file_size > MAX_FILE or info.flag_bits & 1:
                raise ValueError('Oversized or encrypted archive entry')
            data = z.read(info)
            if len(data) != info.file_size:
                raise ValueError('Archive size mismatch')
            payload[name] = data
    if MANIFEST not in payload:
        raise ValueError('Overlay manifest is missing')
    try:
        manifest = json.loads(payload[MANIFEST])
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError('Manifest is not valid UTF-8 JSON') from None
    if not isinstance(manifest, dict):
        raise ValueError('Manifest must be an object')
    if (manifest.get('schemaVersion') != 1 or manifest.get('repository') != 'otto-assistant/polyth'
            or not re.fullmatch('[a-f0-9]{40}', str(manifest.get('baseline', '')))
            or not isinstance(manifest.get('files'), list)):
        raise ValueError('Unsupported overlay manifest')
    expected = set()
    for row in manifest['files']:
        if not isinstance(row, dict):
            raise ValueError('Manifest file entry must be an object')
        name = safe_name(row.get('path'))
        if name == MANIFEST or name in expected:
            raise ValueError('Duplicate/self-referential manifest entry')
        expected.add(name)
        old = row.get('originalGitBlob')
        if old is not None and not re.fullmatch('[a-f0-9]{40}', str(old)):
            raise ValueError('Invalid original blob hash')
        if name not in payload or not re.fullmatch('[a-f0-9]{64}', str(row.get('sha256', ''))):
            raise ValueError('Missing file or invalid payload hash')
        if sha256(payload[name]) != row['sha256']:
            raise ValueError(f'Payload checksum mismatch: {name}')
    if expected != set(payload) - {MANIFEST}:
        raise ValueError('Unlisted or missing archive files')
    return manifest, payload


def git(repo: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    result = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
                             '-c', f'core.hooksPath={os.devnull}', '-C', str(repo), *args],
                            capture_output=True, text=True, timeout=15, env=env, check=False)
    if result.returncode:
        raise ValueError(f'Read-only Git operation failed ({args[0]}); check repository/Git availability')
    return result.stdout


def preflight(archive: Path, root: Path) -> dict:
    repo = root.resolve(strict=True)
    if not repo.is_dir():
        raise ValueError('Target must be a repository directory')
    actual_root = Path(git(repo, 'rev-parse', '--show-toplevel').strip()).resolve()
    if actual_root != repo:
        raise ValueError('Target must be the repository root, not a subdirectory')
    package_path = repo / 'package.json'
    if package_path.is_symlink() or not package_path.is_file() or package_path.stat().st_size > MAX_FILE:
        raise ValueError('Expected a regular bounded root package.json')
    try:
        package = json.loads(package_path.read_bytes())
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError('Invalid root package.json') from None
    if not isinstance(package, dict) or package.get('name') != 'polyth':
        raise ValueError('Target package.json is not Polyth')
    manifest, payload = read_archive(archive)
    head = git(repo, 'rev-parse', '--verify', 'HEAD').strip()
    rows = list(manifest['files']) + [{'path': MANIFEST, 'originalGitBlob': None, 'sha256': sha256(payload[MANIFEST])}]
    changes, unchanged, conflicts = [], [], []
    for row in rows:
        name = row['path']
        target = destination(repo, name)
        if target.exists() and target.stat().st_size > MAX_FILE:
            conflicts.append(f'Target too large: {name}'); continue
        old_data = target.read_bytes() if target.exists() else None
        if old_data == payload[name]:
            unchanged.append(name); continue
        old_hash = row.get('originalGitBlob')
        if old_data is None and old_hash:
            conflicts.append(f'Expected original is missing: {name}'); continue
        if old_data is not None:
            matches = old_hash and (git_blob(old_data) == old_hash or git_blob(old_data.replace(b'\r\n', b'\n')) == old_hash)
            if not matches:
                conflicts.append(f'Existing file differs from reviewed original: {name}'); continue
        changes.append({'path': name, 'before': old_data, 'after': payload[name],
                        'mode': stat.S_IMODE(target.stat().st_mode) if old_data is not None else 0o644})
    if changes:
        # Only managed targets that would change can block installation; unrelated work is untouched.
        dirty = git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', *[c['path'] for c in changes])
        if dirty:
            conflicts.append('At least one managed target has staged/unstaged/untracked changes; review/commit it first')
    if conflicts:
        raise ValueError('Preflight refused:\n' + '\n'.join(conflicts))
    return {'repo': repo, 'archive': archive.resolve(), 'archiveSha256': sha256(archive.read_bytes()),
            'manifest': manifest, 'head': head, 'changes': changes, 'unchanged': unchanged,
            'baselineMatches': head == manifest['baseline']}


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix='.agent-kit-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def apply_plan(plan: dict, backup_dir: Path | None = None) -> Path | None:
    if not plan['changes']:
        return None
    repo = plan['repo']
    if backup_dir is None:
        backup = Path(tempfile.mkdtemp(prefix='polyth-agent-kit-backup-')).resolve()
    else:
        backup = backup_dir.resolve()
        if backup == repo or repo in backup.parents:
            raise ValueError('Backup must be outside the repository')
        if backup.exists() and (not backup.is_dir() or any(backup.iterdir())):
            raise ValueError('Backup directory must be new or empty')
        backup.mkdir(parents=True, exist_ok=True)
    os.chmod(backup, 0o700)
    record = {'archiveSha256': plan['archiveSha256'], 'headBefore': plan['head'], 'files': []}
    for c in plan['changes']:
        if c['before'] is not None:
            file = backup / 'files' / c['path']
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(c['before'])
        record['files'].append({'path': c['path'], 'existed': c['before'] is not None,
                                'beforeSha256': sha256(c['before']) if c['before'] is not None else None,
                                'installedSha256': sha256(c['after']), 'mode': c['mode']})
    (backup / 'backup-manifest.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    applied = []
    try:
        for c in plan['changes']:
            target = destination(repo, c['path'])
            now = target.read_bytes() if target.exists() else None
            if now != c['before']:
                raise ValueError(f'Target changed after preflight: {c["path"]}')
            atomic_write(target, c['after'], c['mode'])
            applied.append(c)
    except Exception as error:
        rollback_errors = []
        for c in reversed(applied):
            try:
                target = destination(repo, c['path'])
                if not target.exists() or target.read_bytes() != c['after']:
                    raise ValueError('Concurrent modification; not overwritten by rollback')
                if c['before'] is None:
                    target.unlink()
                else:
                    atomic_write(target, c['before'], c['mode'])
            except Exception:
                rollback_errors.append(c['path'])
        extra = f'; inspect rollback conflicts: {", ".join(rollback_errors)}' if rollback_errors else '; applied files rolled back'
        raise ValueError(f'Installation failed: {error}{extra}. Backup: {backup}') from error
    return backup


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('repo', type=Path)
    parser.add_argument('--apply', action='store_true', help='Write after all preflight checks; default is read-only')
    parser.add_argument('--backup-dir', type=Path, help='Optional new/empty directory outside the repo')
    args = parser.parse_args(argv)
    if args.backup_dir and not args.apply:
        parser.error('--backup-dir is used only with --apply')
    try:
        plan = preflight(args.archive, args.repo)
        print(f'Repository: {plan["repo"]}\nHEAD: {plan["head"]}\nAudit baseline: {plan["manifest"]["baseline"]}')
        print(f'Would change: {len(plan["changes"])}; already identical: {len(plan["unchanged"])}')
        if not plan['baselineMatches']:
            print('NOTICE: HEAD differs from audit baseline; original target bytes passed compatibility checks. Review source drift after installation.')
        for c in plan['changes']:
            print(('REPLACE ' if c['before'] is not None else 'ADD     ') + c['path'])
        if args.apply:
            backup = apply_plan(plan, args.backup_dir)
            print(f'Applied. Backup: {backup}' if backup else 'Already applied; no files changed.')
            print('No git staging, commit, push, dependency installation or runtime operation was performed.')
        else:
            print('DRY RUN: no files changed. Re-run with --apply after reviewing the list.')
        return 0
    except (ValueError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f'agent-kit-install: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
