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


// ─── INIT: load stats + populate dropdowns ────────────────────────────────────
async function init() {
  try {
    // count: 'exact' + head: true runs a COUNT(*) in Postgres without
    // returning any rows — very fast, no row-limit issues.
    const { count: msgCount, error: mErr } = await sb
      .from('messages')
      .select('*', { count: 'exact', head: true });
    if (mErr) throw mErr;
    document.getElementById('stat-messages').textContent = msgCount.toLocaleString();

    // get_distinct_senders() is a SQL function we created that runs
    // SELECT DISTINCT sender inside Postgres. This avoids the 1,000-row
    // default cap that was causing us to only see 11 senders.
    const { data: senders, error: sErr } = await sb.rpc('get_distinct_senders');
    if (sErr) throw sErr;

    document.getElementById('stat-members').textContent = senders.length.toLocaleString();

    populateSenderDropdown('filter-sender', senders, true);
    populateSenderDropdown('inter-a',       senders, false);
    populateSenderDropdown('inter-b',       senders, false);

    document.getElementById('db-status').textContent = 'db: connected';
  } catch (err) {
    console.error(err);
    document.getElementById('db-status').textContent = 'db: ERROR';
    alert('Could not reach Supabase. Check the browser console for details.');
  }
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
}

init();


// ─── SEARCH TAB ───────────────────────────────────────────────────────────────
const searchBtn   = document.getElementById('search-btn');
const searchInput = document.getElementById('search-query');

searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') startSearch(); });
searchBtn.addEventListener('click', startSearch);

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

  // Step 1: get the total count so we know how many pages to show.
  await fetchTotalCount();

  // Step 2: fetch and render page 1.
  await fetchPage(1);
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
// saved searchState. Called by startSearch() and the pagination buttons.
async function fetchPage(pageNum) {
  const meta    = document.getElementById('result-meta');
  const results = document.getElementById('results');

  searchState.currentPage = pageNum;

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
    return;
  }

  // Post-filter for text-only if needed.
  const filtered = (searchState.mediaRaw === 'none')
    ? data.filter(r => r.media_type === null)
    : data;

  const totalPages = Math.ceil(searchState.totalCount / PAGE_SIZE);

  meta.textContent =
    `Page ${pageNum} of ${totalPages} · ${searchState.totalCount.toLocaleString()} total results`;

  results.innerHTML = filtered.map(r => renderMessage(r, searchState.query)).join('');

  // Render page nav buttons.
  renderPagination();

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

// Renders a single message row.
function renderMessage(msg, query) {
  const content = highlight(escapeHtml(msg.content || ''), query);
  const badges  = [];
  if (msg.media_type)         badges.push(`<span class="badge media">${msg.media_type}</span>`);
  if (msg.reaction_count > 0) badges.push(`<span class="badge rxn">${msg.reaction_count} ❤</span>`);

  return `
    <div class="msg">
      <div class="meta">
        <span class="sender">${escapeHtml(msg.sender)}</span>
        <span class="ts">${formatTs(msg.ts)}</span>
      </div>
      <div class="content">${content || '<em style="color:var(--text-dim)">[no text — media only]</em>'}</div>
      <div class="badges">${badges.join('')}</div>
    </div>
  `;
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