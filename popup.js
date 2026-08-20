const $ = s => document.querySelector(s);
let data = { creators: [], videos: [], scanProgress: null, tagSettings: { tags: [], mode: "any" } };

document.querySelectorAll('.tab').forEach(btn => btn.onclick = () => {
  document.querySelectorAll('.tab,.panel').forEach(el => el.classList.remove('active'));
  btn.classList.add('active'); $('#' + btn.dataset.tab).classList.add('active'); render();
});

$('#saveCreators').onclick = async () => {
  const creators = parseCreators($('#creatorInput').value);
  const tagSettings = { tags: parseTags($('#tagInput').value), mode: $('#matchMode').value };
  await chrome.storage.local.set({ creators, tagSettings }); await load();
};
$('#sample').onclick = () => { $('#creatorInput').value = 'creator_name\nanother_creator'; $('#tagInput').value = '#furniture, #homedecor, #sofa'; };
$('#scan').onclick = async () => {
  if (!data.creators.length) return alert('请先添加达人名单');
  if (!data.tagSettings.tags.length) return alert('请先设置所有达人共用的标签');
  const creators = data.creators.map(c => ({ ...c, requiredTags: data.tagSettings.tags, matchMode: data.tagSettings.mode }));
  const r = await chrome.runtime.sendMessage({ type: 'START_SCAN', creators });
  if (!r?.ok) alert(r?.error || '无法开始巡检'); else poll();
};
$('#scanCurrent').onclick = async () => {
  if (!data.tagSettings.tags.length) return alert('请先设置共用标签');
  const username = await currentUsername();
  const creator = { username, requiredTags: data.tagSettings.tags, matchMode: data.tagSettings.mode };
  const r = await chrome.runtime.sendMessage({ type: 'SCAN_CURRENT', creator });
  if (!r?.ok) alert(r?.error || '无法扫描当前页面'); else await load();
};
$('#pauseScan').onclick = async () => chrome.runtime.sendMessage({ type: 'PAUSE_SCAN' });
$('#resumeScan').onclick = async () => chrome.runtime.sendMessage({ type: 'RESUME_SCAN' });
$('#restartScan').onclick = async () => {
  if (!data.creators.length || !data.tagSettings.tags.length) return alert('请先保存达人和标签');
  const creators = data.creators.map(c => ({ ...c, requiredTags: data.tagSettings.tags, matchMode: data.tagSettings.mode }));
  await chrome.runtime.sendMessage({ type: 'RESTART_SCAN', creators }); poll();
};
$('#export').onclick = exportCsv;
$('#filter').onchange = render;
$('#clearData').onclick = async () => { if (confirm('确定清空全部视频和历史快照吗？')) { await chrome.storage.local.set({ videos: [], snapshots: [] }); load(); } };
chrome.storage.onChanged.addListener(() => load());

