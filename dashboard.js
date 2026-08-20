const $ = s => document.querySelector(s);
let state = {};
const uiStyle = document.createElement('style');
uiStyle.textContent = `nav button{min-height:76px!important;display:flex!important;flex-direction:column;align-items:center;justify-content:center;gap:6px;font-size:10px!important;border-radius:16px!important}nav button::before{display:block;font-size:27px;line-height:1;transition:transform .18s ease}nav button[data-view="overview"]::before{content:"▦"}nav button[data-view="history"]::before{content:"◷"}nav button[data-view="settings"]::before{content:"⚙"}nav button:hover::before{transform:scale(1.12)}.settingRow{grid-template-columns:repeat(2,1fr)!important}.metrics{grid-template-columns:repeat(3,58px)!important}.criteriaInput{height:96px!important;resize:vertical!important}.video button[data-refresh-url]{margin-top:7px;border:1px solid #dddbea;background:#f5f3ff;color:#6259dc;border-radius:8px;padding:6px 9px;cursor:pointer;font-size:10px}.video button[data-refresh-url]:disabled{opacity:.55;cursor:wait}.historyHead{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.historyHead h2{margin:0}.historyHead p{color:#9293a6;font-size:11px}.historyHead button{border:1px solid #e0dfea;background:#fff;color:#77788d;border-radius:9px;padding:8px 11px;cursor:pointer}.historyList{display:grid;gap:12px}.historyItem{background:#fff;border:1px solid #e9e8f1;border-radius:16px;overflow:hidden}.historyItem summary{list-style:none;cursor:pointer;padding:16px;user-select:none}.historyItem summary::-webkit-details-marker{display:none}.historyTitle{display:flex;justify-content:space-between;gap:12px;align-items:center}.historyTitle b::before{content:"›";display:inline-block;margin-right:8px;color:#7168ed;font-size:18px;transition:transform .18s}.historyItem[open] .historyTitle b::before{transform:rotate(90deg)}.historyTitle span{color:#9293a6;font-size:10px}.historyBody{padding:0 16px 16px;border-top:1px solid #f0eff5}.historyVideos{display:grid;gap:6px;margin-top:10px}.historyVideo{background:#f7f7fb;border-radius:9px;padding:9px;font-size:10px}.historyVideo a{color:#6259dc;text-decoration:none;font-weight:700}.historyVideo small{display:block;color:#8e8f9f;margin-top:3px}`;
document.head.appendChild(uiStyle);

document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  showView(b.dataset.view); location.hash=b.dataset.view;
});
function showView(view){const button=document.querySelector(`nav button[data-view="${view}"]`),panel=$('#'+view);if(!button||!panel)return;document.querySelectorAll('nav button,.view').forEach(x=>x.classList.remove('active'));button.classList.add('active');panel.classList.add('active')}
window.addEventListener('hashchange',()=>showView(location.hash.slice(1)||'overview'));
$('#save').onclick = saveSettings;
$('#export').onclick = exportResults;
document.querySelectorAll('.tagOptions button').forEach(btn => btn.onclick = () => toggleRecommendedTag(btn));
$('#start').onclick = async () => { const cfg = await saveSettings(); if (!cfg.creators.length || !cfg.values.length) return alert('请先填写达人和筛选条件'); await chrome.runtime.sendMessage({ type:'START_SCAN', creators:withSettings(cfg) }); };
$('#pause').onclick = () => chrome.runtime.sendMessage({ type:'PAUSE_SCAN' });
$('#resume').onclick = () => chrome.runtime.sendMessage({ type:'RESUME_SCAN' });
$('#restart').onclick = async () => { const cfg=await saveSettings(); await chrome.runtime.sendMessage({ type:'RESTART_SCAN', creators:withSettings(cfg) }); };
$('#creatorGrid').onclick = async event => { const button=event.target.closest('[data-refresh-url]'); if(!button)return; button.disabled=true;button.textContent='查询中…';const response=await chrome.runtime.sendMessage({type:'REFRESH_VIDEO',url:button.dataset.refreshUrl});if(!response?.ok)alert(response?.error||'重新查询失败');button.disabled=false;button.textContent='重新查询数据'; };
$('#clearHistory').onclick = async () => { if(confirm('确定清空全部查询历史吗？当前视频结果不会被删除。')) await chrome.storage.local.set({scanHistory:[]}); };
chrome.storage.onChanged.addListener(load);

