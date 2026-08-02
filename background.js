/**
 * Incognito History Vault - background service worker (Manifest V3)
 * ---------------------------------------------------------------------------
 * chrome.history never records Incognito visits, so we observe navigation
 * ourselves and keep our own log:
 *
 *   chrome.webNavigation.onCommitted            -> real page loads
 *   chrome.webNavigation.onHistoryStateUpdated  -> SPA route changes
 *   chrome.tabs.onUpdated                       -> late-arriving title/favicon
 *   chrome.tabs.onRemoved                       -> close out dwell/tab spans
 *
 * Every event is discarded unless the originating tab has `incognito === true`.
 *
 * The manifest declares `"incognito": "spanning"`, which means ONE service
 * worker instance serves both the normal and the Incognito profile, so a single
 * chrome.storage.local namespace holds everything. (With "split" Chrome would
 * spawn a second, isolated extension instance for Incognito, which defeats the
 * goal of one unified, persistent vault.)
 *
 * A service worker can be torn down at any moment, so *no* durable state lives
 * in module scope: per-tab bookkeeping goes to chrome.storage.session and the
 * log itself goes to chrome.storage.local through a serialised write queue.
 */

const LOG_KEY = 'history';
const SPANS_KEY = 'sessions';
const SETTINGS_KEY = 'settings';
const SESSION_TABS_KEY = 'tabState';

const DEFAULT_SETTINGS = Object.freeze({
  tracking: true,        // master on/off switch
  trackSpa: true,        // record in-page (History API) route changes
  retention: 'forever',  // '1d' | '7d' | 'forever'
  maxEntries: 15000      // hard cap, oldest entries are trimmed first
});

const RETENTION_MS = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  forever: Infinity
};

/** Schemes that carry no meaningful browsing signal. */
const IGNORED_SCHEMES = [
  'chrome:', 'chrome-extension:', 'chrome-search:', 'chrome-untrusted:',
  'devtools:', 'about:', 'edge:', 'brave:', 'opera:', 'vivaldi:',
  'moz-extension:', 'view-source:', 'data:', 'blob:', 'javascript:'
];

const PURGE_ALARM = 'retention-purge';
const DEDUPE_WINDOW_MS = 1500;
const MAX_SPANS = 2000;

/* -------------------------------------------------------------------------- */
/* storage helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Serialises every read-modify-write cycle. Navigation events can fire in
 * bursts (redirect chains, many tabs at once) and chrome.storage has no
 * transactions, so without this chain concurrent updates would clobber
 * each other.
 */
let writeChain = Promise.resolve();

function enqueue(task) {
  const run = writeChain.then(task, task);
  // Keep the chain alive even if one task rejects.
  writeChain = run.catch((err) => console.error('[vault] write failed', err));
  return run;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function getLog() {
  const stored = await chrome.storage.local.get(LOG_KEY);
  return Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
}

async function getSpans() {
  const stored = await chrome.storage.local.get(SPANS_KEY);
  return Array.isArray(stored[SPANS_KEY]) ? stored[SPANS_KEY] : [];
}

async function getTabState() {
  const stored = await chrome.storage.session.get(SESSION_TABS_KEY);
  return stored[SESSION_TABS_KEY] || {};
}

function setTabState(state) {
  return chrome.storage.session.set({ [SESSION_TABS_KEY]: state });
}

/* -------------------------------------------------------------------------- */
/* small utilities                                                            */
/* -------------------------------------------------------------------------- */

function isTrackableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  if (IGNORED_SCHEMES.some((scheme) => lower.startsWith(scheme))) return false;
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('ftp://');
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return '';
  }
}

