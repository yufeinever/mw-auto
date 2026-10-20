const base='http://127.0.0.1:17866';
const args=process.argv.slice(2);
if(!args.length){console.log('用法: node run.mjs MW-UI-014 [MW-UI-015 ...]；全量: node run.mjs --all。先启动控制台。');process.exit(1);}
const state=await fetch(base+'/api/state').then(r=>r.json());
const ids=args[0]==='--all'?state.catalog.map(c=>c.id):args;
const response=await fetch(base+'/api/run',{method:'POST',headers:{'Content-Type':'application/json','X-MW-CSRF':state.csrf},body:JSON.stringify({ids})});
const run=await response.json();if(!response.ok)throw new Error(run.error);
console.log('已提交至本机串行队列；记录 runs/'+run.id+'.json');
