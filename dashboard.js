/**
 * Incognito History Vault - dashboard application
 * ---------------------------------------------------------------------------
 *  1. utilities            - messaging, formatting, DOM helpers
 *  2. search engine        - normal / fuzzy / regex / mixed compilers
 *  3. filter pipeline      - query + facets + sorting
 *  4. vault view           - results table, selection, pagination
 *  5. analytics view       - aggregations + hand-rolled SVG-free charts
 *  6. privacy view         - retention, recording, quota, deletion, nuke
 *  7. export               - JSON / NDJSON / CSV
 *  8. bootstrap            - tabs, events, live storage sync
 *
 * No charting library is loaded. Manifest V3's extension_pages CSP forbids
 * remote scripts (`script-src 'self'`), so a Chart.js CDN tag would simply be
 * blocked; the charts below are plain DOM + CSS, which also keeps the extension
 * network-silent.
 */

/* ========================================================================== */
/* 1. utilities                                                               */
/* ========================================================================== */

const QUOTA_BYTES = (chrome.storage.local.QUOTA_BYTES || 10485760);
const PAGE_SIZE = 200;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const $ = (id) => document.getElementById(id);

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
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function dayKey(ts) {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function startOfDay(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function endOfDay(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function tileColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 52% 42%)`;
}

/** Local initial tile instead of a remote favicon: zero network requests. */
function initialTile(domain) {
  const tile = el('div', 'favicon');
  tile.style.background = tileColor(domain || '?');
  tile.style.display = 'grid';
  tile.style.placeItems = 'center';
  tile.style.color = '#fff';
  tile.style.fontSize = '9px';
  tile.style.fontWeight = '700';
  tile.textContent = (domain || '?').charAt(0).toUpperCase();
  return tile;
}

/** Reopen a logged URL without leaking it into the normal history. */
async function openUrl(url) {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const incognitoWindow = windows.find((w) => w.incognito);
    if (incognitoWindow) {
      await chrome.tabs.create({ url, windowId: incognitoWindow.id });
      return;
    }
    if (state.meta.incognitoAllowed) {
      await chrome.windows.create({ url, incognito: true });
      return;
    }
    await chrome.tabs.create({ url });
    toast('Opened in a normal tab (Incognito access is off)', 'err');
  } catch (err) {
    toast(`Could not open link: ${err.message}`, 'err');
  }
}

function confirmModal({ title, body, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.append(el('h3', null, title), el('p', 'small muted', body));

    const actions = el('div', 'modal__actions');
    const cancel = el('button', 'btn btn--ghost', 'Cancel');
    const confirm = el('button', `btn ${danger ? 'btn--danger' : 'btn--primary'}`, confirmText);
    actions.append(cancel, confirm);
    modal.appendChild(actions);
    backdrop.appendChild(modal);

    const close = (result) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
      if (event.key === 'Enter') close(true);
    };

    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(false); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);
    confirm.focus();
  });
}

/* ========================================================================== */
/* 2. search engine                                                           */
/* ========================================================================== */

/** Which strings of an entry a query is tested against. */
function fieldsOf(entry, field) {
  switch (field) {
    case 'title': return [entry.title || ''];
    case 'url': return [entry.url || ''];
    case 'domain': return [entry.domain || ''];
    default: return [entry.title || '', entry.url || '', entry.domain || ''];
  }
}

/** Classic two-row Levenshtein distance, bailed out early when hopeless. */
function levenshtein(a, b, ceiling = Infinity) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;

  let previous = new Array(b.length + 1);
  let current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (current[j] < rowMin) rowMin = current[j];
    }
    if (rowMin > ceiling) return ceiling + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

function editCeiling(length) {
  if (length <= 3) return 1;
  if (length <= 5) return 2;
  if (length <= 9) return 3;
  return Math.floor(length / 3);
}

/**
 * Approximate match of one needle word against a haystack string.
 * Returns 0 (no match) .. 1 (perfect). Three strategies, best score wins:
 *   1. literal substring            -> 0.85 .. 1.00 (earlier = better)
 *   2. in-order subsequence         -> 0.40 .. 0.75 (tighter = better)
 *   3. edit distance vs. any token  -> 0.30 .. 0.70 (fewer edits = better)
 */
function fuzzyWordScore(needle, haystack) {
  if (!needle) return 1;
  if (!haystack) return 0;

  const at = haystack.indexOf(needle);
  if (at !== -1) {
    const positionBonus = 1 - Math.min(at, 40) / 40;
    return 0.85 + 0.15 * positionBonus;
  }

  // subsequence with gap penalty
  let hi = 0;
  let first = -1;
  let last = -1;
  for (let ni = 0; ni < needle.length; ni += 1) {
    const found = haystack.indexOf(needle[ni], hi);
    if (found === -1) { first = -1; break; }
    if (ni === 0) first = found;
    last = found;
    hi = found + 1;
  }
  let best = 0;
  if (first !== -1) {
    const span = last - first + 1;
    best = 0.4 + 0.35 * (needle.length / span);
  }

  // edit distance against each word-ish token
  const ceiling = editCeiling(needle.length);
  const tokens = haystack.split(/[^a-z0-9]+/i);
  for (const token of tokens) {
    if (!token) continue;
    if (Math.abs(token.length - needle.length) > ceiling) continue;
    const distance = levenshtein(needle, token, ceiling);
    if (distance <= ceiling) {
      const score = 0.7 - (distance / (ceiling + 1)) * 0.4;
      if (score > best) best = score;
    }
  }
  return best;
}

/** Splits a Mixed-mode query, honouring "quoted phrases" and /regex/flags. */
function tokenizeMixed(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    if (/\s/.test(char)) { i += 1; continue; }

    let negate = false;
    let cursor = i;
    if (char === '-' && i + 1 < input.length && !/\s/.test(input[i + 1])) {
      negate = true;
      cursor += 1;
    }

    // quoted phrase
    if (input[cursor] === '"') {
      const end = input.indexOf('"', cursor + 1);
      const value = end === -1 ? input.slice(cursor + 1) : input.slice(cursor + 1, end);
      tokens.push({ raw: value, negate, quoted: true });
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    // inline /regex/flags
    if (input[cursor] === '/') {
      let end = -1;
      for (let k = cursor + 1; k < input.length; k += 1) {
        if (input[k] === '\\') { k += 1; continue; }
        if (input[k] === '/') { end = k; break; }
      }
      if (end !== -1) {
        let flagEnd = end + 1;
        while (flagEnd < input.length && /[gimsuy]/.test(input[flagEnd])) flagEnd += 1;
        tokens.push({
          raw: input.slice(cursor + 1, end),
          flags: input.slice(end + 1, flagEnd),
          negate,
          isRegex: true
        });
        i = flagEnd;
        continue;
      }
    }

    // bare token
    let end = cursor;
    while (end < input.length && !/\s/.test(input[end])) end += 1;
    tokens.push({ raw: input.slice(cursor, end), negate });
    i = end;
  }
  return tokens.filter((token) => token.raw.length || token.isRegex);
}

const DOMAIN_PREFIX = /^(domain|site|host):(.*)$/i;

/**
 * Compiles a raw query string into a reusable matcher.
 * @returns {{ok:boolean, error:string|null, empty:boolean,
 *            score:(entry:Object)=>number, literals:string[], regexes:RegExp[]}}
 */
function compileQuery(raw, mode, options) {
  const field = options.field || 'all';
  const caseSensitive = Boolean(options.caseSensitive);
  const query = (raw || '').trim();

  const passthrough = {
    ok: true, error: null, empty: true,
    score: () => 1, literals: [], regexes: []
  };
  if (!query) return passthrough;

  const norm = (value) => (caseSensitive ? value : value.toLowerCase());

  /* --------------------------------------------------------- normal ------ */
  if (mode === 'normal') {
    const needle = norm(query);
    return {
      ok: true, error: null, empty: false, literals: [query], regexes: [],
      score(entry) {
        return fieldsOf(entry, field).some((text) => norm(text).includes(needle)) ? 1 : 0;
      }
    };
  }

  /* ---------------------------------------------------------- fuzzy ------ */
  if (mode === 'fuzzy') {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return {
      ok: true, error: null, empty: false, literals: [query, ...words], regexes: [],
      score(entry) {
        const texts = fieldsOf(entry, field).map((text) => text.toLowerCase());
        let total = 0;
        for (const word of words) {
          let best = 0;
          for (const text of texts) {
            const score = fuzzyWordScore(word, text);
            if (score > best) best = score;
            if (best === 1) break;
          }
          if (best <= 0) return 0;           // every word must match somewhere
          total += best;
        }
        return total / words.length;
      }
    };
  }

  /* ---------------------------------------------------------- regex ------ */
  if (mode === 'regex') {
    if (query.length > 500) {
      return { ...passthrough, ok: false, empty: false, error: 'Pattern too long (max 500 characters).' };
    }
    let regex;
    try {
      regex = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (err) {
      return { ...passthrough, ok: false, empty: false, error: `Invalid regex: ${err.message}` };
    }
    let highlighter = null;
    try {
      highlighter = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } catch { /* highlighting is optional */ }

    return {
      ok: true, error: null, empty: false, literals: [], regexes: highlighter ? [highlighter] : [],
      score(entry) {
        try {
          return fieldsOf(entry, field).some((text) => regex.test(text)) ? 1 : 0;
        } catch {
          return 0;   // a runtime regex failure must never break the whole list
        }
      }
    };
  }

  /* ---------------------------------------------------------- mixed ------ */
  const tokens = tokenizeMixed(query);
  const clauses = [];
  const literals = [];
  const regexes = [];

  for (const token of tokens) {
    if (token.isRegex) {
      try {
        clauses.push({
          kind: 'regex',
          negate: token.negate,
          regex: new RegExp(token.raw, token.flags && token.flags.includes('i') ? token.flags.replace(/g/g, '') : (caseSensitive ? '' : 'i'))
        });
        regexes.push(new RegExp(token.raw, caseSensitive ? 'g' : 'gi'));
      } catch (err) {
        return { ...passthrough, ok: false, empty: false, error: `Invalid regex "/${token.raw}/": ${err.message}` };
      }
      continue;
    }

    const domainMatch = DOMAIN_PREFIX.exec(token.raw);
    if (domainMatch && domainMatch[2]) {
      clauses.push({ kind: 'domain', negate: token.negate, value: domainMatch[2].toLowerCase() });
      if (!token.negate) literals.push(domainMatch[2]);
      continue;
    }

    const looksLikeDomain = !token.quoted && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(token.raw);
    clauses.push({
      kind: looksLikeDomain ? 'domainOrText' : 'text',
      negate: token.negate,
      value: norm(token.raw)
    });
    if (!token.negate) literals.push(token.raw);
  }

  if (!clauses.length) return passthrough;

  const testClause = (clause, entry) => {
    if (clause.kind === 'domain') {
      return (entry.domain || '').toLowerCase().includes(clause.value);
    }
    if (clause.kind === 'regex') {
      try {
        return fieldsOf(entry, field).some((text) => clause.regex.test(text));
      } catch {
        return false;
      }
    }
    const texts = fieldsOf(entry, field).map(norm);
    const inText = texts.some((text) => text.includes(clause.value));
    if (clause.kind === 'domainOrText') {
      return inText || (entry.domain || '').toLowerCase().includes(clause.value.toLowerCase());
    }
    return inText;
  };

  return {
    ok: true, error: null, empty: false, literals, regexes,
    score(entry) {
      let hits = 0;
      for (const clause of clauses) {
        const matched = testClause(clause, entry);
        if (clause.negate ? matched : !matched) return 0;
        if (!clause.negate) hits += 1;
      }
      return hits ? 1 : 0.5;   // an all-negative query still matches, weakly
    }
  };
}

/* -------------------------------------------------- highlight rendering ---- */

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = ranges.sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else merged.push(sorted[i]);
  }
  return merged;
}

/** Wraps every query hit inside `text` in <mark>, returns a fragment. */
function markup(text, compiled) {
  const value = text || '';
  const frag = document.createDocumentFragment();
  if (!value || !compiled || compiled.empty) {
    frag.appendChild(document.createTextNode(value));
    return frag;
  }

  const ranges = [];
  const lower = value.toLowerCase();
  for (const literal of compiled.literals || []) {
    const needle = String(literal).toLowerCase();
    if (needle.length < 2) continue;
    let from = 0;
    let at = lower.indexOf(needle, from);
    while (at !== -1) {
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
  }
  for (const regex of compiled.regexes || []) {
    try {
      regex.lastIndex = 0;
      let match = regex.exec(value);
      let guard = 0;
      while (match && guard < 500) {
        if (match[0].length) ranges.push([match.index, match.index + match[0].length]);
        else regex.lastIndex += 1;
        match = regex.exec(value);
        guard += 1;
      }
    } catch { /* ignore */ }
  }

  const merged = mergeRanges(ranges);
  if (!merged.length) {
    frag.appendChild(document.createTextNode(value));
    return frag;
  }

  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) frag.appendChild(document.createTextNode(value.slice(cursor, start)));
    const mark = el('mark', null, value.slice(start, end));
    frag.appendChild(mark);
    cursor = end;
  }
  if (cursor < value.length) frag.appendChild(document.createTextNode(value.slice(cursor)));
  return frag;
}

/* ========================================================================== */
/* 3. application state + filter pipeline                                     */
/* ========================================================================== */

const state = {
  entries: [],
  spans: [],
  settings: {},
  meta: { incognitoAllowed: null, bytesInUse: 0 },
  filtered: [],
  scores: new Map(),
  compiled: null,
  selection: new Set(),
  rendered: PAGE_SIZE,
  activeView: 'vault'
};

const MODE_HINTS = {
  normal: 'Literal substring match — the query is used exactly as typed.',
  fuzzy: 'Typo-tolerant match. Every word must match approximately; switch Sort to “Relevance” to rank the best hits first.',
  regex: 'JavaScript regular expression. Open the cheat sheet below if you need a refresher; invalid patterns are reported, never thrown.',
  mixed: 'Structured query: domain:github.com "exact phrase" /re[g]ex/ -exclude free text — all parts must match.'
};

function currentMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'normal';
}

function applyFilters({ resetPaging = true } = {}) {
  const raw = $('query').value;
  const mode = currentMode();
  const field = $('field').value;
  const caseSensitive = $('caseSensitive').checked;

  const compiled = compileQuery(raw, mode, { field, caseSensitive });
  state.compiled = compiled;

  $('searchError').textContent = compiled.ok ? '' : compiled.error;
  $('query').classList.toggle('is-invalid', !compiled.ok);

  const domain = $('domainFilter').value;
  const from = startOfDay($('dateFrom').value);
  const to = endOfDay($('dateTo').value);

  const scores = new Map();
  let rows = state.entries.filter((entry) => {
    if (domain && entry.domain !== domain) return false;
    if (from !== null && entry.ts < from) return false;
    if (to !== null && entry.ts > to) return false;
    if (!compiled.ok) return false;
    if (compiled.empty) return true;
    const score = compiled.score(entry);
    if (score <= 0) return false;
    scores.set(entry.id, score);
    return true;
  });

  const sort = $('sort').value;
  const compare = {
    newest: (a, b) => b.ts - a.ts,
    oldest: (a, b) => a.ts - b.ts,
    dwell: (a, b) => (b.dwellMs || 0) - (a.dwellMs || 0),
    domain: (a, b) => (a.domain || '').localeCompare(b.domain || '') || b.ts - a.ts,
    relevance: (a, b) => (scores.get(b.id) || 0) - (scores.get(a.id) || 0) || b.ts - a.ts
  }[sort] || ((a, b) => b.ts - a.ts);
  rows = rows.sort(compare);

  state.scores = scores;
  state.filtered = rows;
  if (resetPaging) state.rendered = PAGE_SIZE;

  renderResults();
  renderSearchStatus(mode, compiled);
}

function renderSearchStatus(mode, compiled) {
  const total = state.entries.length;
  const shown = state.filtered.length;
  $('resultCount').textContent = `${shown.toLocaleString()} result${shown === 1 ? '' : 's'}`;

  const bits = [`mode: ${mode}`];
  if (!compiled.empty) bits.push(`of ${total.toLocaleString()} stored`);
  if ($('field').value !== 'all') bits.push(`field: ${$('field').value}`);
  if ($('caseSensitive').checked) bits.push('case sensitive');
  $('searchMeta').textContent = bits.join(' · ');
  $('modeHint').textContent = MODE_HINTS[mode] || '';
}

/* ========================================================================== */
/* 4. vault view                                                              */
/* ========================================================================== */

function renderResults() {
  const body = $('resultsBody');
  body.textContent = '';

  const rows = state.filtered;
  const hasRows = rows.length > 0;
  $('resultsEmpty').hidden = hasRows;
  $('resultsTable').hidden = !hasRows;

  if (!hasRows) {
    $('resultsEmptyHint').textContent = state.entries.length
      ? 'No stored visit matches the current query or filters.'
      : 'Browse in an Incognito window (with access granted) and visits will land here.';
    $('loadMore').hidden = true;
    updateSelectionUi();
    return;
  }

  const slice = rows.slice(0, state.rendered);
  const fragment = document.createDocumentFragment();

  for (const entry of slice) {
    const tr = el('tr');
    tr.dataset.id = entry.id;
    if (state.selection.has(entry.id)) tr.classList.add('is-selected');

    // selection
    const tdCheck = el('td', 'col-check');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = state.selection.has(entry.id);
    check.dataset.id = entry.id;
    check.setAttribute('aria-label', 'Select entry');
    tdCheck.appendChild(check);

    // time
    const tdTime = el('td', 'col-time', formatDateTime(entry.ts));
    tdTime.title = new Date(entry.ts).toString();

    // page
    const tdPage = el('td');
    const cell = el('div', 'cell-title');
    const title = el('strong');
    title.appendChild(markup(entry.title || '(no title recorded)', state.compiled));
    const link = document.createElement('a');
    link.href = entry.url;
    link.title = `${entry.url}\nOpens in an Incognito window when one is available`;
    link.appendChild(markup(entry.url, state.compiled));
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openUrl(entry.url);
    });
    cell.append(title, link);
    if (entry.kind === 'spa' || (entry.transition && entry.transition !== 'link')) {
      const tag = el('span', 'badge badge--flat tiny', entry.kind === 'spa' ? 'in-page route' : entry.transition);
      tag.style.justifySelf = 'start';
      cell.appendChild(tag);
    }
    tdPage.appendChild(cell);

    // domain
    const tdDomain = el('td', 'col-domain');
    const domainCell = el('div', 'domain-cell');
    const domainText = el('span');
    domainText.appendChild(markup(entry.domain, state.compiled));
    domainCell.append(initialTile(entry.domain), domainText);
    tdDomain.appendChild(domainCell);

    // dwell
    const tdDwell = el('td', 'col-dwell', entry.dwellMs ? formatDuration(entry.dwellMs) : '—');
    if (!entry.dwellMs) tdDwell.title = 'Still open, or the tab was closed while the browser was shutting down';

    // row actions
    const tdActions = el('td', 'col-actions');
    const del = el('button', 'icon-btn', '×');
    del.type = 'button';
    del.title = 'Delete this entry';
    del.dataset.delete = entry.id;
    tdActions.appendChild(del);

    tr.append(tdCheck, tdTime, tdPage, tdDomain, tdDwell, tdActions);
    fragment.appendChild(tr);
  }

  body.appendChild(fragment);

  const remaining = rows.length - slice.length;
  $('loadMore').hidden = remaining <= 0;
  $('loadMore').textContent = `Load ${Math.min(remaining, PAGE_SIZE)} more (${remaining.toLocaleString()} hidden)`;
  updateSelectionUi();
}

function updateSelectionUi() {
  const count = state.selection.size;
  $('selectionCount').textContent = `${count} selected`;
  $('deleteSelected').disabled = count === 0;
  $('clearSelection').disabled = count === 0;
  const allSelected = state.filtered.length > 0 && state.filtered.every((e) => state.selection.has(e.id));
  $('selectAll').checked = allSelected;
}

function rebuildDomainFilter() {
  const select = $('domainFilter');
  const previous = select.value;
  const counts = new Map();
  for (const entry of state.entries) {
    counts.set(entry.domain, (counts.get(entry.domain) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  select.textContent = '';
  select.appendChild(new Option('All domains', ''));
  for (const [domain, count] of sorted) {
    select.appendChild(new Option(`${domain} (${count})`, domain));
  }
  if (previous && counts.has(previous)) select.value = previous;
}

/* ========================================================================== */
/* 5. analytics view                                                          */
/* ========================================================================== */

function computeAnalytics() {
  const entries = state.entries;
  const domains = new Map();
  const days = new Map();
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const dwells = [];

  for (const entry of entries) {
    domains.set(entry.domain, (domains.get(entry.domain) || 0) + 1);
    const key = dayKey(entry.ts);
    days.set(key, (days.get(key) || 0) + 1);
    const date = new Date(entry.ts);
    const hour = typeof entry.hour === 'number' ? entry.hour : date.getHours();
    const weekday = typeof entry.weekday === 'number' ? entry.weekday : date.getDay();
    hours[hour] += 1;
    weekdays[weekday] += 1;
    heat[weekday][hour] += 1;
    if (entry.dwellMs > 0) dwells.push(entry.dwellMs);
  }

  const durations = state.spans.map((s) => s.durationMs).filter((d) => d > 0);
  const peakHour = hours.indexOf(Math.max(...hours, 0));

  // trailing 14 days including today
  const daily = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * 86400000);
    const key = dayKey(date.getTime());
    daily.push({
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      value: days.get(key) || 0,
      title: date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
    });
  }

  return {
    total: entries.length,
    domains: [...domains.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    days: [...days.entries()].sort((a, b) => b[1] - a[1]),
    hours,
    weekdays,
    heat,
    daily,
    dwells,
    durations,
    peakHour: entries.length ? peakHour : -1,
    firstTs: entries.length ? Math.min(...entries.map((e) => e.ts)) : null
  };
}

function renderBarList(container, items, total) {
  container.textContent = '';
  if (!items.length) {
    container.appendChild(el('p', 'small faint', 'Nothing recorded yet.'));
    return;
  }
  const max = Math.max(...items.map((i) => i.value), 1);
  for (const item of items) {
    const row = el('div', 'bar-row');
    const label = el('div', 'bar-row__label');
    if (item.tile) label.appendChild(initialTile(item.tile));
    const labelText = el('span', null, item.label);
    labelText.title = item.title || item.label;
    label.appendChild(labelText);

    const share = total ? Math.round((item.value / total) * 100) : 0;
    const value = el('div', 'bar-row__value', item.valueText || `${item.value}${total ? ` · ${share}%` : ''}`);

    const track = el('div', 'bar-row__track');
    const fill = el('div', 'bar-row__fill');
    fill.style.width = `${Math.max(2, (item.value / max) * 100)}%`;
    track.appendChild(fill);

    row.append(label, value, track);
    container.appendChild(row);
  }
}

function renderColumnChart(container, items, { peakIndex = -1 } = {}) {
  container.textContent = '';
  const max = Math.max(...items.map((i) => i.value), 1);
  items.forEach((item, index) => {
    const col = el('div', 'chart__col');
    if (index === peakIndex && item.value > 0) col.classList.add('is-peak');
    col.title = `${item.title || item.label}: ${item.value} visit${item.value === 1 ? '' : 's'}`;

    const bar = el('div', `chart__bar${item.value ? '' : ' chart__bar--empty'}`);
    bar.style.height = `${item.value ? Math.max(3, (item.value / max) * 100) : 2}%`;
    col.append(bar, el('div', 'chart__tick', item.label));
    container.appendChild(col);
  });
}

function renderHeat(container, heat) {
  container.textContent = '';
  const max = Math.max(1, ...heat.flat());

  container.appendChild(el('div', 'heat__label', ''));
  for (let hour = 0; hour < 24; hour += 1) {
    container.appendChild(el('div', 'heat__head', hour % 3 === 0 ? String(hour) : ''));
  }
  heat.forEach((row, weekday) => {
    container.appendChild(el('div', 'heat__label', WEEKDAYS[weekday]));
    row.forEach((count, hour) => {
      const cell = el('div', 'heat__cell');
      if (count > 0) {
        const intensity = 0.18 + 0.82 * (count / max);
        cell.style.background = `rgba(140, 116, 255, ${intensity.toFixed(3)})`;
      }
      cell.title = `${WEEKDAYS[weekday]} ${String(hour).padStart(2, '0')}:00 — ${count} visit${count === 1 ? '' : 's'}`;
      container.appendChild(cell);
    });
  });
}

function renderSessions() {
  const body = $('sessionBody');
  body.textContent = '';
  const spans = [...state.spans].sort((a, b) => b.endedAt - a.endedAt);

  $('sessionEmpty').hidden = spans.length > 0;
  const durations = spans.map((s) => s.durationMs).filter((d) => d >= 0);

  $('sCount').textContent = spans.length.toLocaleString();
  $('sAvg').textContent = durations.length
    ? formatDuration(Math.round(durations.reduce((a, b) => a + b, 0) / durations.length))
    : '—';
  $('sMedian').textContent = durations.length ? formatDuration(median(durations)) : '—';

  const longest = spans.reduce((best, s) => (!best || s.durationMs > best.durationMs ? s : best), null);
  $('sMax').textContent = longest ? formatDuration(longest.durationMs) : '—';
  $('sMaxHint').textContent = longest ? (longest.domain || 'unknown host') : '—';
  $('sessionNote').textContent = spans.length
    ? `${spans.length} closed tab${spans.length === 1 ? '' : 's'} tracked · open tabs appear once closed`
    : '';

  for (const span of spans.slice(0, 50)) {
    const tr = el('tr');
    tr.append(
      el('td', 'col-time', formatDateTime(span.startedAt)),
      el('td', 'col-time', formatDateTime(span.endedAt)),
      el('td', 'col-dwell', formatDuration(span.durationMs))
    );

    const tdWhere = el('td');
    const where = el('div', 'domain-cell');
    where.append(initialTile(span.domain), el('span', null, span.domain || '(unknown)'));
    if (span.firstUrl) where.title = span.firstUrl;
    tdWhere.appendChild(where);

    tr.append(tdWhere, el('td', 'col-dwell', String(span.views || 1)));
    body.appendChild(tr);
  }
}

function renderAnalytics() {
  const stats = computeAnalytics();

  $('aVisits').textContent = stats.total.toLocaleString();
  $('aVisitsHint').textContent = stats.firstTs
    ? `since ${new Date(stats.firstTs).toLocaleDateString()}`
    : 'nothing recorded yet';

  $('aDomains').textContent = stats.domains.length.toLocaleString();
  $('aDomainsHint').textContent = stats.domains.length
    ? `top: ${stats.domains[0][0]} (${stats.domains[0][1]}×)`
    : '—';

  $('aPeak').textContent = stats.peakHour >= 0 ? `${String(stats.peakHour).padStart(2, '0')}:00` : '—';
  $('aPeakHint').textContent = stats.peakHour >= 0
    ? `${stats.hours[stats.peakHour]} visits in that hour`
    : '—';

  $('aDwell').textContent = stats.dwells.length ? formatDuration(median(stats.dwells)) : '—';
  $('aDwellHint').textContent = stats.dwells.length
    ? `across ${stats.dwells.length.toLocaleString()} measured page views`
    : 'needs at least one closed page';

  const topN = Number($('domainTopN').value) || 10;
  renderBarList(
    $('domainBars'),
    stats.domains.slice(0, topN).map(([domain, count]) => ({
      label: domain,
      value: count,
      tile: domain,
      valueText: `visited ${count}×`,
      title: `${domain} — visited ${count} time${count === 1 ? '' : 's'}`
    })),
    stats.total
  );

  renderBarList(
    $('dayBars'),
    stats.days.slice(0, 10).map(([key, count]) => {
      const [y, m, d] = key.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      return {
        label: date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        value: count,
        valueText: `${count} visits`
      };
    }),
    stats.total
  );

  renderColumnChart(
    $('hourChart'),
    stats.hours.map((value, hour) => ({
      label: hour % 2 === 0 ? String(hour).padStart(2, '0') : '',
      title: `${String(hour).padStart(2, '0')}:00`,
      value
    })),
    { peakIndex: stats.peakHour }
  );
  const busiest = stats.peakHour >= 0
    ? `peak ${String(stats.peakHour).padStart(2, '0')}:00–${String((stats.peakHour + 1) % 24).padStart(2, '0')}:00`
    : '';
  $('hourSummary').textContent = busiest;

  const peakWeekday = stats.weekdays.indexOf(Math.max(...stats.weekdays, 0));
  renderColumnChart(
    $('weekdayChart'),
    stats.weekdays.map((value, index) => ({ label: WEEKDAYS[index], value })),
    { peakIndex: stats.total ? peakWeekday : -1 }
  );

  renderColumnChart($('dailyChart'), stats.daily);
  renderHeat($('heatGrid'), stats.heat);
  renderSessions();
}

/* ========================================================================== */
/* 6. privacy view                                                            */
/* ========================================================================== */

function renderPrivacy() {
  const settings = state.settings;

  const retention = document.querySelector(`input[name="retention"][value="${settings.retention}"]`);
  if (retention) retention.checked = true;
  $('trackingSwitch').checked = Boolean(settings.tracking);
  $('spaSwitch').checked = Boolean(settings.trackSpa);
  $('maxEntries').value = settings.maxEntries;

  const labels = { '1d': 'entries older than 24 hours are deleted automatically', '7d': 'entries older than 7 days are deleted automatically', forever: 'nothing is deleted automatically' };
  $('retentionHint').textContent = labels[settings.retention] || '';

  const bytes = state.meta.bytesInUse || 0;
  const percent = Math.min(100, (bytes / QUOTA_BYTES) * 100);
  const fill = $('usageFill');
  fill.style.width = `${Math.max(percent, bytes ? 1 : 0)}%`;
  fill.classList.toggle('is-high', percent >= 60 && percent < 85);
  fill.classList.toggle('is-critical', percent >= 85);
  $('usageText').textContent =
    `${formatBytes(bytes)} of ${formatBytes(QUOTA_BYTES)} used (${percent.toFixed(1)}%) · ` +
    `${state.entries.length.toLocaleString()} entries · ${state.spans.length.toLocaleString()} tab sessions`;

  const allowed = state.meta.incognitoAllowed;
  const setupState = $('setupState');
  setupState.textContent = '';
  const strong = el('strong');
  if (allowed === true) {
    strong.textContent = '✓ Incognito access is granted — recording is active.';
    strong.style.color = 'var(--ok)';
  } else if (allowed === false) {
    strong.textContent = '✗ Incognito access is NOT granted — nothing is being recorded.';
    strong.style.color = 'var(--danger)';
  } else {
    strong.textContent = 'Permission state unknown — follow the steps below to be sure.';
  }
  setupState.appendChild(strong);
  $('setupBanner').className = `banner ${allowed === false ? 'banner--warn' : allowed === true ? 'banner--info' : 'banner--info'}`;
}

function renderTopbar() {
  $('metaTotal').textContent = state.entries.length.toLocaleString();
  $('metaDomains').textContent = new Set(state.entries.map((e) => e.domain)).size.toLocaleString();
  $('metaStorage').textContent = formatBytes(state.meta.bytesInUse || 0);
  $('metaRetention').textContent = { '1d': '1 day', '7d': '7 days', forever: 'forever' }[state.settings.retention] || '—';

  const status = $('metaStatus');
  if (state.meta.incognitoAllowed === false) {
    status.textContent = 'no Incognito access';
    status.className = 'badge badge--warn';
  } else if (!state.settings.tracking) {
    status.textContent = 'paused';
    status.className = 'badge badge--danger';
  } else {
    status.textContent = 'recording';
    status.className = 'badge badge--ok';
  }

  $('permBanner').hidden = state.meta.incognitoAllowed !== false;
}

/* ========================================================================== */
/* 7. export                                                                  */
/* ========================================================================== */

function download(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const CSV_COLUMNS = [
  ['id', (e) => e.id],
  ['visited_at', (e) => new Date(e.ts).toISOString()],
  ['epoch_ms', (e) => e.ts],
  ['local_hour', (e) => (typeof e.hour === 'number' ? e.hour : new Date(e.ts).getHours())],
  ['weekday', (e) => WEEKDAYS[typeof e.weekday === 'number' ? e.weekday : new Date(e.ts).getDay()]],
  ['domain', (e) => e.domain],
  ['title', (e) => e.title],
  ['url', (e) => e.url],
  ['transition', (e) => e.transition],
  ['kind', (e) => e.kind],
  ['time_on_page_ms', (e) => e.dwellMs || 0],
  ['tab_id', (e) => e.tabId]
];

function csvCell(value) {
  let text = value === undefined || value === null ? '' : String(value);
  // Neutralise spreadsheet formula injection from page titles.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(entries) {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const entry of entries) {
    lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(entry))).join(','));
  }
  return lines.join('\r\n');
}

async function runExport(kind) {
  try {
    if (kind === 'json') {
      const payload = {
        meta: {
          extension: 'Incognito History Vault',
          version: chrome.runtime.getManifest().version,
          exportedAt: new Date().toISOString(),
          entryCount: state.entries.length,
          sessionCount: state.spans.length
        },
        settings: state.settings,
        entries: state.entries,
        sessions: state.spans
      };
      download(`incognito-vault-${stamp()}.json`, 'application/json', JSON.stringify(payload, null, 2));
    } else if (kind === 'ndjson') {
      download(
        `incognito-vault-${stamp()}.ndjson`,
        'application/x-ndjson',
        state.entries.map((e) => JSON.stringify(e)).join('\n')
      );
    } else if (kind === 'csv') {
      download(`incognito-vault-${stamp()}.csv`, 'text/csv', toCsv(state.entries));
    } else if (kind === 'filtered') {
      if (!state.filtered.length) {
        toast('Current filter matched nothing to export', 'err');
        return;
      }
      download(`incognito-vault-filtered-${stamp()}.csv`, 'text/csv', toCsv(state.filtered));
    }
    toast(`Export ready (${kind})`);
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'err');
  }
}

/* ---------------------------------------------------------- import (v1.0.2) */

/** Minimal RFC 4180 CSV reader (quoted fields, "" escapes, CRLF or LF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Turns one CSV export row back into an entry (undoes csvCell's formula guard). */
function entryFromCsv(header, cells) {
  const get = (name) => {
    const at = header.indexOf(name);
    const value = at === -1 ? '' : (cells[at] || '');
    return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
  };
  const epoch = Number(get('epoch_ms'));
  return {
    id: get('id'),
    ts: Number.isFinite(epoch) && epoch > 0 ? epoch : Date.parse(get('visited_at')),
    domain: get('domain'),
    title: get('title'),
    url: get('url'),
    transition: get('transition'),
    kind: get('kind'),
    dwellMs: Number(get('time_on_page_ms')) || 0,
    tabId: Number(get('tab_id'))
  };
}

/** Reads any file produced by runExport(). Returns { entries, sessions }. */
function parseImport(name, text) {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) throw new Error('The file is empty.');

  if (/\.csv$/i.test(name) || /^id,visited_at,/.test(trimmed)) {
    const rows = parseCsv(trimmed);
    const header = rows.shift() || [];
    if (!header.includes('url')) throw new Error('This CSV has no "url" column, so it is not a vault export.');
    return { entries: rows.map((cells) => entryFromCsv(header, cells)), sessions: [] };
  }

  // Whole-file JSON: the full JSON export, a bare array, or a one-line NDJSON.
  let whole = null;
  try {
    whole = JSON.parse(trimmed);
  } catch {
    // not one JSON document: treat as NDJSON below
  }
  if (Array.isArray(whole)) return { entries: whole, sessions: [] };
  if (whole && Array.isArray(whole.entries)) {
    return { entries: whole.entries, sessions: Array.isArray(whole.sessions) ? whole.sessions : [] };
  }
  if (whole && whole.url) return { entries: [whole], sessions: [] };
  if (whole) throw new Error('This JSON file is not a vault export.');

  const entries = trimmed.split(/\r?\n/).filter((l) => l.trim()).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Line ${i + 1} is not valid JSON.`);
    }
  });
  return { entries, sessions: [] };
}