async function load() {
  state = await chrome.storage.local.get(['creators','tagSettings','videos','creatorResults','scanProgress','scanHistory']);
  state.creators ||= []; state.videos ||= []; state.creatorResults ||= {}; state.scanHistory ||= [];
  state.tagSettings ||= { tags:[], mentions:[], keywords:[], filterType:'tags', mode:'any', recentCount:3 };
  state.tagSettings.mentions ||= []; state.tagSettings.keywords ||= [];
  if (document.activeElement !== $('#creators')) $('#creators').value = state.creators.map(formatCreatorLine).join('\n');
  $('#mode').value = state.tagSettings.mode || 'any'; $('#recentCount').value = state.tagSettings.recentCount || 3;
  if(document.activeElement!==$('#criteria')) $('#criteria').value=[...(state.tagSettings.tags||[]).map(x=>'#'+x),...(state.tagSettings.mentions||[]).map(x=>'@'+x),...(state.tagSettings.keywords||[])].join('\n');
  const savedTokens=new Set([...(state.tagSettings.tags||[]).map(x=>'#'+x),...(state.tagSettings.mentions||[]).map(x=>'@'+x)].map(x=>x.toLowerCase()));
  document.querySelectorAll('.tagOptions button').forEach(b=>b.classList.toggle('selected',savedTokens.has(b.dataset.token.toLowerCase())));
  render();
}

async function saveSettings() {
  const creators=parseCreatorLines($('#creators').value);
  const values=parseCriteriaValues($('#criteria').value);
  const tags=values.filter(x=>x.startsWith('#')).map(x=>x.slice(1).toLowerCase()).filter(Boolean);
  const mentions=values.filter(x=>x.startsWith('@')).map(x=>x.slice(1).toLowerCase()).filter(Boolean);
  const keywords=values.filter(x=>!x.startsWith('#')&&!x.startsWith('@')).map(x=>x.toLowerCase());
  const tagSettings={tags,mentions,keywords,filterTypes:['tags','mentions','keywords'].filter(x=>tagSettingsValues(x,tags,mentions,keywords).length),filterType:'combined',mode:$('#mode').value,recentCount:Math.min(100,Math.max(1,Number($('#recentCount').value)||3))};
  await chrome.storage.local.set({creators,tagSettings}); state.tagSettings=tagSettings;
  return {creators,values,...tagSettings};
}

function tagSettingsValues(type,tags,mentions,keywords){return type==='tags'?tags:type==='mentions'?mentions:keywords}
function parseCriteriaValues(text){return[...new Set(String(text||'').split(/[\r\n,，;；、\t]+/).map(x=>x.trim().replace(/^[,，;；、]+|[,，;；、]+$/g,'')).filter(Boolean))]}
function withSettings(c) { return c.creators.map(x=>({...x,filterType:'combined',filterTypes:c.filterTypes,requiredTags:c.tags,requiredMentions:c.mentions,requiredKeywords:c.keywords,matchMode:c.mode,recentCount:c.recentCount})); }
function parseCreatorLines(text){const seen=new Set(),result=[];for(const raw of text.split(/[\r\n,，\t]+/)){const username=raw.trim().replace(/^@/,'');if(!username||seen.has(username.toLowerCase()))continue;seen.add(username.toLowerCase());result.push({username})}return result}
function formatCreatorLine(c){return c.username}

