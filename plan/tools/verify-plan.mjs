// Verifies plan structure: run from plan/ or repo root:  node plan/tools/verify-plan.mjs
// Checks: every ROADMAP step has a template-conformant file, PROGRESS/AGENT_ROUTING rows exist,
// dependencies reference existing earlier steps (no forward/self references), and gated steps are not depended on.
import fs from 'node:fs'; import path from 'node:path';
const root = fs.existsSync('ROADMAP.md') ? '.' : 'plan';
const read = f => fs.readFileSync(path.join(root,f),'utf8');
const md = read('ROADMAP.md').split('\n');
const slug = t => t.toLowerCase().replace(/&/g,'and').replace(/[()]/g,'').replace(/[^a-z0-9 ]+/g,' ').trim().replace(/\s+/g,'-');
const ms=[]; let cur=null;
for (const line of md){ const h=line.match(/^### (M\d+) — (.+?) \(`(.+?)`\)/); if(h){cur={id:h[1],folder:h[2]&&h[3].replace(/\/$/,''),steps:[]};ms.push(cur);continue;}
  const r=cur&&line.match(/^\| (M\d+-\d\d) \| (.+?) \| ([\d.]+) \| (.+?) \| (.+?) \|$/); if(r) cur.steps.push({id:r[1],title:r[2],effort:Number(r[3]),depends:r[4],scope:r[5],file:`step-${r[1].split('-')[1]}-${slug(r[2])}.md`}); }
const headings=['## 1. Goal','## 2. Why','## 3. Scope','## 4. Design','## 5. Tasks','## 6. Tests','## 7. Acceptance criteria','## 8. Risks / open questions','## 9. Notes & progress log'];
let problems=0, files=0, lines=0;
const report=(f,msg)=>{problems++; console.log(`  ✗ ${f}: ${msg}`);};
const order=new Map(); let n=0; for(const m of ms) for(const s of m.steps) order.set(s.id,n++);
const gated=new Set(); for(const m of ms) for(const s of m.steps) if(/\*\*gated\*\*/i.test(s.scope)) gated.add(s.id);
const progress=read('PROGRESS.md'), routing=fs.existsSync(path.join(root,'AGENT_ROUTING.md'))?read('AGENT_ROUTING.md'):'';
for (const m of ms){ const dir=path.join(root,m.folder); const readme=path.join(dir,'README.md');
  if(!fs.existsSync(readme)) report(m.folder+'/README.md','missing');
  for (const s of m.steps){ const f=path.join(dir,s.file);
    // dependency graph
    const deps=(s.depends.match(/M\d+-\d\d/g)||[]);
    const ranges=(s.depends.match(/(M\d+)-(\d\d)\.\.(\d\d)/g)||[]);
    for(const rg of ranges){ const [,m1,a,b]=rg.match(/(M\d+)-(\d\d)\.\.(\d\d)/); for(let i=Number(a);i<=Number(b);i++) deps.push(`${m1}-${String(i).padStart(2,'0')}`); }
    for(const d of new Set(deps)){
      if(!order.has(d)) report(`ROADMAP ${s.id}`,`depends on unknown step ${d}`);
      else if(d===s.id) report(`ROADMAP ${s.id}`,'depends on itself');
      else if(order.get(d)>order.get(s.id) && !new RegExp(`after\\s+${d}`).test(s.depends)) report(`ROADMAP ${s.id}`,`depends on later step ${d} (order inconsistent; write "after ${d}" if intended)`);
      if(gated.has(d)) report(`ROADMAP ${s.id}`,`depends on gated step ${d}`);
    }
    if(!progress.includes(`| ${s.id} |`)) report('PROGRESS.md',`no row for ${s.id}`);
    if(routing && !routing.includes(`| ${s.id} |`)) report('AGENT_ROUTING.md',`no row for ${s.id}`);
    if(!fs.existsSync(f)){report(f,'missing');continue;}
    const txt=fs.readFileSync(f,'utf8'); files++; lines+=txt.split('\n').length;
    for(const h of headings) if(!txt.includes(h)) report(f,`missing heading "${h}"`);
    if(!/\| Status \| [⬜🟨🧪✅⛔⏸]/.test(txt)) report(f,'no status line');
    const tcs=(txt.match(/\| TC-M\d+-\d\d-\d\d \|/g)||[]).length; if(tcs<5) report(f,`only ${tcs} manual test cases`);
    if(/<X>|<NN>|<Title>|<milestone name>/.test(txt)) report(f,'template placeholder left');
    if(!txt.includes(`# Step ${s.id}`)) report(f,`title does not start with "# Step ${s.id}"`);
    // gated steps must not be required by milestone READMEs / acceptance text of other steps
  } }
// milestone READMEs must not require gated steps as entry conditions
for (const m of ms){ const readme=path.join(root,m.folder,'README.md'); if(!fs.existsSync(readme)) continue; const t=fs.readFileSync(readme,'utf8');
  for(const g of gated){ if(m.steps.some(s=>s.id===g)) continue; const re=new RegExp(`${g}[^|\\n]*✅`); if(re.test(t)) report(readme,`entry condition requires gated step ${g}`); } }
const total=ms.reduce((a,m)=>a+m.steps.reduce((b,s)=>b+s.effort,0),0);
console.log(`checked ${files} step files (${lines} lines) across ${ms.length} milestones, ${order.size} steps, ${total} d of estimates, gated: ${[...gated].join(', ')||'none'}; ${problems} problem(s)`);
process.exit(problems?1:0);