async function runImport(file) {
  if (!file) return;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error('File is larger than 50 MB.');
    const parsed = parseImport(file.name, await file.text());
    if (!parsed.entries.length) throw new Error('No visits found in that file.');

    const ok = await confirmModal({
      title: `Import ${parsed.entries.length.toLocaleString()} visits?`,
      body: `"${file.name}" will be merged into the vault${parsed.sessions.length ? ` together with ${parsed.sessions.length.toLocaleString()} tab sessions` : ''}. Visits already stored are skipped, nothing is deleted and your settings are not changed. Retention and the entry cap still apply afterwards.`,
      confirmText: 'Import'
    });
    if (!ok) return;

    const result = await send('importData', parsed);
    await loadData();
    const parts = [`Imported ${result.added.toLocaleString()} visits`];
    if (result.duplicates) parts.push(`${result.duplicates.toLocaleString()} already stored`);
    if (result.invalid) parts.push(`${result.invalid.toLocaleString()} invalid skipped`);
    if (result.trimmed) parts.push(`${result.trimmed.toLocaleString()} oldest trimmed by the cap`);
    if (result.expired) parts.push(`${result.expired.toLocaleString()} past the retention window removed`);
    toast(parts.join(', '));
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'err');
  }
}

/* ========================================================================== */
/* 8. bootstrap                                                               */
/* ========================================================================== */

