// Verifies plan structure: run from plan/ or repo root:  node plan/tools/verify-plan.mjs
import fs from 'node:fs'; import path from 'node:path';
const root = fs.existsSync('ROADMAP.md') ? '.' : 'plan';
const md = fs.readFileSync(path.join(root,'ROADMAP.md'),'utf8').split('\n');
const slug = t => t.toLowerCase().replace(/&/g,'and').replace(/[()]/g,'').replace(/[^a-z0-9 ]+/g,' ').trim().replace(/\s+/g,'-');
const ms=[]; let cur=null;
for (const line of md){ const h=line.match(/^### (M\d+) — (.+?) \(`(.+?)`\)/); if(h){cur={id:h[1],folder:h[2]&&h[3].replace(/\/$/,''),steps:[]};ms.push(cur);continue;}
  const r=cur&&line.match(/^\| (M\d+-\d\d) \| (.+?) \| ([\d.]+) \| (.+?) \| (.+?) \|$/); if(r) cur.steps.push({id:r[1],title:r[2],file:`step-${r[1].split('-')[1]}-${slug(r[2])}.md`}); }
const headings=['## 1. Goal','## 2. Why','## 3. Scope','## 4. Design','## 5. Tasks','## 6. Tests','## 7. Acceptance criteria','## 8. Risks / open questions','## 9. Notes & progress log'];
let problems=0, files=0, lines=0;
const report=(f,msg)=>{problems++; console.log(`  ✗ ${f}: ${msg}`);};
for (const m of ms){ const dir=path.join(root,m.folder); const readme=path.join(dir,'README.md');
  if(!fs.existsSync(readme)) report(m.folder+'/README.md','missing');
  for (const s of m.steps){ const f=path.join(dir,s.file); if(!fs.existsSync(f)){report(f,'missing');continue;}
    const txt=fs.readFileSync(f,'utf8'); files++; lines+=txt.split('\n').length;
    for(const h of headings) if(!txt.includes(h)) report(f,`missing heading "${h}"`);
    if(!/\| Status \| [⬜🟨🧪✅⛔⏸]/.test(txt)) report(f,'no status line');
    const tcs=(txt.match(/\| TC-M\d+-\d\d-\d\d \|/g)||[]).length; if(tcs<5) report(f,`only ${tcs} manual test cases`);
    if(/<X>|<NN>|<Title>|<milestone name>/.test(txt)) report(f,'template placeholder left');
    if(!txt.includes(`# Step ${s.id}`)) report(f,`title does not start with "# Step ${s.id}"`);
  } }
console.log(`checked ${files} step files (${lines} lines) across ${ms.length} milestones; ${problems} problem(s)`);
process.exit(problems?1:0);
