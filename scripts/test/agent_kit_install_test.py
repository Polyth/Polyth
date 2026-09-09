"""Installer tests use isolated fixture repositories; never a live checkout."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parents[1] / 'agent-kit-install.py'
spec = importlib.util.spec_from_file_location('polyth_kit_installer', SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='polyth-kit-installer-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        (self.repo / 'package.json').write_text('{"name":"polyth"}\n')
        (self.repo / 'AGENTS.md').write_text('old policy\n')
        self.git('init', '--quiet')
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--no-verify', '-m', 'fixture')
        self.head = self.git('rev-parse', 'HEAD').strip()
        self.archive = self.base / 'kit.zip'
        self.payload = {'AGENTS.md': b'new policy\n', 'docs/agents/example.md': b'# Guide\n'}
        self.make_archive()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True, text=True).stdout

    def make_archive(self, extra=None, original=None):
        manifest = {'schemaVersion': 1, 'repository': 'otto-assistant/polyth', 'baseline': self.head, 'files': [
            {'path': p, 'sha256': hashlib.sha256(data).hexdigest(),
             'originalGitBlob': installer.git_blob(b'old policy\n') if p == 'AGENTS.md' else None}
            for p, data in self.payload.items()]}
        with zipfile.ZipFile(self.archive, 'w', zipfile.ZIP_DEFLATED) as z:
            for p, data in self.payload.items():
                z.writestr(p, data)
            z.writestr(installer.MANIFEST, json.dumps(manifest))
            for p, data in (extra or {}).items():
                z.writestr(p, data)

    def test_dry_run_is_read_only(self):
        before = self.git('status', '--porcelain')
        plan = installer.preflight(self.archive, self.repo)
        self.assertEqual(len(plan['changes']), 3)
        self.assertEqual(before, self.git('status', '--porcelain'))
        self.assertFalse((self.repo / 'docs').exists())

    def test_apply_preserves_backups_and_does_not_stage(self):
        backup = installer.apply_plan(installer.preflight(self.archive, self.repo), self.base / 'backup')
        self.assertEqual((self.repo / 'AGENTS.md').read_bytes(), b'new policy\n')
        self.assertEqual((backup / 'files/AGENTS.md').read_bytes(), b'old policy\n')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), '')

    def test_second_apply_is_idempotent(self):
        installer.apply_plan(installer.preflight(self.archive, self.repo), self.base / 'backup')
        plan = installer.preflight(self.archive, self.repo)
        self.assertEqual(plan['changes'], [])
        self.assertIsNone(installer.apply_plan(plan))

    def test_modified_target_is_rejected(self):
        (self.repo / 'AGENTS.md').write_text('user local work')
        with self.assertRaisesRegex(ValueError, 'differs'):
            installer.preflight(self.archive, self.repo)

    def test_colliding_new_file_is_rejected(self):
        p = self.repo / 'docs/agents/example.md'; p.parent.mkdir(parents=True)
        p.write_text('existing user guide')
        with self.assertRaisesRegex(ValueError, 'differs'):
            installer.preflight(self.archive, self.repo)

    def test_unrelated_dirty_work_is_untouched(self):
        (self.repo / 'unrelated.txt').write_text('keep me')
        installer.apply_plan(installer.preflight(self.archive, self.repo), self.base / 'backup')
        self.assertEqual((self.repo / 'unrelated.txt').read_text(), 'keep me')

    def test_staged_target_change_is_rejected_even_if_worktree_matches_old(self):
        (self.repo / 'AGENTS.md').write_text('staged user version')
        self.git('add', 'AGENTS.md')
        (self.repo / 'AGENTS.md').write_text('old policy\n')
        with self.assertRaisesRegex(ValueError, 'staged'):
            installer.preflight(self.archive, self.repo)

    def test_unsafe_or_out_of_scope_paths_are_rejected(self):
        for path in ['../escape', '/absolute', 'C:/x', '.git/config', 'docs/agents/CON', 'packages/server/src/index.ts']:
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    installer.safe_name(path)

    def test_unlisted_extra_file_is_rejected(self):
        self.make_archive({'docs/agents/unlisted.md': b'extra'})
        with self.assertRaisesRegex(ValueError, 'Unlisted'):
            installer.read_archive(self.archive)

    def test_checksum_tampering_is_rejected(self):
        with zipfile.ZipFile(self.archive) as z:
            items = {i.filename: z.read(i) for i in z.infolist()}
        items['AGENTS.md'] = b'tampered'
        with zipfile.ZipFile(self.archive, 'w') as z:
            for p, data in items.items(): z.writestr(p, data)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            installer.read_archive(self.archive)

    def test_archive_symlink_is_rejected(self):
        info = zipfile.ZipInfo('docs/agents/link.md')
        info.create_system = 3; info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(self.archive, 'a') as z: z.writestr(info, '/tmp/outside')
        with self.assertRaisesRegex(ValueError, 'Non-regular'):
            installer.read_archive(self.archive)

    def test_target_symlink_parent_is_rejected(self):
        outside = self.base / 'outside'; outside.mkdir()
        try:
            (self.repo / 'docs').symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('symlink privileges unavailable')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            installer.preflight(self.archive, self.repo)

    def test_backup_inside_repo_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            installer.apply_plan(installer.preflight(self.archive, self.repo), self.repo / 'backup')

    def test_change_between_preflight_and_apply_is_not_overwritten(self):
        plan = installer.preflight(self.archive, self.repo)
        (self.repo / 'AGENTS.md').write_text('concurrent edit')
        with self.assertRaisesRegex(ValueError, 'changed after preflight'):
            installer.apply_plan(plan, self.base / 'backup')
        self.assertEqual((self.repo / 'AGENTS.md').read_text(), 'concurrent edit')

    def test_partial_write_failure_rolls_back_applied_files(self):
        plan = installer.preflight(self.archive, self.repo)
        original = installer.atomic_write
        count = [0]
        def fail_once(path, data, mode):
            count[0] += 1
            if count[0] == 2: raise OSError('injected write failure')
            return original(path, data, mode)
        with patch.object(installer, 'atomic_write', side_effect=fail_once):
            with self.assertRaisesRegex(ValueError, 'rolled back'):
                installer.apply_plan(plan, self.base / 'backup')
        self.assertEqual((self.repo / 'AGENTS.md').read_bytes(), b'old policy\n')
        self.assertFalse((self.repo / 'docs/agents/example.md').exists())

    def test_new_head_with_unchanged_targets_is_explicit_not_silently_rebased(self):
        (self.repo / 'other.txt').write_text('new unrelated commit')
        self.git('add', 'other.txt')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--no-verify', '-m', 'later')
        plan = installer.preflight(self.archive, self.repo)
        self.assertFalse(plan['baselineMatches'])
        self.assertEqual(plan['manifest']['baseline'], self.head)

    def test_repository_subdirectory_is_rejected(self):
        sub = self.repo / 'sub'; sub.mkdir()
        with self.assertRaisesRegex(ValueError, 'root'):
            installer.preflight(self.archive, sub)

    def test_case_colliding_zip_entries_are_rejected(self):
        with zipfile.ZipFile(self.archive, 'a') as z: z.writestr('docs/agents/EXAMPLE.md', b'collision')
        with self.assertRaisesRegex(ValueError, 'case-colliding'):
            installer.read_archive(self.archive)

    def test_nonobject_manifest_is_rejected_cleanly(self):
        with zipfile.ZipFile(self.archive, 'w') as z:
            z.writestr(installer.MANIFEST, '[]')
        with self.assertRaisesRegex(ValueError, 'object'):
            installer.read_archive(self.archive)

    def test_unicode_normalization_collisions_are_rejected(self):
        with zipfile.ZipFile(self.archive, 'a') as z:
            z.writestr('docs/agents/é.md', 'first')
            z.writestr('docs/agents/e\u0301.md', 'second')
        with self.assertRaisesRegex(ValueError, 'case-colliding'):
            installer.read_archive(self.archive)


if __name__ == '__main__':
    unittest.main(verbosity=2)
