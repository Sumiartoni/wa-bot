const API='';
let token=localStorage.getItem('wa_token'),currentUser=null,currentJid=null,allChats=[],allLabels=[],allAgents=[],quickReplies=[],chatFilter='all',aiProvider='groq';

// === API ===
async function api(p,o={}){const r=await fetch(API+p,{...o,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,...o.headers}});if(r.status===401){doLogout();throw new Error('Unauthorized')}return r.json()}

// === Toast ===
function toast(m,t='info'){const e=document.getElementById('toast');e.textContent=m;e.className='toast glass fade-in '+(t==='success'?'text-emerald-400':'text-red-400');e.classList.remove('hidden');setTimeout(()=>e.classList.add('hidden'),3000)}

// === Auth ===
async function doLogin(){
  const u=document.getElementById('loginUser').value,p=document.getElementById('loginPass').value;
  try{const r=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:u,password:p})});
  if(r.token){token=r.token;currentUser=r.user;localStorage.setItem('wa_token',token);initApp()}
  else{document.getElementById('loginError').textContent=r.error||'Login gagal';document.getElementById('loginError').classList.remove('hidden')}}
  catch(e){document.getElementById('loginError').textContent='Login gagal';document.getElementById('loginError').classList.remove('hidden')}}

function doLogout(){api('/api/auth/logout',{method:'POST'}).catch(()=>{});token=null;localStorage.removeItem('wa_token');location.reload()}

async function checkAuth(){if(!token)return;try{const r=await api('/api/auth/verify');currentUser=r.user;initApp()}catch(e){token=null;localStorage.removeItem('wa_token')}}

function initApp(){
  document.getElementById('loginPage').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('app').classList.add('flex');
  document.getElementById('agentName').textContent=currentUser.name;
  document.getElementById('agentRole').textContent=currentUser.role;
  if(currentUser.role!=='admin')document.querySelectorAll('.adminOnly').forEach(e=>e.style.display='none');
  loadAll();setInterval(pollStatus,5000);pollStatus();
  if('Notification'in window)Notification.requestPermission();
}

async function loadAll(){loadChats();loadStats();loadSettings();loadLabels();loadAgents();loadQuickReplies();loadAgentStats()}

// === Pages ===
function showPage(p){document.querySelectorAll('[id^="page-"]').forEach(e=>e.classList.add('hidden'));document.getElementById('page-'+p).classList.remove('hidden');document.querySelectorAll('.sb-item').forEach(e=>e.classList.remove('active'));document.querySelector(`[data-page="${p}"]`)?.classList.add('active');if(p==='dashboard'){loadStats();loadAgentStats()}if(p==='quick')renderQR();if(p==='agents')renderAgents()}

// === Stats ===
async function loadStats(){try{const s=await api('/api/stats');document.getElementById('statsGrid').innerHTML=
  statCard('Total Users',s.totalUsers,'👥')+statCard('Total Pesan',s.totalMessages,'💬')+statCard('Hari Ini',s.todayMessages,'📅')+statCard('Open',s.openChats,'🟡')+statCard('In Progress',s.inProgressChats,'🔵')}catch(e){}}
function statCard(l,v,i){return`<div class="stat-card rounded-xl p-4"><p class="text-xs text-gray-400">${i} ${l}</p><p class="text-2xl font-bold mt-1">${v}</p></div>`}

async function loadAgentStats(){try{const s=await api('/api/stats/agents');document.getElementById('agentLeaderboard').innerHTML=s.map(a=>`<div class="flex items-center justify-between py-2 border-b border-white/5"><div class="flex items-center gap-2"><div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style="background:${a.avatar_color}">${a.name[0]}</div><span class="text-sm">${a.name}</span></div><div class="text-xs text-gray-400">${a.total_replies} replies · ${a.assigned_chats} chats</div></div>`).join('')||'<p class="text-xs text-gray-500">Belum ada data</p>'}catch(e){}}

// === Chats ===
async function loadChats(){try{const f={};if(chatFilter==='mine')f.agentId=currentUser.id;else if(chatFilter!=='all')f.status=chatFilter;const q=new URLSearchParams(f).toString();allChats=await api('/api/chats'+(q?'?'+q:''));renderChatList()}catch(e){}}

function filterChats(){const q=document.getElementById('searchInput').value.toLowerCase();const el=document.getElementById('chatList');const filtered=allChats.filter(c=>(c.name||'').toLowerCase().includes(q)||(c.phone||'').includes(q));renderChatListData(filtered)}

function setFilter(f,el){chatFilter=f;document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));el.classList.add('active');loadChats()}

