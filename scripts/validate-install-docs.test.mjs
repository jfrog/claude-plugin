// Copyright (c) JFrog Ltd. 2026
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInstallDocs } from './validate-install-docs.mjs';

function writeReadme(root, body) {
  writeFileSync(join(root, 'README.md'), body);
}

test('validateInstallDocs passes when README has Verify, Recovery, and no other-plugin links', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-docs-'));
  writeReadme(root, '# Claude\n\n## Verify\n\n1. list plugins\n\n## Recovery\n\n');
  assert.deepEqual(validateInstallDocs({ repoRoot: root, harness: 'claude' }), []);
});

test('validateInstallDocs flags missing Verify section', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-docs-'));
  writeReadme(root, '# Claude\n\nInstall the plugin.\n');
  const errors = validateInstallDocs({ repoRoot: root, harness: 'claude' });
  assert.ok(errors.some((e) => e.includes('## Verify')));
});

test('validateInstallDocs flags missing Recovery section', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-docs-'));
  writeReadme(root, '# Claude\n\n## Verify\n\n1. list plugins\n');
  const errors = validateInstallDocs({ repoRoot: root, harness: 'claude' });
  assert.ok(errors.some((e) => e.includes('## Recovery')));
});

test('validateInstallDocs rejects contradictory failed-init env-var recovery claims', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-docs-'));
  writeReadme(
    root,
    '# x\n## Verify\n## Recovery\nSetting environment variables after a failed init may repair MCP registration.'
  );
  const errors = validateInstallDocs({ repoRoot: root, harness: 'claude' });
  assert.ok(errors.some((e) => e.includes('env vars repair failed init')));
});

test('validateInstallDocs rejects the legacy JFROG_URL env var', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-docs-'));
  writeReadme(root, '# Claude\n## Verify\n## Recovery\nSet `JFROG_URL` to your platform.\n');
  const errors = validateInstallDocs({ repoRoot: root, harness: 'claude' });
  assert.ok(errors.some((e) => e.includes('JFROG_URL')));
});

test('validateInstallDocs rejects links to other plugin GitHub repos', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-docs-'));
  writeReadme(
    root,
    '# Claude\n## Verify\n## Recovery\nSee https://github.com/jfrog/codex-plugin/blob/main/README.md\n'
  );
  const errors = validateInstallDocs({ repoRoot: root, harness: 'claude' });
  assert.ok(errors.some((e) => e.includes('codex-plugin')));
});

test('validateInstallDocs rejects Jira URLs and ticket keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-docs-'));
  const host = ['jfrog-int', 'atlassian', 'net'].join('.');
  const key = ['AX', '1780'].join('-');
  writeReadme(root, `# Claude\n## Verify\n## Recovery\nSee [${key}](https://${host}/browse/${key}).\n`);
  const errors = validateInstallDocs({ repoRoot: root, harness: 'claude' });
  assert.ok(errors.some((e) => e.includes('atlassian.net')));
  assert.ok(errors.some((e) => e.includes('Jira ticket keys')));
});
