const base='http://127.0.0.1:17866';
const args=process.argv.slice(2);
if(!args.length){console.log('用法: node run.mjs MW-UI-014 [MW-UI-015 ...]；全量: --all。默认仅热测；冷→热两轮追加 --restart-confirmed（确认已手动重启）或 --launch-after-exit（已托盘退出，由控制台启动）。');process.exit(1);}
const manual=args.includes('--restart-confirmed'),launch=args.includes('--launch-after-exit');
if(manual&&launch)throw new Error('两种重启方式只能选择一个');
const caseArgs=args.filter(a=>!['--restart-confirmed','--launch-after-exit'].includes(a));
const state=await fetch(base+'/api/state').then(r=>r.json());
const ids=caseArgs[0]==='--all'?state.catalog.map(c=>c.id):caseArgs;
const response=await fetch(base+(manual||launch?'/api/combined-run':'/api/run'),{method:'POST',headers:{'Content-Type':'application/json','X-MW-CSRF':state.csrf},body:JSON.stringify({ids,...(manual||launch?{restart:manual?'manual':'launch'}:{})})});
const run=await response.json();if(!response.ok)throw new Error(run.error);
console.log('已提交至本机串行队列；记录 runs/'+run.id+'.json');