function renderChatList(){renderChatListData(allChats)}
function renderChatListData(chats){document.getElementById('chatList').innerHTML=chats.map(c=>{
  const initial=(c.name||c.phone||'?')[0].toUpperCase();
  const unread=c.unread_count>0?`<span class="bg-indigo-600 text-white text-[10px] w-5 h-5 rounded-full flex items-center justify-center">${c.unread_count}</span>`:'';
  const statusDot=c.chat_status==='open'?'🟡':c.chat_status==='in_progress'?'🔵':'🟢';
  return`<div class="user-item rounded-lg px-3 py-2.5 cursor-pointer flex items-center gap-3 ${currentJid===c.jid?'bg-white/5':''}" onclick="openChat('${c.jid}')">
    <div class="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-sm font-bold flex-shrink-0">${initial}</div>
    <div class="min-w-0 flex-1"><p class="text-sm font-medium truncate">${c.name||c.phone} <span class="text-[10px]">${statusDot}</span></p><p class="text-xs text-gray-500 truncate">${c.last_message||'...'}</p></div>${unread}</div>`}).join('')}

// === Open Chat ===
async function openChat(jid){
  currentJid=jid;showPage('chats');renderChatList();
  const[user,msgs]=await Promise.all([api('/api/chats/'+encodeURIComponent(jid)),api('/api/chats/'+encodeURIComponent(jid)+'/messages')]);
  const area=document.getElementById('chatArea');
  area.innerHTML=`
    <div class="px-4 py-3 border-b border-white/5 flex items-center justify-between bg-[#0d0d14]">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center font-bold text-sm">${(user.name||user.phone||'?')[0].toUpperCase()}</div>
        <div><p class="font-semibold text-sm">${user.name||user.phone}</p><p class="text-xs text-gray-500">${user.phone||''} · <span class="badge status-${user.chat_status}">${user.chat_status}</span></p></div>
      </div>
      <div class="flex gap-2">
        <select onchange="setChatStatus('${jid}',this.value)" class="text-xs w-28">
          <option value="open" ${user.chat_status==='open'?'selected':''}>🟡 Open</option>
          <option value="in_progress" ${user.chat_status==='in_progress'?'selected':''}>🔵 In Progress</option>
          <option value="resolved" ${user.chat_status==='resolved'?'selected':''}>🟢 Resolved</option>
        </select>
        <button onclick="assignToMe('${jid}')" class="btn btn-ghost text-xs">👤 Ambil</button>
      </div>
    </div>
    <div id="chatMsgs" class="flex-1 overflow-y-auto p-5 space-y-3"></div>
    <div class="p-3 border-t border-white/5">
      <div id="qrSuggest" class="hidden flex gap-1 flex-wrap mb-2"></div>
      <div class="flex gap-2">
        <input id="msgInput" type="text" placeholder="Ketik pesan... (/ untuk quick reply)" class="flex-1" onkeydown="handleMsgKey(event)" oninput="showQRSuggest(this.value)">
        <button onclick="sendMsg()" class="btn btn-primary">Kirim</button>
      </div>
    </div>`;
  renderMessages(msgs.reverse());
  loadRightPanel(jid,user);
  document.getElementById('rightPanel').classList.remove('hidden');
}

function renderMessages(msgs){const el=document.getElementById('chatMsgs');if(!el)return;
  el.innerHTML=msgs.map(m=>`<div class="flex ${m.direction==='outgoing'?'justify-end':'justify-start'} fade-in">
    <div class="${m.direction==='outgoing'?'chat-out':'chat-in'} px-4 py-2.5 max-w-[70%]">
      <p class="text-sm whitespace-pre-wrap">${esc(m.content)}</p>
      <p class="text-[10px] ${m.direction==='outgoing'?'text-indigo-200':'text-gray-500'} mt-1 text-right">${m.is_ai_response?'🤖 ':''}${m.agent_name?'👤'+m.agent_name+' · ':''}${new Date(m.timestamp).toLocaleTimeString('id',{hour:'2-digit',minute:'2-digit'})}</p>
    </div></div>`).join('');el.scrollTop=el.scrollHeight}

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