function render() {
  const creators=state.creators,p=state.scanProgress||{},matches=state.videos.filter(v=>['pending','confirmed'].includes(v.status));
  $('#creatorTotal').textContent=creators.length; $('#matchTotal').textContent=matches.length;
  $('#checkedTotal').textContent=Object.values(state.creatorResults).reduce((n,x)=>n+(x.checkedCount||0),0);
  $('#progressText').textContent=`${p.current||0} / ${p.total||creators.length}`; $('#progressBar').style.width=(p.total?Math.round((p.current||0)/p.total*100):0)+'%';
  $('#scanState').textContent={running:'巡检中',paused:'已暂停',done:'已完成',error:'异常'}[p.status]||'待机'; $('#pause').disabled=p.status!=='running'; $('#resume').disabled=p.status!=='paused';
  $('#creatorGrid').innerHTML=creators.map(c=>creatorCard(c,matches.filter(v=>v.username.toLowerCase()===c.username.toLowerCase()))).join('')||'<div class="empty"><b>还没有达人</b>请先前往巡检设置添加达人名单</div>';
  renderHistory();
}

function renderHistory(){const list=$('#historyList'),items=state.scanHistory||[],openIds=new Set([...list.querySelectorAll('details[open]')].map(x=>x.dataset.historyId));list.innerHTML=items.length?items.map(entry=>`<details class="historyItem" data-history-id="${esc(entry.id||entry.at)}" ${openIds.has(String(entry.id||entry.at))?'open':''}><summary><div class="historyTitle"><b>${entry.type==='refresh'?'视频数据复查':'达人巡检'} · ${entry.matchedCount??(entry.videos||[]).length} 条命中</b><span>${relativeTime(entry.at)} · ${fullDate(entry.at)}</span></div></summary><div class="historyBody">${(entry.criteria||[]).length?`<div class="chips">筛选：${entry.criteria.map(esc).join(' ')}</div>`:''}<div class="historyVideos">${(entry.videos||[]).length?(entry.videos||[]).map(v=>`<div class="historyVideo"><a href="${esc(v.url)}" target="_blank">@${esc(v.username||'')} · ${esc((v.caption||'无文案').slice(0,70))}</a><small>发布 ${fullDate(v.createTime)} · 播放 ${num(v.views)} · 点赞 ${num(v.likes)} · 评论 ${num(v.comments)} · 收藏 ${num(v.favorites)} · 转发 ${num(v.shares)}</small></div>`).join(''):'<div class="empty">本次没有符合条件的视频</div>'}</div></div></details>`).join(''):'<div class="empty"><b>暂无查询历史</b>完成一次巡检或视频复查后会自动保存在这里</div>'}
function relativeTime(value){const seconds=Math.max(0,Math.floor((Date.now()-value)/1000));if(seconds<60)return'刚刚';if(seconds<3600)return Math.floor(seconds/60)+' 分钟前';if(seconds<86400)return Math.floor(seconds/3600)+' 小时前';if(seconds<2592000)return Math.floor(seconds/86400)+' 天前';return Math.floor(seconds/2592000)+' 个月前'}

