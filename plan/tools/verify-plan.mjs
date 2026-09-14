// Read-only by default. --write-graph explicitly refreshes DEPENDENCIES.md.
import fs from 'node:fs';
import path from 'node:path';

const root = fs.existsSync('ROADMAP.md') ? '.' : 'plan';
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const issues = [];
const report = (file, reason) => issues.push(`${file}: ${reason}`);
const rows = new Map();
const milestones = [];
let milestone;
for (const line of read('ROADMAP.md').split('\n')) {
  const heading = line.match(/^### (M\d+) — .*?\(`([^`]+)`\)/);
  if (heading) {
    milestone = { id: heading[1], folder: heading[2].replace(/\/$/, ''), steps: [] };
    milestones.push(milestone);
  }
  const row = line.match(/^\| (M\d+-\d\d) \| (.*?) \| ([\d.]+) \| (.*?) \| (.*?) \|$/);
  if (!row) continue;
  if (!milestone || !row[1].startsWith(`${milestone.id}-`)) {
    report('ROADMAP.md', `misplaced step ${row[1]}`); continue;
  }
  if (rows.has(row[1])) report('ROADMAP.md', `duplicate step ${row[1]}`);
  const dependencyText = row[4];
  if (dependencyText !== '—' && !/^M\d+-\d\d(?:, M\d+-\d\d)*$/.test(dependencyText)) {
    report(row[1], 'dependencies must be explicit IDs separated by comma-space; no ranges/all/parallel prose');
  }
  const dependencies = dependencyText === '—' ? [] : dependencyText.split(', ');
  if (new Set(dependencies).size !== dependencies.length) report(row[1], 'duplicate dependency');
  const record = { id: row[1], title: row[2], effort: Number(row[3]), dependencies,
    optional: /\*\*gated\*\*/i.test(row[5]), milestone };
  rows.set(record.id, record); milestone.steps.push(record);
}
if (!rows.size) report('ROADMAP.md', 'no steps parsed');
const sections = ['Goal','Why','Scope','Design','Tasks','Tests','Acceptance criteria','Risks / open questions','Notes & progress log'];
const progress = read('PROGRESS.md');
const routing = read('AGENT_ROUTING.md');
const numericSum = records => records.reduce((sum, record) => sum + record.effort, 0);
let files = 0;
for (const m of milestones) {
  const folder = path.join(root, m.folder);
  const names = fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => /^step-.*\.md$/.test(name)) : [];
  if (names.length !== m.steps.length) report(m.folder, 'step file count differs from roadmap');
  const readmeFile = `${m.folder}/README.md`;
  if (!fs.existsSync(path.join(root, readmeFile))) { report(readmeFile, 'missing'); continue; }
  const readme = read(readmeFile);
  const count = readme.match(/^\| Steps \| (\d+)/m);
  if (!count || Number(count[1]) !== m.steps.length) report(readmeFile, 'step count mismatch');
  const effort = readme.match(/^\| Effort \| ([\d.]+)/m);
  if (!effort || Number(effort[1]) !== numericSum(m.steps)) report(readmeFile, 'effort sum mismatch');
  for (const s of m.steps) {
    const matches = names.filter(name => fs.readFileSync(path.join(folder, name), 'utf8').startsWith(`# Step ${s.id} — `));
    if (matches.length !== 1) { report(s.id, `expected one matching file, found ${matches.length}`); continue; }
    s.file = `${m.folder}/${matches[0]}`;
    const text = read(s.file); files++;
    for (const [index, section] of sections.entries()) {
      if (!text.includes(`## ${index + 1}. ${section}`)) report(s.file, `missing section ${section}`);
    }
    if (!text.startsWith(`# Step ${s.id} — ${s.title}\n`)) report(s.file, 'title differs from roadmap');
    const headerDeps = text.match(/^\| Depends on \| (.*?) \|$/m)?.[1];
    if (headerDeps !== (s.dependencies.join(', ') || '—')) report(s.file, 'dependencies differ from roadmap');
    if (Number(text.match(/^\| Estimated effort \| ([\d.]+)/m)?.[1]) !== s.effort) report(s.file, 'effort differs from roadmap');
    const status = text.match(/^\| Status \| (⬜|🟨|🧪|✅|⛔|⏸)/m)?.[1];
    if (!status) report(s.file, 'missing status');
    const testIds = [...text.matchAll(/^\| (TC-M\d+-\d\d-\d\d) \|/gm)].map(match => match[1]);
    if (testIds.length < 5) report(s.file, 'fewer than five manual cases');
    if (new Set(testIds).size !== testIds.length) report(s.file, 'duplicate manual test IDs');
    if (testIds.some(id => !id.startsWith(`TC-${s.id}-`))) report(s.file, 'manual test ID belongs to another step');
    if (/<X>|<NN>|<Title>|<milestone name>/.test(text)) report(s.file, 'template placeholder');
    for (const [file, content] of [['PROGRESS.md', progress], ['AGENT_ROUTING.md', routing], [readmeFile, readme]]) {
      const lines = content.split('\n').filter(line => line.startsWith(`| ${s.id} |`));
      if (lines.length !== 1) report(file, `expected one row for ${s.id}`);
      if (lines.length === 1 && !lines[0].includes(matches[0])) report(file, `missing/wrong file link for ${s.id}`);
      if (file === 'PROGRESS.md' && lines.length === 1) {
        const cells = lines[0].split('|').map(cell => cell.trim());
        if (cells[5] !== status) report(file, `status mismatch for ${s.id}`);
        if (Number(cells[4].replace(/ d$/, '')) !== s.effort) report(file, `effort mismatch for ${s.id}`);
      }
      if (file === readmeFile && lines.length === 1 && !lines[0].endsWith(`| ${headerDeps} |`)) report(file, `dependency mismatch for ${s.id}`);
    }
    for (const dep of s.dependencies) {
      if (!rows.has(dep)) report(s.id, `unknown dependency ${dep}`);
      else if (dep === s.id) report(s.id, 'self dependency');
      else if (rows.get(dep).optional) report(s.id, `depends on optional gated step ${dep}`);
    }
  }
}
// Actual cycle detection permits legitimate forward-numbered prerequisites.
const done = new Set();
const active = [];
const order = [];
function visit(id) {
  if (done.has(id) || !rows.has(id)) return;
  if (active.includes(id)) { report('dependency graph', `cycle: ${[...active.slice(active.indexOf(id)), id].join(' → ')}`); return; }
  active.push(id);
  for (const dep of rows.get(id).dependencies) visit(dep);
  active.pop(); done.add(id); order.push(id);
}
for (const id of rows.keys()) visit(id);
const required = [...rows.values()].filter(s => !s.optional);
const total = numericSum([...rows.values()]);
const graph = [
  '# Generated step dependency graph', '',
  'Generated from ROADMAP.md by `node plan/tools/verify-plan.mjs --write-graph`. IDs are stable; prerequisites determine execution order. Optional gates also require their documented external decisions.', '',
  `Steps: ${rows.size}; total effort: ${total} working days; required scope: ${numericSum(required)} working days. Estimates are not delivery forecasts.`, '',
  '## Topological execution order', '',
  '| Order | Step | Direct prerequisites | Effort | Release scope |', '|---|---|---|---|---|',
  ...order.map((id, index) => { const s = rows.get(id); return `| ${index + 1} | [${id}: ${s.title}](${s.file}) | ${s.dependencies.join(', ') || '—'} | ${s.effort} d | ${s.optional ? 'Optional gated' : 'Required'} |`; }), '',
  '## Complete graph', '', '```mermaid', 'flowchart TD',
  ...[...rows.values()].map(s => `  ${s.id.replace('-', '_')}["${s.id}${s.optional ? ' optional' : ''}"]`),
  ...[...rows.values()].flatMap(s => s.dependencies.map(dep => `  ${dep.replace('-', '_')} --> ${s.id.replace('-', '_')}`)), '```', '',
].join('\n');
if (!issues.length && process.argv.includes('--write-graph')) fs.writeFileSync(path.join(root, 'DEPENDENCIES.md'), graph);
else if (!issues.length && (!fs.existsSync(path.join(root, 'DEPENDENCIES.md')) || read('DEPENDENCIES.md') !== graph)) report('DEPENDENCIES.md', 'missing or stale; run --write-graph');
for (const issue of issues) console.error(`  ✗ ${issue}`);
console.log(`Checked ${files} step files across ${milestones.length} milestones; ${total} d total, ${numericSum(required)} d required; ${issues.length} problem(s). Structural checks do not establish runtime feasibility.`);
process.exitCode = issues.length ? 1 : 0;
