/* ============================================================================
   app.js — GC Dossier frontend logic

   What this file does:
     - Connects to Supabase using the PUBLIC anon key (safe to expose).
     - Wires up three tabs: Search, Interactions, Timeline.
     - Calls the RPC functions we defined in schema.sql:
         * search_messages     → keyword + filter search
         * find_interactions   → temporal-adjacency "reply" detection
         * activity_around     → who was active around a given moment
     - Renders results into the page.

   IMPORTANT — the two config values below:
     SUPABASE_URL and SUPABASE_ANON_KEY are the PUBLIC credentials. The anon
     key is DESIGNED to be shipped to browsers. Row Level Security (set up
     in schema.sql) is what actually prevents misuse — the anon key can
     only do what the RLS policies allow, which is read-only SELECT.
     Never put your service_role key in this file.
   ============================================================================ */

// ----- CONFIG (replace these with your values) -----
const SUPABASE_URL      = 'https://mhjmjrkhxfoeeumhedsh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_VfzrVVtR-AWb2xIEE11rhw_9Gy24Yb8';

// Initialize the Supabase client. The SDK is loaded from the CDN in index.html
// and exposes a global `supabase` object with a createClient() factory.
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


// ----------------------------------------------------------------------------
// Tab switching
// ----------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    // Update the tab buttons themselves
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Show the right panel, hide the others
    const target = btn.dataset.tab;
    document.querySelectorAll('.panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== `panel-${target}`);
    });
  });
});


