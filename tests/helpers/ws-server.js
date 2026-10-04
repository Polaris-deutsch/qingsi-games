const net = require('node:net');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const WebSocket = require('ws');
exports.startServer = async function(t, setup = '') {
  const listener = net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port = listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const env = {...process.env,PORT:String(port),NODE_ENV:'test'};delete env.PUBLIC_BASE_URL;delete env.ANDROID_SKIP_REGISTRY_LOAD;
  const child=spawn(process.execPath,['-e',setup+"\nrequire('./server');"],{cwd:path.join(__dirname,'../..'),env,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);const clients=[];
  t.after(async()=>{clients.forEach(ws=>ws.terminate());if(child.exitCode===null){child.kill();await once(child,'exit');}});
  const deadline=Date.now()+6000;
  while(true){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)break;}catch{}
    if(Date.now()>deadline)throw Error('Startup timeout: '+logs);await new Promise(r=>setTimeout(r,30));}
  return {port,logs:()=>logs,connect:async()=>{const ws=new WebSocket(`ws://127.0.0.1:${port}`,{origin:`http://127.0.0.1:${port}`});clients.push(ws);await once(ws,'open');return ws;}};
};
exports.message = function(ws,type,predicate=()=>true,timeout=4000){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error('Missing '+type));},timeout);
    function cleanup(){clearTimeout(timer);ws.off('message',receive);}
    function receive(raw){const msg=JSON.parse(raw);if(msg.type==='error'&&type!=='error'){cleanup();reject(Error(msg.code+': '+msg.message));}
      else if(msg.type===type&&predicate(msg)){cleanup();resolve(msg);}}
    ws.on('message',receive);
  });
};
exports.request = function(ws,type,data,expected,predicate,timeout){const pending=exports.message(ws,expected,predicate,timeout);ws.send(JSON.stringify({type,data}));return pending.catch(error=>{throw Error(type+' -> '+expected+': '+error.message);});};