// === Right Panel ===
async function loadRightPanel(jid,user){
  const[labels,notes]=await Promise.all([api('/api/chats/'+encodeURIComponent(jid)+'/labels'),api('/api/chats/'+encodeURIComponent(jid)+'/notes')]);
  const panel=document.getElementById('rightPanel');
  panel.innerHTML=`
    <h3 class="font-semibold text-sm">📋 Info Customer</h3>
    <div class="space-y-2 text-xs">
      <p><span class="text-gray-500">Nama:</span> ${user.name||'-'}</p>
      <p><span class="text-gray-500">Phone:</span> ${user.phone}</p>
      <p><span class="text-gray-500">Total Pesan:</span> ${user.total_messages}</p>
      <p><span class="text-gray-500">First Seen:</span> ${new Date(user.first_seen).toLocaleDateString('id')}</p>
      <p><span class="text-gray-500">Agent:</span> ${user.agent_name||'Belum assign'}</p>
      <p><span class="text-gray-500">Priority:</span>
        <select onchange="setPriority('${jid}',this.value)" class="text-xs w-20 inline">
          ${['low','normal','high','urgent'].map(p=>`<option value="${p}" ${user.priority===p?'selected':''}>${p}</option>`).join('')}
        </select></p>
      <p><span class="text-gray-500">AI:</span>
        <button onclick="toggleUserAI('${jid}',${user.ai_enabled?0:1})" class="text-xs px-2 py-0.5 rounded ${user.ai_enabled?'bg-emerald-500/20 text-emerald-400':'bg-gray-700 text-gray-400'}">${user.ai_enabled?'ON':'OFF'}</button></p>
    </div>
    <h3 class="font-semibold text-sm mt-4">🏷️ Labels</h3>
    <div class="flex flex-wrap gap-1" id="chatLabels">${labels.map(l=>`<span class="badge cursor-pointer" style="background:${l.color}30;color:${l.color}" onclick="removeLabel('${jid}',${l.id})">${l.name} ×</span>`).join('')}</div>
    <select onchange="addLabelToChat('${jid}',this.value);this.value=''" class="text-xs mt-1"><option value="">+ Label</option>${allLabels.map(l=>`<option value="${l.id}">${l.name}</option>`).join('')}</select>
    <h3 class="font-semibold text-sm mt-4">📝 Notes</h3>
    <div id="notesList">${notes.map(n=>`<div class="note-item"><p class="text-xs">${esc(n.content)}</p><p class="text-[10px] text-gray-500 mt-1">${n.agent_name} · ${new Date(n.created_at).toLocaleDateString('id')}<span class="cursor-pointer ml-2 text-red-400" onclick="deleteNote(${n.id},'${jid}')">×</span></p></div>`).join('')}</div>
    <div class="flex gap-1"><input id="noteInput" placeholder="Tambah catatan..." class="flex-1 text-xs"><button onclick="addNote('${jid}')" class="btn btn-ghost text-xs">+</button></div>`;
}

// === Chat Actions ===
async function sendMsg(){const inp=document.getElementById('msgInput');const m=inp.value.trim();if(!m||!currentJid)return;inp.value='';document.getElementById('qrSuggest').classList.add('hidden');
  try{await api('/api/chats/'+encodeURIComponent(currentJid)+'/send',{method:'POST',body:JSON.stringify({message:m})});openChat(currentJid)}catch(e){toast(e.message,'error')}}

function handleMsgKey(e){if(e.key==='Enter')sendMsg()}

async function setChatStatus(jid,s){await api('/api/chats/'+encodeURIComponent(jid)+'/status',{method:'PUT',body:JSON.stringify({status:s})});loadChats();toast('Status diubah','success')}
async function assignToMe(jid){await api('/api/chats/'+encodeURIComponent(jid)+'/assign',{method:'PUT',body:JSON.stringify({agentId:currentUser.id})});loadChats();openChat(jid);toast('Chat di-assign ke kamu','success')}
async function setPriority(jid,p){await api('/api/chats/'+encodeURIComponent(jid)+'/priority',{method:'PUT',body:JSON.stringify({priority:p})})}
async function toggleUserAI(jid,v){await api('/api/chats/'+encodeURIComponent(jid)+'/ai',{method:'PUT',body:JSON.stringify({enabled:!!v})});openChat(jid)}
async function addLabelToChat(jid,id){if(!id)return;await api('/api/chats/'+encodeURIComponent(jid)+'/labels',{method:'POST',body:JSON.stringify({labelId:parseInt(id)})});openChat(jid)}
async function removeLabel(jid,id){await api('/api/chats/'+encodeURIComponent(jid)+'/labels/'+id,{method:'DELETE'});openChat(jid)}
async function addNote(jid){const inp=document.getElementById('noteInput');if(!inp.value.trim())return;await api('/api/chats/'+encodeURIComponent(jid)+'/notes',{method:'POST',body:JSON.stringify({content:inp.value})});inp.value='';openChat(jid)}
async function deleteNote(id,jid){await api('/api/notes/'+id,{method:'DELETE'});openChat(jid)}