function makeId() {
  // crypto.randomUUID is available in service workers on Chrome 92+.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Reads a tab, tolerating the "tab was closed mid-flight" race. */
async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* badge                                                                      */
/* -------------------------------------------------------------------------- */

async function refreshBadge(log) {
  try {
    const entries = log || (await getLog());
    const dayAgo = Date.now() - RETENTION_MS['1d'];
    const today = entries.reduce((n, e) => (e.ts >= dayAgo ? n + 1 : n), 0);
    await chrome.action.setBadgeBackgroundColor({ color: '#6d4aff' });
    await chrome.action.setBadgeText({ text: today ? String(Math.min(today, 9999)) : '' });
  } catch (err) {
    console.warn('[vault] badge update skipped', err);
  }
}

/* -------------------------------------------------------------------------- */
/* recording                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Records one Incognito navigation.
 *
 * Side effects, all inside a single queued read-modify-write:
 *  - closes the dwell timer of whatever the tab was showing before
 *  - opens/extends the tab's "span" (used by the session-duration analytics)
 *  - appends (or de-duplicates) the entry and enforces the size cap
 */
async function recordVisit({ tabId, url, title, favIconUrl, transition, kind, windowId }) {
  const settings = await getSettings();
  if (!settings.tracking) return;
  if (!isTrackableUrl(url)) return;
  if (kind === 'spa' && !settings.trackSpa) return;

  await enqueue(async () => {
    const now = Date.now();
    const [log, spans, tabState] = await Promise.all([getLog(), getSpans(), getTabState()]);
    const key = String(tabId);
    const previous = tabState[key];

    // --- de-duplicate redirect chains / double-commits on the same tab -----
    if (previous && previous.entryId && previous.url === url && now - previous.startedAt < DEDUPE_WINDOW_MS) {
      const existing = log.find((e) => e.id === previous.entryId);
      if (existing) {
        if (title) existing.title = title;
        if (favIconUrl) existing.favIconUrl = favIconUrl;
        await chrome.storage.local.set({ [LOG_KEY]: log });
        return;
      }
    }

    // --- close the dwell timer on the tab's previous page ------------------
    if (previous && previous.entryId) {
      const prevEntry = log.find((e) => e.id === previous.entryId);
      if (prevEntry && !prevEntry.dwellMs) {
        prevEntry.dwellMs = Math.max(0, now - previous.startedAt);
      }
    }

    // --- append -----------------------------------------------------------
    const entry = {
      id: makeId(),
      url,
      domain: domainOf(url),
      path: pathOf(url),
      title: title || '',
      favIconUrl: favIconUrl || '',
      ts: now,
      hour: new Date(now).getHours(),
      weekday: new Date(now).getDay(),
      tabId,
      windowId: typeof windowId === 'number' ? windowId : -1,
      transition: transition || kind || 'link',
      kind: kind || 'load',
      dwellMs: 0,
      incognito: true
    };
    log.push(entry);

    // --- size cap ---------------------------------------------------------
    const cap = Number(settings.maxEntries) || DEFAULT_SETTINGS.maxEntries;
    const overflow = log.length - cap;
    if (overflow > 0) log.splice(0, overflow);

    // --- tab span bookkeeping --------------------------------------------
    const spanStart = previous && previous.tabOpenedAt ? previous.tabOpenedAt : now;
    tabState[key] = {
      entryId: entry.id,
      url,
      startedAt: now,
      tabOpenedAt: spanStart,
      views: (previous && previous.views ? previous.views : 0) + 1,
      firstUrl: previous && previous.firstUrl ? previous.firstUrl : url,
      firstDomain: previous && previous.firstDomain ? previous.firstDomain : entry.domain
    };

    await Promise.all([
      chrome.storage.local.set({ [LOG_KEY]: log, [SPANS_KEY]: spans }),
      setTabState(tabState)
    ]);
    await refreshBadge(log);
  });
}

/** Fills in title/favicon that Chrome only knows about after the commit. */
async function enrichLatest(tabId, patch) {
  if (!patch.title && !patch.favIconUrl) return;
  await enqueue(async () => {
    const tabState = await getTabState();
    const current = tabState[String(tabId)];
    if (!current || !current.entryId) return;

    const log = await getLog();
    const entry = log.find((e) => e.id === current.entryId);
    if (!entry) return;

    let dirty = false;
    if (patch.title && patch.title !== entry.title) {
      entry.title = patch.title;
      dirty = true;
    }
    if (patch.favIconUrl && patch.favIconUrl !== entry.favIconUrl) {
      entry.favIconUrl = patch.favIconUrl;
      dirty = true;
    }
    if (dirty) await chrome.storage.local.set({ [LOG_KEY]: log });
  });
}

/** A tab went away: stamp its final dwell time and archive the span. */
async function closeTab(tabId) {
  await enqueue(async () => {
    const tabState = await getTabState();
    const key = String(tabId);
    const state = tabState[key];
    if (!state) return;

    const now = Date.now();
    const [log, spans] = await Promise.all([getLog(), getSpans()]);

    const entry = state.entryId ? log.find((e) => e.id === state.entryId) : null;
    if (entry && !entry.dwellMs) entry.dwellMs = Math.max(0, now - state.startedAt);

    spans.push({
      id: makeId(),
      tabId,
      startedAt: state.tabOpenedAt || state.startedAt,
      endedAt: now,
      durationMs: Math.max(0, now - (state.tabOpenedAt || state.startedAt)),
      views: state.views || 1,
      firstUrl: state.firstUrl || '',
      domain: state.firstDomain || domainOf(state.firstUrl || ''),
      lastUrl: state.url || ''
    });
    if (spans.length > MAX_SPANS) spans.splice(0, spans.length - MAX_SPANS);

    delete tabState[key];
    await Promise.all([
      chrome.storage.local.set({ [LOG_KEY]: log, [SPANS_KEY]: spans }),
      setTabState(tabState)
    ]);
  });
}

/* -------------------------------------------------------------------------- */
/* retention                                                                  */
/* -------------------------------------------------------------------------- */

async function applyRetention() {
  const settings = await getSettings();
  const window = RETENTION_MS[settings.retention];
  if (!window || window === Infinity) return { removed: 0 };

  return enqueue(async () => {
    const cutoff = Date.now() - window;
    const [log, spans] = await Promise.all([getLog(), getSpans()]);
    const keptLog = log.filter((e) => e.ts >= cutoff);
    const keptSpans = spans.filter((s) => s.endedAt >= cutoff);
    const removed = log.length - keptLog.length;

    if (removed || keptSpans.length !== spans.length) {
      await chrome.storage.local.set({ [LOG_KEY]: keptLog, [SPANS_KEY]: keptSpans });
      await refreshBadge(keptLog);
    }
    return { removed };
  });
}

function ensureAlarm() {
  chrome.alarms.get(PURGE_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(PURGE_ALARM, { periodInMinutes: 30, delayInMinutes: 1 });
  });
}

