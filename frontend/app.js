/* ============================================================================
   app.js — GC Dossier frontend logic

   What this file does:
     - Connects to Supabase using the PUBLIC anon key (safe to expose).
     - Wires up three tabs: Search, Interactions, Timeline.
     - Calls the RPC functions we defined in schema.sql.
     - Paginates search results like Gmail — 50 per page, nav buttons.

   IMPORTANT: SUPABASE_ANON_KEY is the PUBLIC key, safe to ship to browsers.
   Row Level Security (RLS) enforces read-only access. Never put the
   service_role key here.
   ============================================================================ */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://mhjmjrkhxfoeeumhedsh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_VfzrVVtR-AWb2xIEE11rhw_9Gy24Yb8';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// How many messages to show per page. Change this number to adjust page size.
const PAGE_SIZE = 50;


// ─── PAGINATION STATE ─────────────────────────────────────────────────────────
// We store the current search parameters here so that when the user clicks
// "Next" or "Prev", we can re-run the same query with a different offset
// without re-reading the form inputs each time.
//
// "offset" means "skip the first N results". Page 1 = skip 0,
// page 2 = skip 50, page 3 = skip 100, and so on.
let searchState = {
  query:       null,
  sender:      null,
  filterMedia: null,
  mediaRaw:    '',
  startDate:   null,
  endDate:     null,
  minRxns:     0,
  sortOrder:   'newest',  // 'newest' | 'oldest' | 'relevance' | 'most_reactions'
  totalCount:  0,
  currentPage: 1,
};


// ─── TAB SWITCHING ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    document.querySelectorAll('.panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== `panel-${target}`);
    });
  });
});


// Wraps a Supabase call in a hard timeout. On free-tier cold start, queries
// can hang indefinitely (no rejection, no resolution). Without this, init()
// stays pending forever and the retry loop never cycles.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ─── INIT: load stats + populate dropdowns ────────────────────────────────────
async function init() {
  try {
    console.log('init: starting');
    const [
      { data: stats,   error: mErr },
      { data: senders, error: sErr },
    ] = await Promise.all([
      withTimeout(
        sb.from('site_stats').select('*').single(),
        8000, 'site_stats'
      ),
      withTimeout(
        sb.rpc('get_distinct_senders'),
        8000, 'get_distinct_senders'
      ),
    ]);
    if (mErr) throw mErr;
    if (sErr) throw sErr;
    console.log('init: ok — messages', stats.total_messages, '· senders', senders?.length);

    document.getElementById('stat-messages').textContent = stats.total_messages.toLocaleString();
    document.getElementById('stat-members').textContent  = senders.length.toLocaleString();

    populateSenderDropdown('filter-sender', senders, true);
    populateSenderDropdown('inter-a',       senders, false);
    populateSenderDropdown('inter-b',       senders, false);

    initFilterCollapse();
    document.getElementById('db-status').textContent = 'db: connected';
  } catch (err) {
    console.error(err);
    document.getElementById('db-status').textContent = 'db: ERROR';
    showError('Could not reach the database. Check your connection and refresh.');
    throw err;  // re-throw so caller knows to retry
  }
}

// Show the error banner. Called from init() and anywhere else
// we need to surface a user-facing error. Replaces alert().
function showError(message) {
  const banner = document.getElementById('error-banner');
  const msgEl  = document.getElementById('error-msg');
  if (!banner || !msgEl) return;
  msgEl.textContent = message;
  banner.classList.remove('hidden');
}

function hideError() {
  const banner = document.getElementById('error-banner');
  if (banner) banner.classList.add('hidden');
}

// Wire up dismiss button. Done at script load — element is already in DOM
// because this script tag is at the bottom of body.
document.getElementById('error-dismiss')?.addEventListener('click', hideError);

