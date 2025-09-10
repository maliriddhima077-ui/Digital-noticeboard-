/*
Digital Notice Board Prototype - All-in-One File
Features:
- In-memory notices (HashMap)
- Inverted index for search
- Priority queue for urgent notices
- FSM lifecycle: DRAFT -> PENDING -> PUBLISHED -> EXPIRED
- Push notifications via SSE
- Web frontend included
- No external files needed
Run:
1. npm init -y
2. npm install express
3. node digital_noticeboard.js
*/

const express = require('express');
const bodyParser = require('express').json;
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser());
app.use(express.static('.'));

// ---------------------- Data Structures ----------------------
class PriorityQueue {
  constructor(compare) {
    this._heap = [];
    this._compare = compare || ((a,b)=>a-b);
  }
  size() { return this._heap.length; }
  isEmpty() { return this.size()===0; }
  peek() { return this._heap[0]; }
  push(value) {
    this._heap.push(value);
    this._siftUp();
  }
  pop() {
    const top = this.peek();
    const bottom = this._heap.pop();
    if(!this.isEmpty()){ this._heap[0]=bottom; this._siftDown();}
    return top;
  }
  _siftUp(){ let node=this.size()-1;
    while(node>0){ const parent=Math.floor((node-1)/2);
      if(this._compare(this._heap[node],this._heap[parent])<0){
        [this._heap[node],this._heap[parent]]=[this._heap[parent],this._heap[node]]; node=parent;
      } else break;
    }
  }
  _siftDown(){ let node=0, length=this.size();
    while(true){ let left=2*node+1, right=2*node+2, smallest=node;
      if(left<length && this._compare(this._heap[left],this._heap[smallest])<0) smallest=left;
      if(right<length && this._compare(this._heap[right],this._heap[smallest])<0) smallest=right;
      if(smallest!==node){ [this._heap[node],this._heap[smallest]]=[this._heap[smallest],this._heap[node]]; node=smallest; } else break;
    }
  }
}

// ---------------------- Store ----------------------
const notices=new Map(); let nextId=1;
const inverted=new Map();
const sseClients=new Set();
const dispatchPQ=new PriorityQueue((a,b)=>{
  if(a.priority!==b.priority) return b.priority-a.priority;
  if(a.publishAt!==b.publishAt) return a.publishAt-b.publishAt;
  return a.id-b.id;
});
const pushQueue=[];

// ---------------------- Utilities ----------------------
function tokenize(text){ return (''+text).toLowerCase().match(/\w+/g)||[]; }
function indexNotice(id,text){ for(const t of new Set(tokenize(text))){ if(!inverted.has(t)) inverted.set(t,new Set()); inverted.get(t).add(id); } }
function removeFromIndex(id){ for(const [term,set] of inverted){ if(set.has(id)){ set.delete(id); if(set.size===0) inverted.delete(term); } } }

function createNotice({title,body,tags,category,priority,author,requiresApproval,publishAt,expireAt}){
  const id=nextId++; const now=Date.now();
  const notice={id,title:title||'',body:body||'',tags:tags||[],category:category||'general',priority:Number(priority)||0,author:author||'anonymous',status:requiresApproval?'DRAFT':'PUBLISHED',requiresApproval:!!requiresApproval,createdAt:now,publishAt:publishAt||now,expireAt:expireAt||null,audit:[{action:'create',actor:author||'anonymous',at:now}]};
  notices.set(id,notice); indexNotice(id,notice.title+' '+notice.body+' '+(notice.tags||[]).join(' '));
  if(notice.status==='PUBLISHED' && notice.publishAt<=Date.now()) dispatchPQ.push({priority:notice.priority,publishAt:notice.publishAt,id});
  return notice;
}

