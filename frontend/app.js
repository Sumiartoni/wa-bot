const API='';let token=localStorage.getItem('wa_token'),currentUser=null,currentJid=null,allChats=[],allLabels=[],allAgents=[],quickReplies=[],chatFilter='all',aiProvider='groq';
async function api(p,o={}){const r=await fetch(API+p,{...o,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,...o.headers}});if(r.status===401){doLogout();throw new Error('Unauthorized')}return r.json()}
function toast(m,t='info'){const e=document.getElementById('toast');e.textContent=m;e.style.color=t==='success'?'var(--success)':'var(--danger)';e.classList.remove('hidden');setTimeout(()=>e.classList.add('hidden'),3000)}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function icons(){lucide.createIcons()}
function toggleTheme(){const t=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=t;localStorage.setItem('wa_theme',t);document.getElementById('themeIcon').setAttribute('data-lucide',t==='dark'?'sun':'moon');icons()}
(function(){const t=localStorage.getItem('wa_theme');if(t)document.documentElement.dataset.theme=t})();

// Auth
async function doLogin(){const u=document.getElementById('loginUser').value,p=document.getElementById('loginPass').value;
try{const r=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:u,password:p})});
if(r.token){token=r.token;currentUser=r.user;localStorage.setItem('wa_token',token);initApp()}
else{document.getElementById('loginError').textContent=r.error||'Login gagal';document.getElementById('loginError').classList.remove('hidden')}}
catch(e){document.getElementById('loginError').textContent='Login gagal';document.getElementById('loginError').classList.remove('hidden')}}
function doLogout(){api('/api/auth/logout',{method:'POST'}).catch(()=>{});token=null;localStorage.removeItem('wa_token');location.reload()}
async function checkAuth(){if(!token)return;try{const r=await api('/api/auth/verify');currentUser=r.user;initApp()}catch(e){token=null;localStorage.removeItem('wa_token')}}
function initApp(){document.getElementById('loginPage').style.display='none';const app=document.getElementById('app');app.style.display='grid';app.classList.remove('hidden');
document.getElementById('agentName').textContent=currentUser.name;document.getElementById('agentRole').textContent=currentUser.role;document.getElementById('userAvatar').textContent=currentUser.name[0].toUpperCase();
if(currentUser.role!=='admin')document.querySelectorAll('.adminOnly').forEach(e=>e.style.display='none');
loadAll();setInterval(pollStatus,5000);pollStatus();if('Notification'in window)Notification.requestPermission();icons()}
async function loadAll(){loadChats();loadStats();loadSettings();loadLabels();loadAgents();loadQuickReplies();loadAgentStats()}

// Pages
function showPage(p){document.querySelectorAll('[id^="page-"]').forEach(e=>e.classList.add('hidden'));document.getElementById('page-'+p).classList.remove('hidden');document.querySelectorAll('.nav-item').forEach(e=>e.classList.remove('active'));document.querySelector(`[data-page="${p}"]`)?.classList.add('active');if(p==='dashboard'){loadStats();loadAgentStats()}if(p==='quick')renderQR();if(p==='agents')renderAgents();icons()}

