if (!globalThis.__tkMonitorContentLoaded) {
  globalThis.__tkMonitorContentLoaded = true;
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === "SCRAPE_PROFILE") {
      collectProfileVideos(msg.creator || {}).then(reply).catch(error => reply({ error: String(error?.message || error), videos: [] }));
      return true;
    }
    if (msg.type === "SCRAPE_VIDEO_DETAIL") {
      scrapeVideoDetail(msg.videoId, msg.creator || {}).then(reply).catch(error => reply({ error: String(error?.message || error) }));
      return true;
    }
  });
  initInlinePanel();
}

async function collectProfileVideos(creator) {
  const requestedCount = Math.min(100, Math.max(1, Number(creator.recentCount) || 3));
  const collectionTarget = requestedCount + 3;
  const seen = new Map();
  let scrollRounds = 0, stagnantRounds = 0, previousHeight = 0;
  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(500);
  while (scrollRounds < 60) {
    for (const video of mergePageVideos()) {
      const key = video.videoId || video.url;
      if (key) seen.set(key, mergeVideoData(seen.get(key) || {}, video));
    }
    if (seen.size >= collectionTarget) break;
    const beforeCount = seen.size;
    const beforeHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    window.scrollTo({ top: beforeHeight, behavior: "smooth" });
    scrollRounds += 1;
    await waitForMoreCards(beforeCount, beforeHeight);
    for (const video of mergePageVideos()) {
      const key = video.videoId || video.url;
      if (key) seen.set(key, mergeVideoData(seen.get(key) || {}, video));
    }
    const afterHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    if (seen.size === beforeCount && afterHeight <= beforeHeight && afterHeight === previousHeight) stagnantRounds += 1;
    else stagnantRounds = 0;
    previousHeight = afterHeight;
    if (stagnantRounds >= 3) break;
  }
  const reachedTarget = seen.size >= collectionTarget;
  const noMoreContent = !reachedTarget && stagnantRounds >= 3;
  return scrapeProfile(creator, [...seen.values()], { requestedCount, collectionTarget, loadedCount: seen.size, scrollRounds, loadComplete: reachedTarget || noMoreContent, targetReached: reachedTarget, noMoreContent });
}

function scrapeProfile(creator, collectedVideos = mergePageVideos(), diagnostics = {}) {
  const requiredTags = (creator.requiredTags || []).map(normalizeTag).filter(Boolean);
  const requiredMentions = (creator.requiredMentions || []).map(normalizeMention).filter(Boolean);
  const requiredKeywords = (creator.requiredKeywords || []).map(normalizeKeyword).filter(Boolean);
  const filterType = ["mentions", "keywords", "combined"].includes(creator.filterType) ? creator.filterType : "tags";
  const matchMode = creator.matchMode === "all" ? "all" : "any";
  const adWords = ["#ad", "#ads", "#sponsored", "paid partnership", "gifted", "affiliate", "合作", "广告"];
  const requestedCount = Math.min(100, Math.max(1, Number(creator.recentCount) || 3));
  const videos = collectedVideos.map(item => classify(item, requiredTags, requiredMentions, requiredKeywords, filterType, matchMode, adWords))
    .filter(v => v.createTime)
    .sort((a, b) => b.createTime - a.createTime)
    .slice(0, requestedCount)
    .map((v, index) => ({ ...v, recentRank: index + 1 }));
  return { videos, capturedAt: Date.now(), username: detectUsername(), diagnostics: { requestedCount, ...diagnostics } };
}