// === Quick Reply Suggest ===
function showQRSuggest(v){const el=document.getElementById('qrSuggest');if(!v.startsWith('/')){el.classList.add('hidden');return}
  const q=v.slice(1).toLowerCase();const matches=quickReplies.filter(r=>r.shortcut.toLowerCase().includes(q)||r.title.toLowerCase().includes(q));
  if(matches.length===0){el.classList.add('hidden');return}
  el.classList.remove('hidden');el.innerHTML=matches.map(r=>`<button class="btn btn-ghost text-xs" onclick="document.getElementById('msgInput').value='${r.content.replace(/'/g,"\\'")}';document.getElementById('qrSuggest').classList.add('hidden')">${r.shortcut} - ${r.title}</button>`).join('')}

// === Quick Replies Page ===
async function loadQuickReplies(){try{quickReplies=await api('/api/quick-replies')}catch(e){}}
function renderQR(){document.getElementById('qrList').innerHTML=quickReplies.map(r=>`<div class="glass rounded-xl p-4 flex justify-between items-start"><div><p class="font-semibold text-sm">${r.shortcut} <span class="text-gray-500 font-normal">— ${r.title}</span></p><p class="text-xs text-gray-400 mt-1">${r.content}</p></div><button onclick="deleteQR(${r.id})" class="text-red-400 text-xs">🗑️</button></div>`).join('')||'<p class="text-sm text-gray-500">Belum ada quick reply</p>'}

function showAddQR(){showModal('Tambah Quick Reply',`<input id="mQrShortcut" placeholder="/shortcut" class="mb-2"><input id="mQrTitle" placeholder="Judul" class="mb-2"><textarea id="mQrContent" rows="3" placeholder="Isi pesan..."></textarea>`,()=>addQR())}
async function addQR(){const s=document.getElementById('mQrShortcut').value,t=document.getElementById('mQrTitle').value,c=document.getElementById('mQrContent').value;
  await api('/api/quick-replies',{method:'POST',body:JSON.stringify({shortcut:s,title:t,content:c})});hideModal();await loadQuickReplies();renderQR();toast('Quick reply ditambahkan','success')}
async function deleteQR(id){await api('/api/quick-replies/'+id,{method:'DELETE'});await loadQuickReplies();renderQR()}

// === Agents Page ===
async function loadAgents(){try{allAgents=await api('/api/agents')}catch(e){}}
function renderAgents(){document.getElementById('agentList').innerHTML=allAgents.map(a=>`<div class="glass rounded-xl p-4 flex justify-between items-center"><div class="flex items-center gap-3"><div class="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm" style="background:${a.avatar_color}">${a.name[0]}</div><div><p class="text-sm font-semibold">${a.name}</p><p class="text-xs text-gray-500">@${a.username} · ${a.role} · <span class="${a.status==='online'?'text-emerald-400':'text-gray-500'}">${a.status}</span></p></div></div>${a.role!=='admin'?`<button onclick="deleteAgent(${a.id})" class="text-red-400 text-xs">🗑️</button>`:''}</div>`).join('')}

function showAddAgent(){showModal('Tambah Agent',`<input id="mAName" placeholder="Nama" class="mb-2"><input id="mAUser" placeholder="Username" class="mb-2"><input id="mAPass" type="password" placeholder="Password" class="mb-2"><select id="mARole" class="mb-2"><option value="agent">Agent</option><option value="admin">Admin</option></select>`,()=>addAgent())}
async function addAgent(){const n=document.getElementById('mAName').value,u=document.getElementById('mAUser').value,p=document.getElementById('mAPass').value,r=document.getElementById('mARole').value;
  try{await api('/api/agents',{method:'POST',body:JSON.stringify({username:u,password:p,name:n,role:r})});hideModal();await loadAgents();renderAgents();toast('Agent ditambahkan','success')}catch(e){toast('Username sudah ada','error')}}
async function deleteAgent(id){if(!confirm('Hapus agent ini?'))return;await api('/api/agents/'+id,{method:'DELETE'});await loadAgents();renderAgents()}

// === Labels ===
async function loadLabels(){try{allLabels=await api('/api/labels')}catch(e){}}
async function addLabel(){const n=document.getElementById('newLabel').value,c=document.getElementById('newLabelColor').value;if(!n)return;
  await api('/api/labels',{method:'POST',body:JSON.stringify({name:n,color:c})});document.getElementById('newLabel').value='';await loadLabels();renderLabels()}