/* -------------------------------------------------------------------------- */
/* event wiring                                                               */
/* -------------------------------------------------------------------------- */

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;                       // top-level frames only
  const tab = await safeGetTab(details.tabId);
  if (!tab || tab.incognito !== true) return;              // <- the Incognito gate
  await recordVisit({
    tabId: details.tabId,
    windowId: tab.windowId,
    url: details.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl,
    transition: details.transitionType,
    kind: 'load'
  });
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const tab = await safeGetTab(details.tabId);
  if (!tab || tab.incognito !== true) return;
  await recordVisit({
    tabId: details.tabId,
    windowId: tab.windowId,
    url: details.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl,
    transition: details.transitionType,
    kind: 'spa'
  });
});

// Titles and favicons usually resolve a beat after onCommitted fires.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab || tab.incognito !== true) return;
  if (!changeInfo.title && !changeInfo.favIconUrl) return;
  if (!isTrackableUrl(tab.url)) return;
  enrichLatest(tabId, { title: changeInfo.title, favIconUrl: changeInfo.favIconUrl });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  closeTab(tabId);
});

// Replaced tabs (prerender/back-forward cache swaps) keep browsing alive under
// a new id, so migrate the bookkeeping instead of dropping it.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  enqueue(async () => {
    const tabState = await getTabState();
    const old = tabState[String(removedTabId)];
    if (!old) return;
    tabState[String(addedTabId)] = old;
    delete tabState[String(removedTabId)];
    await setTabState(tabState);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PURGE_ALARM) applyRetention();
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  ensureAlarm();
  await applyRetention();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  // Tabs from the previous browser run are gone; drop their bookkeeping.
  await chrome.storage.session.remove(SESSION_TABS_KEY);
  ensureAlarm();
  await applyRetention();
  await refreshBadge();
});