// Stats
async function loadStats(){try{const s=await api('/api/stats');document.getElementById('statsGrid').innerHTML=
sc('Users',s.totalUsers,'users','stat-c1')+sc('Pesan',s.totalMessages,'message-circle','stat-c2')+sc('Hari Ini',s.todayMessages,'calendar','stat-c3')+sc('Open',s.openChats,'circle-dot','stat-c4')+sc('Progress',s.inProgressChats,'loader','stat-c5');icons()}catch(e){}}
function sc(l,v,ic,cls){return`<div class="stat-card ${cls}"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><i data-lucide="${ic}" style="width:16px;height:16px;opacity:.6"></i><span style="font-size:12px;color:var(--text2)">${l}</span></div><p style="font-size:26px;font-weight:700">${v}</p></div>`}
async function loadAgentStats(){try{const s=await api('/api/stats/agents');document.getElementById('agentLeaderboard').innerHTML=s.length?s.map(a=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)"><div style="display:flex;align-items:center;gap:10px"><div class="avatar avatar-sm" style="background:${a.avatar_color}">${a.name[0]}</div><span style="font-size:13px;font-weight:500">${a.name}</span></div><span style="font-size:12px;color:var(--text3)">${a.total_replies} replies &middot; ${a.assigned_chats} chats</span></div>`).join(''):'<p style="font-size:13px;color:var(--text3)">Belum ada data</p>';icons()}catch(e){}}

// Chats
async function loadChats(){try{const f={};if(chatFilter==='mine')f.agentId=currentUser.id;else if(chatFilter!=='all')f.status=chatFilter;const q=new URLSearchParams(f).toString();allChats=await api('/api/chats'+(q?'?'+q:''));renderChatList()}catch(e){}}
function filterChats(){const q=document.getElementById('searchInput').value.toLowerCase();renderChatListData(allChats.filter(c=>(c.name||'').toLowerCase().includes(q)||(c.phone||'').includes(q)))}
function setFilter(f,el){chatFilter=f;document.querySelectorAll('.ftab').forEach(e=>e.classList.remove('active'));el.classList.add('active');loadChats()}
function renderChatList(){renderChatListData(allChats)}
function renderChatListData(chats){const el=document.getElementById('chatList');el.innerHTML=chats.map(c=>{
const ini=(c.name||c.phone||'?')[0].toUpperCase();const unread=c.unread_count>0?`<span class="badge-count">${c.unread_count}</span>`:'';
return`<div class="chat-item ${currentJid===c.jid?'active':''}" onclick="openChat('${c.jid}')">
<div class="avatar" style="background:linear-gradient(135deg,hsl(${Math.abs(c.jid.charCodeAt(0)*47)%360},65%,55%),hsl(${Math.abs(c.jid.charCodeAt(1)*73)%360},65%,45%))">${ini}</div>
<div style="min-width:0;flex:1"><div style="display:flex;justify-content:space-between;align-items:center"><p style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.name||c.phone}</p>${unread}</div>
<p style="font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">${c.last_message||'...'}</p></div></div>`}).join('');icons()}

// Open Chat
async function openChat(jid){currentJid=jid;showPage('chats');renderChatList();
const[user,msgs]=await Promise.all([api('/api/chats/'+encodeURIComponent(jid)),api('/api/chats/'+encodeURIComponent(jid)+'/messages')]);
const area=document.getElementById('chatArea');const stCls=user.chat_status==='open'?'badge-open':user.chat_status==='in_progress'?'badge-progress':'badge-resolved';
area.innerHTML=`<div class="surface" style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
<div style="display:flex;align-items:center;gap:12px"><div class="avatar" style="background:linear-gradient(135deg,hsl(${Math.abs(jid.charCodeAt(0)*47)%360},65%,55%),hsl(${Math.abs(jid.charCodeAt(1)*73)%360},65%,45%))">${(user.name||user.phone||'?')[0].toUpperCase()}</div>
<div><p style="font-size:14px;font-weight:600">${user.name||user.phone}</p><p style="font-size:11px;color:var(--text3)">${user.phone||''} <span class="badge ${stCls}" style="margin-left:4px">${user.chat_status}</span></p></div></div>
<div style="display:flex;gap:8px;align-items:center"><select onchange="setChatStatus('${jid}',this.value)" style="font-size:12px;width:auto;padding:6px 10px">
<option value="open" ${user.chat_status==='open'?'selected':''}>Open</option><option value="in_progress" ${user.chat_status==='in_progress'?'selected':''}>In Progress</option><option value="resolved" ${user.chat_status==='resolved'?'selected':''}>Resolved</option></select>
<button onclick="assignToMe('${jid}')" class="btn btn-ghost" style="font-size:12px;padding:6px 12px"><i data-lucide="user-check" style="width:14px;height:14px"></i>Ambil</button></div></div>
<div id="chatMsgs" style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:10px"></div>
<div style="padding:14px 20px;border-top:1px solid var(--border)"><div id="qrSuggest" class="hidden" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
<div style="display:flex;gap:10px"><input id="msgInput" placeholder="Ketik pesan... ( / untuk quick reply )" style="flex:1" onkeydown="if(event.key==='Enter')sendMsg()" oninput="showQRSuggest(this.value)">
<button onclick="sendMsg()" class="btn btn-primary"><i data-lucide="send" style="width:14px;height:14px"></i></button></div></div>`;
renderMessages(msgs.reverse());loadRightPanel(jid,user);document.getElementById('rightPanel').classList.remove('hidden');icons()}

function renderMessages(msgs){const el=document.getElementById('chatMsgs');if(!el)return;
el.innerHTML=msgs.map(m=>`<div style="display:flex;${m.direction==='outgoing'?'justify-content:flex-end':''}" class="fade-in">
<div class="${m.direction==='outgoing'?'chat-out':'chat-in'}" style="padding:10px 16px;max-width:70%">
<p style="font-size:13px;white-space:pre-wrap;line-height:1.5">${esc(m.content)}</p>
<p style="font-size:10px;opacity:.6;margin-top:4px;text-align:right">${m.is_ai_response?'AI ':''}${m.agent_name?m.agent_name+' · ':''}${new Date(m.timestamp).toLocaleTimeString('id',{hour:'2-digit',minute:'2-digit'})}</p>
</div></div>`).join('');el.scrollTop=el.scrollHeight}

// Right Panel
async function loadRightPanel(jid,user){const[labels,notes]=await Promise.all([api('/api/chats/'+encodeURIComponent(jid)+'/labels'),api('/api/chats/'+encodeURIComponent(jid)+'/notes')]);
document.getElementById('rightPanel').innerHTML=`<h3 style="font-size:13px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:6px"><i data-lucide="user" style="width:14px;height:14px;color:var(--primary)"></i>Customer Info</h3>
<div style="font-size:12px;display:grid;gap:8px">
<div><span style="color:var(--text3)">Nama</span><p style="font-weight:500">${user.name||'-'}</p></div>
<div><span style="color:var(--text3)">Phone</span><p style="font-weight:500">${user.phone}</p></div>
<div><span style="color:var(--text3)">Total Pesan</span><p style="font-weight:500">${user.total_messages}</p></div>
<div><span style="color:var(--text3)">Agent</span><p style="font-weight:500">${user.agent_name||'Belum assign'}</p></div>
<div><span style="color:var(--text3)">Priority</span><select onchange="setPriority('${jid}',this.value)" style="font-size:11px;padding:4px 8px;width:auto;margin-top:2px">${['low','normal','high','urgent'].map(p=>`<option value="${p}" ${user.priority===p?'selected':''}>${p}</option>`).join('')}</select></div>
<div><span style="color:var(--text3)">AI</span><button onclick="toggleUserAI('${jid}',${user.ai_enabled?0:1})" class="toggle ${user.ai_enabled?'on':'off'}" style="margin-top:4px"><span class="dot"></span></button></div></div>
<div class="divider" style="margin:14px 0"></div>
<h3 style="font-size:13px;font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:6px"><i data-lucide="tag" style="width:14px;height:14px;color:var(--accent)"></i>Labels</h3>
<div style="display:flex;flex-wrap:wrap;gap:4px">${labels.map(l=>`<span class="badge" style="background:${l.color}20;color:${l.color};cursor:pointer" onclick="removeLabel('${jid}',${l.id})">${l.name} ×</span>`).join('')}</div>
<select onchange="addLabelToChat('${jid}',this.value);this.value=''" style="font-size:11px;margin-top:6px;padding:6px 8px"><option value="">+ Tambah label</option>${allLabels.map(l=>`<option value="${l.id}">${l.name}</option>`).join('')}</select>
<div class="divider" style="margin:14px 0"></div>
<h3 style="font-size:13px;font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:6px"><i data-lucide="sticky-note" style="width:14px;height:14px;color:var(--warning)"></i>Notes</h3>
${notes.map(n=>`<div class="note-card" style="margin-bottom:8px"><p style="font-size:12px">${esc(n.content)}</p><p style="font-size:10px;color:var(--text3);margin-top:4px">${n.agent_name} <span style="cursor:pointer;color:var(--danger);margin-left:6px" onclick="deleteNote(${n.id},'${jid}')">hapus</span></p></div>`).join('')}
<div style="display:flex;gap:6px;margin-top:6px"><input id="noteInput" placeholder="Tambah catatan..." style="flex:1;font-size:11px;padding:8px 10px"><button onclick="addNote('${jid}')" class="btn btn-ghost" style="padding:8px"><i data-lucide="plus" style="width:14px;height:14px"></i></button></div>`;icons()}

// Chat Actions
async function sendMsg(){const inp=document.getElementById('msgInput');const m=inp.value.trim();if(!m||!currentJid)return;inp.value='';document.getElementById('qrSuggest').classList.add('hidden');
try{await api('/api/chats/'+encodeURIComponent(currentJid)+'/send',{method:'POST',body:JSON.stringify({message:m})});openChat(currentJid)}catch(e){toast(e.message,'error')}}
async function setChatStatus(jid,s){await api('/api/chats/'+encodeURIComponent(jid)+'/status',{method:'PUT',body:JSON.stringify({status:s})});loadChats();toast('Status diubah','success')}
async function assignToMe(jid){await api('/api/chats/'+encodeURIComponent(jid)+'/assign',{method:'PUT',body:JSON.stringify({agentId:currentUser.id})});loadChats();openChat(jid);toast('Chat di-assign','success')}
async function setPriority(jid,p){await api('/api/chats/'+encodeURIComponent(jid)+'/priority',{method:'PUT',body:JSON.stringify({priority:p})})}
async function toggleUserAI(jid,v){await api('/api/chats/'+encodeURIComponent(jid)+'/ai',{method:'PUT',body:JSON.stringify({enabled:!!v})});openChat(jid)}
async function addLabelToChat(jid,id){if(!id)return;await api('/api/chats/'+encodeURIComponent(jid)+'/labels',{method:'POST',body:JSON.stringify({labelId:parseInt(id)})});openChat(jid)}
async function removeLabel(jid,id){await api('/api/chats/'+encodeURIComponent(jid)+'/labels/'+id,{method:'DELETE'});openChat(jid)}
async function addNote(jid){const inp=document.getElementById('noteInput');if(!inp.value.trim())return;await api('/api/chats/'+encodeURIComponent(jid)+'/notes',{method:'POST',body:JSON.stringify({content:inp.value})});inp.value='';openChat(jid)}
async function deleteNote(id,jid){await api('/api/notes/'+id,{method:'DELETE'});openChat(jid)}
function showQRSuggest(v){const el=document.getElementById('qrSuggest');if(!v.startsWith('/')){el.classList.add('hidden');return}const q=v.slice(1).toLowerCase();const m=quickReplies.filter(r=>r.shortcut.toLowerCase().includes(q)||r.title.toLowerCase().includes(q));if(!m.length){el.classList.add('hidden');return}el.classList.remove('hidden');el.style.display='flex';el.innerHTML=m.map(r=>`<button class="btn btn-ghost" style="font-size:11px" onclick="document.getElementById('msgInput').value=\`${r.content.replace(/`/g,"\\`")}\`;document.getElementById('qrSuggest').classList.add('hidden')">${r.shortcut}</button>`).join('')}

