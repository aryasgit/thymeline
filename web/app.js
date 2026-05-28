// Thymeline — single-page logic.
// Talks to /api/*. State is intentionally minimal; render() is the source of truth.

(() => {
'use strict';

// ====================== state ======================

const state = {
  me: null,
  project: null,
  ownerSet: false,
  entries: [],
  members: [],
  tags: [],
  stats: { types: {}, total: 0, members: 0, host: '' },
  filter: { type: null, tag: null, author: null, q: '' },
  pending: { files: [], type: 'idea' },
  open: new Set(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ENTRY_TYPES = ['idea', 'progress', 'failure', 'log', 'debug', 'code', 'record'];

// ====================== utilities ======================

function html(strings, ...values) {
  // Tagged template that escapes interpolated values.
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += escapeHtml(values[i]) + strings[i + 1];
  }
  return out;
}

function escapeHtml(v) {
  if (v == null) return '';
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clsx(...parts) { return parts.filter(Boolean).join(' '); }

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtDay(iso) {
  const d = new Date(iso);
  const now = new Date();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today - dayStart) / 86400000);
  if (diffDays === 0) return { lbl: 'Today', ago: fmtAgo(diffDays) };
  if (diffDays === 1) return { lbl: 'Yesterday', ago: fmtAgo(diffDays) };
  const lbl = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const yr = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '';
  return { lbl: lbl + yr, ago: fmtAgo(diffDays) };
}

function fmtAgo(diffDays) {
  if (diffDays === 0) return 'now';
  if (diffDays === 1) return '1d ago';
  if (diffDays < 7) return diffDays + 'd ago';
  if (diffDays < 31) return Math.floor(diffDays / 7) + 'w ago';
  if (diffDays < 365) return Math.floor(diffDays / 30) + 'mo ago';
  return Math.floor(diffDays / 365) + 'y ago';
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ====================== tiny markdown renderer ======================
// Supports: **bold**, *italic*, `code`, ```fences```, # headings, - lists,
// > quotes, [text](url), images via ![alt](url), autolinks, #tag chips.
// Escapes all input first.

function renderMd(src) {
  if (!src) return '';
  let s = escapeHtml(src);

  // Fenced code blocks
  s = s.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre${langAttr}><code>${code.replace(/\n$/, '')}</code></pre>`;
  });

  // Split by blocks (paragraphs) to handle lists/quotes/headings
  const blocks = s.split(/\n{2,}/);
  const out = [];
  for (let block of blocks) {
    block = block.trim();
    if (!block) continue;
    if (block.startsWith('<pre')) { out.push(block); continue; }

    if (/^### /.test(block)) { out.push(`<h3>${inline(block.replace(/^### /, ''))}</h3>`); continue; }
    if (/^## /.test(block))  { out.push(`<h2>${inline(block.replace(/^## /, ''))}</h2>`); continue; }
    if (/^# /.test(block))   { out.push(`<h1>${inline(block.replace(/^# /, ''))}</h1>`); continue; }

    if (/^&gt; /.test(block)) {
      const lines = block.split('\n').map(l => l.replace(/^&gt; ?/, '')).join('<br>');
      out.push(`<blockquote>${inline(lines)}</blockquote>`);
      continue;
    }

    if (/^[-*] /m.test(block) && block.split('\n').every(l => /^[-*] /.test(l))) {
      const items = block.split('\n').map(l => `<li>${inline(l.replace(/^[-*] /, ''))}</li>`).join('');
      out.push(`<ul>${items}</ul>`);
      continue;
    }

    if (/^\d+\. /m.test(block) && block.split('\n').every(l => /^\d+\. /.test(l))) {
      const items = block.split('\n').map(l => `<li>${inline(l.replace(/^\d+\. /, ''))}</li>`).join('');
      out.push(`<ol>${items}</ol>`);
      continue;
    }

    out.push(`<p>${inline(block.replace(/\n/g, '<br>'))}</p>`);
  }
  return out.join('\n');
}

function inline(s) {
  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold and italic
  s = s.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^\*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Images
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    if (!/^https?:|^\//.test(src)) return _;
    return `<img alt="${escapeHtml(alt)}" src="${escapeHtml(src)}" style="max-width:100%;border:1px solid var(--line-2)">`;
  });
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    if (!/^https?:|^\//.test(href)) return _;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>`;
  });
  // Autolinks
  s = s.replace(/(?<![">\w])(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  // #tags
  s = s.replace(/(^|[\s])#([A-Za-z][\w-]{0,40})/g,
    (m, lead, t) => `${lead}<a class="hash" data-tag="${escapeHtml(t.toLowerCase())}">#${escapeHtml(t)}</a>`);
  return s;
}

// ====================== api ======================

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) {
    state.me = null;
    renderAll();
    throw new Error('unauthorized');
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`${r.status} ${t}`);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

async function apiForm(path, formData, method = 'POST') {
  const r = await fetch(path, { method, body: formData, credentials: 'same-origin' });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`${r.status} ${t}`);
  }
  return r.json();
}

// ====================== boot ======================

async function boot() {
  startClock();
  bindGlobal();
  bindCmd();
  bindFilters();
  bindDialogs();
  bindTheme();
  bindDragDrop();

  const me = await api('/api/me');
  state.me = me.member;
  state.project = me.project;
  state.ownerSet = me.owner_set;

  if (!state.ownerSet) {
    showBootstrap();
    return;
  }
  if (!state.me) {
    // Not signed in, not owner. Show a hint to ask owner for invite.
    document.body.innerHTML = `
      <header class="topbar"><div class="wrap top-grid">
        <a href="/" class="brand"><span class="glyph"></span>Thymeline</a>
        <div></div><div></div>
      </div></header>
      <section class="hero"><div class="wrap">
        <div class="cap">Access</div>
        <h1 class="tight" style="margin-top:1rem">
          You need an invite to <span class="dim">${escapeHtml(state.project?.name || 'this project')}.</span>
        </h1>
        <p class="dim" style="margin-top:1rem">Ask the owner for a link.</p>
      </div></section>`;
    return;
  }

  await refreshAll();
  renderAll();
}

async function refreshAll() {
  const [entries, members, tags, stats] = await Promise.all([
    api('/api/entries?limit=200' + filterQuery()),
    api('/api/members'),
    api('/api/tags'),
    api('/api/stats'),
  ]);
  state.entries = entries.entries;
  state.members = members.members;
  state.tags = tags.tags;
  state.stats = stats;
}

function filterQuery() {
  const p = new URLSearchParams();
  if (state.filter.type) p.set('type', state.filter.type);
  if (state.filter.tag) p.set('tag', state.filter.tag);
  if (state.filter.author) p.set('author', state.filter.author);
  if (state.filter.q) p.set('q', state.filter.q);
  const s = p.toString();
  return s ? '&' + s : '';
}

async function refreshEntries() {
  const r = await api('/api/entries?limit=200' + filterQuery());
  state.entries = r.entries;
  renderTimeline();
  renderFeedHead();
}

// ====================== render ======================

function renderAll() {
  renderTopbar();
  renderStats();
  renderFilters();
  renderTags();
  renderMembers();
  renderTimeline();
  renderFeedHead();
  renderFooter();
}

function renderTopbar() {
  $('#projectName').textContent = state.project?.name || '—';
  const inline = $('#membersInline');
  inline.innerHTML = state.members.slice(0, 5).map(m =>
    `<span class="dot" style="background:${escapeHtml(m.color)}" title="${escapeHtml(m.name)}">${escapeHtml(initials(m.name))}</span>`
  ).join('');
  const invite = $('#inviteBtn');
  invite.hidden = !state.me?.is_owner;
}

function renderStats() {
  const grid = $('#statsGrid');
  const t = state.stats.types || {};
  const total = state.stats.total || 0;
  const items = [
    { num: total, lbl: 'entries' },
    { num: (t.progress || 0), lbl: 'progress' },
    { num: (t.failure || 0), lbl: 'failures · debugs', extra: (t.debug || 0) },
    { num: state.stats.members || 0, lbl: 'people on the team' },
  ];
  // Second slot: failure+debug summed
  items[2].num = (t.failure || 0) + (t.debug || 0);
  grid.innerHTML = items.map(it => `
    <div class="stat">
      <div class="num">${escapeHtml(it.num)}</div>
      <div class="lbl">${escapeHtml(it.lbl)}</div>
    </div>
  `).join('');
}

function renderFilters() {
  const box = $('#typeFilters');
  const t = state.stats.types || {};
  const total = state.stats.total || 0;
  const rows = [
    { key: null, label: 'All', n: total },
    ...ENTRY_TYPES.map(k => ({ key: k, label: k, n: t[k] || 0 })),
  ];
  box.innerHTML = rows.map(r => `
    <button class="f ${state.filter.type === r.key ? 'on' : ''}" data-type="${r.key ?? ''}">
      <span>${escapeHtml(r.label)}</span><span class="n">${escapeHtml(r.n)}</span>
    </button>
  `).join('');
  $$('.f', box).forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.type || null;
      state.filter.type = state.filter.type === t ? null : t;
      renderFilters();
      renderFeedHead();
      refreshEntries();
    });
  });
}

function renderTags() {
  const box = $('#tagCloud');
  if (!state.tags.length) {
    box.innerHTML = `<span class="cap dim">none yet</span>`;
    return;
  }
  box.innerHTML = state.tags.slice(0, 60).map(t => `
    <button class="tag ${state.filter.tag === t.tag ? 'on' : ''}" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)} <span class="dim">${t.count}</span></button>
  `).join('');
  $$('button.tag', box).forEach(b => {
    b.addEventListener('click', () => {
      const t = b.dataset.tag;
      state.filter.tag = state.filter.tag === t ? null : t;
      renderTags();
      renderFeedHead();
      refreshEntries();
    });
  });
}

function renderMembers() {
  const box = $('#membersList');
  box.innerHTML = state.members.map(m => `
    <button class="mem ${state.filter.author === m.id ? 'on' : ''}" data-author="${escapeHtml(m.id)}">
      <span class="d" style="background:${escapeHtml(m.color)}">${escapeHtml(initials(m.name))}</span>
      <span class="n">${escapeHtml(m.name)}${m.is_owner ? ' <span class="dim">·owner</span>' : ''}</span>
      <span class="c">${m.entry_count}</span>
    </button>
  `).join('');
  $$('button.mem', box).forEach(b => {
    b.addEventListener('click', () => {
      const a = b.dataset.author;
      state.filter.author = state.filter.author === a ? null : a;
      renderMembers();
      renderFeedHead();
      refreshEntries();
    });
  });
}

function renderFeedHead() {
  $('#feedCount').textContent = `${state.entries.length} entr${state.entries.length === 1 ? 'y' : 'ies'}`;
  const f = state.filter;
  const bits = [];
  if (f.type) bits.push(`type: ${f.type}`);
  if (f.tag) bits.push(`#${f.tag}`);
  if (f.author) {
    const m = state.members.find(x => x.id === f.author);
    if (m) bits.push(`by ${m.name}`);
  }
  if (f.q) bits.push(`"${f.q}"`);
  const box = $('#feedActive');
  if (!bits.length) { box.innerHTML = ''; return; }
  box.innerHTML = `${escapeHtml(bits.join(' · '))} <span class="clear" id="clearFilters">clear</span>`;
  $('#clearFilters').addEventListener('click', () => {
    state.filter = { type: null, tag: null, author: null, q: '' };
    $('#searchInput').value = '';
    renderFilters(); renderTags(); renderMembers(); renderFeedHead();
    refreshEntries();
  });
}

function renderTimeline() {
  const tl = $('#timeline');
  const empty = $('#timelineEmpty');
  if (!state.entries.length) {
    tl.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // Group by day (YYYY-MM-DD)
  const groups = new Map();
  for (const e of state.entries) {
    const d = e.created_at.slice(0, 10);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(e);
  }

  const sections = [];
  for (const [day, entries] of groups) {
    const { lbl, ago } = fmtDay(day + 'T00:00:00Z');
    const rows = entries.map(e => renderEntry(e)).join('');
    sections.push(`
      <div class="day reveal">
        <div class="day-lbl tight">${escapeHtml(lbl)}<span class="ago">${escapeHtml(ago)}</span></div>
        <div class="day-list">${rows}</div>
      </div>
    `);
  }
  tl.innerHTML = sections.join('');

  // Bind expand
  $$('.entry', tl).forEach(el => {
    el.addEventListener('click', (ev) => {
      // Don't toggle when clicking on a link/button inside
      if (ev.target.closest('a, button, .act')) return;
      const id = el.dataset.id;
      if (state.open.has(id)) state.open.delete(id);
      else state.open.add(id);
      el.classList.toggle('open');
      lazyLoadBody(el);
    });
  });

  // Pre-expand previously open ones
  $$('.entry', tl).forEach(el => {
    if (state.open.has(el.dataset.id)) {
      el.classList.add('open');
      lazyLoadBody(el);
    }
  });

  // Reveal animation
  const io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && e.target.classList.add('in')),
    { threshold: 0.05, rootMargin: '0px 0px -20px 0px' });
  $$('.reveal', tl).forEach(el => io.observe(el));
}

