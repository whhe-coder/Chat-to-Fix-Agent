import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(process.argv[2]); const out = process.argv[3];
const rel = p => path.relative(root, p);
const re = /(?:from\s*|import\s*\(\s*|import\s+|export\s+\*\s+from\s*|export\s*\{[^}]*\}\s*from\s*)['"]([^'"]+)['"]/g;
const urlRe = /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g;
const list = d => { const o=[]; const w=d=>{ if(!fs.existsSync(d))return; for(const f of fs.readdirSync(d,{withFileTypes:true})){ if(f.name==='node_modules')continue; const p=path.join(d,f.name); if(f.isDirectory()) w(p); else o.push(p);} }; w(d); return o; };
const isJs = p => /\.(m?js|cjs)$/.test(p);
const lines = p => fs.readFileSync(p,'utf8').split('\n').length;
const ext = new Map(); const assets = new Set(); const unresolved = [];
function resolve(from, spec){ let p=path.resolve(path.dirname(from), spec); if(fs.existsSync(p)&&fs.statSync(p).isDirectory()) p=path.join(p,'index.js'); if(!fs.existsSync(p)&&fs.existsSync(p+'.js')) p+='.js'; return fs.existsSync(p)?p:null; }
function reach(seeds){ const seen=new Set(); const q=[...seeds]; while(q.length){ const f=q.pop(); if(seen.has(f)) continue; seen.add(f); if(!isJs(f)) continue; const t=fs.readFileSync(f,'utf8');
  for(const m of t.matchAll(re)){ const s=m[1]; if(s.startsWith('.')){ const p=resolve(f,s); if(p) q.push(p); else unresolved.push(rel(f)+' -> '+s); } else if(!s.startsWith('node:')){ const pk=s.startsWith('@')?s.split('/').slice(0,2).join('/'):s.split('/')[0]; if(!ext.has(pk)) ext.set(pk,new Set()); ext.get(pk).add(rel(f)); } }
  for(const m of t.matchAll(urlRe)){ const p=path.resolve(path.dirname(f),m[1]); if(fs.existsSync(p)){ if(fs.statSync(p).isDirectory()) list(p).forEach(x=>{assets.add(x); q.push(x)}); else { assets.add(p); q.push(p);} } } }
  return seen; }
const runtime = reach(list(path.join(root,'src')).filter(isJs));
const extRuntime = new Map([...ext].map(([k,v])=>[k,new Set(v)]));
const devSeeds = [...list(path.join(root,'test')), ...list(path.join(root,'scripts')), path.join(root,'bot/test/harness-resolve.mjs')].filter(isJs);
const dev = reach(devSeeds);
const bot = list(path.join(root,'bot')).filter(p=>!rel(p).startsWith('bot/node_modules'));
const rows=[]; for(const p of bot){ const r=rel(p); const cls = runtime.has(p)?'runtime':dev.has(p)?'test-support':'unused'; rows.push({r,cls,js:isJs(p),n:isJs(p)||/\.(md|json|ya?ml|txt|css|html)$/.test(p)?lines(p):0}); }
// bot tests classification
const botSrc = path.join(root,'bot','src')+path.sep;
const tests = list(path.join(root,'bot','test')).filter(p=>p.endsWith('.test.js')).map(p=>{ const deps=[...reach([p])].filter(f=>f.startsWith(botSrc)); const u=deps.filter(f=>runtime.has(f)).length; return {r:rel(p),n:lines(p),deps:deps.length,used:u,cls: deps.length===0?'no-src':u===deps.length?'only-used':u===0?'only-unused':'mixed'}; });
fs.writeFileSync(out, JSON.stringify({rows,tests,ext:Object.fromEntries([...extRuntime].map(([k,v])=>[k,[...v]])),assets:[...assets].map(rel).filter(a=>a.startsWith('bot/')),unresolved},null,1));
const sum=(a,f)=>a.reduce((s,x)=>s+f(x),0);
for(const c of ['runtime','test-support','unused']){ const a=rows.filter(x=>x.cls===c); console.log(c, a.length,'files', sum(a.filter(x=>x.js),x=>x.n),'js lines', a.filter(x=>!x.js).length,'non-js files'); }
for(const c of ['only-used','mixed','only-unused','no-src']){ const a=tests.filter(x=>x.cls===c); console.log('bot test',c,a.length,'files',sum(a,x=>x.n),'lines'); }
console.log('external pkgs from runtime:', [...extRuntime.keys()].join(', '));
console.log('assets:', [...assets].map(rel).filter(a=>a.startsWith('bot/')).join(', '));
console.log('unresolved:', unresolved.slice(0,10));
