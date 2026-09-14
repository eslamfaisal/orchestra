import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const executable = path.join(root, 'node_modules/.bin/depcruise');

function inspect(t, importer, content, extra = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-boundaries-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, '.dependency-cruiser.cjs'), path.join(cwd, '.dependency-cruiser.cjs'));
  fs.copyFileSync(path.join(root, 'tsconfig.base.json'), path.join(cwd, 'tsconfig.base.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(cwd, 'node_modules'), 'dir');
  const modules = {
    'packages/core/src/index.ts': 'export interface Entity { id: string }; export const value = 1;',
    'packages/sdk/src/index.ts': 'export const value = 1;',
    'packages/ui/src/index.ts': 'export const value = 1;',
    'packages/providers/codex/src/index.ts': 'export const value = 1;',
    'apps/daemon/src/index.ts': 'export const value = 1;',
    'apps/daemon/src/infrastructure/index.ts': 'export const value = 1;',
    'apps/daemon/src/interface/index.ts': 'export const value = 1;',
    ...extra,
    [importer]: content,
  };
  for (const [file, body] of Object.entries(modules)) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  // pnpm dependencies are package-local; mirror only the two core allowlisted modules.
  fs.mkdirSync(path.join(cwd, 'packages/core/node_modules'), { recursive: true });
  for (const name of ['zod', 'neverthrow']) {
    fs.symlinkSync(path.join(root, 'packages/core/node_modules', name), path.join(cwd, 'packages/core/node_modules', name), 'dir');
  }
  const run = spawnSync(executable, ['--config', '.dependency-cruiser.cjs', '--output-type', 'json', importer], { cwd, encoding: 'utf8' });
  assert.ifError(run.error);
  assert.ok(run.stdout, run.stderr);
  const result = JSON.parse(run.stdout);
  return { status: run.status, rules: result.summary.violations.map(violation => violation.rule.name) };
}

const denied = [
  ['core rejects Node builtins', 'packages/core/src/check.ts', "import 'node:fs';", 'core-allowed-deps'],
  ['core rejects sibling SDK', 'packages/core/src/check.ts', "import '@orchestra/sdk';", 'core-allowed-deps'],
  ['core rejects undeclared npm dependencies', 'packages/core/src/check.ts', "import 'typescript';", 'core-allowed-deps'],
  ['SDK rejects UI', 'packages/sdk/src/check.ts', "import '@orchestra/ui';", 'sdk-only-core'],
  ['SDK rejects runtime core dependency', 'packages/sdk/src/check.ts', "import '@orchestra/core';", 'sdk-core-types-only'],
  ['provider rejects core', 'packages/providers/claude/src/check.ts', "import '@orchestra/core';", 'providers-only-sdk'],
  ['provider rejects peer adapter', 'packages/providers/claude/src/check.ts', "import '@orchestra/provider-codex';", 'providers-only-sdk'],
  ['application rejects infrastructure', 'apps/daemon/src/application/check.ts', "import '../infrastructure/index.js';", 'daemon-layering'],
  ['domain rejects interface', 'apps/daemon/src/core/check.ts', "import '../interface/index.js';", 'daemon-layering'],
  ['web rejects daemon', 'apps/web/src/check.ts', "import '../../daemon/src/index.js';", 'web-no-daemon'],
  ['UI cannot spawn processes', 'packages/ui/src/check.ts', "import 'node:child_process';", 'no-child-process-outside-infra'],
  ['unresolved import cannot bypass checks', 'packages/ui/src/check.ts', "import './missing.js';", 'no-unresolved'],
];
for (const [name, importer, code, rule] of denied) {
  test(name, t => {
    const result = inspect(t, importer, code);
    assert.notEqual(result.status, 0);
    assert.ok(result.rules.includes(rule), `${rule} missing: ${result.rules.join(', ')}`);
  });
}
const allowed = [
  ['core accepts Zod and neverthrow', 'packages/core/src/check.ts', "import { z } from 'zod'; import { ok } from 'neverthrow'; export const result = ok(z.string().parse('ok'));"],
  ['core accepts its own modules', 'packages/core/src/check.ts', "export { value } from './index.js';"],
  ['SDK accepts core types', 'packages/sdk/src/check.ts', "import type { Entity } from '@orchestra/core'; export type Record = Entity;"],
  ['provider accepts SDK', 'packages/providers/claude/src/check.ts', "export { value } from '@orchestra/sdk';"],
  ['provider accepts own module', 'packages/providers/codex/src/check.ts', "export { value } from './index.js';"],
  ['infrastructure may spawn', 'apps/daemon/src/infrastructure/check.ts', "import 'node:child_process';"],
  ['fake provider may spawn', 'packages/sdk/src/fake/check.ts', "import 'node:child_process';"],
  ['CLI may spawn', 'apps/cli/src/check.ts', "import 'child_process';"],
];
for (const [name, importer, code] of allowed) {
  test(name, t => {
    const result = inspect(t, importer, code);
    assert.equal(result.status, 0, result.rules.join(', '));
    assert.deepEqual(result.rules, []);
  });
}