function renderEntry(e) {
  const preview = (e.body || '').replace(/[#`*>\n]/g, ' ').trim().slice(0, 140);
  const title = e.title || preview || '—';
  return `
    <div class="entry" data-id="${escapeHtml(e.id)}">
      <div class="entry-head">
        <span class="e-time mono">${escapeHtml(fmtTime(e.created_at))}</span>
        <span class="e-type t-${escapeHtml(e.type)}">${escapeHtml(e.type)}</span>
        <span class="e-title tight">
          <span class="e-author" style="background:${escapeHtml(e.author.color)}" title="${escapeHtml(e.author.name)}">${escapeHtml(initials(e.author.name))}</span>
          <span>${escapeHtml(e.title || preview || '—')}</span>
          ${e.title && preview ? `<span class="preview">${escapeHtml(preview)}</span>` : ''}
        </span>
        <span class="e-arrow">→</span>
      </div>
      <div class="entry-body" data-loaded="0"></div>
    </div>
  `;
}

function lazyLoadBody(entryEl) {
  const body = $('.entry-body', entryEl);
  if (body.dataset.loaded === '1') return;
  const e = state.entries.find(x => x.id === entryEl.dataset.id);
  if (!e) return;
  body.dataset.loaded = '1';

  const md = e.body ? `<div class="md">${renderMd(e.body)}</div>` : '';
  const assets = (e.assets || []).map(a => {
    const isImg = /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(a);
    const url = '/' + a.replace(/^\/+/, '');
    if (isImg) return `<a href="${escapeHtml(url)}" target="_blank"><img loading="lazy" src="${escapeHtml(url)}" alt=""></a>`;
    return `<a href="${escapeHtml(url)}" target="_blank" class="file">${escapeHtml(a.split('/').pop())}</a>`;
  }).join('');
  const tagChips = (e.tags || []).map(t => `<span class="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('');
  const canEdit = state.me && (state.me.id === e.author_id || state.me.is_owner);
  const actions = canEdit ? `
    <span class="act" data-act="copy" data-id="${escapeHtml(e.id)}">copy</span>
    <span class="act" data-act="edit" data-id="${escapeHtml(e.id)}">edit</span>
    <span class="act danger" data-act="del" data-id="${escapeHtml(e.id)}">delete</span>
  ` : `<span class="act" data-act="copy" data-id="${escapeHtml(e.id)}">copy</span>`;

  body.innerHTML = `
    <div class="entry-body-inner">
      ${md}
      ${assets ? `<div class="entry-assets">${assets}</div>` : ''}
      <div class="entry-meta">
        <span>by ${escapeHtml(e.author.name)}</span>
        <span>${escapeHtml(new Date(e.created_at).toLocaleString())}</span>
        ${tagChips}
        <span class="meta-actions">${actions}</span>
      </div>
    </div>
  `;
  // Bind actions
  $$('.act', body).forEach(b => b.addEventListener('click', onEntryAction));
  // Tag chips inside body
  $$('.entry-meta .tag, .md a.hash', body).forEach(b => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const t = b.dataset.tag || b.textContent.replace(/^#/, '').trim();
      state.filter.tag = t;
      renderTags(); renderFeedHead();
      refreshEntries();
    });
  });
}

function renderFooter() {
  $('#footVault').textContent = state.stats.host ? `host: ${state.stats.host}` : '';
}

// ====================== entry actions ======================

async function onEntryAction(ev) {
  ev.stopPropagation();
  const b = ev.currentTarget;
  const id = b.dataset.id;
  const act = b.dataset.act;
  const e = state.entries.find(x => x.id === id);
  if (!e) return;

  if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(e.body || e.title || '');
      toast('copied');
    } catch { toast('clipboard blocked', 'err'); }
    return;
  }

  if (act === 'del') {
    if (!confirm('Delete this entry? The .md file will be removed.')) return;
    try {
      await api(`/api/entries/${id}`, { method: 'DELETE' });
      state.open.delete(id);
      await refreshAll(); renderAll();
      toast('deleted');
    } catch (err) { toast('delete failed: ' + err.message, 'err'); }
    return;
  }

  if (act === 'edit') {
    const next = prompt('Edit entry body (markdown):', e.body || '');
    if (next === null) return;
    try {
      const r = await api(`/api/entries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: next }),
      });
      // Replace in state
      const idx = state.entries.findIndex(x => x.id === id);
      if (idx >= 0) state.entries[idx] = r;
      await Promise.all([
        api('/api/tags').then(t => state.tags = t.tags),
        api('/api/stats').then(s => state.stats = s),
      ]);
      renderTimeline(); renderTags(); renderStats();
      toast('saved');
    } catch (err) { toast('edit failed: ' + err.message, 'err'); }
  }
}