function mergePageVideos() {
  const byId = new Map();
  for (const video of readStructuredVideos()) byId.set(video.videoId || video.url, video);
  for (const video of readDomVideos()) {
    const key = video.videoId || video.url;
    byId.set(key, mergeVideoData(byId.get(key) || {}, video));
  }
  return [...byId.values()];
}
function mergeVideoData(old, fresh) {
  const merged = { ...old, ...fresh };
  for (const key of ["caption", "createTime", "views", "likes", "comments", "favorites", "shares"]) {
    if (fresh[key] == null || fresh[key] === "" || (key === "caption" && String(fresh[key]).length < String(old[key] || "").length)) merged[key] = old[key];
  }
  return merged;
}
async function waitForMoreCards(beforeCount, beforeHeight) {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    await sleep(350);
    const count = new Set(readDomVideos().map(v => v.videoId || v.url)).size;
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    if (count > beforeCount || height > beforeHeight) { await sleep(450); return; }
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeVideoDetail(requestedId, creator) {
  await expandVideoDescription();
  const videoId = String(requestedId || (location.pathname.match(/\/video\/(\d+)/) || [])[1] || "");
  const structured = readStructuredVideos().find(v => v.videoId === videoId) || {};
  const dom = {
    likes: readDetailMetric(["browse-like-count", "like-count"]),
    comments: readDetailMetric(["browse-comment-count", "comment-count"]),
    favorites: readDetailMetric(["browse-favorite-count", "favorite-count", "collect-count"]),
    shares: readDetailMetric(["browse-share-count", "share-count"]),
    views: readDetailMetric(["browse-video-views", "video-views", "play-count", "view-count"])
  };
  const descEl = document.querySelector('[data-e2e="browse-video-desc"],[data-e2e="video-desc"]');
  const visibleCaption = readExpandedCaption(descEl);
  const metadataCaption = readMetadataCaption();
  const detail = {
    videoId,
    url: location.href.split('?')[0],
    caption: combineCaptionSources(structured.caption, visibleCaption, metadataCaption),
    createTime: structured.createTime || snowflakeTime(videoId),
    views: structured.views ?? dom.views,
    likes: structured.likes ?? dom.likes,
    comments: structured.comments ?? dom.comments,
    favorites: structured.favorites ?? dom.favorites,
    shares: structured.shares ?? dom.shares,
    source: Object.keys(structured).length ? "video-structured-data" : "video-detail-dom"
  };
  const requiredTags = (creator.requiredTags || []).map(normalizeTag).filter(Boolean);
  const requiredMentions = (creator.requiredMentions || []).map(normalizeMention).filter(Boolean);
  const requiredKeywords = (creator.requiredKeywords || []).map(normalizeKeyword).filter(Boolean);
  const filterType = ["mentions", "keywords", "combined"].includes(creator.filterType) ? creator.filterType : "tags";
  const matchMode = creator.matchMode === "all" ? "all" : "any";
  return classify(detail, requiredTags, requiredMentions, requiredKeywords, filterType, matchMode, ["#ad", "#ads", "#sponsored", "paid partnership", "gifted", "affiliate", "合作", "广告"]);
}

async function expandVideoDescription() {
  const desc = document.querySelector('[data-e2e="browse-video-desc"],[data-e2e="video-desc"]');
  const direct = document.querySelector('[data-e2e="browse-video-desc-more"],[data-e2e="video-desc-more"],[data-e2e="expand-video-desc"],[aria-label="See more"],[aria-label="More"],[aria-label="展开"],[aria-label="更多"]');
  if (direct) { direct.click(); await sleep(500); return; }
  if (!desc) return;
  const candidates = [
    ...desc.querySelectorAll('button,[role="button"],[aria-expanded="false"]'),
    ...desc.parentElement?.querySelectorAll('button,[role="button"],[aria-expanded="false"]') || []
  ];
  const expand = candidates.find(el => /^(more|see more|展开|更多|显示更多|查看全部)\s*[.…]*$/i.test(compact(el.innerText || el.getAttribute('aria-label') || '')));
  if (!expand) return;
  expand.click();
  await sleep(450);
}

function readExpandedCaption(desc) {
  if (!desc) return "";
  const scope = desc.closest('[data-e2e*="video-desc"],article,[class*="DivVideoInfoContainer"],[class*="DivDescription"]') || desc;
  const tags = [...scope.querySelectorAll('a[href*="/tag/"]')].map(a => compact(a.innerText || a.textContent || tagFromHref(a.href))).filter(Boolean);
  const mentions = [...scope.querySelectorAll('a[href*="/@"]')].map(a => compact(a.innerText || a.textContent || '')).filter(Boolean);
  return compact([desc?.innerText || '', desc?.textContent || '', ...tags, ...mentions].join(' '));
}

function readMetadataCaption() {
  const values = [];
  for (const selector of ['meta[property="og:description"]','meta[name="description"]','meta[name="twitter:description"]']) {
    const value = document.querySelector(selector)?.getAttribute('content');
    if (value) values.push(value);
  }
  return compact(values.join(' '));
}

function tagFromHref(href) {
  const value = String(href || '').match(/\/tag\/([^/?#]+)/)?.[1];
  return value ? '#' + decodeURIComponent(value) : '';
}

function combineCaptionSources(...values) {
  const unique = [...new Set(values.map(compact).filter(Boolean))];
  return compact(unique.join(' '));
}

function readDetailMetric(names) {
  for (const name of names) {
    const el = document.querySelector(`[data-e2e="${name}"]`);
    if (!el) continue;
    const tokens = cleanMetricTokens(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`);
    if (tokens.length) return tokens[tokens.length - 1];
  }
  return null;
}

function classify(item, requiredTags, requiredMentions, requiredKeywords, filterType, matchMode, adWords) {
  const text = compact(item.caption || ""), lower = text.toLowerCase(), tags = extractTags(text), mentions = extractMentions(text);
  const matchedTags = requiredTags.filter(tag => tags.includes(tag));
  const matchedMentions = requiredMentions.filter(account => mentions.includes(account));
  const matchedKeywords = requiredKeywords.filter(keyword => lower.includes(keyword));
  const adMatched = adWords.filter(k => lower.includes(k));
  const combined = filterType === "combined";
  const required = combined ? [...requiredTags, ...requiredMentions, ...requiredKeywords] : filterType === "mentions" ? requiredMentions : filterType === "keywords" ? requiredKeywords : requiredTags;
  const matchedPrimary = combined ? [...matchedTags, ...matchedMentions, ...matchedKeywords] : filterType === "mentions" ? matchedMentions : filterType === "keywords" ? matchedKeywords : matchedTags;
  const filterPass = required.length === 0 || (matchMode === "all" ? matchedPrimary.length === required.length : matchedPrimary.length > 0);
  const displayMatched = combined ? [...matchedTags.map(x => "#" + x), ...matchedMentions.map(x => "@" + x), ...matchedKeywords] : filterType === "mentions" ? matchedMentions.map(x => "@" + x) : filterType === "tags" ? matchedTags.map(x => "#" + x) : matchedKeywords;
  const score = filterPass ? Math.min(100, matchedPrimary.length * 65 + adMatched.length * 10) : 0;
  return { ...item, caption: text.slice(0, 1000), tags, mentions, matched: [...displayMatched, ...adMatched], filterType, filterPass, tagPass: filterPass, matchMode, score, status: filterPass ? "pending" : "ignored" };
}

function readStructuredVideos() {
  const found = new Map();
  for (const script of document.querySelectorAll('script[type="application/json"],script#__UNIVERSAL_DATA_FOR_REHYDRATION__,script#SIGI_STATE')) {
    const raw = script.textContent || "";
    if (!raw || raw.length > 15000000) continue;
    try { walk(JSON.parse(raw), found); } catch (_) {}
  }
  return [...found.values()];
}

function walk(node, found, depth = 0) {
  if (!node || depth > 18) return;
  if (Array.isArray(node)) return node.forEach(x => walk(x, found, depth + 1));
  if (typeof node !== "object") return;
  const id = String(node.id || node.itemId || node.awemeId || ""), stats = node.stats || node.statistics || node.statsV2 || {};
  const desc = node.desc ?? node.description ?? node.title, created = Number(node.createTime || node.create_time || 0);
  if (/^\d{12,}$/.test(id) && desc != null && String(desc).trim()) {
    const username = node.author?.uniqueId || node.author?.unique_id || detectUsername();
    const createTime = created ? (created < 1e12 ? created * 1000 : created) : snowflakeTime(id);
    const previous = found.get(id) || {};
    found.set(id, { ...previous, videoId: id, url: `https://www.tiktok.com/@${username}/video/${id}`, caption: String(desc), createTime,
      views: metric(stats.playCount ?? stats.viewCount ?? stats.play_count) ?? previous.views ?? null, likes: metric(stats.diggCount ?? stats.likeCount ?? stats.like_count) ?? previous.likes ?? null, comments: metric(stats.commentCount ?? stats.comment_count) ?? previous.comments ?? null, favorites: metric(stats.collectCount ?? stats.favoriteCount ?? stats.favouriteCount ?? stats.collect_count) ?? previous.favorites ?? null, shares: metric(stats.shareCount ?? stats.share_count) ?? previous.shares ?? null });
  }
  Object.values(node).forEach(x => walk(x, found, depth + 1));
}

function readDomVideos() {
  const seen = new Set(), videos = [];
  document.querySelectorAll('a[href*="/video/"]').forEach(anchor => {
    const url = anchor.href.split("?")[0];
    if (!url || seen.has(url)) return; seen.add(url);
    const card = anchor.closest('div[data-e2e],article,div[class*="DivItemContainer"]') || anchor.parentElement?.parentElement || anchor;
    const id = (url.match(/\/video\/(\d+)/) || [])[1] || "";
    const metrics = extractCardMetrics(anchor, card);
    videos.push({ url, videoId: id, caption: compact([anchor.getAttribute("aria-label"), anchor.getAttribute("title"), card?.innerText].filter(Boolean).join(" ")), favorites: null, ...metrics, createTime: snowflakeTime(id) });
  });
  return videos;
}

function compact(v) { return String(v).replace(/\s+/g, " ").trim(); }
function extractViewCount(text) { const t = String(text).match(/(?:\d+(?:[.,]\d+)?)\s*[KMB万亿]?/gi) || []; return t.length ? t[t.length - 1].replace(/\s/g, "") : null; }
function extractCardMetrics(anchor, card) {
  const result = {
    likes: metricByHint(card, ["like-count", "like count", "likes", "点赞"]),
    shares: metricByHint(card, ["share-count", "share count", "shares", "转发", "分享"]),
    comments: metricByHint(card, ["comment-count", "comment count", "comments", "评论"]),
    views: metricByHint(card, ["view-count", "play-count", "video-views", "views", "播放"])
  };
  const units = findBottomIconUnits(anchor, card);
  if (units.length === 3) {
    // Confirmed fixed order: share, comment, views from left to right.
    // SVG presence confirms the metric row; position is authoritative.
    const shareValue = readIconUnitValue(units[0]);
    const commentValue = readIconUnitValue(units[1]);
    const viewValue = readIconUnitValue(units[2]);
    if (shareValue != null) result.shares = shareValue;
    if (commentValue != null) result.comments = commentValue;
    if (viewValue != null) result.views = viewValue;
  }
  if (result.likes == null) {
    const likeUnit = findLikeIconUnit(anchor);
    if (likeUnit) result.likes = readIconUnitValue(likeUnit);
  }
  return result;
}
function metricByHint(root, hints) {
  if (!root) return null;
  for (const el of root.querySelectorAll('[data-e2e],[aria-label],[title],button')) {
    const identity = `${el.getAttribute('data-e2e')||''} ${el.getAttribute('aria-label')||''} ${el.getAttribute('title')||''}`.toLowerCase();
    if (!hints.some(h => identity.includes(h))) continue;
    const tokens = cleanMetricTokens(`${el.innerText||''} ${el.getAttribute('aria-label')||''}`);
    if (tokens.length) return tokens[tokens.length - 1];
  }
  return null;
}
function findBottomIconUnits(anchor, card) {
  const anchorBox = anchor.getBoundingClientRect();
  const candidates = [...(card || anchor.parentElement).querySelectorAll('div,li')].filter(row => {
    const children = [...row.children];
    if (children.length !== 3) return false;
    const box = row.getBoundingClientRect();
    return box.top >= anchorBox.bottom - 8 && children.every(child => child.querySelector('svg') && readIconUnitValue(child) != null);
  });
  if (!candidates.length) return [];
  const row = candidates.sort((a,b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
  return [...row.children].sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
}
function findLikeIconUnit(anchor) {
  const box = anchor.getBoundingClientRect();
  const units = [...anchor.querySelectorAll('div,span,button')].filter(el => {
    if (!el.querySelector('svg') || readIconUnitValue(el) == null) return false;
    const r = el.getBoundingClientRect();
    return r.left < box.left + box.width * .45 && r.top > box.top + box.height * .55;
  });
  const semantic = units.find(el => classifyIconUnit(el) === 'likes');
  if (semantic) return semantic;
  return units.sort((a,b) => (a.getBoundingClientRect().width*a.getBoundingClientRect().height) - (b.getBoundingClientRect().width*b.getBoundingClientRect().height))[0] || null;
}
function classifyIconUnit(unit) {
  const svg = unit.querySelector('svg');
  const identity = `${unit.getAttribute('aria-label')||''} ${unit.getAttribute('title')||''} ${unit.getAttribute('data-e2e')||''} ${svg?.getAttribute('aria-label')||''} ${svg?.getAttribute('data-icon')||''} ${svg?.querySelector('title')?.textContent||''}`.toLowerCase();
  if (/like|heart|点赞/.test(identity)) return 'likes';
  if (/share|forward|转发|分享/.test(identity)) return 'shares';
  if (/comment|reply|评论/.test(identity)) return 'comments';
  if (/play|view|播放/.test(identity)) return 'views';
  const d = [...(svg?.querySelectorAll('path') || [])].map(p => p.getAttribute('d') || '').join(' ');
  if (svg?.querySelector('polygon') || ((d.match(/[Ll]/g)||[]).length >= 2 && (d.match(/[Zz]/g)||[]).length === 1 && d.length < 180)) return 'views';
  return null;
}
function readIconUnitValue(unit) {
  const clone = unit.cloneNode(true);
  clone.querySelectorAll('svg,style,script').forEach(x => x.remove());
  const tokens = cleanMetricTokens(clone.textContent || '');
  return tokens.length === 1 ? tokens[0] : null;
}
function cleanMetricTokens(text) { return (String(text).match(/(?:\d+(?:[.,]\d+)?)\s*[KMB万亿]?/gi) || []).map(x => x.replace(/\s/g, "")); }
function detectUsername() { return decodeURIComponent((location.pathname.match(/^\/@([^/]+)/) || [])[1] || "unknown"); }
function extractTags(text) { return [...new Set([...String(text).matchAll(/#([\p{L}\p{N}_-]+)/gu)].map(m => normalizeTag(m[1])))]; }
function extractMentions(text) { return [...new Set([...String(text).matchAll(/@([\p{L}\p{N}._&-]+)/gu)].map(m => normalizeMention(m[1])))]; }
function normalizeTag(v) { return String(v || "").trim().replace(/^#/, "").toLowerCase(); }
function normalizeMention(v) { return String(v || "").trim().replace(/^@/, "").toLowerCase(); }
function normalizeKeyword(v) { return String(v || "").trim().toLowerCase(); }
function metric(v) { return v == null ? null : String(v); }
function snowflakeTime(id) { try { return Number(BigInt(id) >> 32n) * 1000; } catch (_) { return 0; } }

function initInlinePanel() {
  if (document.getElementById('tk-monitor-host')) return;
  const host = document.createElement('div'); host.id = 'tk-monitor-host'; document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial}.dock{position:fixed;right:16px;top:92px;width:332px;max-height:calc(100vh - 112px);z-index:2147483646;background:#0d1014;color:#eef1f4;border:1px solid #30363d;border-radius:14px;box-shadow:0 18px 55px #0008;font:12px/1.45 Inter,"Microsoft YaHei",sans-serif;overflow:hidden}.head{display:flex;justify-content:space-between;align-items:center;padding:14px 15px;border-bottom:1px solid #282d33;background:#11151a}.brand{font-weight:800;font-size:14px}.brand i{font-style:normal;color:#ffd166}.state{font-size:10px;color:#9aa2ab;border:1px solid #3a4149;border-radius:99px;padding:4px 7px}.body{padding:13px;max-height:calc(100vh - 170px);overflow:auto}.label{display:flex;justify-content:space-between;color:#cbd1d7;margin:8px 0 5px}.label small{color:#737c86}textarea,input,select{width:100%;box-sizing:border-box;background:#171b20;color:#eef1f4;border:1px solid #343b43;border-radius:7px;padding:8px;outline:none;font:inherit}textarea{height:82px;resize:vertical}input:focus,textarea:focus,select:focus{border-color:#ffd166}.row{display:grid;grid-template-columns:1fr 112px;gap:7px}.actions{display:flex;gap:6px;flex-wrap:wrap;margin:11px 0}.actions button{border:1px solid #363d45;background:#1a1f25;color:#dfe4e9;border-radius:7px;padding:7px 9px;cursor:pointer;font:inherit}.actions .go{background:#ffd166;color:#17130b;border-color:#ffd166;font-weight:800}.actions button:disabled{opacity:.35;cursor:not-allowed}.progress{height:3px;background:#242a30;border-radius:5px;overflow:hidden}.progress b{display:block;height:100%;background:#ffd166;width:0}.progressText{color:#87909a;font-size:10px;margin:5px 0 10px}.result{border-top:1px solid #252a30;padding:9px 0}.result:first-child{border-top:0}.rTop{display:flex;justify-content:space-between;gap:7px}.rTop a{color:#8abfff;text-decoration:none;font-weight:700}.pass{color:#14110a;background:#ffd166;border-radius:99px;padding:2px 6px;font-size:9px}.desc{color:#969fa8;margin:5px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tags{color:#f3c763;font-size:10px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:6px}.metrics span{background:#171b20;padding:5px;border-radius:5px;color:#737d87;font-size:9px}.metrics b{display:block;color:#ecf0f3;font-size:11px}.empty{color:#68717b;text-align:center;padding:20px 5px}.mini{position:fixed;right:16px;top:92px;z-index:2147483647;background:#ffd166;color:#17130b;border:0;border-radius:99px;width:42px;height:42px;font-weight:900;display:none;cursor:pointer}.collapsed .dock{display:none}.collapsed .mini{display:block}.close{background:none;border:0;color:#818a94;cursor:pointer}
  </style><div class="wrap"><button class="mini">TK</button><section class="dock"><div class="head"><span class="brand"><i>TK</i> 推广视频雷达</span><div><span class="state">待机</span><button class="close">—</button></div></div><div class="body"><div class="pageLinks"><button class="openOverview">查询总览</button><button class="openHistory">历史记录</button></div><div class="label"><span>达人名单</span><small>每行一个账号</small></div><textarea class="creators" placeholder="creator_one&#10;creator_two"></textarea><div class="label"><span>组合筛选条件</span><small>推荐每行一个</small></div><div class="row criteriaRow"><textarea class="tags" placeholder="#furniture&#10;@brandname&#10;sofa discount"></textarea><select class="mode"><option value="any">满足任一</option><option value="all">必须满足全部</option></select></div><div class="criteriaHint">支持换行、逗号、分号和顿号；# 为 Tag，@ 为账号，无前缀为关键词</div><div class="label"><span>每位达人读取最近几条</span><small>1–100，另加载 3 条置顶缓冲</small></div><input class="recentCount" type="number" min="1" max="100" value="3"><div class="actions"><button class="save">保存</button><button class="go start">开始巡检</button><button class="pause">暂停</button><button class="resume">继续</button><button class="restart">重新开始</button></div><div class="progress"><b></b></div><div class="progressText">等待开始</div><div class="results"></div></div></section></div>`;
  const theme = document.createElement('style');
  theme.textContent = `.dock{background:#f7f7fc;color:#343449;border-color:#e2e1ee;box-shadow:0 20px 55px #5f628033}.head{background:linear-gradient(135deg,#7a70f2,#665fed);border-bottom:0;color:#fff}.brand i{color:#fff;background:#ffffff24;border-radius:7px;padding:3px 5px}.state{color:#f0efff;border-color:#ffffff55;background:#ffffff18}.close{color:#eeedff}.body{background:linear-gradient(145deg,#f2f3f9,#faf9fd)}.label{color:#55566b}.label small{color:#9a9bac}textarea,input,select{background:#fff;color:#3b3b50;border-color:#deddea;border-radius:9px}input:focus,textarea:focus,select:focus{border-color:#7a71ee;box-shadow:0 0 0 3px #766cf318}.actions button{border-color:#dcdae8;background:#fff;color:#5b5c70;border-radius:9px}.actions .go{background:#7168ed;color:#fff;border-color:#7168ed}.progress{background:#e2e1ec}.progress b{background:linear-gradient(90deg,#766cf3,#a49dee)}.progressText{color:#8e8f9f}.result{border-color:#e5e4ed}.rTop a{color:#5e57d7}.pass{color:#5b54d5;background:#ebe9ff}.desc{color:#9293a3}.tags{color:#6d64e5}.metrics span{background:#fff;color:#999aaa;border:1px solid #ecebf3}.metrics b{color:#424257}.empty{color:#9899a8}.mini{background:linear-gradient(135deg,#7a70f2,#625cf0);color:#fff;box-shadow:0 10px 28px #655ee455}`;
  theme.textContent += `.metrics{grid-template-columns:repeat(3,1fr)!important}`;
  theme.textContent += `.dock{background:#fff!important;color:#121212!important;border-color:#dedede!important;box-shadow:0 10px 34px #00000014!important}.head{background:#121212!important;color:#fff!important;border-bottom:1px solid #121212!important}.brand i{background:#fff!important;color:#121212!important}.state{background:#ffffff14!important;border-color:#ffffff44!important;color:#fff!important}.body{background:#f7f7f7!important}.label{color:#222!important}.label small{color:#8c8c8c!important}textarea,input,select{background:#fff!important;color:#171717!important;border-color:#dcdcdc!important}input:focus,textarea:focus,select:focus{border-color:#2458e8!important;box-shadow:0 0 0 3px #2458e815!important}.actions button{background:#fff!important;color:#333!important;border-color:#dcdcdc!important}.actions .go{background:#121212!important;color:#fff!important;border-color:#121212!important}.progress{background:#e4e4e4!important}.progress b{background:#2458e8!important}.progressText{color:#777!important}.result{border-color:#e5e5e5!important}.rTop a,.tags{color:#2458e8!important}.pass{background:#eef3ff!important;color:#2458e8!important}.desc{color:#777!important}.metrics span{background:#fff!important;border-color:#e5e5e5!important;color:#888!important}.metrics b{color:#171717!important}.mini{background:#121212!important;color:#fff!important;box-shadow:0 8px 24px #0003!important}`;
  theme.textContent += `.criteriaRow{align-items:start!important}.criteriaRow .tags{height:78px!important;resize:vertical!important;line-height:1.5!important;color:#171717!important}.criteriaHint{font:10px/1.45 Inter,"Microsoft YaHei",sans-serif;color:#888;margin:5px 0 9px}`;
  theme.textContent += `.pageLinks{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:10px}.pageLinks button{border:1px solid #dcdcdc;background:#fff;color:#222;border-radius:9px;padding:8px;cursor:pointer;font:11px Inter,"Microsoft YaHei",sans-serif}.pageLinks button:hover{border-color:#2458e8;color:#2458e8}`;
  root.appendChild(theme);
  // TikTok listens for page-wide keyboard shortcuts (for example, fullscreen).
  // Let controls handle typing first, then stop those events at the shadow root
  // so they never bubble into TikTok's page handlers.
  for (const eventName of ['keydown', 'keypress', 'keyup']) {
    root.addEventListener(eventName, event => event.stopPropagation());
  }
  const q = s => root.querySelector(s), wrap = q('.wrap');
  const criteriaLabel = q('.tags').closest('.row').previousElementSibling;
  criteriaLabel.querySelector('span').textContent = '筛选条件';
  criteriaLabel.querySelector('span').textContent = '组合筛选条件';
  criteriaLabel.querySelector('small').textContent = '用逗号或分号分隔';
  q('.tags').placeholder = '#furniture; @brandname; sofa discount';
  q('.close').onclick = () => wrap.classList.add('collapsed'); q('.mini').onclick = () => wrap.classList.remove('collapsed');
  q('.openOverview').onclick = () => chrome.runtime.sendMessage({type:'OPEN_DASHBOARD_VIEW',view:'overview'});
  q('.openHistory').onclick = () => chrome.runtime.sendMessage({type:'OPEN_DASHBOARD_VIEW',view:'history'});
  q('.save').onclick = saveInlineSettings;
  q('.start').onclick = async () => { const cfg = await saveInlineSettings(); if (!cfg.creators.length || !cfg.values.length) return alert('请填写达人名单和筛选条件'); const creators=cfg.creators.map(c=>({...c,filterType:cfg.filterType,requiredTags:cfg.tags,requiredMentions:cfg.mentions,requiredKeywords:cfg.keywords,matchMode:cfg.mode,recentCount:cfg.recentCount})); await chrome.runtime.sendMessage({type:'START_SCAN',creators}); };
  q('.pause').onclick = () => chrome.runtime.sendMessage({type:'PAUSE_SCAN'});
  q('.resume').onclick = () => chrome.runtime.sendMessage({type:'RESUME_SCAN'});
  q('.restart').onclick = async () => { const cfg=await saveInlineSettings();const creators=cfg.creators.map(c=>({...c,filterType:cfg.filterType,requiredTags:cfg.tags,requiredMentions:cfg.mentions,requiredKeywords:cfg.keywords,matchMode:cfg.mode,recentCount:cfg.recentCount}));await chrome.runtime.sendMessage({type:'RESTART_SCAN',creators}); };
  chrome.storage.onChanged.addListener(() => renderInline());
  renderInline();

  async function saveInlineSettings() {
    const stored=await chrome.storage.local.get('tagSettings');
    const creators=[];
    for(const raw of q('.creators').value.split(/[\r\n,，\t]+/)){const username=raw.trim().replace(/^@/,'');if(!username)continue;creators.push({username})}
    const values=splitInlineCriteria(q('.tags').value);
    const tags=values.filter(x=>x.startsWith('#')).map(x=>x.slice(1).toLowerCase()).filter(Boolean);
    const mentions=values.filter(x=>x.startsWith('@')).map(x=>x.slice(1).toLowerCase()).filter(Boolean);
    const keywords=values.filter(x=>!x.startsWith('#')&&!x.startsWith('@')).map(x=>x.toLowerCase());
    const settings={tags,mentions,keywords,filterType:'combined',filterTypes:['tags','mentions','keywords'].filter((_,i)=>[tags,mentions,keywords][i].length),mode:q('.mode').value,recentCount:Math.min(100,Math.max(1,Number(q('.recentCount').value)||3))};
    await chrome.storage.local.set({creators,tagSettings:settings}); return {creators,values,...settings};
  }
  async function renderInline() {
    const state=await chrome.storage.local.get(['creators','tagSettings','videos','scanProgress']);
    if (root.activeElement !== q('.creators')) q('.creators').value=(state.creators||[]).map(x=>x.username).join('\n');
    const values=[...(state.tagSettings?.tags||[]).map(x=>'#'+x),...(state.tagSettings?.mentions||[]).map(x=>'@'+x),...(state.tagSettings?.keywords||[])];
    if (root.activeElement !== q('.tags')) q('.tags').value=values.join('\n');
    q('.mode').value=state.tagSettings?.mode||'any';
    q('.recentCount').value=state.tagSettings?.recentCount||3;
    const p=state.scanProgress||{}, status=p.status||'idle'; q('.state').textContent={running:'巡检中',paused:'已暂停',done:'已完成',error:'异常',idle:'待机'}[status]||'待机';
    q('.progress b').style.width=(p.total?Math.round((p.current||0)/p.total*100):0)+'%';
    q('.progressText').textContent=status==='running'?`正在检查 @${p.username||''} · ${p.current||0}/${p.total||0}${p.videoRank?' · 第 '+p.videoRank+' 条':''}`:status==='paused'?`将在当前视频保存后暂停 · @${p.username||''} · ${p.current||0}/${p.total||0}${p.videoRank?' · 已保存第 '+p.videoRank+' 条':''}`:status==='done'?`巡检完成 · ${p.total||0} 位达人`:status==='error'?(p.message||'巡检异常'):'等待开始';
    q('.pause').disabled=status!=='running';q('.resume').disabled=status!=='paused';
    const videos=(state.videos||[]).filter(v=>v.status==='pending').sort((a,b)=>(b.lastSeenAt||0)-(a.lastSeenAt||0)).slice(0,12);
    q('.results').innerHTML=videos.length?videos.map(v=>`<article class="result"><div class="rTop"><a href="${safe(v.url)}">@${safe(v.username)} · 发布时间倒序第 ${v.recentRank||'?'} 条</a><span class="pass">匹配</span></div><div class="desc">${safe(v.caption||'')}</div><div class="tags">${(v.matched||[]).map(safe).join(' ')}</div><div class="metrics"><span>播放<b>${fmt(v.views)}</b></span><span>点赞<b>${fmt(v.likes)}</b></span><span>评论<b>${fmt(v.comments)}</b></span><span>收藏<b>${fmt(v.favorites)}</b></span><span>转发<b>${fmt(v.shares)}</b></span><span>互动率<b>${inlineEngagement(v)}</b></span></div></article>`).join(''):'<div class="empty">暂无符合筛选条件的视频</div>';
    annotateVisibleCards(state.videos||[]);
  }
}

function splitInlineCriteria(text){return[...new Set(String(text||'').split(/[\r\n,，;；、\t]+/).map(x=>x.trim().replace(/^[,，;；、]+|[,，;；、]+$/g,'')).filter(Boolean))]}

function annotateVisibleCards(videos) {
  const byId=new Map(videos.map(v=>[v.videoId,v]));
  document.querySelectorAll('a[href*="/video/"]').forEach(a=>{const id=(a.href.match(/\/video\/(\d+)/)||[])[1],v=byId.get(id);if(!v||a.querySelector('.tk-monitor-badge'))return;const badge=document.createElement('span');badge.className='tk-monitor-badge';badge.textContent=`▶ ${v.views??'—'}  ♥ ${v.likes??'—'}  💬 ${v.comments??'—'}  ↗ ${v.shares??'—'}`;badge.style.cssText='position:absolute;left:6px;bottom:6px;z-index:99;background:#0b0d10dd;color:#fff;padding:4px 6px;border-radius:5px;font:10px sans-serif;pointer-events:none';if(getComputedStyle(a).position==='static')a.style.position='relative';a.appendChild(badge);});
}
function safe(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmt(v){if(v==null||v==='')return'—';const n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(n):safe(v);}
function inlineMetricNumber(value){if(value==null||value==='')return null;const s=String(value).trim().replace(/,/g,'').toUpperCase(),m=s.match(/^([\d.]+)\s*(K|M|B|万|亿)?$/);if(!m)return Number.isFinite(Number(s))?Number(s):null;return Number(m[1])*({K:1e3,M:1e6,B:1e9,'万':1e4,'亿':1e8}[m[2]]||1);}
function inlineEngagement(v){const values=[v.likes,v.comments,v.favorites,v.shares].map(inlineMetricNumber),views=inlineMetricNumber(v.views);if(!views||values.some(x=>x==null))return'—';return(values.reduce((a,b)=>a+b,0)/views*100).toFixed(2)+'%';}
