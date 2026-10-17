'use strict';

// Unauthenticated Bluesky AppView. Signed-in requests go to the user's own PDS,
// which proxies app.bsky.* calls to the AppView.
const PUBLIC_API = 'https://public.api.bsky.app';
const DEFAULT_PDS = 'https://bsky.social';
const SESSION_KEY = 'bsky-search.session';
const FORM_FIELDS = [
  'mode', 'q', 'sort', 'author', 'mentions', 'lang', 'domain', 'url', 'tags',
  'actor', 'filter', 'contains', 'reposts', 'pins',
  'since', 'sinceTime', 'until', 'untilTime', 'count',
];
const SENSITIVE_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore']);

const $ = (sel, root = document) => root.querySelector(sel);
const form = $('#search-form');

let run = null; // state of the current search; see startRun()

// ---------------------------------------------------------------------------
// Small DOM helper

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function safeHref(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session (app-password sign-in)

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable (private mode); the session just won't persist.
  }
  renderAccount();
}

function pdsFromDidDoc(doc) {
  const svc = (doc?.service || []).find(s => s.id === '#atproto_pds' || s.id?.endsWith('#atproto_pds'));
  return svc?.serviceEndpoint || null;
}

async function fetchDidDoc(did) {
  let url;
  if (did.startsWith('did:plc:')) url = `https://plc.directory/${did}`;
  else if (did.startsWith('did:web:')) url = `https://${did.slice(8)}/.well-known/did.json`;
  else return null;
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

// Find the PDS that hosts an account, so accounts not on bsky.social can sign in.
async function resolvePds(identifier) {
  try {
    let did = identifier.startsWith('did:') ? identifier : null;
    if (!did && !identifier.includes('@')) {
      const res = await fetch(buildUrl(PUBLIC_API, 'com.atproto.identity.resolveHandle', { handle: identifier.replace(/^@/, '') }));
      if (res.ok) did = (await res.json()).did;
    }
    if (did) return pdsFromDidDoc(await fetchDidDoc(did)) || DEFAULT_PDS;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_PDS;
}

async function postJson(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

async function signIn(identifier, password, authFactorToken) {
  identifier = identifier.trim().replace(/^@/, '');
  const pds = await resolvePds(identifier);
  const data = await postJson(`${pds}/xrpc/com.atproto.server.createSession`, {
    identifier, password, authFactorToken: authFactorToken || undefined,
  });
  saveSession({
    did: data.did,
    handle: data.handle,
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
    pdsUrl: pdsFromDidDoc(data.didDoc) || pds,
  });
}

async function refreshSession(session) {
  const data = await postJson(`${session.pdsUrl}/xrpc/com.atproto.server.refreshSession`, null, session.refreshJwt);
  const next = { ...session, accessJwt: data.accessJwt, refreshJwt: data.refreshJwt, handle: data.handle || session.handle };
  saveSession(next);
  return next;
}

async function signOut() {
  const session = loadSession();
  saveSession(null);
  if (session) {
    postJson(`${session.pdsUrl}/xrpc/com.atproto.server.deleteSession`, null, session.refreshJwt).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// XRPC

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `Request failed (HTTP ${status})`);
    this.status = status;
    this.error = body?.error;
  }
}

function buildUrl(base, nsid, params) {
  const url = new URL(`/xrpc/${nsid}`, base);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else url.searchParams.set(k, String(v));
  }
  return url;
}

async function xrpcGet(nsid, params, { signal, onUrl } = {}) {
  let session = loadSession();
  for (let attempt = 0; ; attempt++) {
    const url = buildUrl(session ? session.pdsUrl : PUBLIC_API, nsid, params);
    onUrl?.(url);
    const headers = session ? { Authorization: `Bearer ${session.accessJwt}` } : {};
    const res = await fetch(url, { headers, signal });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;

    const err = new ApiError(res.status, body);
    if (session && attempt === 0 && (err.error === 'ExpiredToken' || err.error === 'InvalidToken' || res.status === 401)) {
      try {
        session = await refreshSession(session);
      } catch {
        saveSession(null);
        session = null;
        showError('Your Bluesky sign-in expired, so you were signed out. Trying again without signing in…');
      }
      continue;
    }
    throw err;
  }
}

// Handles typed with or without "@", or pasted as bsky.app profile links.
function normalizeActor(value) {
  let v = (value || '').trim();
  const m = v.match(/bsky\.app\/profile\/([^/?#]+)/);
  if (m) v = decodeURIComponent(m[1]);
  return v.replace(/^@/, '');
}

// ---------------------------------------------------------------------------
// Form <-> parameters

function localBoundary(dateStr, timeStr, isEnd) {
  if (!dateStr) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  if (timeStr) {
    const [hh, mm] = timeStr.split(':').map(Number);
    // An end time includes the whole minute.
    return new Date(y, mo - 1, d, hh, mm + (isEnd ? 1 : 0));
  }
  return isEnd ? new Date(y, mo - 1, d + 1) : new Date(y, mo - 1, d);
}

function readForm() {
  const fd = new FormData(form);
  const get = k => (fd.get(k) || '').toString().trim();
  const p = {
    mode: get('mode') || 'search',
    q: get('q'),
    sort: get('sort') || 'latest',
    author: normalizeActor(get('author')),
    mentions: normalizeActor(get('mentions')),
    lang: get('lang'),
    domain: get('domain').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    url: get('url'),
    tags: get('tags'),
    actor: normalizeActor(get('actor')),
    filter: get('filter') || 'posts_with_replies',
    contains: get('contains'),
    reposts: fd.has('reposts'),
    pins: fd.has('pins'),
    since: get('since'),
    sinceTime: get('sinceTime'),
    until: get('until'),
    untilTime: get('untilTime'),
    count: Math.min(5000, Math.max(1, parseInt(get('count'), 10) || 50)),
  };
  p.sinceDate = localBoundary(p.since, p.sinceTime, false);
  p.untilDate = localBoundary(p.until, p.untilTime, true);
  p.tagList = p.tags.split(/[\s,]+/).map(t => t.replace(/^#/, '')).filter(Boolean);

  if (p.mode === 'search' && !p.q) {
    throw new Error(p.author
      ? 'Bluesky search needs some search words. To see everything a person posted, use the “All posts from a person” tab.'
      : 'Please enter some search words.');
  }
  if (p.mode === 'author' && !p.actor) throw new Error('Please enter the person’s handle (for example, name.bsky.social).');
  if (p.sinceDate && p.untilDate && p.sinceDate >= p.untilDate) throw new Error('The “From” date must be before the “Through” date.');
  return p;
}

function writeForm(values) {
  for (const name of FORM_FIELDS) {
    if (!(name in values)) continue;
    const el = form.elements[name];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = values[name] === '1' || values[name] === true;
    else el.value = values[name];
  }
  setMode(form.elements.mode.value);
}

function paramsToQueryString(p) {
  const qs = new URLSearchParams();
  const fields = p.mode === 'search'
    ? ['mode', 'q', 'sort', 'author', 'mentions', 'lang', 'domain', 'url', 'tags']
    : ['mode', 'actor', 'filter', 'contains', 'reposts', 'pins'];
  for (const k of [...fields, 'since', 'sinceTime', 'until', 'untilTime', 'count']) {
    const v = p[k];
    if (typeof v === 'boolean') qs.set(k, v ? '1' : '0');
    else if (v !== '' && v != null) qs.set(k, v);
  }
  return qs.toString();
}

function setMode(mode) {
  form.elements.mode.value = mode;
  for (const tab of form.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  for (const panel of form.querySelectorAll('.mode-panel')) panel.hidden = panel.dataset.mode !== mode;
  $('#go-btn').textContent = mode === 'search' ? 'Search' : 'Show posts';
}

function setQuickRange(days) {
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  form.elements.since.value = days ? fmt(start) : '';
  form.elements.until.value = days ? fmt(today) : '';
  form.elements.sinceTime.value = '';
  form.elements.untilTime.value = '';
}

// ---------------------------------------------------------------------------
// Running a search

function startRun(params) {
  run?.controller?.abort();
  run = {
    params, cursor: undefined, done: false, results: [], seen: new Set(),
    scanned: 0, oldestScanned: null, hitsTotal: null, controller: null,
  };
  $('#results').replaceChildren();
  $('#results-section').hidden = false;
  history.replaceState(null, '', `?${paramsToQueryString(params)}`);
}

async function loadMore() {
  if (!run || run.controller || run.done) return;
  hideError();
  run.controller = new AbortController();
  const { signal } = run.controller;
  const target = run.results.length + run.params.count;
  updateControls();
  try {
    while (!run.done && run.results.length < target) {
      if (run.params.mode === 'search') await fetchSearchPage(target - run.results.length, signal);
      else await fetchAuthorPage(signal);
      updateStatus();
    }
  } catch (err) {
    if (err.name !== 'AbortError') showError(describeError(err));
  } finally {
    run.controller = null;
    updateControls();
    updateStatus();
  }
}

function showRequest(url) {
  $('#request-url').textContent = `GET ${url.href}`;
}

async function fetchSearchPage(remaining, signal) {
  const p = run.params;
  const data = await xrpcGet('app.bsky.feed.searchPosts', {
    q: p.q,
    sort: p.sort,
    since: p.sinceDate?.toISOString(),
    until: p.untilDate?.toISOString(),
    author: p.author,
    mentions: p.mentions,
    lang: p.lang,
    domain: p.domain,
    url: p.url,
    tag: p.tagList,
    limit: Math.min(100, remaining),
    cursor: run.cursor,
  }, { signal, onUrl: showRequest });
  if (data.hitsTotal != null) run.hitsTotal = data.hitsTotal;
  const posts = data.posts || [];
  run.scanned += posts.length;
  for (const post of posts) addResult({ post });
  run.cursor = data.cursor;
  if (!data.cursor || posts.length === 0) run.done = true;
}

// getAuthorFeed has no date filter, so walk the feed newest-first and keep the
// posts in range, stopping once the feed is older than the "From" date.
async function fetchAuthorPage(signal) {
  const p = run.params;
  const data = await xrpcGet('app.bsky.feed.getAuthorFeed', {
    actor: p.actor,
    filter: p.filter,
    includePins: p.pins,
    limit: 100,
    cursor: run.cursor,
  }, { signal, onUrl: showRequest });
  const feed = data.feed || [];
  const contains = p.contains.toLowerCase();
  let reachedStart = false;

  for (const item of feed) {
    const reason = item.reason?.$type || '';
    const isPin = reason.endsWith('#reasonPin');
    const isRepost = reason.endsWith('#reasonRepost');
    run.scanned++;

    const feedTime = new Date(isRepost ? item.reason.indexedAt : item.post.indexedAt);
    if (!isPin) {
      if (!run.oldestScanned || feedTime < run.oldestScanned) run.oldestScanned = feedTime;
      if (p.sinceDate && feedTime < p.sinceDate) reachedStart = true;
    }
    if (isRepost && !p.reposts) continue;

    // A repost counts as happening when it was reposted; a post when it was written.
    const when = new Date(isRepost ? item.reason.indexedAt : (item.post.record?.createdAt || item.post.indexedAt));
    if (p.sinceDate && when < p.sinceDate) continue;
    if (p.untilDate && when >= p.untilDate) continue;
    if (contains && !(item.post.record?.text || '').toLowerCase().includes(contains)) continue;
    addResult(item);
  }

  run.cursor = data.cursor;
  if (!data.cursor || feed.length === 0 || reachedStart) run.done = true;
}

function addResult(item) {
  const key = item.reason?.$type?.endsWith('#reasonRepost')
    ? `${item.post.uri}|repost|${item.reason.by?.did}`
    : item.post.uri;
  if (run.seen.has(key)) return;
  run.seen.add(key);
  run.results.push(item);
  $('#results').append(renderFeedItem(item));
}

function describeError(err) {
  if (err instanceof TypeError) {
    return 'Could not reach Bluesky. Check your internet connection and try again.';
  }
  if (err instanceof ApiError) {
    if (run?.params.mode === 'search' && (err.status === 401 || err.status === 403) && !loadSession()) {
      return h('span', null,
        'Bluesky asks you to sign in before searching. ',
        h('button', { type: 'button', class: 'link', onclick: openSignIn }, 'Sign in with an app password'),
        ' and then search again.');
    }
    if (err.error === 'BlockedActor' || err.error === 'BlockedByActor') return 'This account is blocked, or has blocked you.';
    if (/profile not found|could not find|actor not found/i.test(err.message)) return 'Couldn’t find that person. Check the spelling of the handle.';
    if (err.status === 429) return 'Bluesky says too many requests were made. Wait a minute and try again.';
    return `Bluesky returned an error: ${err.message}`;
  }
  return err.message || String(err);
}

// ---------------------------------------------------------------------------
// Rendering posts

function atUriParts(uri) {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)/.exec(uri || '');
  return m ? { repo: m[1], collection: m[2], rkey: m[3] } : null;
}

function postWebUrl(uri, handle) {
  const parts = atUriParts(uri);
  if (!parts) return null;
  const who = handle && handle !== 'handle.invalid' ? handle : parts.repo;
  return `https://bsky.app/profile/${who}/post/${parts.rkey}`;
}

function profileUrl(author) {
  return `https://bsky.app/profile/${author.handle && author.handle !== 'handle.invalid' ? author.handle : author.did}`;
}

// Facet offsets are UTF-8 byte offsets, so slice on the encoded bytes.
function renderRichText(text, facets) {
  const frag = document.createDocumentFragment();
  if (!text) return frag;
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  const slice = (a, b) => decoder.decode(bytes.slice(a, b));
  const sorted = (facets || [])
    .filter(f => f.index && f.features?.length)
    .sort((a, b) => a.index.byteStart - b.index.byteStart);

  let pos = 0;
  for (const facet of sorted) {
    const { byteStart, byteEnd } = facet.index;
    if (byteStart < pos || byteEnd > bytes.length || byteEnd <= byteStart) continue;
    if (byteStart > pos) frag.append(slice(pos, byteStart));
    const feature = facet.features[0];
    let href = null;
    if (feature.$type === 'app.bsky.richtext.facet#link') href = safeHref(feature.uri);
    else if (feature.$type === 'app.bsky.richtext.facet#mention') href = `https://bsky.app/profile/${feature.did}`;
    else if (feature.$type === 'app.bsky.richtext.facet#tag') href = `https://bsky.app/hashtag/${encodeURIComponent(feature.tag)}`;
    const segment = slice(byteStart, byteEnd);
    frag.append(href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, segment) : segment);
    pos = byteEnd;
  }
  if (pos < bytes.length) frag.append(slice(pos));
  return frag;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function authorLine(author, iso, link) {
  return h('div', { class: 'author' },
    author.avatar
      ? h('img', { class: 'avatar', src: author.avatar, alt: '', loading: 'lazy' })
      : h('span', { class: 'avatar placeholder' }),
    h('a', { class: 'name', href: profileUrl(author), target: '_blank', rel: 'noopener' },
      h('strong', null, author.displayName || author.handle),
      ' ',
      h('span', { class: 'handle' }, `@${author.handle}`)),
    iso && h('a', { class: 'time', href: link, target: '_blank', rel: 'noopener', title: iso }, formatDate(iso)));
}

function sensitiveLabels(post) {
  return [...(post.labels || []), ...(post.author?.labels || [])]
    .map(l => l.val)
    .filter(v => SENSITIVE_LABELS.has(v));
}

function maybeBlur(node, labels) {
  if (!labels.length) return node;
  const wrapper = h('div', { class: 'blurred' }, node);
  const button = h('button', {
    type: 'button',
    class: 'secondary small reveal',
    onclick: () => { wrapper.classList.remove('blurred'); button.remove(); },
  }, `Content warning: ${labels.join(', ')} — show`);
  return h('div', null, button, wrapper);
}

function renderImages(images) {
  return h('div', { class: `images n${Math.min(images.length, 4)}` },
    images.map(img => h('a', { href: img.fullsize, target: '_blank', rel: 'noopener' },
      h('img', { src: img.thumb, alt: img.alt || '', title: img.alt || '', loading: 'lazy' }))));
}

function renderExternal(ext) {
  const href = safeHref(ext.uri);
  return h('a', { class: 'external', href, target: '_blank', rel: 'noopener noreferrer' },
    ext.thumb && h('img', { src: ext.thumb, alt: '', loading: 'lazy' }),
    h('div', null,
      h('strong', null, ext.title || ext.uri),
      ext.description && h('p', null, ext.description),
      h('small', null, href ? new URL(href).hostname : ext.uri)));
}

function renderVideo(video, postLink) {
  return h('a', { class: 'video', href: postLink, target: '_blank', rel: 'noopener', title: 'Watch on Bluesky' },
    video.thumbnail ? h('img', { src: video.thumbnail, alt: video.alt || 'Video', loading: 'lazy' }) : h('span', null, 'Video'),
    h('span', { class: 'play', 'aria-hidden': 'true' }, '▶'));
}

function renderQuoted(record) {
  const type = record?.$type || '';
  if (type.endsWith('#viewRecord')) {
    const link = postWebUrl(record.uri, record.author.handle);
    return h('div', { class: 'quote' },
      authorLine(record.author, record.value?.createdAt || record.indexedAt, link),
      h('div', { class: 'text' }, renderRichText(record.value?.text, record.value?.facets)),
      (record.embeds || []).map(e => renderEmbed(e, link, true)));
  }
  if (type.endsWith('#viewNotFound')) return h('div', { class: 'quote muted' }, 'Quoted post was deleted.');
  if (type.endsWith('#viewBlocked')) return h('div', { class: 'quote muted' }, 'Quoted post is from a blocked account.');
  if (type.endsWith('#viewDetached')) return h('div', { class: 'quote muted' }, 'Quoted post was removed by its author.');
  if (type === 'app.bsky.feed.defs#generatorView') return h('div', { class: 'quote' }, `Feed: ${record.displayName}`);
  if (type === 'app.bsky.graph.defs#listView') return h('div', { class: 'quote' }, `List: ${record.name}`);
  if (type === 'app.bsky.graph.defs#starterPackViewBasic') return h('div', { class: 'quote' }, `Starter pack: ${record.record?.name || ''}`);
  return null;
}

function renderEmbed(embed, postLink, nested = false) {
  const type = embed?.$type || '';
  if (type === 'app.bsky.embed.images#view') return renderImages(embed.images || []);
  if (type === 'app.bsky.embed.external#view') return renderExternal(embed.external);
  if (type === 'app.bsky.embed.video#view') return renderVideo(embed, postLink);
  if (type === 'app.bsky.embed.record#view') return nested ? null : renderQuoted(embed.record);
  if (type === 'app.bsky.embed.recordWithMedia#view') {
    return h('div', null, renderEmbed(embed.media, postLink, nested), nested ? null : renderQuoted(embed.record?.record));
  }
  return null;
}

function renderFeedItem(item) {
  const { post, reason, reply } = item;
  const record = post.record || {};
  const link = postWebUrl(post.uri, post.author.handle);
  const reasonType = reason?.$type || '';

  let context = null;
  if (reasonType.endsWith('#reasonRepost')) {
    context = h('div', { class: 'context' }, `↻ Reposted by ${reason.by.displayName || reason.by.handle} · ${formatDate(reason.indexedAt)}`);
  } else if (reasonType.endsWith('#reasonPin')) {
    context = h('div', { class: 'context' }, '📌 Pinned post');
  }

  let replyLine = null;
  if (record.reply) {
    const parentAuthor = reply?.parent?.author;
    const parentLink = postWebUrl(record.reply.parent?.uri, parentAuthor?.handle);
    replyLine = h('div', { class: 'context' },
      '↳ Reply to ',
      h('a', { href: parentLink, target: '_blank', rel: 'noopener' }, parentAuthor ? `@${parentAuthor.handle}` : 'a post'));
  }

  const embed = post.embed && renderEmbed(post.embed, link);
  return h('li', { class: 'post' },
    context,
    authorLine(post.author, record.createdAt || post.indexedAt, link),
    replyLine,
    h('div', { class: 'text' }, renderRichText(record.text, record.facets)),
    embed && maybeBlur(embed, sensitiveLabels(post)),
    h('div', { class: 'stats' },
      h('span', { title: 'Replies' }, `💬 ${post.replyCount ?? 0}`),
      h('span', { title: 'Reposts' }, `↻ ${post.repostCount ?? 0}`),
      h('span', { title: 'Quotes' }, `❝ ${post.quoteCount ?? 0}`),
      h('span', { title: 'Likes' }, `♥ ${post.likeCount ?? 0}`),
      link && h('a', { href: link, target: '_blank', rel: 'noopener' }, 'Open on Bluesky ↗')));
}

// ---------------------------------------------------------------------------
// Status, controls, errors

function updateStatus() {
  if (!run) return;
  const n = run.results.length;
  const parts = [`${n.toLocaleString()} post${n === 1 ? '' : 's'}`];
  if (run.hitsTotal != null) parts.push(`about ${run.hitsTotal.toLocaleString()} matches in total`);
  if (run.params.mode === 'author') {
    parts.push(`${run.scanned.toLocaleString()} checked`);
    if (run.oldestScanned) parts.push(`back to ${run.oldestScanned.toLocaleDateString(undefined, { dateStyle: 'medium' })}`);
  }
  if (run.controller) parts.push('loading…');
  else if (run.done) parts.push(n ? 'that’s everything' : 'nothing found');
  $('#status').textContent = parts.join(' · ');
}

function updateControls() {
  const busy = !!run?.controller;
  $('#go-btn').disabled = busy;
  $('#stop-btn').hidden = !busy;
  $('#more-btn').hidden = !run || busy || run.done;
  $('#more-btn').textContent = run ? `Load ${run.params.count} more` : 'Load more';
  for (const id of ['#export-csv-btn', '#export-json-btn']) $(id).disabled = !run?.results.length;
}

function showError(message) {
  const box = $('#error');
  box.replaceChildren(message);
  box.hidden = false;
}

function hideError() {
  $('#error').hidden = true;
}

// ---------------------------------------------------------------------------
// Export

function download(filename, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportName(ext) {
  const p = run.params;
  const base = p.mode === 'search' ? `search-${p.q}` : `posts-${p.actor}`;
  return `${base.replace(/[^\w.-]+/g, '_').slice(0, 60)}.${ext}`;
}

function exportCsv() {
  const cols = ['created_at', 'author_handle', 'author_name', 'text', 'url', 'type', 'replies', 'reposts', 'quotes', 'likes', 'languages'];
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = run.results.map(({ post, reason }) => {
    const r = post.record || {};
    const type = reason?.$type?.endsWith('#reasonRepost') ? `repost by @${reason.by.handle}` : r.reply ? 'reply' : 'post';
    return [r.createdAt, post.author.handle, post.author.displayName, r.text, postWebUrl(post.uri, post.author.handle),
      type, post.replyCount, post.repostCount, post.quoteCount, post.likeCount, (r.langs || []).join(' ')].map(esc).join(',');
  });
  download(exportName('csv'), 'text/csv;charset=utf-8', `﻿${[cols.join(','), ...rows].join('\r\n')}`);
}

function exportJson() {
  download(exportName('json'), 'application/json', JSON.stringify(run.results, null, 2));
}

// ---------------------------------------------------------------------------
// Account UI

function renderAccount() {
  const session = loadSession();
  $('#account-status').textContent = session ? `Signed in as @${session.handle}` : 'Not signed in';
  $('#signin-btn').hidden = !!session;
  $('#signout-btn').hidden = !session;
}

function openSignIn() {
  $('#signin-error').hidden = true;
  $('#signin-dialog').showModal();
}

async function onSignInSubmit(event) {
  event.preventDefault();
  const f = event.target;
  const errorBox = $('#signin-error');
  const button = f.querySelector('button[type=submit]');
  errorBox.hidden = true;
  button.disabled = true;
  try {
    await signIn(f.elements.identifier.value, f.elements.password.value, f.elements.authFactorToken.value);
    f.elements.password.value = '';
    f.elements.authFactorToken.value = '';
    $('#auth-factor-row').hidden = true;
    $('#signin-dialog').close();
    hideError();
  } catch (err) {
    if (err.error === 'AuthFactorTokenRequired') {
      $('#auth-factor-row').hidden = false;
      errorBox.textContent = 'Bluesky emailed you a sign-in code. Enter it above and press Sign in again.';
    } else if (err instanceof TypeError) {
      errorBox.textContent = 'Could not reach Bluesky. Check your internet connection.';
    } else {
      errorBox.textContent = err.status === 401
        ? 'That handle or app password wasn’t accepted. Check them and try again.'
        : `Sign-in failed: ${err.message}`;
    }
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Handle typeahead

function attachTypeahead(input) {
  const list = document.getElementById(input.getAttribute('list'));
  let timer = null;
  let lastQuery = '';
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = normalizeActor(input.value);
    if (q.length < 2 || q.startsWith('did:') || q === lastQuery) return;
    timer = setTimeout(async () => {
      lastQuery = q;
      try {
        const res = await fetch(buildUrl(PUBLIC_API, 'app.bsky.actor.searchActorsTypeahead', { q, limit: 8 }));
        if (!res.ok) return;
        const { actors = [] } = await res.json();
        list.replaceChildren(...actors.map(a => h('option', { value: a.handle }, a.displayName || a.handle)));
      } catch {
        // Suggestions are optional.
      }
    }, 250);
  });
}

// ---------------------------------------------------------------------------
// Wiring

function submitSearch() {
  hideError();
  let params;
  try {
    params = readForm();
  } catch (err) {
    showError(err.message);
    return;
  }
  startRun(params);
  loadMore();
}

form.addEventListener('submit', event => {
  event.preventDefault();
  submitSearch();
});
form.addEventListener('reset', () => setTimeout(() => setMode(form.elements.mode.value === 'author' ? 'author' : 'search')));
for (const tab of form.querySelectorAll('.tab')) tab.addEventListener('click', () => setMode(tab.dataset.mode));
for (const btn of form.querySelectorAll('[data-range]')) btn.addEventListener('click', () => setQuickRange(Number(btn.dataset.range)));
for (const input of form.querySelectorAll('[data-typeahead]')) attachTypeahead(input);

$('#stop-btn').addEventListener('click', () => run?.controller?.abort());
$('#more-btn').addEventListener('click', loadMore);
$('#export-csv-btn').addEventListener('click', exportCsv);
$('#export-json-btn').addEventListener('click', exportJson);
$('#copy-link-btn').addEventListener('click', async event => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(location.href);
    button.textContent = 'Copied!';
  } catch {
    button.textContent = 'Copy the address bar instead';
  }
  setTimeout(() => { button.textContent = 'Copy link to this search'; }, 2000);
});

$('#signin-btn').addEventListener('click', openSignIn);
$('#signout-btn').addEventListener('click', signOut);
$('#signin-form').addEventListener('submit', onSignInSubmit);
$('#signin-cancel').addEventListener('click', () => $('#signin-dialog').close());

// Restore a search from the address bar (shared links, bookmarks, reloads).
(function init() {
  renderAccount();
  const qs = new URLSearchParams(location.search);
  if ([...qs.keys()].length) {
    writeForm(Object.fromEntries(qs));
    if (qs.get('q') || qs.get('actor')) submitSearch();
  } else {
    setMode('search');
  }
})();