// Quick Replies
async function loadQuickReplies(){try{quickReplies=await api('/api/quick-replies')}catch(e){}}
function renderQR(){document.getElementById('qrList').innerHTML=quickReplies.map(r=>`<div class="card" style="padding:16px;display:flex;justify-content:space-between;align-items:start"><div><p style="font-size:13px;font-weight:600">${r.shortcut} <span style="color:var(--text3);font-weight:400">— ${r.title}</span></p><p style="font-size:12px;color:var(--text2);margin-top:4px">${r.content}</p></div><button onclick="deleteQR(${r.id})" class="btn btn-danger" style="padding:6px 10px"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button></div>`).join('')||'<p style="color:var(--text3);font-size:13px">Belum ada quick reply</p>';icons()}
function showAddQR(){showModal('Tambah Quick Reply',`<input id="mQrS" placeholder="/shortcut" style="margin-bottom:10px"><input id="mQrT" placeholder="Judul" style="margin-bottom:10px"><textarea id="mQrC" rows="3" placeholder="Isi pesan..."></textarea>`,()=>addQR())}
async function addQR(){await api('/api/quick-replies',{method:'POST',body:JSON.stringify({shortcut:document.getElementById('mQrS').value,title:document.getElementById('mQrT').value,content:document.getElementById('mQrC').value})});hideModal();await loadQuickReplies();renderQR();toast('Ditambahkan','success')}
async function deleteQR(id){await api('/api/quick-replies/'+id,{method:'DELETE'});await loadQuickReplies();renderQR()}

