/**
 * Incognito History Vault - popup controller
 * Minimal, reactive quick-access view. All heavy lifting (advanced search,
 * analytics, export) lives in dashboard.html.
 *
 * Deliberate privacy choice: favicons are NOT rendered from their remote URLs,
 * because that would fire off network requests for the sites you visited every
 * time you open the popup. We draw a local initial tile instead.
 */

const RECENT_LIMIT = 300;   // how much we pull for client-side filtering
const RENDER_LIMIT = 60;    // how much we actually paint

const els = {
  statusLine: document.getElementById('statusLine'),
  trackingToggle: document.getElementById('trackingToggle'),
  permBannerWrap: document.getElementById('permBannerWrap'),
  openExtensionsPage: document.getElementById('openExtensionsPage'),
  statTotal: document.getElementById('statTotal'),
  stat24h: document.getElementById('stat24h'),
  statSites: document.getElementById('statSites'),
  search: document.getElementById('search'),
  clearSearch: document.getElementById('clearSearch'),
  list: document.getElementById('list'),
  wipe: document.getElementById('wipe'),
  openDashboard: document.getElementById('openDashboard'),
  toasts: document.getElementById('toasts')
};

let entries = [];
let state = null;
let wipeArmed = false;
let wipeTimer = null;

/* ------------------------------------------------------------------ utils */

function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (reply) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) return reject(new Error(lastError.message));
      if (!reply || !reply.ok) return reject(new Error((reply && reply.error) || 'No response'));
      resolve(reply.data);
    });
  });
}

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Stable pastel-ish colour per domain, so tiles are recognisable. */
function tileColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 52% 42%)`;
}

function initialTile(domain) {
  const tile = document.createElement('div');
  tile.className = 'favicon';
  tile.style.background = tileColor(domain || '?');
  tile.style.display = 'grid';
  tile.style.placeItems = 'center';
  tile.style.color = '#fff';
  tile.style.fontSize = '9px';
  tile.style.fontWeight = '700';
  tile.textContent = (domain || '?').charAt(0).toUpperCase();
  return tile;
}

/** Builds a text node fragment with <mark> around every query hit. */
function highlight(text, query) {
  const frag = document.createDocumentFragment();
  const value = text || '';
  if (!query) {
    frag.appendChild(document.createTextNode(value));
    return frag;
  }
  const haystack = value.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  let at = haystack.indexOf(needle, from);
  if (at === -1) {
    frag.appendChild(document.createTextNode(value));
    return frag;
  }
  while (at !== -1) {
    if (at > from) frag.appendChild(document.createTextNode(value.slice(from, at)));
    const mark = document.createElement('mark');
    mark.textContent = value.slice(at, at + needle.length);
    frag.appendChild(mark);
    from = at + needle.length;
    at = haystack.indexOf(needle, from);
  }
  if (from < value.length) frag.appendChild(document.createTextNode(value.slice(from)));
  return frag;
}

/* ------------------------------------------------------------- open a link */

/**
 * Reopening a logged URL in a *normal* window would leak it into the regular
 * chrome.history, so we prefer an existing Incognito window, then a new one,
 * and only fall back to a normal tab when Incognito access is not granted.
 */
async function openUrl(url) {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const incognitoWindow = windows.find((w) => w.incognito);
    if (incognitoWindow) {
      await chrome.tabs.create({ url, windowId: incognitoWindow.id });
      return;
    }
    if (state && state.incognitoAllowed) {
      await chrome.windows.create({ url, incognito: true });
      return;
    }
    await chrome.tabs.create({ url });
  } catch (err) {
    toast(`Could not open link: ${err.message}`, 'err');
  }
}

/* ---------------------------------------------------------------- rendering */

function filterEntries(query) {
  if (!query) return entries;
  const needle = query.toLowerCase().trim();
  return entries.filter((e) => {
    const haystack = `${e.title || ''} ${e.url || ''} ${e.domain || ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}