// ====================== quick entry ======================

function bindCmd() {
  const form = $('#cmdForm');
  const input = $('#cmdInput');
  const types = $('#cmdTypes');
  const filesInput = $('#cmdFiles');

  // Type pills
  $$('button.t', types).forEach(b => {
    b.addEventListener('click', () => {
      setCmdType(b.dataset.type);
    });
  });

  // Save
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await saveCmd();
  });

  // Keyboard
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      saveCmd();
    } else if (ev.key === 'Tab' && !ev.shiftKey && !ev.metaKey) {
      const idx = ENTRY_TYPES.indexOf(state.pending.type);
      const next = ENTRY_TYPES[(idx + 1) % ENTRY_TYPES.length];
      ev.preventDefault();
      setCmdType(next);
    } else if (ev.key === 'Escape') {
      clearCmd();
    }
  });

  // File picker
  $('#cmdAttach').addEventListener('click', () => filesInput.click());
  filesInput.addEventListener('change', () => addFiles(filesInput.files));

  // Paste — image OR code detection
  input.addEventListener('paste', (ev) => {
    const items = ev.clipboardData?.items || [];
    let consumed = false;
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) { addFiles([f]); consumed = true; }
      }
    }
    if (consumed) {
      setCmdType('progress');
      ev.preventDefault();
      return;
    }
    // Heuristic: paste with multiple lines + code-y characters → code
    const text = ev.clipboardData?.getData('text/plain') || '';
    if (text.split('\n').length >= 4 && /[{};=()<>]/.test(text) && !text.startsWith('```')) {
      if (state.pending.type === 'idea') {
        setCmdType('code');
        // Wrap in fenced block once
        setTimeout(() => {
          if (!input.value.includes('```')) {
            input.value = '```\n' + input.value + '\n```';
            input.setSelectionRange(4, 4);
          }
        }, 0);
      }
    }
  });

  // Form-level dragover for visual hint
  const cmd = $('#cmdForm');
  cmd.addEventListener('dragover', (ev) => { ev.preventDefault(); cmd.classList.add('dragover'); });
  cmd.addEventListener('dragleave', () => cmd.classList.remove('dragover'));
  cmd.addEventListener('drop', (ev) => {
    ev.preventDefault(); cmd.classList.remove('dragover');
    if (ev.dataTransfer?.files?.length) {
      addFiles(ev.dataTransfer.files);
      setCmdType('progress');
    }
  });
}