// Agents
async function loadAgents(){try{allAgents=await api('/api/agents')}catch(e){}}
function renderAgents(){document.getElementById('agentList').innerHTML=allAgents.map(a=>`<div class="card" style="padding:16px;display:flex;justify-content:space-between;align-items:center"><div style="display:flex;align-items:center;gap:12px"><div class="avatar" style="background:${a.avatar_color}">${a.name[0]}</div><div><p style="font-size:13px;font-weight:600">${a.name}</p><p style="font-size:11px;color:var(--text3)">@${a.username} · ${a.role}</p></div></div>${a.role!=='admin'?`<button onclick="deleteAgent(${a.id})" class="btn btn-danger" style="padding:6px 10px"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>`:''}</div>`).join('');icons()}
function showAddAgent(){showModal('Tambah Agent',`<input id="mAN" placeholder="Nama" style="margin-bottom:10px"><input id="mAU" placeholder="Username" style="margin-bottom:10px"><input id="mAP" type="password" placeholder="Password" style="margin-bottom:10px"><select id="mAR" style="margin-bottom:10px"><option value="agent">Agent</option><option value="admin">Admin</option></select>`,()=>addAgent())}
async function addAgent(){try{await api('/api/agents',{method:'POST',body:JSON.stringify({username:document.getElementById('mAU').value,password:document.getElementById('mAP').value,name:document.getElementById('mAN').value,role:document.getElementById('mAR').value})});hideModal();await loadAgents();renderAgents();toast('Agent ditambahkan','success')}catch(e){toast('Username sudah ada','error')}}
async function deleteAgent(id){if(!confirm('Hapus agent?'))return;await api('/api/agents/'+id,{method:'DELETE'});await loadAgents();renderAgents()}