function transition(noticeId,event,actor){
  const n=notices.get(noticeId); if(!n) return {error:'Not found'};
  const now=Date.now();
  if(event==='submit'){ if(n.status!=='DRAFT') return {error:'Can only submit from DRAFT'}; n.status='PENDING'; n.audit.push({action:'submit',actor,at:now}); }
  else if(event==='approve'){ if(n.status!=='PENDING') return {error:'Can only approve from PENDING'}; n.status='PUBLISHED'; n.audit.push({action:'approve',actor,at:now}); if(n.publishAt<=now) dispatchPQ.push({priority:n.priority,publishAt:n.publishAt,id:n.id}); }
  else if(event==='publish_now'){ n.status='PUBLISHED'; n.publishAt=now; n.audit.push({action:'publish_now',actor,at:now}); dispatchPQ.push({priority:n.priority,publishAt:n.publishAt,id:n.id}); }
  else if(event==='expire'){ n.status='EXPIRED'; n.audit.push({action:'expire',actor,at:now}); removeFromIndex(n.id); }
  else if(event==='delete'){ n.audit.push({action:'delete',actor,at:now}); notices.delete(n.id); removeFromIndex(n.id); }
  else return {error:'Unknown event'};
  return {ok:true,notice:n};
}

// ---------------------- Dispatcher ----------------------
setInterval(()=>{
  while(!dispatchPQ.isEmpty()){ const top=dispatchPQ.peek(); if(top.publishAt<=Date.now()){ const task=dispatchPQ.pop(); const n=notices.get(task.id); if(!n) continue; if(n.status!=='PUBLISHED') continue; if(n.expireAt && n.expireAt<=Date.now()){ transition(n.id,'expire','system'); continue; } pushQueue.push({noticeId:n.id,attempts:0}); } else break; }
  while(pushQueue.length>0){ const task=pushQueue.shift(); const n=notices.get(task.noticeId); if(!n) continue; for(const res of sseClients){ try{ res.write(`event: notice\ndata: ${JSON.stringify({id:n.id,title:n.title,body:n.body,priority:n.priority})}\n\n`); }catch(e){} } n.audit.push({action:'dispatched',actor:'dispatcher',at:Date.now()}); }
},1000);

// ---------------------- HTTP API ----------------------
app.get('/',(req,res)=>{
  res.send(`<!doctype html><html><head><title>Digital Notice Board</title></head><body>
<h1>Digital Notice Board Prototype</h1>
<form id="form">
<input name="title" placeholder="Title"><br>
<textarea name="body" placeholder="Body"></textarea><br>
<input name="priority" placeholder="Priority (0 low)"><br>
<label>Requires Approval: <input type="checkbox" name="requiresApproval"></label><br>
<button type="submit">Create Notice</button>
</form>
<h2>Notifications (SSE)</h2><ul id="events"></ul>
<script>
const evtSource=new EventSource('/sse');
evtSource.addEventListener('notice',e=>{const data=JSON.parse(e.data);const li=document.createElement('li');li.textContent=\`Notice \${data.id} - \${data.title} (priority \${data.priority}): \${data.body}\`;document.getElementById('events').appendChild(li);});
document.getElementById('form').onsubmit=async(ev)=>{ev.preventDefault();const fd=new FormData(ev.target);const body={title:fd.get('title'),body:fd.get('body'),priority:Number(fd.get('priority')||0),requiresApproval:fd.get('requiresApproval')==='on'};const r=await fetch('/api/notice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();alert('Created: '+JSON.stringify(j));};
</script>
</body></html>`);
});

// SSE endpoint
app.get('/sse',(req,res)=>{
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
  res.flushHeaders(); res.write('retry: 10000\n\n'); sseClients.add(res);
  req.on('close',()=>{sseClients.delete(res);});
});

// API endpoints
app.post('/api/notice',(req,res)=>{const {title,body,priority,requiresApproval}=req.body||{};const notice=createNotice({title,body,priority,requiresApproval});res.json({ok:true,notice});});
app.get('/api/notices',(req,res)=>{res.json(Array.from(notices.values()));});
app.post('/api/notice/:id/approve',(req,res)=>{res.json(transition(Number(req.params.id),'approve','admin'));});
app.post('/api/notice/:id/publish',(req,res)=>{res.json(transition(Number(req.params.id),'publish_now','admin'));});
app.get('/api/search',(req,res)=>{const q=req.query.q||'';const terms=tokenize(q);if(terms.length===0)return res.json([]); let resSet=null; for(const t of terms){const s=inverted.get(t)||new Set();resSet=resSet===null?new Set(s):new Set([...resSet].filter(x=>s.has(x)));} res.json([...resSet].map(id=>notices.get(id)).filter(Boolean));});
app.delete('/api/notice/:id',(req,res)=>{res.json(transition(Number(req.params.id),'delete','admin'));});

app.listen(PORT,()=>console.log(`Digital Notice Board running at http://localhost:${PORT}`));