function setCmdType(t) {
  state.pending.type = t;
  $$('#cmdTypes .t').forEach(b => b.classList.toggle('on', b.dataset.type === t));
}

function addFiles(fl) {
  for (const f of fl) state.pending.files.push(f);
  renderPending();
}

function renderPending() {
  const box = $('#cmdPreview');
  if (!state.pending.files.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = state.pending.files.map((f, i) => {
    const isImg = f.type.startsWith('image/');
    const thumb = isImg ? `<img src="${URL.createObjectURL(f)}">` : '';
    return `<span class="chip">${thumb}${escapeHtml(f.name)} <span class="x" data-i="${i}">×</span></span>`;
  }).join('');
  $$('.cmd-preview .x').forEach(x => x.addEventListener('click', (e) => {
    const i = +e.currentTarget.dataset.i;
    state.pending.files.splice(i, 1);
    renderPending();
  }));
}

function clearCmd() {
  $('#cmdInput').value = '';
  state.pending.files = [];
  setCmdType('idea');
  renderPending();
}

async function saveCmd() {
  const input = $('#cmdInput');
  const text = input.value.trim();
  if (!text && !state.pending.files.length) {
    toast('type something or attach a file', 'err');
    return;
  }
  const fd = new FormData();
  fd.set('type', state.pending.type);
  fd.set('body', text);
  // First-line title heuristic for non-code types
  if (state.pending.type !== 'code') {
    const firstLine = text.split('\n')[0].trim();
    if (firstLine && firstLine.length <= 80 && (text.includes('\n') || state.pending.files.length)) {
      fd.set('title', firstLine);
      fd.set('body', text.split('\n').slice(1).join('\n').trim());
    }
  }
  for (const f of state.pending.files) fd.append('files', f);
  try {
    await apiForm('/api/entries', fd);
    clearCmd();
    await refreshAll(); renderAll();
    toast('logged');
  } catch (err) {
    toast('save failed: ' + err.message, 'err');
  }
}

// ====================== filters / search ======================

function bindFilters() {
  const s = $('#searchInput');
  let h;
  s.addEventListener('input', () => {
    clearTimeout(h);
    h = setTimeout(() => {
      state.filter.q = s.value.trim();
      renderFeedHead();
      refreshEntries();
    }, 200);
  });
  s.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { s.value = ''; state.filter.q = ''; renderFeedHead(); refreshEntries(); }
  });
}