// initWithRetry drives init() with plain setTimeout-based retries.
// We previously used async/await inside a for-loop; the await continuation
// after Promise.race silently stalled on cold load (Safari + Supabase SDK
// interaction). Using setTimeout means each attempt is a fresh macrotask
// with no dependency on the prior async context.
function initWithRetry() {
  const DELAYS = [0, 500, 2000, 5000, 10000]; // ms before each attempt
  let attempt = 0;

  function schedule() {
    if (attempt >= DELAYS.length) {
      console.error('initWithRetry: all attempts exhausted');
      return;
    }
    const delay = DELAYS[attempt++];
    console.log(`initWithRetry: attempt ${attempt}/${DELAYS.length} in ${delay}ms`);
    setTimeout(run, delay);
  }

  function run() {
    console.log(`initWithRetry: running attempt ${attempt}`);
    init()
      .then(() => {
        hideError();
        console.log('initWithRetry: success on attempt', attempt);
      })
      .catch(err => {
        console.warn(`initWithRetry: attempt ${attempt} failed —`, err.message);
        schedule();
      });
  }

  schedule();
}

function populateSenderDropdown(id, senders, includeAny) {
  const sel = document.getElementById(id);
  sel.innerHTML = '';
  if (includeAny) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Anyone';
    sel.appendChild(opt);
  }
  for (const s of senders) {
    const opt = document.createElement('option');
    opt.value = s.sender;
    const displayName = s.alias || s.sender;
    opt.textContent = `${displayName} (${s.message_count.toLocaleString()})`;
    sel.appendChild(opt);
  }
  buildSearchableDropdown(id);
}

// Wait for the DOM to be fully ready before initializing. This avoids the
// cold-start race where the Supabase CDN script is loaded but its internal
// session bootstrap is mid-flight when our queries fire. DOMContentLoaded
// gives the CDN script a moment to finish setting up the supabase global.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWithRetry);
} else {
  // DOM already ready (script ran late) — just go.
  initWithRetry();
}


// ─── SEARCH TAB ───────────────────────────────────────────────────────────────
const searchBtn   = document.getElementById('search-btn');
const searchInput = document.getElementById('search-query');

searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') startSearch(); });
searchBtn.addEventListener('click', startSearch);

// Delegated click: any .msg card in the results list opens the context view.
document.getElementById('results').addEventListener('click', e => {
  const card = e.target.closest('.msg');
  if (card?.dataset.ts) openContext(card.dataset.ts);
});

// Disable/enable the search button and pagination during a fetch so the user
// can't fire overlapping requests.
function setSearchBusy(busy) {
  searchBtn.disabled = busy;
  searchBtn.textContent = busy ? 'Searching…' : 'Search';
  document.querySelectorAll('#pagination .page-btn').forEach(b => { b.disabled = busy; });
}

// startSearch() is called when the user hits Search or presses Enter.
// It reads the form, validates input, saves state, then fetches page 1.
async function startSearch() {
  const query     = searchInput.value.trim();
  const sender    = document.getElementById('filter-sender').value || null;
  const mediaRaw  = document.getElementById('filter-media').value;
  const startDate = document.getElementById('filter-start').value;
  const endDate   = document.getElementById('filter-end').value;
  const minRxns   = parseInt(document.getElementById('filter-min-reactions').value, 10) || 0;
  const sortOrder = document.getElementById('filter-sort').value || 'newest';

  // Guard: require at least one filter. An unfiltered scan of 484k rows
  // with ts_rank ordering will always time out on the free tier.
  const hasKeyword   = query.length > 0;
  const hasSender    = sender !== null;
  const hasMedia     = mediaRaw !== '' && mediaRaw !== undefined;
  const hasDateRange = startDate || endDate;
  const hasMinRxns   = minRxns > 0;

  const meta = document.getElementById('result-meta');

  if (!hasKeyword && !hasSender && !hasMedia && !hasDateRange && !hasMinRxns) {
    meta.textContent = '[WARN] Enter a keyword or set at least one filter.';
    return;
  }

  // 'none' = text-only filter. We can't express IS NULL through the RPC param,
  // so we send null to the DB and post-filter in JS after the response.
  const filterMedia = (mediaRaw && mediaRaw !== 'none') ? mediaRaw : null;

  // Save all params to searchState so pagination can reuse them.
  searchState = {
    query,
    sender,
    filterMedia,
    mediaRaw,
    startDate: startDate ? new Date(startDate).toISOString() : null,
    endDate:   endDate   ? new Date(endDate + 'T23:59:59').toISOString() : null,
    minRxns,
    sortOrder,
    totalCount:  0,
    currentPage: 1,
  };

  meta.textContent = 'Counting results…';
  setSearchBusy(true);

  try {
    // Step 1: get the total count so we know how many pages to show.
    await fetchTotalCount();

    // Step 2: fetch and render page 1.
    await fetchPage(1);
  } finally {
    setSearchBusy(false);
  }
}

