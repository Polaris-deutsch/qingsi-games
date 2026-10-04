const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

module.exports = function activityDOM() {
  const elements = new Set(), timers = new Map(), frames = new Map(), observers = [];
  let now = 10000, next = 0;
  class Element {
    constructor() {
      elements.add(this);this.nodes=[];this.listeners=new Map();this.attributes={};this.dataset={};this.style={setProperty(name,value){this[name]=value;}};
      this.className='';this.value='';this.textContent='';this.hidden=false;this.clientHeight=100;this.clientWidth=1000;this._scrollTop=0;
      this.classList={add:(...names)=>{this.className=[...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' ');},
        remove:(...names)=>{this.className=this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ');},
        contains:name=>this.className.split(/\s+/).includes(name),toggle:(name,force)=>{if(force)this.classList.add(name);else this.classList.remove(name);}};
    }
    get scrollHeight(){return Math.max(this.clientHeight,this.nodes.filter(node=>!node.hidden).reduce((sum,node)=>sum+node.offsetHeight,0));}
    get scrollTop(){return this._scrollTop;}
    set scrollTop(value){this._scrollTop=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight));}
    get offsetHeight(){return this.hidden?0:40;}
    get children(){return this.nodes;}
    appendChild(node){this.nodes.push(node);node.parentElement=this;return node;}
    replaceChildren(...nodes){for(const node of this.nodes)node.parentElement=null;this.nodes=[];nodes.forEach(node=>this.appendChild(node));}
    remove(){if(this.parentElement)this.parentElement.nodes=this.parentElement.nodes.filter(node=>node!==this);this.parentElement=null;}
    setAttribute(key,value){this.attributes[key]=String(value);}
    getAttribute(key){return this.attributes[key]??null;}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
    emit(type,extra={}){const event={key:'',stopPropagation(){},preventDefault(){},...extra};for(const fn of [...(this.listeners.get(type)||[])])fn(event);}
    click(){if(!this.disabled)this.emit('click');}
    focus(){document.activeElement=this;this.emit('focus');}
    blur(){if(document.activeElement===this)document.activeElement=null;this.emit('blur');}
    querySelectorAll(selector){return this.nodes.flatMap(node=>[node,...node.querySelectorAll('*')]).filter(node=>selector==='*'||node.classList.contains(selector.slice(1)));}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  }
  const document={activeElement:null,createElement:()=>new Element(),getElementById(){throw Error('Global DOM lookup is forbidden');},querySelector(){throw Error('Global DOM lookup is forbidden');}};
  const window=new Element();window.innerHeight=900;window.visualViewport=new Element();window.visualViewport.height=900;window.visualViewport.offsetTop=0;
  window.requestAnimationFrame=fn=>{const id=++next;frames.set(id,fn);return id;};window.cancelAnimationFrame=id=>frames.delete(id);
  window.ResizeObserver=class {constructor(fn){this.fn=fn;this.disconnected=false;observers.push(this);}observe(target){this.target=target;}disconnect(){this.disconnected=true;}};
  const context=vm.createContext({window,document,Date:class extends Date{static now(){return now;}},
    setTimeout:(fn,ms)=>{const id=++next;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)});
  const root=path.join(__dirname,'../..');
  for(const relative of ['public/js/activity-protocol.js','public/js/ui/activity-feed.js'])vm.runInContext(fs.readFileSync(path.join(root,relative),'utf8'),context);
  function advance(ms){const end=now+ms;while(true){const entry=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;now=entry[1].at;timers.delete(entry[0]);entry[1].fn();}now=end;}
  return {window,document,observers,createElement:()=>new Element(),advance,
    create:options=>window.ActivityFeed.create(options),
    flushFrames(){const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());},
    get listenerCount(){return [...elements].reduce((count,el)=>count+[...el.listeners.values()].reduce((n,set)=>n+set.size,0),0);},
    get timerCount(){return timers.size;},get frameCount(){return frames.size;}};
};