// Labels & Settings
async function loadLabels(){try{allLabels=await api('/api/labels')}catch(e){}}
function renderLabels(){const el=document.getElementById('labelList');if(!el)return;el.innerHTML=allLabels.map(l=>`<span class="badge" style="background:${l.color}20;color:${l.color};cursor:pointer" onclick="deleteLabel(${l.id})">${l.name} ×</span>`).join('')}
async function addLabel(){const n=document.getElementById('newLabel').value,c=document.getElementById('newLabelColor').value;if(!n)return;await api('/api/labels',{method:'POST',body:JSON.stringify({name:n,color:c})});document.getElementById('newLabel').value='';await loadLabels();renderLabels()}
async function deleteLabel(id){await api('/api/labels/'+id,{method:'DELETE'});await loadLabels();renderLabels()}
async function loadSettings(){try{const s=await api('/api/settings');document.getElementById('sModel').value=s.ai_model||'';document.getElementById('sPrompt').value=s.ai_system_prompt||'';document.getElementById('sGroqKey').value=s.groq_api_key||'';document.getElementById('sOpenrouterKey').value=s.openrouter_api_key||'';document.getElementById('sChatgptToken').value=s.chatgpt_access_token||'';aiProvider=s.ai_provider||'groq';updateProviderUI();updateAIToggle(s.global_ai_enabled==='true');renderLabels()}catch(e){}}
function setAIProvider(p){aiProvider=p;updateProviderUI()}
function updateProviderUI(){['pGroq','pOpenrouter','pChatgpt'].forEach(id=>{const el=document.getElementById(id);if(!el)return;const k=id.replace('p','').toLowerCase();el.style.borderColor=aiProvider===k?'var(--primary)':'var(--border)';el.style.background=aiProvider===k?'rgba(99,102,241,.08)':''});updateModelList()}