// ----------------------------------------------------------------------------
// On page load: fetch stats and populate the sender dropdowns.
// ----------------------------------------------------------------------------
async function init() {
  try {
    // Total message count. `count: 'exact'` + `head: true` runs a COUNT
    // query without returning any rows — fast and cheap.
    const { count: msgCount, error: mErr } = await sb
      .from('messages')
      .select('*', { count: 'exact', head: true });
    if (mErr) throw mErr;
    document.getElementById('stat-messages').textContent = msgCount.toLocaleString();

    // Distinct senders. We do this via a small RPC would be fastest, but for
    // now we pull a single column and dedupe in JS — fine for a few thousand
    // rows at most. If this gets slow, we'll move it into a SQL function.
    const { data: senderRows, error: sErr } = await sb
      .from('messages')
      .select('sender')
      .limit(50000);   // more than enough unique senders for any group chat
    if (sErr) throw sErr;

    const senders = [...new Set(senderRows.map(r => r.sender))].sort();
    document.getElementById('stat-members').textContent = senders.length.toLocaleString();

    // Populate every sender dropdown on the page
    populateSenderDropdown('filter-sender', senders, /*includeAny*/ true);
    populateSenderDropdown('inter-a',       senders, /*includeAny*/ false);
    populateSenderDropdown('inter-b',       senders, /*includeAny*/ false);

    document.getElementById('db-status').textContent = 'db: connected';
  } catch (err) {
    console.error(err);
    document.getElementById('db-status').textContent = 'db: ERROR';
    alert('Could not reach Supabase. Check SUPABASE_URL and SUPABASE_ANON_KEY in app.js.');
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
  for (const name of senders) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
}

init();


// ----------------------------------------------------------------------------
// SEARCH TAB
// ----------------------------------------------------------------------------
const searchBtn   = document.getElementById('search-btn');
const searchInput = document.getElementById('search-query');

// Let Enter trigger search — little UX touch that matters a lot.
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
searchBtn.addEventListener('click', runSearch);

async function runSearch() {
  const query      = searchInput.value.trim();
  const sender     = document.getElementById('filter-sender').value || null;
  const mediaRaw   = document.getElementById('filter-media').value;
  const startDate  = document.getElementById('filter-start').value;
  const endDate    = document.getElementById('filter-end').value;
  const minRxns    = parseInt(document.getElementById('filter-min-reactions').value, 10) || 0;

  // Media filter encoding: UI has a "none" option which should map to
  // "media_type IS NULL". Supabase RPC can't express that through a simple
  // param, so we treat "none" specially below in post-filtering.
  const filterMedia = (mediaRaw && mediaRaw !== 'none') ? mediaRaw : null;

  const meta = document.getElementById('result-meta');
  const results = document.getElementById('results');
  meta.textContent = 'Searching…';
  results.innerHTML = '';

  // Call the search_messages SQL function we defined in schema.sql.
  const { data, error } = await sb.rpc('search_messages', {
    query_text:    query || null,
    filter_sender: sender,
    filter_media:  filterMedia,
    start_date:    startDate ? new Date(startDate).toISOString() : null,
    end_date:      endDate   ? new Date(endDate + 'T23:59:59').toISOString() : null,
    min_reactions: minRxns,
    result_limit:  200,
    result_offset: 0,
  });

  if (error) {
    console.error(error);
    meta.textContent = 'Error: ' + error.message;
    return;
  }

  // Apply the "text only" filter client-side since the RPC doesn't handle IS NULL.
  const filtered = (mediaRaw === 'none')
    ? data.filter(r => r.media_type === null)
    : data;

  meta.textContent = `${filtered.length} result${filtered.length === 1 ? '' : 's'}` +
                     (filtered.length === 200 ? ' (showing first 200)' : '');

  results.innerHTML = filtered.map(r => renderMessage(r, query)).join('');
}

// Build one message row. Highlights query terms in the content.
function renderMessage(msg, query) {
  const content = highlight(escapeHtml(msg.content || ''), query);
  const badges = [];
  if (msg.media_type) badges.push(`<span class="badge media">${msg.media_type}</span>`);
  if (msg.reaction_count > 0) badges.push(`<span class="badge rxn">${msg.reaction_count} ❤</span>`);

  return `
    <div class="msg">
      <div class="meta">
        <span class="sender">${escapeHtml(msg.sender)}</span>
        <span class="ts">${formatTs(msg.ts)}</span>
      </div>
      <div class="content">${content || '<em style="color:#8a8174">[no text — media only]</em>'}</div>
      <div class="badges">${badges.join('')}</div>
    </div>
  `;
}


// ----------------------------------------------------------------------------
// INTERACTIONS TAB
// ----------------------------------------------------------------------------
document.getElementById('inter-btn').addEventListener('click', async () => {
  const userA  = document.getElementById('inter-a').value;
  const userB  = document.getElementById('inter-b').value;
  const window = parseInt(document.getElementById('inter-window').value, 10) || 60;
  const meta    = document.getElementById('inter-meta');
  const results = document.getElementById('inter-results');

  if (!userA || !userB || userA === userB) {
    meta.textContent = 'Pick two different users.';
    return;
  }

  meta.textContent = 'Scanning…';
  results.innerHTML = '';

  const { data, error } = await sb.rpc('find_interactions', {
    user_a: userA,
    user_b: userB,
    window_seconds: window,
    result_limit: 200,
  });

  if (error) { meta.textContent = 'Error: ' + error.message; return; }

  meta.textContent = `${data.length} interaction${data.length === 1 ? '' : 's'} found` +
                     ` (${userA} followed by ${userB} within ${window}s)`;

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


// ----------------------------------------------------------------------------
// TIMELINE TAB
// ----------------------------------------------------------------------------
document.getElementById('tl-btn').addEventListener('click', async () => {
  const centerRaw  = document.getElementById('tl-center').value;
  const windowHrs  = parseInt(document.getElementById('tl-window').value, 10) || 24;
  const meta       = document.getElementById('tl-meta');
  const results    = document.getElementById('tl-results');

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


// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

// Prevent XSS when we inject user content into innerHTML.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Wrap query terms in <em class="hit"> for the yellow highlight.
// Case-insensitive, escapes regex special chars.
function highlight(html, query) {
  if (!query) return html;
  const terms = query.split(/\s+/).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (terms.length === 0) return html;
  const re = new RegExp(`(${terms.join('|')})`, 'ig');
  return html.replace(re, '<em class="hit">$1</em>');
}

// "2024-03-15T14:32:07+00:00" → "Mar 15 2024 · 10:32 AM"
function formatTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}