// ====================== dialogs ======================

function bindDialogs() {
  $('#inviteBtn').addEventListener('click', openInvite);
  $('#inviteClose').addEventListener('click', () => $('#inviteDialog').hidden = true);
  $('#inviteCopy').addEventListener('click', async () => {
    const url = $('#inviteUrl').value;
    try { await navigator.clipboard.writeText(url); toast('copied'); }
    catch { $('#inviteUrl').select(); document.execCommand('copy'); toast('copied'); }
  });
  $('#bootstrapForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const project = f.project.value.trim();
    const name = f.name.value.trim();
    try {
      await api('/api/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, name }),
      });
      $('#bootstrapDialog').hidden = true;
      const me = await api('/api/me');
      state.me = me.member; state.project = me.project; state.ownerSet = me.owner_set;
      await refreshAll(); renderAll();
      toast('welcome, ' + name);
    } catch (err) { toast('start failed: ' + err.message, 'err'); }
  });
  // Click outside dialog → close
  $$('.dialog').forEach(d => d.addEventListener('click', (ev) => {
    if (ev.target === d && d.id !== 'bootstrapDialog') d.hidden = true;
  }));
}

function showBootstrap() { $('#bootstrapDialog').hidden = false; }

async function openInvite() {
  try {
    const r = await api('/api/invite', { method: 'POST' });
    $('#inviteUrl').value = r.url;
    $('#inviteDialog').hidden = false;
  } catch (err) { toast('invite failed: ' + err.message, 'err'); }
}

