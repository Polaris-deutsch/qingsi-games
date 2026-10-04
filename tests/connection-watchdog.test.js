const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(){const timers=new Map(),warnings=[],expired=[];let id=0;const ctx={window:{},setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),console:{warn:(...args)=>warnings.push(args)}};
vm.runInNewContext(fs.readFileSync('public/js/ui/connection-watchdog.js','utf8'),ctx);
return {timers,warnings,expired,create:()=>ctx.window.ConnectionWatchdog.create({onTimeout:c=>expired.push(c)}),fire(){const [key,timer]=timers.entries().next().value;timers.delete(key);timer.fn();}};}
test('connection retries cannot extend an outstanding response deadline',()=>{const h=harness(),watch=h.create(),context={game:'2048',roomId:'ABC',phase:'resume'};
watch.start(context);watch.start(context);assert.equal(h.timers.size,1);assert.equal([...h.timers.values()][0].ms,8000);h.fire();assert.deepEqual(h.expired,[context]);assert.deepEqual(h.warnings[0][1],context);});
test('successful responses stop deadlines; destroyed watchdogs never schedule again',()=>{const h=harness(),watch=h.create();watch.start({});watch.stop();assert.equal(h.timers.size,0);watch.start({});watch.destroy();watch.start({});assert.equal(h.timers.size,0);assert.deepEqual(h.expired,[]);});
