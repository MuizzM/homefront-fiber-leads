// Synthetic test of ACTUAL LiveOps query options + resume effect, using real
// TanStack Query observers. No browser/server/provider/customer data needed.
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const assert = require('node:assert/strict'); const { createRequire } = require('node:module');
const repo = process.cwd();
const requireRepo = createRequire(path.join(repo,'package.json'));
const ts = requireRepo('typescript'); const { QueryClient, QueryObserver } = requireRepo('@tanstack/react-query');
const p=path.join(repo,'client/src/pages/LiveOps.tsx'); const src=fs.readFileSync(p,'utf8');
const file=ts.createSourceFile(p,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const queries={}; let resume;
function walk(n) {
  if(ts.isVariableDeclaration(n)&&['repsQuery','presenceQuery'].includes(n.name.getText(file))) queries[n.name.getText(file)]=n.initializer.arguments[0].getText(file);
  if(ts.isCallExpression(n)&&n.expression.getText(file)==='useEffect') {
    const body=n.arguments[0]?.getText(file)||'';
    if(body.includes('wasDisplayActive')&&body.includes('invalidateQueries')) resume=body;
  }
  ts.forEachChild(n,walk);
} walk(file);
function evaluate(expression,context) {
  const js=ts.transpileModule(`const value=${expression};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return vm.runInNewContext(`(()=>{${js}\nreturn value;})()`,context);
}
const settle=()=>new Promise(r=>setImmediate(r));
async function check({streaming,effectBeforeOptions}) {
  assert.ok(resume,'LiveOps must reconcile foreground recovery explicitly');
  const qc=new QueryClient({defaultOptions:{queries:{staleTime:60000,refetchOnWindowFocus:false,retry:false}}});
  const requests=[]; const invalidations=[]; let version='first';
  const originalInvalidate=qc.invalidateQueries.bind(qc);
  qc.invalidateQueries=(...args)=>{invalidations.push(args[0].queryKey.join('/'));return originalInvalidate(...args);};
  const context={displayActive:true,streaming,REFRESH_MS:15000,qc,wasDisplayActive:{current:true},
    apiRequest:async(method,url)=>{requests.push(url);const value={version};return {json:async()=>value};}};
  const effect=()=>evaluate(resume,context)();
  const options=name=>evaluate(queries[name],context);
  const observers=Object.keys(queries).map(name=>({name,observer:new QueryObserver(qc,options(name))}));
  const unsubscribe=observers.map(({observer})=>observer.subscribe(()=>{}));
  const updateOptions=()=>observers.forEach(({name,observer})=>observer.setOptions(options(name)));
  try {
    effect(); await settle(); assert.equal(requests.length,2); assert.equal(invalidations.length,0);
    context.displayActive=false; effect(); updateOptions(); await settle();
    assert.equal(requests.length,2); assert.equal(invalidations.length,0);
    // Do not advance time: cached rows are deliberately still within 60s.
    version='changed while hidden'; context.displayActive=true;
    if(effectBeforeOptions) { effect(); updateOptions(); } else { updateOptions(); effect(); }
    await settle(); assert.equal(requests.length,4); assert.equal(invalidations.length,2);
    observers.forEach(({observer})=>assert.deepEqual(observer.getCurrentResult().data,{version:'changed while hidden'}));
    effect(); await settle(); assert.equal(requests.length,4); assert.equal(invalidations.length,2);
    return {streaming,effectBeforeOptions,initialRequests:2,resumeRequests:2,unrelatedRenderRequests:0};
  } finally {unsubscribe.forEach(fn=>fn());qc.clear();}
}
module.exports={queries,resume,evaluate,check};