function creatorCard(c,videos) { const r=state.creatorResults[c.username.toLowerCase()]; const diagnostic=r?`请求 ${r.requestedCount??r.checkedCount} 条 · 实际加载 ${r.loadedCount??r.checkedCount} 条 · 滚动 ${r.scrollRounds??0} 轮 · ${r.loadComplete?'加载完整':'可能未完整'}`:'尚未巡检'; return `<article class="creatorCard"><div class="creatorHead"><b>@${esc(c.username)}</b><span>${diagnostic}<br>${r?date(r.lastScannedAt):''}</span></div><div class="videos">${videos.length?videos.sort((a,b)=>a.recentRank-b.recentRank).map(videoRow).join(''):'<div class="empty"><b>暂无符合条件的视频</b>'+(r?'最近检查的视频均未命中筛选条件':'等待首次巡检')+'</div>'}</div></article>`; }
function videoRow(v) { return `<div class="video"><div><a href="${esc(v.url)}" target="_blank">发布时间倒序第 ${v.recentRank} 条（1=最新） · ${esc((v.caption||'无文案').slice(0,48))}</a><div class="desc">${esc(v.caption||'')}</div><div class="chips">${(v.matched||[]).map(esc).join(' ')} · 发布 ${fullDate(v.createTime)}${v.lastRefreshedAt?' · 复查 '+fullDate(v.lastRefreshedAt):''}</div><button data-refresh-url="${esc(v.url)}">重新查询数据</button></div><div class="metrics"><span>播放<b>${num(v.views)}</b></span><span>点赞<b>${num(v.likes)}</b></span><span>评论<b>${num(v.comments)}</b></span><span>收藏<b>${num(v.favorites)}</b></span><span>转发<b>${num(v.shares)}</b></span><span>互动率<b>${engagementRate(v)}</b></span></div></div>`; }
function toggleRecommendedTag(btn) { const values=parseCriteriaValues($('#criteria').value), token=btn.dataset.token, lower=token.toLowerCase(); const next=values.some(x=>x.toLowerCase()===lower)?values.filter(x=>x.toLowerCase()!==lower):[...values,token]; $('#criteria').value=next.join('\n'); btn.classList.toggle('selected',next.some(x=>x.toLowerCase()===lower)); }

function exportResults() {
  const matches=state.videos.filter(v=>['pending','confirmed'].includes(v.status)); const registeredAt=new Date().toLocaleString('zh-CN'); const rows=[['达人','结果','筛选依据','达人近期视频序号（1=最新）','视频链接','文案','命中条件','视频实际发布日期','播放','点赞','评论','收藏','转发','互动率','数据登记时间','最后复查时间','最后巡检时间']];
  const typeLabel={tags:'Tag',mentions:'@账号',keywords:'文案关键词',combined:'组合条件'};
  for(const creator of state.creators){const videos=matches.filter(v=>v.username.toLowerCase()===creator.username.toLowerCase()),scanned=state.creatorResults[creator.username.toLowerCase()];if(!videos.length)rows.push([creator.username,scanned?'无符合条件视频':'尚未巡检',typeLabel[state.tagSettings.filterType]||'组合条件','','','','','','','','','','','',registeredAt,'',scanned?fullDate(scanned.lastScannedAt):'']);else videos.forEach(v=>rows.push([creator.username,'符合条件',typeLabel[v.filterType]||'组合条件',v.recentRank,v.url,v.caption,(v.matched||[]).join(' '),fullDate(v.createTime),v.views||'',v.likes||'',v.comments||'',v.favorites||'',v.shares||'',engagementRate(v),registeredAt,fullDate(v.lastRefreshedAt),scanned?fullDate(scanned.lastScannedAt):'']))}
  const csv='\ufeff'+rows.map(r=>r.map(x=>'"'+String(x??'').replaceAll('"','""')+'"').join(',')).join('\r\n'); const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download=`tk-creator-results-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(a.href);
}

function num(v){if(v==null||v==='')return'—';const n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(n):esc(v)}
function metricNumber(value){if(value==null||value==='')return null;const s=String(value).trim().replace(/,/g,'').toUpperCase();const m=s.match(/^([\d.]+)\s*(K|M|B|万|亿)?$/);if(!m)return Number.isFinite(Number(s))?Number(s):null;const factor={K:1e3,M:1e6,B:1e9,'万':1e4,'亿':1e8}[m[2]]||1;return Number(m[1])*factor}
function engagementRate(v){const views=metricNumber(v.views),likes=metricNumber(v.likes),comments=metricNumber(v.comments),favorites=metricNumber(v.favorites),shares=metricNumber(v.shares);if(!views||[likes,comments,favorites,shares].some(x=>x==null))return'—';return(((likes+comments+favorites+shares)/views)*100).toFixed(2)+'%'}
function date(v){return v?new Date(v).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):''}
function fullDate(v){return v?new Date(v).toLocaleString('zh-CN'):''}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
load();
showView(location.hash.slice(1)||'overview');