function switchView(name) {
  state.activeView = name;
  for (const view of ['vault', 'analytics', 'privacy']) {
    $(`view-${view}`).hidden = view !== name;
    const tab = $(`tab-${view}`);
    tab.setAttribute('aria-selected', String(view === name));
  }
  if (name === 'analytics') renderAnalytics();
  if (name === 'privacy') renderPrivacy();
}

async function loadData({ keepFilters = true } = {}) {
  const [all, meta] = await Promise.all([send('getAll'), send('getState')]);
  state.entries = all.entries;
  state.spans = all.spans;
  state.settings = all.settings;
  state.meta = meta;

  // Drop selections that no longer exist.
  const ids = new Set(state.entries.map((e) => e.id));
  for (const id of [...state.selection]) if (!ids.has(id)) state.selection.delete(id);

  rebuildDomainFilter();
  renderTopbar();
  applyFilters({ resetPaging: !keepFilters });
  if (state.activeView === 'analytics') renderAnalytics();
  if (state.activeView === 'privacy') renderPrivacy();
}

function wireEvents() {
  /* --- tabs ---------------------------------------------------------- */
  $('tab-vault').addEventListener('click', () => switchView('vault'));
  $('tab-analytics').addEventListener('click', () => switchView('analytics'));
  $('tab-privacy').addEventListener('click', () => switchView('privacy'));
  $('permBannerFix').addEventListener('click', () => switchView('privacy'));

  /* --- search -------------------------------------------------------- */
  const debouncedFilter = debounce(() => applyFilters(), 130);
  $('query').addEventListener('input', () => {
    $('queryClear').hidden = $('query').value.length === 0;
    debouncedFilter();
  });
  $('queryClear').addEventListener('click', () => {
    $('query').value = '';
    $('queryClear').hidden = true;
    applyFilters();
    $('query').focus();
  });
  $('modeGroup').addEventListener('change', () => {
    const mode = currentMode();
    if (mode === 'regex') $('regexGuide').open = true;
    if (mode === 'fuzzy' && $('sort').value === 'newest') $('sort').value = 'relevance';
    if (mode !== 'fuzzy' && $('sort').value === 'relevance') $('sort').value = 'newest';
    applyFilters();
  });
  ['field', 'domainFilter', 'dateFrom', 'dateTo', 'sort'].forEach((id) => {
    $(id).addEventListener('change', () => applyFilters());
  });
  $('caseSensitive').addEventListener('change', () => applyFilters());

  $('resetFilters').addEventListener('click', () => {
    $('query').value = '';
    $('queryClear').hidden = true;
    $('field').value = 'all';
    $('domainFilter').value = '';
    $('dateFrom').value = '';
    $('dateTo').value = '';
    $('sort').value = 'newest';
    $('caseSensitive').checked = false;
    document.querySelector('input[name="mode"][value="normal"]').checked = true;
    applyFilters();
  });

  // regex recipes from the cheat sheet
  $('regexGuide').addEventListener('click', (event) => {
    const button = event.target.closest('[data-recipe]');
    if (!button) return;
    document.querySelector('input[name="mode"][value="regex"]').checked = true;
    $('query').value = button.dataset.recipe;
    $('queryClear').hidden = false;
    applyFilters();
    $('query').focus();
  });

  // column header sorting
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      const sort = $('sort');
      if (key === 'newest') sort.value = sort.value === 'newest' ? 'oldest' : 'newest';
      else sort.value = key;
      applyFilters({ resetPaging: false });
    });
  });

  $('loadMore').addEventListener('click', () => {
    state.rendered += PAGE_SIZE;
    renderResults();
  });

  /* --- selection + row actions --------------------------------------- */
  $('resultsBody').addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-id]');
    if (!checkbox) return;
    if (checkbox.checked) state.selection.add(checkbox.dataset.id);
    else state.selection.delete(checkbox.dataset.id);
    const row = checkbox.closest('tr');
    if (row) row.classList.toggle('is-selected', checkbox.checked);
    updateSelectionUi();
  });

  $('resultsBody').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete]');
    if (!button) return;
    const id = button.dataset.delete;
    try {
      await send('deleteEntries', { ids: [id] });
      state.selection.delete(id);
      await loadData();
      toast('Entry deleted');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('selectAll').addEventListener('change', () => {
    if ($('selectAll').checked) state.filtered.forEach((e) => state.selection.add(e.id));
    else state.filtered.forEach((e) => state.selection.delete(e.id));
    renderResults();
  });

  $('clearSelection').addEventListener('click', () => {
    state.selection.clear();
    renderResults();
  });

  $('deleteSelected').addEventListener('click', async () => {
    const count = state.selection.size;
    const ok = await confirmModal({
      title: `Delete ${count} entr${count === 1 ? 'y' : 'ies'}?`,
      body: 'The selected visits are removed from local storage. This cannot be undone.',
      confirmText: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await send('deleteEntries', { ids: [...state.selection] });
      state.selection.clear();
      await loadData();
      toast(`${count} entr${count === 1 ? 'y' : 'ies'} deleted`);
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  /* --- export dropdown ---------------------------------------------- */
  const menu = $('exportMenu');
  $('exportBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    $('exportBtn').setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-export]');
    if (!item) return;
    menu.hidden = true;
    $('exportBtn').setAttribute('aria-expanded', 'false');
    runExport(item.dataset.export);
  });
  document.addEventListener('click', () => {
    if (!menu.hidden) {
      menu.hidden = true;
      $('exportBtn').setAttribute('aria-expanded', 'false');
    }
  });

  /* --- import (v1.0.2) ---------------------------------------------- */
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    event.target.value = '';   // allow picking the same file again
    await runImport(file);
  });

  $('refreshBtn').addEventListener('click', async () => {
    await loadData();
    toast('Reloaded from storage');
  });

  /* --- analytics controls ------------------------------------------- */
  $('domainTopN').addEventListener('change', renderAnalytics);

  /* --- privacy controls -------------------------------------------- */
  document.querySelectorAll('input[name="retention"]').forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      try {
        const result = await send('setSettings', { patch: { retention: radio.value } });
        state.settings = result.settings;
        await loadData();
        renderPrivacy();
        toast(radio.value === 'forever' ? 'Auto-delete disabled' : `Auto-delete set to ${radio.value === '1d' ? '1 day' : '7 days'}`);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });

  $('trackingSwitch').addEventListener('change', async () => {
    const tracking = $('trackingSwitch').checked;
    try {
      const result = await send('setSettings', { patch: { tracking } });
      state.settings = result.settings;
      renderTopbar();
      toast(tracking ? 'Recording resumed' : 'Recording paused');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('spaSwitch').addEventListener('change', async () => {
    try {
      const result = await send('setSettings', { patch: { trackSpa: $('spaSwitch').checked } });
      state.settings = result.settings;
      toast('Preference saved');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('maxEntries').addEventListener('change', debounce(async () => {
    const value = Math.max(100, Math.min(100000, Number($('maxEntries').value) || 15000));
    $('maxEntries').value = value;
    try {
      const result = await send('setSettings', { patch: { maxEntries: value } });
      state.settings = result.settings;
      toast(`Cap set to ${value.toLocaleString()} entries`);
    } catch (err) {
      toast(err.message, 'err');
    }
  }, 250));

  $('purgeNow').addEventListener('click', async () => {
    try {
      const result = await send('purgeNow');
      await loadData();
      renderPrivacy();
      toast(result && result.removed ? `${result.removed} old entries removed` : 'Nothing to clean up');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('deleteBefore').addEventListener('input', () => {
    $('deleteBeforeBtn').disabled = !$('deleteBefore').value;
  });

  $('deleteBeforeBtn').addEventListener('click', async () => {
    const ts = startOfDay($('deleteBefore').value);
    if (ts === null) return;
    const affected = state.entries.filter((e) => e.ts < ts).length;
    const ok = await confirmModal({
      title: `Delete ${affected} entr${affected === 1 ? 'y' : 'ies'}?`,
      body: `Everything recorded before ${new Date(ts).toLocaleDateString()} will be removed permanently.`,
      confirmText: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await send('deleteOlderThan', { ts });
      await loadData();
      renderPrivacy();
      toast(`${affected} entr${affected === 1 ? 'y' : 'ies'} deleted`);
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  const nuke = async () => {
    const ok = await confirmModal({
      title: 'Nuke the entire vault?',
      body: `All ${state.entries.length.toLocaleString()} stored visits and ${state.spans.length.toLocaleString()} tab sessions will be erased from chrome.storage.local immediately. There is no undo — export first if you want a copy.`,
      confirmText: 'Nuke everything',
      danger: true
    });
    if (!ok) return;
    try {
      await send('nuke', { keepSettings: true });
      state.selection.clear();
      await loadData({ keepFilters: false });
      renderPrivacy();
      toast('Vault erased');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('nukeBtn').addEventListener('click', nuke);
  $('nukeTopBtn').addEventListener('click', nuke);

  $('openExtPage').addEventListener('click', async () => {
    const url = `chrome://extensions/?id=${chrome.runtime.id}`;
    try {
      await chrome.tabs.create({ url });
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied — paste it into the address bar');
      } catch {
        toast('Open chrome://extensions manually', 'err');
      }
    }
  });

  /* --- keyboard shortcuts ------------------------------------------ */
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      switchView('vault');
      $('query').focus();
      $('query').select();
    }
    if (event.key === 'Escape' && document.activeElement === $('query') && $('query').value) {
      $('query').value = '';
      $('queryClear').hidden = true;
      applyFilters();
    }
  });

  /* --- live sync with the service worker --------------------------- */
  const syncSoon = debounce(() => loadData(), 450);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.history || changes.sessions || changes.settings) syncSoon();
  });
}

async function init() {
  wireEvents();
  switchView('vault');
  try {
    await loadData({ keepFilters: false });
  } catch (err) {
    toast(`Could not reach the service worker: ${err.message}`, 'err');
  }
}

init();
