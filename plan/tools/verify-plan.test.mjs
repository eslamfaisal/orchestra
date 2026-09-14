import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = path.resolve(fs.existsSync('ROADMAP.md') ? '.' : 'plan');
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-plan-verifier-'));
  fs.cpSync(source, path.join(cwd, 'plan'), { recursive: true });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return {
    write(file, mutate) {
      const target = path.join(cwd, 'plan', file);
      fs.writeFileSync(target, mutate(fs.readFileSync(target, 'utf8')));
    },
    remove(file) { fs.unlinkSync(path.join(cwd, 'plan', file)); },
    run(...args) {
      const run = spawnSync(process.execPath, ['plan/tools/verify-plan.mjs', ...args], { cwd, encoding: 'utf8' });
      assert.ifError(run.error);
      return { code: run.status, output: run.stdout + run.stderr };
    },
  };
}
test('current plan passes and permits legitimate forward-numbered prerequisites', t => {
  const f = fixture(t); assert.equal(f.run().code, 0);
});
test('missing feasibility step is rejected', t => {
  const f = fixture(t); f.remove('01-m0-foundation/step-09-provider-feasibility-gates-and-evidence-matrix.md');
  const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /M0-09: expected one matching file/);
});
test('cycle is rejected even when all dependency IDs exist', t => {
  const f = fixture(t);
  f.write('ROADMAP.md', text => text.replace('| M0-01 | Monorepo scaffold & toolchain | 1.5 | — |', '| M0-01 | Monorepo scaffold & toolchain | 1.5 | M0-02 |'));
  const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /cycle: M0-01 → M0-02 → M0-01/);
});
test('required step cannot depend on a gated adapter', t => {
  const f = fixture(t);
  f.write('ROADMAP.md', text => text.replace('| M0-03 | human-run', '| M0-03, M1-07 | human-run'));
  const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /depends on optional gated step M1-07/);
});
test('ambiguous all dependency cannot silently pass', t => {
  const f = fixture(t);
  f.write('ROADMAP.md', text => text.replace('| M0-03 | human-run', '| all M0 | human-run'));
  const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /dependencies must be explicit IDs/);
});
test('unknown prerequisite is rejected', t => {
  const f = fixture(t);
  f.write('ROADMAP.md', text => text.replace('| M0-03 | human-run', '| M99-01 | human-run'));
  const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /unknown dependency M99-01/);
});
test('step header drift is rejected', t => {
  const f = fixture(t);
  f.write('01-m0-foundation/step-09-provider-feasibility-gates-and-evidence-matrix.md', text => text.replace('| Depends on | M0-03 |', '| Depends on | M0-02 |'));
  const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /dependencies differ from roadmap/);
});
test('duplicate test IDs and inconsistent milestone totals are rejected', t => {
  const f = fixture(t);
  f.write('01-m0-foundation/step-09-provider-feasibility-gates-and-evidence-matrix.md', text => text.replace('TC-M0-09-07', 'TC-M0-09-01'));
  f.write('01-m0-foundation/README.md', text => text.replace('| Effort | 20 working', '| Effort | 999 working'));
  const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /duplicate manual test IDs/); assert.match(r.output, /effort sum mismatch/);
});
test('stale generated graph fails read-only check and explicit regeneration repairs it', t => {
  const f = fixture(t); f.write('DEPENDENCIES.md', text => text + '\nStale content\n');
  const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /missing or stale/);
  assert.equal(f.run('--write-graph').code, 0); assert.equal(f.run().code, 0);
});
