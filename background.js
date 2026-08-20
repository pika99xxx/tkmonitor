const WAIT_MS = 6500;
let running = false;
const control = { paused: false, stop: false, restart: false, creators: [] };

chrome.action.onClicked.addListener(async () => {
  await openDashboard("overview");
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "START_SCAN") {
    if (running) return reply({ ok: false, error: "巡检正在运行" });
    control.paused = false; control.stop = false; control.restart = false; control.creators = msg.creators || [];
    running = true;
    scanCreators(msg.creators || []).finally(() => { running = false; });
    reply({ ok: true });
    return true;
  }
  if (msg.type === "PAUSE_SCAN") { control.paused = true; setProgressStatus("paused"); reply({ ok: true }); return true; }
  if (msg.type === "RESUME_SCAN") { control.paused = false; setProgressStatus("running"); reply({ ok: true }); return true; }
  if (msg.type === "RESTART_SCAN") {
    if (running) { control.restart = true; control.paused = false; reply({ ok: true }); }
    else { control.paused = false; control.stop = false; control.restart = false; control.creators = msg.creators || []; running = true; scanCreators(control.creators).finally(() => { running = false; }); reply({ ok: true }); }
    return true;
  }
  if (msg.type === "SCAN_CURRENT") {
    scanCurrent(msg.creator).then(reply).catch(error => reply({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.type === "SCAN_STATUS") reply({ running });
  if (msg.type === "OPEN_DASHBOARD_VIEW") { openDashboard(msg.view).then(() => reply({ ok: true })).catch(error => reply({ ok: false, error: String(error?.message || error) })); return true; }
  if (msg.type === "REFRESH_VIDEO") {
    if (running) { reply({ ok: false, error: "请先暂停或等待巡检完成" }); return true; }
    refreshRecordedVideo(msg.url).then(reply).catch(error => reply({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

async function openDashboard(view = "overview") {
  const safeView = ["overview", "history", "settings"].includes(view) ? view : "overview";
  const baseUrl = chrome.runtime.getURL("dashboard.html"), targetUrl = `${baseUrl}#${safeView}`;
  const tabs = await chrome.tabs.query({ url: baseUrl + "*" });
  if (tabs[0]?.id) await chrome.tabs.update(tabs[0].id, { url: targetUrl, active: true });
  else await chrome.tabs.create({ url: targetUrl, active: true });
}

async function scanCreators(creators) {
  const runStartedAt = Date.now();
  const runResults = new Map();
  const tabs = await chrome.tabs.query({ url: ["https://www.tiktok.com/*", "https://tiktok.com/*"] });
  const tab = tabs.find(t => t.active) || tabs[0];
  if (!tab?.id) {
    await chrome.storage.local.set({ scanProgress: { status: "error", message: "请先打开并登录 TikTok 页面" } });
    return;
  }
  await chrome.storage.local.set({ scanProgress: { current: 0, total: creators.length, status: "running" } });
  for (let i = 0; i < creators.length; i++) {
    await waitForControl();
    if (control.stop) break;
    if (control.restart) { control.restart = false; runResults.clear(); i = -1; await chrome.storage.local.set({ scanProgress: { current: 0, total: creators.length, status: "running" } }); continue; }
    const creator = creators[i];
    await chrome.storage.local.set({ scanProgress: { current: i + 1, total: creators.length, username: creator.username, status: "running" } });
    try {
      await chrome.tabs.update(tab.id, { url: `https://www.tiktok.com/@${creator.username}`, active: true });
      await waitForTab(tab.id);
      await controlledDelay(WAIT_MS);
      await waitForControl();
      const result = await sendScrape(tab.id, creator);
      await enrichVideoDetails(tab.id, result, creator);
      await mergeResult(creator, result, false);
      runResults.set(creator.username.toLowerCase(), (result?.videos || []).filter(isMatchedVideo).map(v => historyVideo(v, creator.username)));
    } catch (error) {
      await appendError(creator.username, String(error?.message || error));
    }
    await controlledDelay(3500 + Math.floor(Math.random() * 3500));
  }
  await chrome.storage.local.set({ scanProgress: { current: creators.length, total: creators.length, status: "done", finishedAt: Date.now() } });
  const historyVideos = [...runResults.values()].flat();
  await appendHistory({ type: "scan", at: Date.now(), startedAt: runStartedAt, creatorCount: creators.length, criteria: historyCriteria(creators[0]), matchedCount: historyVideos.length, videos: historyVideos });
}

async function waitForControl() { while (control.paused && !control.stop) await delay(300); }
async function controlledDelay(ms) { const end = Date.now() + ms; while (Date.now() < end) { await waitForControl(); if (control.stop || control.restart) return; await delay(Math.min(300, end - Date.now())); } }
async function setProgressStatus(status) { const { scanProgress = {} } = await chrome.storage.local.get("scanProgress"); await chrome.storage.local.set({ scanProgress: { ...scanProgress, status } }); }

async function scanCurrent(creator) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !String(tab.url || "").includes("tiktok.com/@")) throw new Error("请先打开一个 TikTok 达人主页");
  const originalUrl = tab.url;
  const result = await sendScrape(tab.id, creator || {});
  await enrichVideoDetails(tab.id, result, creator || {});
  const detected = result?.username || (String(tab.url).match(/tiktok\.com\/@([^/?]+)/) || [])[1] || "current";
  await mergeResult({ ...(creator || {}), username: detected }, result, false);
  const matched=(result?.videos||[]).filter(isMatchedVideo).map(v=>historyVideo(v,detected));
  await appendHistory({type:"scan",at:Date.now(),startedAt:Date.now(),creatorCount:1,criteria:historyCriteria(creator||{}),matchedCount:matched.length,videos:matched});
  if (originalUrl) await chrome.tabs.update(tab.id, { url: originalUrl }).catch(() => {});
  return { ok: true, count: result?.videos?.length || 0, username: detected };
}

async function refreshRecordedVideo(url) {
  const stored = await chrome.storage.local.get(["videos", "snapshots"]);
  const videos = stored.videos || [], index = videos.findIndex(v => v.url === url);
  if (index < 0) throw new Error("没有找到这条已记录的视频");
  const tabs = await chrome.tabs.query({ url: ["https://www.tiktok.com/*", "https://tiktok.com/*"] });
  const tab = tabs.find(t => t.active) || tabs[0];
  if (!tab?.id) throw new Error("请先打开并登录 TikTok 页面");
  const originalUrl = tab.url;
  try {
    await chrome.tabs.update(tab.id, { url, active: true });
    await waitForTab(tab.id);
    await delay(4200);
    const current = videos[index];
    const detail = await sendPageMessage(tab.id, { type: "SCRAPE_VIDEO_DETAIL", videoId: current.videoId, creator: {} });
    if (detail?.error) throw new Error(detail.error);
    const now = Date.now();
    for (const key of ["caption","createTime","views","likes","comments","favorites","shares","source","tags","mentions"]) {
      if (detail?.[key] != null && detail[key] !== "") current[key] = detail[key];
    }
    current.lastRefreshedAt = now;
    const snapshots = stored.snapshots || [];
    snapshots.push({ url, at: now, kind: "manual-refresh", views: current.views, likes: current.likes, comments: current.comments, favorites: current.favorites, shares: current.shares });
    await chrome.storage.local.set({ videos, snapshots: snapshots.slice(-10000) });
    await appendHistory({ type: "refresh", at: now, creatorCount: 1, matchedCount: 1, videos: [historyVideo(current, current.username)] });
    return { ok: true, refreshedAt: now };
  } finally {
    if (originalUrl) await chrome.tabs.update(tab.id, { url: originalUrl }).catch(() => {});
  }
}

async function enrichVideoDetails(tabId, profileResult, creator) {
  for (const video of profileResult?.videos || []) {
    await waitForControl();
    if (control.stop || control.restart) return;
    try {
      await chrome.tabs.update(tabId, { url: video.url, active: true });
      await waitForTab(tabId);
      // Once a video page is opened, finish reading it before honoring pause.
      // This prevents a visible matching video from remaining unsaved forever.
      await delay(4200);
      if (control.stop || control.restart) return;
      const detail = await sendPageMessage(tabId, { type: "SCRAPE_VIDEO_DETAIL", videoId: video.videoId, creator });
      if (detail?.error) throw new Error(detail.error);
      for (const key of ["caption","createTime","views","likes","comments","favorites","shares","source","tags","mentions","matched","filterType","filterPass","tagPass","matchMode","score","status"]) {
        if (detail?.[key] != null && detail[key] !== "") video[key] = detail[key];
      }
      await mergeProgressVideo(creator, video);
      await chrome.storage.local.set({ scanProgress: { ...(await chrome.storage.local.get("scanProgress")).scanProgress, status: control.paused ? "paused" : "running", videoRank: video.recentRank } });
    } catch (error) {
      await appendError(video.videoId || video.url, `视频详情读取失败：${String(error?.message || error)}`);
    }
  }
}

function waitForTab(tabId) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 20000);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendScrape(tabId, creator) {
  const result = await sendPageMessage(tabId, { type: "SCRAPE_PROFILE", creator });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function sendPageMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!String(error?.message || error).includes("Receiving end does not exist")) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await delay(300);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function mergeProgressVideo(creator, item) {
  const stored = await chrome.storage.local.get(["videos", "snapshots"]);
  const byUrl = new Map((stored.videos || []).map(v => [v.url, v])), snapshots = stored.snapshots || [], now = Date.now(), existing = byUrl.get(item.url) || {};
  byUrl.set(item.url, { ...existing, ...item, username: creator.username, requiredKeywords: creator.requiredKeywords || [], requiredMentions: creator.requiredMentions || [], requiredTags: creator.requiredTags || [], lastSeenAt: now, firstSeenAt: existing.firstSeenAt || now });
  snapshots.push({ url: item.url, at: now, kind: "scan-progress", views: item.views, likes: item.likes, comments: item.comments, favorites: item.favorites, shares: item.shares });
  await chrome.storage.local.set({ videos: [...byUrl.values()], snapshots: snapshots.slice(-10000) });
}

async function mergeResult(creator, result, recordSnapshots = true) {
  const stored = await chrome.storage.local.get(["videos", "snapshots", "creatorResults"]);
  const byUrl = new Map((stored.videos || []).map(v => [v.url, v]));
  const snapshots = stored.snapshots || [];
  const now = Date.now();
  for (const item of result?.videos || []) {
    const existing = byUrl.get(item.url) || {};
    byUrl.set(item.url, { ...existing, ...item, username: creator.username, requiredKeywords: creator.requiredKeywords || [], requiredMentions: creator.requiredMentions || [], requiredTags: creator.requiredTags || [], lastSeenAt: now, firstSeenAt: existing.firstSeenAt || now });
    if (recordSnapshots) snapshots.push({ url: item.url, at: now, views: item.views, likes: item.likes, comments: item.comments, favorites: item.favorites, shares: item.shares });
  }
  const creatorResults = stored.creatorResults || {};
  creatorResults[creator.username.toLowerCase()] = { username: creator.username, lastScannedAt: now, checkedCount: result?.videos?.length || 0, matchedCount: (result?.videos || []).filter(v => v.status === "pending" || v.status === "confirmed").length, ...(result?.diagnostics || {}) };
  await chrome.storage.local.set({ videos: [...byUrl.values()], snapshots: snapshots.slice(-10000), creatorResults });
}

async function appendError(username, message) {
  const { scanErrors = [] } = await chrome.storage.local.get("scanErrors");
  scanErrors.push({ username, message, at: Date.now() });
  await chrome.storage.local.set({ scanErrors: scanErrors.slice(-100) });
}
function isMatchedVideo(video) { return video?.status === "pending" || video?.status === "confirmed"; }
function historyVideo(video, username) { return { username: username || video.username || "", url: video.url, caption: video.caption || "", createTime: video.createTime || null, views: video.views ?? null, likes: video.likes ?? null, comments: video.comments ?? null, favorites: video.favorites ?? null, shares: video.shares ?? null, matched: video.matched || [] }; }
function historyCriteria(creator = {}) { return [...(creator.requiredTags || []).map(x => "#" + x), ...(creator.requiredMentions || []).map(x => "@" + x), ...(creator.requiredKeywords || [])]; }
async function appendHistory(entry) { const { scanHistory = [] } = await chrome.storage.local.get("scanHistory"); scanHistory.unshift({ id: `${entry.at}-${Math.random().toString(36).slice(2,8)}`, ...entry, videos: (entry.videos || []).slice(0, 500) }); await chrome.storage.local.set({ scanHistory: scanHistory.slice(0, 50) }); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
