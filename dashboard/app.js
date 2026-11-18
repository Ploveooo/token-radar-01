// Token Radar's dashboard. Reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a filterable table, a per-protocol detail view with the
// model's own inputs and the protocol's farm plan, the separate Live view and the model
// page. No network: every byte it shows is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;

  var $ = function (id) { return document.getElementById(id); };
  var rowsEl = $('rows'), liveEl = $('liveRows'), detailEl = $('detail');
  var state = { q: '', category: 'all', chain: 'all', sort: 'implied', dir: -1, watchOnly: false, earlyOnly: false, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Header, statistics and filter options.
  $('meta').innerHTML = 'Snapshot as of <b>' + esc(DATA.as_of) + '</b> &middot; model <b>' + esc(DATA.model_version) + '</b><br>' +
    'Floor $' + (DATA.floor_usd / 1e6) + 'M TVL &middot; DefiLlama public protocols data';
  var topImplied = DATA.rows.length ? DATA.rows[0].implied_value_usd : 0;
  $('stats').innerHTML = [
    ['Board rows', DATA.board_size, 'protocols ranked'],
    ['Watchlist', DATA.watchlist_size, 'of them on the list'],
    ['Early finds', DATA.early_size, 'below the floor'],
    ['Top implied', fmtUsd(topImplied), 'rank 1 value'],
  ].map(function (s) {
    return '<div class="stat"><div class="k">' + s[0] + '</div><div class="v">' + s[1] + ' <small>' + s[2] + '</small></div></div>';
  }).join('');
  var cats = {}, chains = {};
  DATA.rows.forEach(function (r) {
    if (r.category) cats[r.category] = 1;
    r.chains.forEach(function (c) { chains[c] = 1; });
  });
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; $('category').appendChild(o);
  });
  Object.keys(chains).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; $('chain').appendChild(o);
  });

  // Sorting: implied value, TVL, 7-day change, age; rank and name fall back to the board order.
  var sorters = {
    implied: function (a, b) { return a.implied_value_usd - b.implied_value_usd; },
    tvl: function (a, b) { return a.tvl_usd - b.tvl_usd; },
    growth: function (a, b) { return (a.change_7d === null ? -1e9 : a.change_7d) - (b.change_7d === null ? -1e9 : b.change_7d); },
    age: function (a, b) { return (a.age_days === null ? -1 : a.age_days) - (b.age_days === null ? -1 : b.age_days); },
    rank: function (a, b) { return a.rank - b.rank; },
    name: function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; },
    category: function (a, b) { return (a.category || '') < (b.category || '') ? -1 : 1; },
    chains: function (a, b) { return (a.chains[0] || '') < (b.chains[0] || '') ? -1 : 1; },
  };

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = DATA.rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.earlyOnly && r.watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = sorters[state.sort] || sorters.implied;
    list.sort(function (a, b) { return key(a, b) * state.dir || (a.rank - b.rank); });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    $('count').textContent = list.length + ' of ' + DATA.rows.length + ' protocols shown';
    rowsEl.innerHTML = list.map(function (r) {
      var g = r.change_7d === null ? '<span>n/a</span>' : '<span class="' + (r.change_7d >= 0 ? 'up' : 'down') + '">' + fmtPct(r.change_7d) + '</span>';
      var badge = r.watchlist ? '<span class="badge">WATCHLIST</span>' : '<span class="badge early">EARLY</span>';
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td class="name"><b>' + esc(r.name) + '</b><span>' + esc(r.slug) + '</span>' + badge + '</td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + g + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num"><b>' + fmtUsd(r.implied_value_usd) + '</b></td></tr>';
    }).join('');
  }

  function renderLive() {
    liveEl.innerHTML = DATA.live.map(function (p) {
      var g = p.change_7d === null ? 'n/a' : fmtPct(p.change_7d);
      return '<tr><td class="name"><b>' + esc(p.name) + '</b><span>' + esc(p.slug) + '</span></td>' +
        '<td>' + esc(p.category || '—') + '</td><td>' + esc(p.chains.slice(0, 3).join(', ')) + '</td>' +
        '<td class="num">' + fmtUsd(p.tvl_usd) + '</td><td class="num">' + fmtUsd(p.mcap_usd) + '</td>' +
        '<td class="num">' + g + '</td></tr>';
    }).join('');
  }

  function openDetail(slug) {
    var r = null;
    DATA.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    state.selected = slug;
    var m = DATA.model;
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    detailEl.innerHTML =
      '<button type="button" class="close" id="closeDetail">Close</button>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">Rank ' + r.rank + ' &middot; ' + esc(r.slug) + ' &middot; ' + esc(r.category || 'no category') + ' &middot; ' +
      esc(r.chains.join(', ')) + ' &middot; listed ' + esc(r.listed_at || 'unknown') + ' &middot; ' +
      (r.watchlist ? 'on the watchlist' : 'an early find below the watchlist floor') + '</p>' +
      '<div class="grid">' +
      '<div class="cell"><div class="k">Implied value</div><div class="v">' + fmtUsd(r.implied_value_usd) + '</div></div>' +
      '<div class="cell"><div class="k">TVL</div><div class="v">' + fmtUsd(r.tvl_usd) + '</div></div>' +
      '<div class="cell"><div class="k">7-day change</div><div class="v">' + fmtPct(r.change_7d) + '</div></div>' +
      '<div class="cell"><div class="k">Age</div><div class="v">' + fmtAge(r.age_days) + '</div></div>' +
      '</div>' +
      '<h3>How the value is built</h3>' +
      '<p>Base ' + m.base_coef + ' &times; TVL^' + m.tvl_exponent + ', then &times; growth ' + r.growth_multiplier +
      ' &times; maturity ' + r.maturity_multiplier + ' &times; velocity ' + r.velocity_multiplier +
      ' &times; chains ' + r.chain_multiplier + '. The protocol records no token, so this is the model\u2019s claim, not a market price.</p>' +
      '<h3>Farm plan — seven steps</h3><ol>' + steps + '</ol>';
    detailEl.hidden = false;
    $('closeDetail').addEventListener('click', function () { detailEl.hidden = true; state.selected = null; renderBoard(); });
    detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    renderBoard();
  }

  rowsEl.addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });

  // Controls.
  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  $('category').addEventListener('change', function (e) { state.category = e.target.value; renderBoard(); });
  $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; state.dir = -1; renderBoard(); });
  $('watchOnly').addEventListener('change', function (e) { state.watchOnly = e.target.checked; if (e.target.checked) state.earlyOnly = false, $('earlyOnly').checked = false; renderBoard(); });
  $('earlyOnly').addEventListener('change', function (e) { state.earlyOnly = e.target.checked; if (e.target.checked) state.watchOnly = false, $('watchOnly').checked = false; renderBoard(); });
  document.querySelectorAll('#board th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'name' || key === 'category' ? 1 : -1; }
      $('sort').value = sorters[state.sort] ? (['implied', 'tvl', 'growth', 'age'].indexOf(key) >= 0 ? key : state.sort) : 'implied';
      renderBoard();
    });
  });

  // Tabs.
  document.querySelectorAll('.tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var tab = btn.getAttribute('data-tab');
      $('view-board').hidden = tab !== 'board';
      $('view-live').hidden = tab !== 'live';
      $('view-model').hidden = tab !== 'model';
      if (tab === 'live') renderLive();
    });
  });

  // Model page.
  var m = DATA.model;
  $('formula').textContent =
    'implied = round( ' + m.base_coef + ' * tvl_usd^' + m.tvl_exponent + ' * growth * maturity * velocity * chains )\n\n' +
    'growth   = 1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 * ' + m.growth_weight +
    '  (+' + m.kicker_25 + ' past +25%, another +' + m.kicker_60 + ' past +60%, ' + m.drag_30 + ' below -30%)\n' +
    'maturity = ' + m.maturity_floor + ' + ' + m.maturity_range + ' * (1 - exp(-age_days / ' + m.maturity_scale_days + '))\n' +
    'velocity = 1 + ' + m.velocity_weight + ' * tanh( log10( tvl_usd / max(age_days, ' + m.velocity_floor_days + ') / 1,000,000 ) / 2 )\n' +
    'chains   = 1 + ' + m.chain_step + ' * min(chains - 1, ' + m.chain_max_steps + ')\n\n' +
    'Unknown age counts as ' + m.unknown_age_days + ' days; missing 7-day change counts as 0%.';
  $('modelNotes').innerHTML =
    '<p>Why a power law on TVL: a protocol ten times as big is not worth ten times as much — the exponent ' + m.tvl_exponent +
    ' gives it about five times the base, so growth, age and capital speed can move a row past a bigger neighbour.</p>' +
    '<p>Why velocity: TVL divided by days alive is how fast a protocol formed its capital. A young protocol that gathered $100M in three months reads hotter than an old one that took three years.</p>' +
    '<p>What is left out on purpose: exchanges, bridges and staked or wrapped products are not ranked — they are not airdrop subjects — and a name ending in a version marker is a pool of another protocol. Protocols whose token already trades sit in the Live view at their market cap, never in the ranked board.</p>';

  $('source').textContent = 'Data: DefiLlama public protocols endpoint, snapshot as of ' + DATA.as_of + '. ' +
    DATA.rows.length + ' protocols ranked; ' + DATA.live.length + ' live-token protocols shown separately.';

  renderBoard();
})();