// fetchTotalCount() calls a lightweight SQL function that counts matching
// rows without fetching any message data. This is what lets us show
// "Page 1 of 47" without fetching all 2,300 results upfront.
async function fetchTotalCount() {
  const { data, error } = await sb.rpc('count_messages', {
    query_text:    searchState.query    || null,
    filter_sender: searchState.sender,
    filter_media:  searchState.filterMedia,
    start_date:    searchState.startDate,
    end_date:      searchState.endDate,
    min_reactions: searchState.minRxns,
  });

  if (error) {
    console.error('count_messages error:', error);
    searchState.totalCount = 0;
    return;
  }

  // The RPC returns the count directly.
  searchState.totalCount = data ?? 0;
}

// fetchPage(n) fetches exactly PAGE_SIZE rows for page n, using the
// saved searchState. Called by startSearch() (already inside setSearchBusy)
// and directly by pagination buttons.
async function fetchPage(pageNum) {
  const meta    = document.getElementById('result-meta');
  const results = document.getElementById('results');

  searchState.currentPage = pageNum;
  setSearchBusy(true);

  // offset = rows to skip before returning results.
  const offset = (pageNum - 1) * PAGE_SIZE;

  meta.textContent = `Loading page ${pageNum}…`;
  results.innerHTML = '';

  const { data, error } = await sb.rpc('search_messages', {
    query_text:    searchState.query    || null,
    filter_sender: searchState.sender,
    filter_media:  searchState.filterMedia,
    start_date:    searchState.startDate,
    end_date:      searchState.endDate,
    min_reactions: searchState.minRxns,
    sort_order:    searchState.sortOrder,
    result_limit:  PAGE_SIZE,
    result_offset: offset,
  });

  if (error) {
    console.error(error);
    meta.textContent = 'Error: ' + error.message;
    setSearchBusy(false);
    return;
  }

  // Post-filter for text-only if needed.
  const filtered = (searchState.mediaRaw === 'none')
    ? data.filter(r => r.media_type === null)
    : data;

  const totalPages = Math.ceil(searchState.totalCount / PAGE_SIZE);

  meta.textContent =
    `Page ${pageNum} of ${totalPages} · ${searchState.totalCount.toLocaleString()} total results`;

  if (filtered.length === 0) {
    results.innerHTML = '<p class="empty-results">No messages matched your filters.</p>';
  } else {
    results.innerHTML = filtered.map(r => renderMessage(r, searchState.query)).join('');
  }

  // Render page nav buttons.
  renderPagination();
  setSearchBusy(false);

  // Scroll the result-meta line into view — same feel as Gmail page turns.
  document.getElementById('result-meta').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// renderPagination() builds the Prev / numbered pages / Next control bar.
// It shows a sliding window of page numbers centred on the current page,
// with ellipsis gaps and first/last shortcuts — exactly like Gmail.
function renderPagination() {
  const container = document.getElementById('pagination');
  if (!container) return;

  const total      = searchState.totalCount;
  const current    = searchState.currentPage;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (totalPages <= 1) { container.innerHTML = ''; return; }

  // Show up to 7 page buttons centred around the current page.
  const WINDOW = 3;
  let startPage = Math.max(1, current - WINDOW);
  let endPage   = Math.min(totalPages, current + WINDOW);

  // Shift window if we're near the edges so we always show ~7 buttons.
  if (endPage - startPage < WINDOW * 2) {
    if (startPage === 1) endPage   = Math.min(totalPages, 1 + WINDOW * 2);
    else                 startPage = Math.max(1, totalPages - WINDOW * 2);
  }

  let html = '';

  html += `<button class="page-btn${current === 1 ? ' disabled' : ''}"
    onclick="if(${current}>1) fetchPage(${current - 1})">&laquo; Prev</button>`;

  if (startPage > 1) {
    html += `<button class="page-btn" onclick="fetchPage(1)">1</button>`;
    if (startPage > 2) html += `<span class="page-ellipsis">…</span>`;
  }

  for (let p = startPage; p <= endPage; p++) {
    html += `<button class="page-btn${p === current ? ' active' : ''}"
      onclick="fetchPage(${p})">${p}</button>`;
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += `<span class="page-ellipsis">…</span>`;
    html += `<button class="page-btn" onclick="fetchPage(${totalPages})">${totalPages}</button>`;
  }

  html += `<button class="page-btn${current === totalPages ? ' disabled' : ''}"
    onclick="if(${current}<${totalPages}) fetchPage(${current + 1})">Next &raquo;</button>`;

  container.innerHTML = html;
}

// Renders a single message row. Clicking opens the context view.
function renderMessage(msg, query) {
  const content = highlight(escapeHtml(msg.content || ''), query);
  const badges  = [];
  if (msg.media_type)         badges.push(`<span class="badge media">${msg.media_type}</span>`);
  if (msg.reaction_count > 0) badges.push(`<span class="badge rxn">${msg.reaction_count} ❤</span>`);

  return `
    <div class="msg" data-ts="${escapeHtml(msg.ts)}">
      <div class="meta">
        <span class="sender">${escapeHtml(msg.sender)}</span>
        <span class="ts">${formatTs(msg.ts)}</span>
      </div>
      <div class="content">${content || '<em style="color:var(--text-dim)">[no text — media only]</em>'}</div>
      <div class="badges">${badges.join('')}</div>
    </div>
  `;
}


// ─── CONTEXT VIEW ─────────────────────────────────────────────────────────────

document.getElementById('ctx-back').addEventListener('click', closeContext);

function closeContext() {
  document.getElementById('panel-context').classList.add('hidden');
  document.getElementById('panel-search').classList.remove('hidden');
}

async function openContext(anchorTs) {
  const panelSearch  = document.getElementById('panel-search');
  const panelContext = document.getElementById('panel-context');
  const thread       = document.getElementById('ctx-thread');
  const title        = document.getElementById('ctx-title');

  panelSearch.classList.add('hidden');
  panelContext.classList.remove('hidden');
  thread.innerHTML = '<div class="ctx-loading">[SYS] loading context…</div>';
  title.textContent = '';

  // Fetch messages ±6 hours around the anchor timestamp
  const anchor = new Date(anchorTs);
  const from   = new Date(anchor.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const to     = new Date(anchor.getTime() + 6 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from('messages')
    .select('id, sender, content, media_type, timestamp')
    .gte('timestamp', from)
    .lte('timestamp', to)
    .eq('message_type', 'message')
    .order('timestamp', { ascending: true })
    .limit(80);

  if (error) {
    thread.innerHTML = `<div class="ctx-loading">[ERR] ${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data || data.length === 0) {
    thread.innerHTML = '<div class="ctx-loading">No messages found in this window.</div>';
    return;
  }

  title.textContent = `${data.length} msgs · ${formatTs(anchorTs)}`;
  thread.innerHTML = renderContextThread(data, anchor.getTime());

  // Scroll the highlighted message into view
  requestAnimationFrame(() => {
    document.getElementById('ctx-anchor')?.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
}

function renderContextThread(messages, anchorMs) {
  let prevSender = null;
  let prevMs     = null;
  const parts    = [];

  for (const msg of messages) {
    const msgMs     = new Date(msg.timestamp).getTime();
    const isAnchor  = Math.abs(msgMs - anchorMs) < 2000;
    const newSender = msg.sender !== prevSender;
    const gapMs     = prevMs !== null ? msgMs - prevMs : 0;

    // Time divider when >30 min gap between consecutive messages
    if (prevMs !== null && gapMs > 30 * 60 * 1000) {
      parts.push(`<div class="ctx-gap">${formatTs(msg.timestamp)}</div>`);
    }

    parts.push(`
      <div class="ctx-msg${isAnchor ? ' ctx-anchor' : ''}${newSender ? ' ctx-new-sender' : ''}"${isAnchor ? ' id="ctx-anchor"' : ''}>
        ${newSender ? `<div class="ctx-sender-name">${escapeHtml(msg.sender)}</div>` : ''}
        <div class="ctx-bubble">
          ${escapeHtml(msg.content) || '<em style="opacity:.5">[media only]</em>'}
          ${msg.media_type ? `<span class="ctx-media-badge">${msg.media_type}</span>` : ''}
        </div>
        ${(isAnchor || newSender) ? `<div class="ctx-msg-meta">${formatTs(msg.timestamp)}</div>` : ''}
      </div>
    `);

    prevSender = msg.sender;
    prevMs     = msgMs;
  }

  return parts.join('');
}


// ─── INTERACTIONS TAB ─────────────────────────────────────────────────────────
document.getElementById('inter-btn').addEventListener('click', async () => {
  const userA      = document.getElementById('inter-a').value;
  const userB      = document.getElementById('inter-b').value;
  const windowSecs = parseInt(document.getElementById('inter-window').value, 10) || 60;
  const meta       = document.getElementById('inter-meta');
  const results    = document.getElementById('inter-results');

  if (!userA || !userB || userA === userB) {
    meta.textContent = 'Pick two different users.';
    return;
  }

  meta.textContent = 'Scanning…';
  results.innerHTML = '';

  const { data, error } = await sb.rpc('find_interactions', {
    user_a:         userA,
    user_b:         userB,
    window_seconds: windowSecs,
    result_limit:   500,
  });

  if (error) { meta.textContent = 'Error: ' + error.message; return; }

  meta.textContent = `${data.length} interaction${data.length === 1 ? '' : 's'} found` +
                     ` (${userA} followed by ${userB} within ${windowSecs}s)`;

  results.innerHTML = data.map(row => `
    <div class="pair">
      <div class="line a">
        <span class="who">${escapeHtml(userA)} · ${formatTs(row.a_timestamp)}</span>
        <span>${escapeHtml(row.a_content || '[media]')}</span>
      </div>
      <div class="line b">
        <span class="who">${escapeHtml(userB)} · +${row.gap_seconds}s</span>
        <span>${escapeHtml(row.b_content || '[media]')}</span>
      </div>
    </div>
  `).join('');
});


// ─── TIMELINE TAB ─────────────────────────────────────────────────────────────
document.getElementById('tl-btn').addEventListener('click', async () => {
  const centerRaw = document.getElementById('tl-center').value;
  const windowHrs = parseInt(document.getElementById('tl-window').value, 10) || 24;
  const meta      = document.getElementById('tl-meta');
  const results   = document.getElementById('tl-results');

  if (!centerRaw) { meta.textContent = 'Pick a center time first.'; return; }

  meta.textContent = 'Analyzing…';
  results.innerHTML = '';

  const { data, error } = await sb.rpc('activity_around', {
    center_time:  new Date(centerRaw).toISOString(),
    window_hours: windowHrs,
  });

  if (error) { meta.textContent = 'Error: ' + error.message; return; }

  meta.textContent = `${data.length} sender${data.length === 1 ? '' : 's'} active ` +
                     `in ±${windowHrs}h around ${formatTs(new Date(centerRaw).toISOString())}`;

  results.innerHTML = data.map(row => `
    <div class="activity-row">
      <span class="name">${escapeHtml(row.sender)}</span>
      <span class="count">${row.message_count.toLocaleString()}</span>
      <span class="range">${formatTs(row.first_msg)} → ${formatTs(row.last_msg)}</span>
    </div>
  `).join('');
});


// ─── SEARCHABLE SENDER DROPDOWN ──────────────────────────────────────────────
// Replaces native <select> for the three sender fields. 573 options in a
// native select is unusable on mobile. The hidden <select> stays in the DOM
// as the value source so all existing code that reads .value still works.
//
// Selected senders display as a removable chip. Backspace on an empty input
// clears the chip. The dropdown list is max-height scrollable so it never
// takes over the page scroll.

const _ss = {};

function buildSearchableDropdown(id) {
  const sel = document.getElementById(id);
  if (!sel) return;

  document.getElementById('ss-' + id)?.remove();
  sel.style.display = 'none';

  // .ss-wrap is the styled container (border, bg, flex row)
  const wrap = document.createElement('div');
  wrap.className = 'ss-wrap';
  wrap.id = 'ss-' + id;

  // Chip shown when a real sender is selected
  const chip = document.createElement('div');
  chip.className = 'ss-chip';
  chip.hidden = true;
  const chipLabel = document.createElement('span');
  chipLabel.className = 'ss-chip-label';
  const chipX = document.createElement('button');
  chipX.type = 'button';
  chipX.className = 'ss-chip-x';
  chipX.setAttribute('tabindex', '-1');
  chipX.textContent = '×';
  chip.appendChild(chipLabel);
  chip.appendChild(chipX);

  // Inner input — transparent, no border; sits inside the styled wrap
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'ss-inner-inp';
  inp.autocomplete = 'off';
  inp.setAttribute('spellcheck', 'false');
  inp.placeholder = sel.options[0]?.textContent || 'Select…';

  const list = document.createElement('ul');
  list.className = 'ss-list';
  list.hidden = true;

  wrap.appendChild(chip);
  wrap.appendChild(inp);
  wrap.appendChild(list);
  sel.insertAdjacentElement('beforebegin', wrap);
  _ss[id] = { wrap, chip, chipLabel, inp, list, sel };
  _ssRebuild(id);

  // Clicking the wrap (outside the chip) focuses the input
  wrap.addEventListener('mousedown', e => {
    if (!chip.contains(e.target)) { e.preventDefault(); inp.focus(); }
  });

  chipX.addEventListener('mousedown', e => e.preventDefault());
  chipX.addEventListener('click',    () => _ssClear(id));
  chipX.addEventListener('touchend', e => { e.preventDefault(); _ssClear(id); }, { passive: false });

  inp.addEventListener('focus', () => _ssOpen(id));
  inp.addEventListener('input', () => {
    if (!_ss[id].chip.hidden) _ssClearChipOnly(id); // typing replaces selection
    list.hidden = false;
    _ssFilter(id, inp.value);
  });
  inp.addEventListener('keydown', e => _ssKey(id, e));

  // Distinguish scroll from tap inside the list
  let _touchY = 0, _touchScrolled = false;
  list.addEventListener('touchstart', e => { _touchY = e.touches[0].clientY; _touchScrolled = false; }, { passive: true });
  list.addEventListener('touchmove',  e => { if (Math.abs(e.touches[0].clientY - _touchY) > 8) _touchScrolled = true; }, { passive: true });
  list.addEventListener('touchend', e => {
    if (_touchScrolled) return;
    const li = e.target.closest('.ss-opt');
    if (li) { e.preventDefault(); _ssPick(id, li.dataset.value); }
  }, { passive: false });
  list.addEventListener('mousedown', e => {
    e.stopPropagation(); // prevent wrap's mousedown from firing inp.focus() → _ssOpen()
    const li = e.target.closest('.ss-opt');
    if (li) { e.preventDefault(); _ssPick(id, li.dataset.value); }
  });
}

// Close open dropdowns on outside interaction
['mousedown', 'touchstart'].forEach(evt =>
  document.addEventListener(evt, e => {
    Object.entries(_ss).forEach(([id, d]) => {
      if (!d.list.hidden && !d.wrap.contains(e.target)) _ssClose(id);
    });
  }, { passive: true })
);

function _ssRebuild(id) {
  const { list, sel } = _ss[id];
  list.innerHTML = '';
  Array.from(sel.options).forEach(opt => {
    const li = document.createElement('li');
    li.className = 'ss-opt';
    li.dataset.value = opt.value;
    li.textContent = opt.textContent;
    list.appendChild(li);
  });
}

function _ssOpen(id) {
  const { inp, list } = _ss[id];
  inp.value = '';
  list.querySelectorAll('.ss-opt').forEach(li => { li.hidden = false; li.classList.remove('ss-kb'); });
  list.hidden = false;
  list.querySelector('.ss-sel')?.scrollIntoView({ block: 'nearest' });
}

function _ssClose(id) {
  if (_ss[id].list.hidden) return;
  _ss[id].list.hidden = true;
  _ss[id].inp.value = '';
}

function _ssClearChipOnly(id) {
  const { chip, inp, list, sel } = _ss[id];
  chip.hidden = true;
  inp.hidden = false;
  sel.value = '';
  inp.placeholder = sel.options[0]?.textContent || 'Select…';
  inp.value = '';
  list.querySelectorAll('.ss-opt').forEach(li => li.classList.remove('ss-sel'));
}

function _ssClear(id) {
  _ssClearChipOnly(id);
  _ss[id].inp.focus();
  _ssOpen(id);
}

function _ssFilter(id, q) {
  const lq = q.toLowerCase();
  _ss[id].list.querySelectorAll('.ss-opt').forEach(li => {
    li.hidden = lq.length > 0 && !li.textContent.toLowerCase().includes(lq);
    li.classList.remove('ss-kb');
  });
}

function _ssPick(id, value) {
  const { chip, chipLabel, inp, list, sel } = _ss[id];
  sel.value = value;
  list.querySelectorAll('.ss-opt').forEach(li => {
    li.hidden = false;
    li.classList.remove('ss-kb');
    li.classList.toggle('ss-sel', li.dataset.value === value);
  });
  list.hidden = true;
  inp.value = '';

  if (!value) {
    // "Anyone" / empty option — no chip
    chip.hidden = true;
    inp.hidden = false;
    inp.placeholder = sel.options[0]?.textContent || 'Select…';
  } else {
    const opt = Array.from(sel.options).find(o => o.value === value);
    chipLabel.textContent = opt?.textContent || value;
    chip.hidden = false;
    inp.hidden = true; // hide input so chip fills the wrap (flex: 1 needs a defined container width)
    inp.blur();
  }
}

function _ssKey(id, e) {
  const { chip, inp, list } = _ss[id];
  // Backspace on empty input with active chip → clear selection
  if (e.key === 'Backspace' && inp.value === '' && !chip.hidden) {
    _ssClear(id);
    return;
  }
  if (e.key === 'Escape') { _ssClose(id); inp.blur(); return; }
  if (e.key === 'Tab')    { _ssClose(id); return; }
  if (list.hidden) {
    if (e.key === 'ArrowDown') { e.preventDefault(); _ssOpen(id); }
    return;
  }
  const vis = [...list.querySelectorAll('.ss-opt:not([hidden])')];
  if (!vis.length) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const kb = list.querySelector('.ss-kb');
    if (kb) _ssPick(id, kb.dataset.value);
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const cur = list.querySelector('.ss-kb');
  const idx = cur ? vis.indexOf(cur) : -1;
  const next = e.key === 'ArrowDown'
    ? vis[(idx + 1) % vis.length]
    : vis[(idx - 1 + vis.length) % vis.length];
  cur?.classList.remove('ss-kb');
  next.classList.add('ss-kb');
  next.scrollIntoView({ block: 'nearest' });
}


// ─── FILTER COLLAPSE (MOBILE) ─────────────────────────────────────────────────
function initFilterCollapse() {
  if (document.getElementById('filters-toggle')) return;
  const filtersEl = document.querySelector('#panel-search .filters');
  if (!filtersEl) return;

  const toggle = document.createElement('button');
  toggle.className = 'filters-toggle';
  toggle.id = 'filters-toggle';
  filtersEl.insertAdjacentElement('beforebegin', toggle);

  function countActive() {
    let n = 0;
    if (document.getElementById('filter-sender')?.value)                    n++;
    if (document.getElementById('filter-media')?.value)                     n++;
    if (document.getElementById('filter-start')?.value)                     n++;
    if (document.getElementById('filter-end')?.value)                       n++;
    const rxn  = document.getElementById('filter-min-reactions')?.value;
    const sort = document.getElementById('filter-sort')?.value;
    if (rxn  && rxn  !== '0')      n++;
    if (sort && sort !== 'newest') n++;
    return n;
  }

  let isOpen = true;

  function applyState() {
    const n = countActive();
    toggle.textContent = `FILTERS${n > 0 ? ` (${n} ACTIVE)` : ''}`;
    toggle.classList.toggle('open', isOpen);
    filtersEl.style.display = isOpen ? '' : 'none';
  }

  toggle.addEventListener('click', () => {
    isOpen = !isOpen;
    applyState();
  });
  filtersEl.addEventListener('change', applyState);

  applyState(); // start expanded
}


// ─── UTILITIES ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function highlight(html, query) {
  if (!query) return html;
  const terms = query.split(/\s+/).filter(Boolean)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return html;
  return html.replace(new RegExp(`(${terms.join('|')})`, 'ig'), '<em class="hit">$1</em>');
}

function formatTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}