async function load() {
  data = await chrome.storage.local.get(['creators','videos','scanProgress','tagSettings']);
  data.creators ||= []; data.videos ||= []; data.tagSettings ||= { tags: [], mode: 'any' };
  $('#creatorInput').value = data.creators.map(c => c.username).join('\n');
  $('#tagInput').value = data.tagSettings.tags.map(x => '#' + x).join(', ');
  $('#matchMode').value = data.tagSettings.mode || 'any'; render();
}
function parseCreators(text) { return [...new Set(text.split(/[\r\n,，\t]+/).map(x => x.trim().replace(/^@/, '')).filter(Boolean))].map(username => ({ username })); }
function parseTags(text) { return [...new Set(text.split(/[\s,，#]+/).map(x => x.trim().toLowerCase()).filter(Boolean))]; }
function render() {
  const pending = data.videos.filter(v => v.status === 'pending').sort((a,b) => b.score-a.score);
  $('#pendingCount').textContent = pending.length; $('#emptyReview').style.display = pending.length ? 'none' : 'block';
  $('#videoList').innerHTML = pending.map(card).join('');
  const filter = $('#filter').value;
  $('#allList').innerHTML = data.videos.filter(v => filter === 'all' || v.status === filter).sort((a,b) => b.lastSeenAt-a.lastSeenAt).map(card).join('');
  $('#creatorStats').textContent = `已保存 ${data.creators.length} 位达人 · 共用 ${data.tagSettings.tags.length} 个标签 · ${data.tagSettings.mode === 'all' ? '满足全部' : '满足任一'} · ${data.videos.length} 条视频`;
  bindActions(); renderProgress();
}
function card(v) {
  const statusText = { pending:'待审核', confirmed:'已确认', ignored:'已忽略' }[v.status] || v.status;
  return `<article class="card"><div class="cardTop"><span class="creator">@${esc(v.username)} · 最近第 ${v.recentRank||'?'} 条</span><span class="score">${v.score||0}% · ${statusText}</span></div><p class="caption">${esc(v.caption||'未读取到文案')}</p><div class="chips">${(v.matched||[]).map(x=>`<span class="chip">${esc(x)}</span>`).join('')}</div><div class="metrics"><span>播放<b>${num(v.views)}</b></span><span>点赞<b>${num(v.likes)}</b></span><span>评论<b>${num(v.comments)}</b></span><span>分享<b>${num(v.shares)}</b></span></div><div class="meta"><a href="${esc(v.url)}" target="_blank">打开视频 ↗</a><div class="actions"><button data-action="confirmed" data-url="${esc(v.url)}">确认推广</button><button data-action="ignored" data-url="${esc(v.url)}">忽略</button></div></div></article>`;
}
function bindActions() { document.querySelectorAll('[data-action]').forEach(btn => btn.onclick = async () => chrome.storage.local.set({ videos: data.videos.map(v => v.url === btn.dataset.url ? { ...v, status: btn.dataset.action } : v) })); }
function renderProgress() { const p=data.scanProgress,box=$('#progress'); if(!p||p.status==='done'){box.classList.add('hidden');$('#state').textContent='待机';return} box.classList.remove('hidden'); box.querySelector('span').style.width=(p.total?Math.round(p.current/p.total*100):0)+'%'; const detail=p.videoRank?` · 正在读取第 ${p.videoRank} 条视频详情`:''; box.querySelector('p').textContent=p.status==='error'?(p.message||'巡检失败'):p.status==='paused'?`已暂停在 @${p.username||''} · ${p.current||0}/${p.total||0}${detail}`:`正在检查 @${p.username||''} · ${p.current||0}/${p.total||0}${detail}`; $('#state').textContent=p.status==='running'?'巡检中':p.status==='paused'?'已暂停':'需处理'; $('#pauseScan').disabled=p.status!=='running'; $('#resumeScan').disabled=p.status!=='paused'; }
function poll() { const timer=setInterval(async()=>{await load();if(['done','error'].includes(data.scanProgress?.status))clearInterval(timer)},1500); }
function exportCsv() { const rows=[['达人','最近排名','视频链接','文案','标签','状态','置信度','播放','点赞','评论','分享','首次发现','最近发现'],...data.videos.map(v=>[v.username,v.recentRank,v.url,v.caption,(v.tags||[]).map(x=>'#'+x).join(' '),v.status,v.score,v.views||'',v.likes||'',v.comments||'',v.shares||'',date(v.firstSeenAt),date(v.lastSeenAt)])]; const csv='\ufeff'+rows.map(r=>r.map(x=>'"'+String(x??'').replaceAll('"','""')+'"').join(',')).join('\r\n'); const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`tk-monitor-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(a.href); }
async function currentUsername() { const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); return decodeURIComponent((String(tab?.url||'').match(/tiktok\.com\/@([^/?]+)/)||[])[1]||'current'); }
function num(v) { if(v==null||v==='')return'—';const n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(n):esc(v); }
function date(ts){return ts?new Date(ts).toLocaleString('zh-CN'):''} function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
load();