function updateModelList(){const dl=document.getElementById('modelSuggestions');if(!dl)return;
if(aiProvider==='openrouter'){
dl.innerHTML=`<option value="google/gemini-2.0-flash-001">Gemini 2.0 Flash (OpenRouter/Gratis)</option>
<option value="google/gemini-2.0-pro-exp-02-05:free">Gemini 2.0 Pro (OpenRouter/Gratis)</option>
<option value="deepseek/deepseek-r1">DeepSeek R1</option>
<option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option>
<option value="meta-llama/llama-3.3-70b-instruct">Llama 3.3 70B</option>
<option value="openai/gpt-4o-mini">GPT-4o Mini</option>`;
}else if(aiProvider==='groq'){
dl.innerHTML=`<option value="llama-3.3-70b-versatile">Llama 3.3 70B (GROQ)</option>
<option value="mixtral-8x7b-32768">Mixtral 8x7B (GROQ)</option>
<option value="gemma2-9b-it">Gemma 2 9B (GROQ)</option>`;
}else{
dl.innerHTML=`<option value="auto">Auto (ChatGPT)</option><option value="gpt-4">GPT-4</option>`;
}}
function updateAIToggle(on){const b=document.getElementById('aiToggle');b.className='toggle '+(on?'on':'off');b.dataset.on=on}
async function toggleAI(){const b=document.getElementById('aiToggle');const v=b.dataset.on!=='true';await api('/api/settings',{method:'PUT',body:JSON.stringify({global_ai_enabled:String(v)})});updateAIToggle(v)}
async function saveSettings(){const d={ai_provider:aiProvider,ai_model:document.getElementById('sModel').value,ai_system_prompt:document.getElementById('sPrompt').value};const g=document.getElementById('sGroqKey').value,o=document.getElementById('sOpenrouterKey').value,c=document.getElementById('sChatgptToken').value;if(g)d.groq_api_key=g;if(o)d.openrouter_api_key=o;if(c)d.chatgpt_access_token=c;await api('/api/settings',{method:'PUT',body:JSON.stringify(d)});toast('Settings disimpan!','success')}

// Bot & Poll
async function startBot(){const b=document.getElementById('btnStart');b.disabled=true;try{const r=await api('/api/bot/start',{method:'POST'});toast(r.message||'Bot dimulai','success');setTimeout(pollStatus,1500)}catch(e){toast(e.message,'error')}finally{b.disabled=false}}
async function logoutBot(){if(!confirm('Logout WhatsApp?'))return;try{await api('/api/bot/logout',{method:'POST'});toast('Logout berhasil','success');pollStatus()}catch(e){toast(e.message,'error')}}
async function pollStatus(){try{const s=await api('/api/bot/status');const el=document.getElementById('statusBadge');const colors={connected:'var(--success)',connecting:'var(--warning)',qr:'var(--warning)',disconnected:'var(--text3)'};const labels={connected:'Connected',connecting:'Connecting...',qr:'Scan QR',disconnected:'Offline'};
el.innerHTML=`<span style="width:7px;height:7px;border-radius:50%;background:${colors[s.status]||colors.disconnected};${s.status==='connecting'?'animation:pulseDot 2s infinite':''}"></span><span style="font-size:11px;color:var(--text3)">${labels[s.status]||s.status}</span>`;
if(s.status==='qr'&&s.qrCode){document.getElementById('qrSection').classList.remove('hidden');document.getElementById('qrImage').src=s.qrCode}else{document.getElementById('qrSection').classList.add('hidden')}loadChats()}catch(e){}}

// Modal
function showModal(title,body,onSave){document.getElementById('modal').classList.remove('hidden');document.getElementById('modalContent').innerHTML=`<h3 style="font-size:18px;font-weight:700;margin-bottom:18px">${title}</h3>${body}<div style="display:flex;gap:8px;margin-top:18px;justify-content:flex-end"><button onclick="hideModal()" class="btn btn-ghost">Batal</button><button onclick="(${onSave})()" class="btn btn-primary">Simpan</button></div>`;icons()}
function hideModal(){document.getElementById('modal').classList.add('hidden')}

checkAuth();
