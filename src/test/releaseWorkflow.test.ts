import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { load } from 'js-yaml';

const root = path.resolve(__dirname, '..', '..');
const workflow = load(fs.readFileSync(path.join(root, '.github/workflows/release-vsix.yml'), 'utf8')) as any;
const steps: any[] = workflow.jobs.release.steps;
const version: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const step = (name: string): any => {
  const found = steps.find((item) => item.name === name);
  assert.ok(found, `missing workflow step: ${name}`);
  return found;
};

test('package and lockfile versions match', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('main updates and manual dispatch build and upload a VSIX after tests', () => {
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.equal(step('Check out the triggering commit').with.ref, '${{ github.sha }}');
  const commands = steps.map((item) => item.run);
  assert.ok(commands.indexOf('npm ci') >= 0);
  assert.ok(commands.indexOf('npm ci') < commands.indexOf('npm test'));
  assert.ok(commands.indexOf('npm test') < commands.indexOf('npm run package'));
  const upload = step('Upload VSIX build artifact');
  assert.equal(upload.uses, 'actions/upload-artifact@v4');
  assert.equal(upload.with.path, 'coding-harness.vsix');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.match(upload.with.name, /github\.sha/);
  assert.ok(steps.indexOf(upload) > commands.indexOf('npm run package'));
});

test('publishing is limited to main and never replaces an existing tag', () => {
  const check = step('Check whether this version can be released');
  const release = step('Create GitHub release');
  assert.match(check.if, /refs\/heads\/main/);
  assert.match(release.if, /refs\/heads\/main/);
  assert.match(release.if, /release_check\.outputs\.publish == 'true'/);
  assert.match(release.run, /gh release create/);
  assert.match(release.run, /--target "\$GITHUB_SHA"/);
  assert.doesNotMatch(release.run, /--clobber|release delete|tag -f/);
});

test('tag check publishes new versions, skips existing versions, and surfaces git failures', () => {
  const check = step('Check whether this version can be released');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-release-check-'));
  try {
    const git = path.join(dir, 'git');
    fs.writeFileSync(git, `#!/bin/sh
[ "$1" = ls-remote ] && [ "$2" = --tags ] && [ "$3" = origin ] && [ "$4" = "refs/tags/v$VERSION" ] || exit 42
case "$STUB_TAG" in
  existing) printf 'a123 refs/tags/v%s\\n' "$VERSION" ;;
  failure) echo 'remote unavailable' >&2; exit 1 ;;
esac
`, { mode: 0o755 });
    for (const [mode, expected] of [['new', 'publish=true'], ['existing', 'publish=false'], ['failure', undefined]] as const) {
      const outputFile = path.join(dir, `${mode}.txt`);
      fs.writeFileSync(outputFile, '');
      const proc = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', check.run], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, VERSION: version, GITHUB_OUTPUT: outputFile, STUB_TAG: mode },
      });
      if (expected) {
        assert.equal(proc.status, 0, proc.stderr);
        assert.equal(fs.readFileSync(outputFile, 'utf8').trim(), expected);
        if (mode === 'existing') assert.match(proc.stdout, /already exists/);
      } else {
        assert.notEqual(proc.status, 0);
        assert.match(proc.stderr, /remote unavailable/);
        assert.equal(fs.readFileSync(outputFile, 'utf8'), '');
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