/* -------------------------------------------------------------------------- */
/* message API (used by popup.js and dashboard.js)                             */
/* -------------------------------------------------------------------------- */

async function isIncognitoAllowed() {
  try {
    if (chrome.extension && chrome.extension.isAllowedIncognitoAccess) {
      return await chrome.extension.isAllowedIncognitoAccess();
    }
  } catch (err) {
    console.warn('[vault] could not read Incognito access', err);
  }
  return null; // unknown
}

const handlers = {
  async getState() {
    const [log, settings, allowed, bytes] = await Promise.all([
      getLog(),
      getSettings(),
      isIncognitoAllowed(),
      chrome.storage.local.getBytesInUse ? chrome.storage.local.getBytesInUse(null) : Promise.resolve(0)
    ]);
    const dayAgo = Date.now() - RETENTION_MS['1d'];
    return {
      settings,
      incognitoAllowed: allowed,
      total: log.length,
      last24h: log.reduce((n, e) => (e.ts >= dayAgo ? n + 1 : n), 0),
      newest: log.length ? log[log.length - 1].ts : null,
      bytesInUse: bytes || 0
    };
  },

  async getRecent({ limit = 25 } = {}) {
    const log = await getLog();
    return { entries: log.slice(-limit).reverse() };
  },

  async getAll() {
    const [log, spans, settings] = await Promise.all([getLog(), getSpans(), getSettings()]);
    return { entries: log, spans, settings };
  },

  async setSettings({ patch }) {
    const settings = { ...(await getSettings()), ...(patch || {}) };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    if (patch && 'retention' in patch) await applyRetention();
    return { settings };
  },

  async deleteEntries({ ids }) {
    const remove = new Set(ids || []);
    return enqueue(async () => {
      const log = await getLog();
      const kept = log.filter((e) => !remove.has(e.id));
      await chrome.storage.local.set({ [LOG_KEY]: kept });
      await refreshBadge(kept);
      return { removed: log.length - kept.length, total: kept.length };
    });
  },

  async deleteOlderThan({ ts }) {
    return enqueue(async () => {
      const [log, spans] = await Promise.all([getLog(), getSpans()]);
      const kept = log.filter((e) => e.ts >= ts);
      const keptSpans = spans.filter((s) => s.endedAt >= ts);
      await chrome.storage.local.set({ [LOG_KEY]: kept, [SPANS_KEY]: keptSpans });
      await refreshBadge(kept);
      return { removed: log.length - kept.length };
    });
  },

  async purgeNow() {
    return applyRetention();
  },

  /** The "nuke" button: wipes the log, the spans and the tab bookkeeping. */
  async nuke({ keepSettings = true } = {}) {
    return enqueue(async () => {
      const settings = await getSettings();
      await chrome.storage.local.clear();
      await chrome.storage.session.remove(SESSION_TABS_KEY);
      if (keepSettings) await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      await refreshBadge([]);
      return { ok: true };
    });
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message type: ${message && message.type}` });
    return false;
  }
  handler(message.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the channel open for the async reply
});

// Cold-start housekeeping (the worker also spins up on plain events).
ensureAlarm();
refreshBadge();