function renderList() {
  const query = els.search.value.trim();
  els.clearSearch.hidden = query.length === 0;

  const matches = filterEntries(query);
  els.list.textContent = '';

  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    const icon = document.createElement('div');
    icon.className = 'empty__icon';
    icon.textContent = query ? '\u2298' : '\u25CE';
    const text = document.createElement('div');
    text.className = 'small';
    if (query) {
      text.textContent = 'No stored visit matches that filter.';
    } else if (state && state.incognitoAllowed === false) {
      text.textContent = 'Grant Incognito access to start recording.';
    } else if (state && state.settings && !state.settings.tracking) {
      text.textContent = 'Recording is paused.';
    } else {
      text.textContent = 'No Incognito visits recorded yet.';
    }
    li.append(icon, text);
    els.list.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  matches.slice(0, RENDER_LIMIT).forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'entry';
    li.tabIndex = 0;
    li.title = entry.url;
    li.setAttribute('role', 'link');

    const body = document.createElement('div');
    body.className = 'entry__body';

    const title = document.createElement('div');
    title.className = 'entry__title';
    title.appendChild(highlight(entry.title || entry.domain || entry.url, query));

    const meta = document.createElement('div');
    meta.className = 'entry__meta';
    meta.appendChild(highlight(entry.domain + (entry.path && entry.path !== '/' ? entry.path : ''), query));

    body.append(title, meta);

    const time = document.createElement('div');
    time.className = 'entry__time';
    time.textContent = relativeTime(entry.ts);
    time.title = new Date(entry.ts).toLocaleString();

    li.append(initialTile(entry.domain), body, time);

    const activate = () => openUrl(entry.url);
    li.addEventListener('click', activate);
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });

    fragment.appendChild(li);
  });
  els.list.appendChild(fragment);
}

function renderHeader() {
  if (!state) return;
  const { total, last24h, settings, incognitoAllowed } = state;

  els.statTotal.textContent = total.toLocaleString();
  els.stat24h.textContent = last24h.toLocaleString();
  els.statSites.textContent = new Set(entries.map((e) => e.domain)).size.toLocaleString();

  els.trackingToggle.checked = Boolean(settings.tracking);
  els.permBannerWrap.hidden = incognitoAllowed !== false;

  if (incognitoAllowed === false) {
    els.statusLine.textContent = 'Incognito access required';
    els.statusLine.className = 'badge badge--warn';
  } else if (!settings.tracking) {
    els.statusLine.textContent = 'Recording paused';
    els.statusLine.className = 'badge badge--danger';
  } else {
    els.statusLine.textContent = 'Recording Incognito activity';
    els.statusLine.className = 'badge badge--ok';
  }
}

async function refresh() {
  try {
    const [nextState, recent] = await Promise.all([
      send('getState'),
      send('getRecent', { limit: RECENT_LIMIT })
    ]);
    state = nextState;
    entries = recent.entries;
    renderHeader();
    renderList();
  } catch (err) {
    els.statusLine.textContent = 'Service worker unavailable';
    els.statusLine.className = 'badge badge--danger';
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------------- events */

els.search.addEventListener('input', renderList);
els.clearSearch.addEventListener('click', () => {
  els.search.value = '';
  els.search.focus();
  renderList();
});

els.trackingToggle.addEventListener('change', async () => {
  const tracking = els.trackingToggle.checked;
  try {
    const result = await send('setSettings', { patch: { tracking } });
    state.settings = result.settings;
    renderHeader();
    renderList();
    toast(tracking ? 'Recording resumed' : 'Recording paused');
  } catch (err) {
    els.trackingToggle.checked = !tracking;
    toast(err.message, 'err');
  }
});

// Two-step destructive action: the first click only arms the button.
els.wipe.addEventListener('click', async () => {
  if (!wipeArmed) {
    wipeArmed = true;
    els.wipe.textContent = 'Sure? Click again';
    wipeTimer = setTimeout(() => {
      wipeArmed = false;
      els.wipe.textContent = 'Clear data';
    }, 3500);
    return;
  }
  clearTimeout(wipeTimer);
  wipeArmed = false;
  els.wipe.textContent = 'Clear data';
  try {
    await send('nuke', { keepSettings: true });
    toast('Vault cleared');
    await refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
});

els.openDashboard.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});

els.openExtensionsPage.addEventListener('click', async () => {
  const url = `chrome://extensions/?id=${chrome.runtime.id}`;
  try {
    await chrome.tabs.create({ url });
    window.close();
  } catch {
    // Some Chrome builds refuse programmatic chrome:// navigation.
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied - paste it in the address bar');
    } catch {
      toast('Open chrome://extensions manually', 'err');
    }
  }
});

// Live updates while the popup is open (e.g. a new page loads in Incognito).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.history || changes.settings)) refresh();
});

refresh();