// ====================== theme ======================

function bindTheme() {
  const saved = localStorage.getItem('thymeline_theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('thymeline_theme', next);
  });
}

// ====================== drag-drop on page ======================

function bindDragDrop() {
  let depth = 0;
  document.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types || []).includes('Files')) return;
    depth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) document.body.classList.remove('dragging');
  });
  document.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer?.types && Array.from(ev.dataTransfer.types).includes('Files')) {
      ev.preventDefault();
    }
  });
  document.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer?.files?.length) return;
    ev.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    addFiles(ev.dataTransfer.files);
    setCmdType('progress');
    $('#cmdInput').focus();
  });
}

// ====================== global keys ======================

function bindGlobal() {
  document.addEventListener('keydown', (ev) => {
    // ⌘K → focus search
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'k') {
      ev.preventDefault();
      $('#searchInput').focus();
      return;
    }
    // 'n' anywhere (not in input) → focus quick entry
    if (ev.key === 'n' && !/INPUT|TEXTAREA/.test(ev.target.tagName)) {
      $('#cmdInput').focus();
    }
  });
}

// ====================== live clock ======================

function startClock() {
  const tick = () => {
    const d = new Date();
    const p = n => n < 10 ? '0' + n : '' + n;
    $('#localTime').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ====================== go ======================

document.addEventListener('DOMContentLoaded', () => {
  boot().catch(err => {
    console.error(err);
    toast('boot failed: ' + err.message, 'err');
  });
});

})();