function renderLabels(){document.getElementById('labelList').innerHTML=allLabels.map(l=>`<span class="badge cursor-pointer" style="background:${l.color}30;color:${l.color}" onclick="deleteLabel(${l.id})">${l.name} ×</span>`).join('')}
async function deleteLabel(id){await api('/api/labels/'+id,{method:'DELETE'});await loadLabels();renderLabels()}

// === Settings ===
async function loadSettings(){try{const s=await api('/api/settings');document.getElementById('sModel').value=s.ai_model||'';document.getElementById('sPrompt').value=s.ai_system_prompt||'';document.getElementById('sGroqKey').value=s.groq_api_key||'';document.getElementById('sOpenaiKey').value=s.openai_api_key||'';document.getElementById('sChatgptToken').value=s.chatgpt_access_token||'';aiProvider=s.ai_provider||'groq';updateProviderUI();updateAIToggle(s.global_ai_enabled==='true');renderLabels()}catch(e){}}

function setAIProvider(p){aiProvider=p;updateProviderUI()}
function updateProviderUI(){['pGroq','pOpenai','pChatgpt'].forEach(id=>{const el=document.getElementById(id);const active=id==='p'+aiProvider.charAt(0).toUpperCase()+aiProvider.slice(1);el.className='border rounded-xl p-3 text-center text-xs transition '+(active?'border-indigo-500 bg-indigo-500/10':'border-white/10')})}
function updateAIToggle(on){const b=document.getElementById('aiToggle');b.className='w-12 h-6 rounded-full relative '+(on?'bg-indigo-600':'bg-gray-700');b.querySelector('span').style.transform=on?'translateX(24px)':'none';b.dataset.on=on}
async function toggleAI(){const b=document.getElementById('aiToggle');const v=b.dataset.on!=='true';await api('/api/settings',{method:'PUT',body:JSON.stringify({global_ai_enabled:String(v)})});updateAIToggle(v)}

async function saveSettings(){const d={ai_provider:aiProvider,ai_model:document.getElementById('sModel').value,ai_system_prompt:document.getElementById('sPrompt').value};
  const gk=document.getElementById('sGroqKey').value,ok=document.getElementById('sOpenaiKey').value,ct=document.getElementById('sChatgptToken').value;
  if(gk)d.groq_api_key=gk;if(ok)d.openai_api_key=ok;if(ct)d.chatgpt_access_token=ct;
  await api('/api/settings',{method:'PUT',body:JSON.stringify(d)});toast('Settings disimpan!','success')}

// === Bot Control ===
async function startBot(){const b=document.getElementById('btnStart');b.disabled=true;b.textContent='⏳ Starting...';
  try{const r=await api('/api/bot/start',{method:'POST'});toast(r.message||'Bot dimulai','success');setTimeout(pollStatus,1500)}catch(e){toast(e.message,'error')}finally{b.disabled=false;b.textContent='▶ Start Bot'}}
async function logoutBot(){if(!confirm('Logout WhatsApp?'))return;try{await api('/api/bot/logout',{method:'POST'});toast('Berhasil logout','success');pollStatus()}catch(e){toast(e.message,'error')}}

// === Polling ===
async function pollStatus(){try{const s=await api('/api/bot/status');
  const el=document.getElementById('statusBadge');const c={connected:'bg-emerald-500',connecting:'bg-yellow-500 pulse',qr:'bg-yellow-500 pulse',disconnected:'bg-gray-500'};const l={connected:'Connected',connecting:'Connecting...',qr:'Scan QR',disconnected:'Offline'};
  el.innerHTML=`<span class="w-2 h-2 rounded-full ${c[s.status]||c.disconnected}"></span><span class="text-xs text-gray-400">${l[s.status]||s.status}</span>`;
  if(s.status==='qr'&&s.qrCode){document.getElementById('qrSection').classList.remove('hidden');document.getElementById('qrImage').src=s.qrCode}else{document.getElementById('qrSection').classList.add('hidden')}
  // Reload chats periodically
  loadChats();
}catch(e){}}

// === Modal ===
function showModal(title,body,onSave){document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modalContent').innerHTML=`<h3 class="font-bold text-lg mb-4">${title}</h3><div class="space-y-2">${body}</div><div class="flex gap-2 mt-4 justify-end"><button onclick="hideModal()" class="btn btn-ghost">Batal</button><button onclick="(${onSave})()" class="btn btn-primary">Simpan</button></div>`}
function hideModal(){document.getElementById('modal').classList.add('hidden')}

// === Notification ===
function notify(title,body){if(Notification.permission==='granted'){new Notification(title,{body,icon:'🎧'})}}

// Init
checkAuth();
