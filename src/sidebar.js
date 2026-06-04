// ── Module state ──────────────────────────────────────────────────────────────
let _state              = null;
let _onSelectionChange  = null;
let _onAreaFly          = null;
let _infoOnlyPlaces     = [];  // GeoJSON features for info-only custom places

export function setInfoOnlyPlaces(features) {
  _infoOnlyPlaces = features ?? [];
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initSidebar({ cityNames, countyNames, houseNames, senateNames, cityMeta, houseMeta, senateMeta, state, onSelectionChange, onAreaFly }) {
  _state             = state;
  _onSelectionChange = onSelectionChange;
  _onAreaFly         = onAreaFly;

  const panel = document.getElementById('left-panel');
  if (!panel) return;

  panel.innerHTML = `
    <!-- AREA TYPE -->
    <div class="rail-section tight">
      <div class="eyebrow">Subject Area Type</div>
      <div class="type-strip" id="areatype-toggle" role="group" aria-label="Subject area type">
        <button data-value="city"   class="${state.selectedAreaType === 'city'   ? 'active' : ''}">City</button>
        <button data-value="county" class="${state.selectedAreaType === 'county' ? 'active' : ''}">County</button>
        <button data-value="house"  class="${state.selectedAreaType === 'house'  ? 'active' : ''}">Utah House</button>
        <button data-value="senate" class="${state.selectedAreaType === 'senate' ? 'active' : ''}">Utah Senate</button>
      </div>
    </div>

    <!-- SUBJECT -->
    <div class="rail-section tight">
      <div class="eyebrow">Subject Area</div>
      <div class="search-wrap">
        <input
          id="area-search"
          class="search-input"
          type="text"
          placeholder="${_searchPlaceholder(state.selectedAreaType)}"
          autocomplete="off"
          spellcheck="false"
          aria-label="Select area"
          aria-autocomplete="list"
          aria-controls="area-dropdown"
          aria-expanded="false"
          value="${_escHtml(state.selectedArea)}"
        />
        <ul id="area-dropdown" class="search-dropdown" role="listbox" aria-label="Areas" hidden></ul>
      </div>
      <div class="search-context">
        <span class="pip"></span>
        <span id="search-context-text">${_aggregationLabel(state.aggregation)} view &middot; ${state.year}</span>
      </div>
    </div>

    <!-- DIRECTION -->
    <div class="rail-section tight">
      <div class="eyebrow">Direction <span class="eyebrow-suffix">&middot; where</span></div>
      <div class="seg tall" id="direction-toggle" role="group" aria-label="Flow direction">
        <button data-value="outflow" class="${state.direction === 'outflow' ? 'active' : ''}">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 640 640" fill="currentColor" aria-hidden="true"><path d="M264 112L376 112C380.4 112 384 115.6 384 120L384 160L256 160L256 120C256 115.6 259.6 112 264 112zM208 120L208 160L128 160C92.7 160 64 188.7 64 224L64 320L576 320L576 224C576 188.7 547.3 160 512 160L432 160L432 120C432 89.1 406.9 64 376 64L264 64C233.1 64 208 89.1 208 120zM576 368L384 368L384 384C384 401.7 369.7 416 352 416L288 416C270.3 416 256 401.7 256 384L256 368L64 368L64 480C64 515.3 92.7 544 128 544L512 544C547.3 544 576 515.3 576 480L576 368z"/></svg>
          <span class="seg-text">
            <span class="seg-line">Residents</span>
            <span class="seg-line">WORK</span>
          </span>
        </button>
        <button data-value="inflow" class="${state.direction === 'inflow' ? 'active' : ''}">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 640 640" fill="currentColor" aria-hidden="true"><path d="M341.8 72.6C329.5 61.2 310.5 61.2 298.3 72.6L74.3 280.6C64.7 289.6 61.5 303.5 66.3 315.7C71.1 327.9 82.8 336 96 336L112 336L112 512C112 547.3 140.7 576 176 576L464 576C499.3 576 528 547.3 528 512L528 336L544 336C557.2 336 569 327.9 573.8 315.7C578.6 303.5 575.4 289.5 565.8 280.6L341.8 72.6zM304 384L336 384C362.5 384 384 405.5 384 432L384 528L256 528L256 432C256 405.5 277.5 384 304 384z"/></svg>
          <span class="seg-text">
            <span class="seg-line">Workers</span>
            <span class="seg-line">LIVE</span>
          </span>
        </button>
      </div>
    </div>

    <!-- AGGREGATION -->
    <div class="rail-section tight">
      <div class="eyebrow">Map Zones</div>
      <div class="type-strip" id="aggregation-toggle" role="group" aria-label="Aggregation level">
        <button data-value="city"   class="${state.aggregation === 'city'   ? 'active' : ''}">City</button>
        <button data-value="county" class="${state.aggregation === 'county' ? 'active' : ''}">County</button>
        <!-- TO RE-ENABLE district map zones: uncomment the two lines below -->
        <!-- <button data-value="house"  class="${state.aggregation === 'house'  ? 'active' : ''}">Utah House</button> -->
        <!-- <button data-value="senate" class="${state.aggregation === 'senate' ? 'active' : ''}">Utah Senate</button> -->
      </div>
    </div>

    <div class="rail-rule"></div>

    <!-- AGGREGATE FLOWS -->
    <div class="rail-section" id="flow-section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
        <div class="eyebrow">Commute Balance</div>
        <div style="display:flex;gap:5px;">
          <button class="chart-tool" id="export-sankey-png">PNG</button>
          <button class="chart-tool" id="export-sankey-csv">CSV</button>
        </div>
      </div>
      <div class="mini-toggle" id="flow-tab-toggle">
        <button class="mini-toggle-btn active" data-tab="overview">Overview</button>
        <button class="mini-toggle-btn" data-tab="venn">Venn</button>
      </div>
      <div id="flow-overview-panel">
        <div id="flow-wheel"></div>
      </div>
      <div id="flow-venn-panel" style="display:none;">
        <div class="flow-summary" id="flow-summary"></div>
      </div>
      <div class="cp-info-note" style="margin-top:10px;margin-bottom:0;">
        <strong>Note:</strong> Totals include cross-state commuters from neighboring states. Flows to/from distant states may appear under <em>Out of State</em> in the data but are not shown as individual arcs.
      </div>
    </div>

    <div class="rail-rule"></div>

    <!-- ATTRIBUTION -->
    <div class="sidebar-attribution">
      <div class="attribution-links">
        <button id="about-open-btn" class="credits-link-btn">About the Map</button>
        <button id="credits-open-btn" class="credits-link-btn">Data &amp; Credits</button>
      </div>
    </div>
  `;

  // Reflect direction on body so map toolbar + slider can pick up the accent color
  document.body.dataset.direction = _state.direction;

  // Wire area type toggle
  document.getElementById('areatype-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    const newType = btn.dataset.value;
    if (newType === _state.selectedAreaType) return;

    _state.selectedAreaType = newType;
    _setActiveToggle('areatype-toggle', newType);

    const input = document.getElementById('area-search');
    if (input) input.placeholder = _searchPlaceholder(newType);

    // Reset selected area if it doesn't exist in the new type's list
    const names = { cityNames, countyNames, houseNames, senateNames };
    const currentAreas = _getAreaList(newType, names, cityMeta);
    const existing = currentAreas.find(a => a.label === _state.selectedArea);
    if (!existing && currentAreas.length) {
      _state.selectedArea = currentAreas[0].label;
      if (input) input.value = currentAreas[0].label;
    }

    _onSelectionChange();
  });

  // Wire direction toggle
  document.getElementById('direction-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    _state.direction = btn.dataset.value;
    document.body.dataset.direction = btn.dataset.value;
    _setActiveToggle('direction-toggle', btn.dataset.value);
    _onSelectionChange();
  });

  // Wire aggregation toggle
  document.getElementById('aggregation-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    _state.aggregation = btn.dataset.value;
    _setActiveToggle('aggregation-toggle', btn.dataset.value);
    _updateSearchContext();
    _onSelectionChange();
  });

  // Wire search dropdown
  _initDropdown({ cityNames, countyNames, houseNames, senateNames }, cityMeta);

  // Modals
  _initAboutModal();
  _initCreditsModal();
}

export function syncAreaTypeToggle(type) {
  _setActiveToggle('areatype-toggle', type);
  const input = document.getElementById('area-search');
  if (input) input.placeholder = _searchPlaceholder(type);
}

export function updateSidebarStats(flows, appState) {
  const state = appState;

  _updateSearchContext();
  _updateInfoNote(state);

  if (!flows.length) {
    _clearDemoRows();
    const reachEl = document.getElementById('reach-avg-val');
    if (reachEl) reachEl.textContent = '—';
    const reachMeta = document.getElementById('reach-meta');
    if (reachMeta) reachMeta.textContent = 'No flow data for this area.';
    return;
  }

  // ── Breakdown totals ───────────────────────────────────────────────────────
  const bd = flows.reduce((acc, f) => ({
    SA01: acc.SA01 + Number(f.SA01 || 0),
    SA02: acc.SA02 + Number(f.SA02 || 0),
    SA03: acc.SA03 + Number(f.SA03 || 0),
    SE01: acc.SE01 + Number(f.SE01 || 0),
    SE02: acc.SE02 + Number(f.SE02 || 0),
    SE03: acc.SE03 + Number(f.SE03 || 0),
    SI01: acc.SI01 + Number(f.SI01 || 0),
    SI02: acc.SI02 + Number(f.SI02 || 0),
    SI03: acc.SI03 + Number(f.SI03 || 0),
  }), { SA01: 0, SA02: 0, SA03: 0, SE01: 0, SE02: 0, SE03: 0, SI01: 0, SI02: 0, SI03: 0 });

  const ageSum      = bd.SA01 + bd.SA02 + bd.SA03 || 1;
  const earningsSum = bd.SE01 + bd.SE02 + bd.SE03 || 1;
  const industrySum = bd.SI01 + bd.SI02 + bd.SI03 || 1;
  const dirClass    = state.direction === 'inflow' ? 'inflow' : '';

  // ── Age rows ───────────────────────────────────────────────────────────────
  const ageEl = document.getElementById('demo-rows-age');
  if (ageEl) {
    ageEl.innerHTML = _bdRow('Under 30', bd.SA01, ageSum, dirClass)
      + _bdRow('30 – 54', bd.SA02, ageSum, dirClass)
      + _bdRow('55 +', bd.SA03, ageSum, dirClass);
  }

  // ── Earnings rows ──────────────────────────────────────────────────────────
  const earningsEl = document.getElementById('demo-rows-earnings');
  if (earningsEl) {
    earningsEl.innerHTML = _bdRow('&le;$1,250/mo', bd.SE01, earningsSum, dirClass)
      + _bdRow('$1,251–3,333', bd.SE02, earningsSum, dirClass)
      + _bdRow('&gt;$3,333/mo', bd.SE03, earningsSum, dirClass);
  }

  // ── Industry rows ──────────────────────────────────────────────────────────
  const industryEl = document.getElementById('demo-rows-industry');
  if (industryEl) {
    industryEl.innerHTML = _bdRow('Goods', bd.SI01, industrySum, dirClass)
      + _bdRow('Trade', bd.SI02, industrySum, dirClass)
      + _bdRow('Services', bd.SI03, industrySum, dirClass);
  }

  // ── Reach — block-level weighted mean and band-interpolated median ───────────
  // dist_wsum = Σ(S000 × block_haversine_miles) per destination zone pair
  // dist_n    = Σ(S000) for block pairs with valid coordinates
  // Summing across all destination zones gives the true weighted mean for the subject area.
  const totalWsum = flows.reduce((s, f) => s + Number(f.dist_wsum || 0), 0);
  const totalN    = flows.reduce((s, f) => s + Number(f.dist_n    || 0), 0);
  const avgMiles  = totalN > 0 ? totalWsum / totalN : null;

  // Median: interpolate within the band that straddles the 50th percentile.
  const bn0   = flows.reduce((s, f) => s + Number(f.d0_5    || 0), 0);
  const bn5   = flows.reduce((s, f) => s + Number(f.d5_10   || 0), 0);
  const bn10  = flows.reduce((s, f) => s + Number(f.d10_25  || 0), 0);
  const bn25  = flows.reduce((s, f) => s + Number(f.d25_50  || 0), 0);
  const bn50  = flows.reduce((s, f) => s + Number(f.d50_100 || 0), 0);
  const bn100 = flows.reduce((s, f) => s + Number(f.d100p   || 0), 0);
  const medianMiles = _bandMedian(bn0, bn5, bn10, bn25, bn50, bn100);

  const avgEl    = document.getElementById('reach-avg');
  const medianEl = document.getElementById('reach-median');
  if (avgEl)    avgEl.innerHTML    = avgMiles    != null ? `${avgMiles.toFixed(1)}<span class="unit">mi</span>`    : '&mdash;<span class="unit">mi</span>';
  if (medianEl) medianEl.innerHTML = medianMiles != null ? `${medianMiles.toFixed(1)}<span class="unit">mi</span>` : '&mdash;<span class="unit">mi</span>';
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _bdRow(label, count, sum, dirClass) {
  const pct = sum > 0 ? Math.round((count / sum) * 100) : 0;
  return `
    <div class="bd-row${dirClass ? ' ' + dirClass : ''}">
      <span class="bd-label">${label}</span>
      <div class="bd-bar"><span style="width:${pct}%"></span></div>
      <div>
        <div class="bd-count">${Number(count).toLocaleString()}</div>
        <div class="bd-pct">${pct}%</div>
      </div>
    </div>
  `;
}

function _updateInfoNote(state) {
  const existing = document.getElementById('cp-info-note');
  const match = state.selectedAreaType === 'county'
    ? _infoOnlyPlaces.find(f => f.properties?.county === state.selectedArea && f.properties?.enable === false)
    : null;

  if (!match) { existing?.remove(); return; }
  if (existing) return;

  const p = match.properties;
  const note = document.createElement('div');
  note.id        = 'cp-info-note';
  note.className = 'cp-info-note';
  note.innerHTML =
    `<strong>${p.name}</strong>${p.employees_approx ? ` &mdash; ${p.employees_approx} employees` : ''} ` +
    `is this county's largest employer but falls outside LEHD coverage &mdash; ` +
    `federal and military positions are not UI-insured. ` +
    `Commute flows to/from this site are not reflected in these figures.`;

  document.getElementById('flow-section')?.before(note);
}

function _clearDemoRows() {
  ['demo-rows-age', 'demo-rows-earnings', 'demo-rows-industry'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
}

function _bandMedian(n0_5, n5_10, n10_25, n25_50, n50_100, n100p) {
  const total = n0_5 + n5_10 + n10_25 + n25_50 + n50_100 + n100p;
  if (total === 0) return null;
  const half = total / 2;
  let cum = 0;
  for (const [lo, hi, n] of [
    [0, 5, n0_5], [5, 10, n5_10], [10, 25, n10_25],
    [25, 50, n25_50], [50, 100, n50_100], [100, 150, n100p],
  ]) {
    if (n > 0 && cum + n >= half) return lo + ((half - cum) / n) * (hi - lo);
    cum += n;
  }
  return null;
}

function _aggregationLabel(agg) {
  const labels = { city: 'City', county: 'County', house: 'Utah House District', senate: 'Utah Senate District' };
  return labels[agg] ?? 'City';
}

function _searchPlaceholder(type) {
  const ph = {
    city:   'Search cities…',
    county: 'Search counties…',
    house:  'Search house districts…',
    senate: 'Search senate districts…',
  };
  return ph[type] ?? ph.city;
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _updateSearchContext() {
  const el = document.getElementById('search-context-text');
  if (el && _state) {
    el.textContent = `${_aggregationLabel(_state.aggregation)} view · ${_state.year}`;
  }
}

/**
 * Return the item list for a given area type.
 */
function _getAreaList(type, names, cityMeta) {
  if (type === 'county') return names.countyNames.map(n => ({ label: n, type: 'county' }));
  if (type === 'house')  return names.houseNames.map(n => ({ label: n, type: 'house' }));
  if (type === 'senate') return names.senateNames.map(n => ({ label: n, type: 'senate' }));
  return names.cityNames.map(n => ({ label: n, type: cityMeta?.[n]?.place_type ?? 'city' }));
}

/**
 * Set active state on a toggle group. Supports both:
 *   - .seg button[data-value]  (new segmented controls)
 *   - .toggle-btn[data-value]  (backward-compat class)
 */
function _setActiveToggle(groupId, value) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('[data-value]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function _initDropdown(names, cityMeta) {
  const input    = document.getElementById('area-search');
  const dropdown = document.getElementById('area-dropdown');
  if (!input || !dropdown) return;

  let activeIdx = -1;

  function getCurrentAreas() {
    return _getAreaList(_state.selectedAreaType, names, cityMeta);
  }

  function show(items) {
    if (!items.length) { hide(); return; }
    dropdown.innerHTML = items.map((a, i) => `
      <li role="option" data-value="${_escHtml(a.label)}" data-type="${a.type}"
          aria-selected="false" id="drop-item-${i}">
        <span>${_escHtml(a.label)}</span>
        <span class="row-type">${a.type}</span>
      </li>
    `).join('');
    dropdown.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    activeIdx = -1;
  }

  function hide() {
    dropdown.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIdx = -1;
  }

  function selectItem(label, type) {
    const effectiveType = type === 'cdp' ? 'city' : type;
    _state.selectedArea     = label;
    _state.selectedAreaType = effectiveType;
    input.value = label;

    // Sync area type toggle
    _setActiveToggle('areatype-toggle', effectiveType);

    // TO RE-ENABLE district map zones: replace the current if-block with the commented one
    const _ZONE_TYPES = ['city', 'county'];
    if (_ZONE_TYPES.includes(effectiveType) && effectiveType !== _state.aggregation) {
      _state.aggregation = effectiveType;
      _setActiveToggle('aggregation-toggle', effectiveType);
      _updateSearchContext();
    }
    // if (effectiveType !== _state.aggregation) {  // ← restore this block instead
    //   _state.aggregation = effectiveType;
    //   _setActiveToggle('aggregation-toggle', effectiveType);
    //   _updateSearchContext();
    // }
    hide();
    _onAreaFly?.(label, effectiveType);
    _onSelectionChange();
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const areas = getCurrentAreas();
    show(q ? areas.filter(a => a.label.toLowerCase().includes(q)) : areas);
  });

  input.addEventListener('focus', () => {
    const q = input.value.trim().toLowerCase();
    const areas = getCurrentAreas();
    show(q ? areas.filter(a => a.label.toLowerCase().includes(q)) : areas);
  });

  input.addEventListener('keydown', e => {
    const items = dropdown.querySelectorAll('li');
    if (dropdown.hidden || !items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const q = input.value.trim().toLowerCase();
        const areas = getCurrentAreas();
        show(q ? areas.filter(a => a.label.toLowerCase().includes(q)) : areas);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      _highlightItem(items, activeIdx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      _highlightItem(items, activeIdx);
    } else if (e.key === 'Enter') {
      if (activeIdx >= 0 && items[activeIdx]) {
        e.preventDefault();
        const el = items[activeIdx];
        selectItem(el.dataset.value, el.dataset.type);
      }
    } else if (e.key === 'Escape') {
      hide();
      input.blur();
    }
  });

  dropdown.addEventListener('click', e => {
    const item = e.target.closest('li');
    if (item) selectItem(item.dataset.value, item.dataset.type);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) hide();
  });
}

function _highlightItem(items, idx) {
  items.forEach((el, i) => {
    el.classList.toggle('hl', i === idx);
    el.setAttribute('aria-selected', i === idx ? 'true' : 'false');
  });
  items[idx]?.scrollIntoView({ block: 'nearest' });
}


function _initAboutModal() {
  const existing = document.getElementById('about-backdrop');
  if (existing) {
    document.getElementById('about-open-btn')
      ?.addEventListener('click', () => {
        existing.classList.add('is-open');
        document.getElementById('about-close-btn')?.focus();
      });
    return;
  }

  const backdrop = document.createElement('div');
  backdrop.id = 'about-backdrop';
  backdrop.className = 'credits-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'about-modal-title');

  backdrop.innerHTML = `
    <div class="credits-modal about-modal">
      <button class="credits-close" id="about-close-btn" aria-label="Close">&times;</button>
      <h2 class="credits-title" id="about-modal-title">About the Map</h2>

      <div class="credits-section">
        <p class="about-body">Utah's continued investment in roads, transit, and other transportation improvements has helped create one of the strongest transportation networks in the nation. This map explores how those investments connect workers to jobs across the state and beyond.</p>
        <p class="about-body">As the cost of building new roads and expanding transit rises, communities are looking for solutions that reduce the need for long commutes — such as creating a better balance between housing and jobs. When people live closer to where they work, they gain time back and our transportation system operates more efficiently for everyone.</p>
      </div>

      <div class="credits-section">
        <div class="credits-section-label">What this map shows</div>
        <p class="about-body">Commute flows between Utah cities, counties, and neighboring-state areas using anonymized employment data from the US Census Bureau. Flows represent workers' <strong>reported home and work locations</strong> — not daily travel routes. A flow from Provo to Salt Lake City means a worker reports living in Provo and working in Salt Lake City, not that they make that specific trip every workday.</p>
      </div>

      <div class="credits-section">
        <div class="credits-section-label">Neighboring states</div>
        <p class="about-body">Cities and counties in the six surrounding states (ID, WY, CO, NM, AZ, NV) are included by buffering Utah's boundary by approximately 80 km (50 mi) and intersecting with all counties in those states. Areas within this zone — including the Las Vegas (Clark County) metro area — appear as point markers on the map. They show cross-border inflow and outflow flows but are not selectable as a subject area.</p>
      </div>

      <div class="credits-section">
        <div class="credits-section-label">Data limitations</div>
        <ul class="credits-list">
          <li><strong>Unincorporated areas</strong> within each county are grouped under a single label (e.g. "Salt Lake County Unincorporated") and are not available as individual selectable zones.</li>
          <li><strong>Hill Air Force Base</strong> and similar federal sites are underrepresented. Federal and military positions are not covered by Unemployment Insurance wage records, so commute flows to and from these sites are not fully reflected in this data.</li>
        </ul>
      </div>

      <div class="credits-rule"></div>
      <p class="about-body" style="margin:0;">To learn about the datasets powering this map, see the <button class="credits-inline-link" id="about-to-credits-btn">Data &amp; Credits</button> section.</p>
    </div>
  `;

  document.body.appendChild(backdrop);

  function open() {
    backdrop.classList.add('is-open');
    document.getElementById('about-close-btn').focus();
  }

  function close() {
    backdrop.classList.remove('is-open');
    document.getElementById('about-open-btn')?.focus();
  }

  document.getElementById('about-open-btn').addEventListener('click', open);
  document.getElementById('about-close-btn').addEventListener('click', close);

  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) close();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && backdrop.classList.contains('is-open')) close();
  });

  // "Data & Credits" inline link inside the About modal
  backdrop.addEventListener('click', e => {
    if (e.target.id === 'about-to-credits-btn') {
      close();
      setTimeout(() => document.getElementById('credits-open-btn')?.click(), 150);
    }
  });
}

function _initCreditsModal() {
  const existing = document.getElementById('credits-backdrop');
  if (existing) {
    // Sidebar was re-rendered (year change) — the open button is a new element;
    // re-attach its listener to the already-existing backdrop.
    document.getElementById('credits-open-btn')
      ?.addEventListener('click', () => {
        existing.classList.add('is-open');
        document.getElementById('credits-close-btn')?.focus();
      });
    return;
  }

  const backdrop = document.createElement('div');
  backdrop.id = 'credits-backdrop';
  backdrop.className = 'credits-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'credits-modal-title');

  backdrop.innerHTML = `
    <div class="credits-modal">
      <button class="credits-close" id="credits-close-btn" aria-label="Close credits">&times;</button>
      <h2 class="credits-title" id="credits-modal-title">Credits &amp; Attribution</h2>

      <div class="credits-section">
        <div class="credits-section-label">Data Sources</div>
        <ul class="credits-list">
          <li>
            <a href="https://lehd.ces.census.gov/data/lodes/" target="_blank" rel="noopener">US Census LEHD LODES 8</a>
            &mdash; Origin-destination employment data for Utah (2002&ndash;2023)
          </li>
          <li>
            <a href="https://www.census.gov/programs-surveys/acs/data.html" target="_blank" rel="noopener">US Census American Community Survey (ACS) 5-Year Estimates</a>
            &mdash; Means of transportation and travel time to work, by place and county (2009&ndash;2023)
          </li>
          <li>
            <a href="https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html" target="_blank" rel="noopener">US Census TIGER/Line 2024</a>
            &mdash; Place, county, and legislative district boundary shapefiles
          </li>
        </ul>
      </div>

      <div class="credits-section">
        <div class="credits-section-label">Map Tiles</div>
        <ul class="credits-list">
          <li>
            <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>
            &mdash; Positron (light) &amp; Dark Matter basemap tiles
          </li>
          <li>
            &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors
          </li>
        </ul>
      </div>

      <div class="credits-section">
        <div class="credits-section-label">Open Source Libraries</div>
        <ul class="credits-list">
          <li>
            <a href="https://maplibre.org/" target="_blank" rel="noopener">MapLibre GL JS</a>
            &mdash; WebGL map rendering (BSD 3-Clause)
          </li>
          <li>
            <a href="https://deck.gl/" target="_blank" rel="noopener">deck.gl</a>
            &mdash; WebGL flow arc visualization (MIT)
          </li>
          <li>
            <a href="https://duckdb.org/" target="_blank" rel="noopener">DuckDB-Wasm</a>
            &mdash; In-browser SQL analytics on Parquet (MIT)
          </li>
          <li>
            <a href="https://echarts.apache.org/" target="_blank" rel="noopener">Apache ECharts</a>
            &mdash; Data visualization (Apache 2.0)
          </li>
          <li>
            <a href="https://github.com/visgl/flowmap.gl" target="_blank" rel="noopener">flowmap.gl</a>
            &mdash; Flow map layer (Apache 2.0)
          </li>
          <li>
            <a href="https://vitejs.dev/" target="_blank" rel="noopener">Vite</a>
            &mdash; Build tooling (MIT)
          </li>
        </ul>
      </div>

      <div class="credits-rule"></div>

      <div class="credits-footer">
        <span>Built by <a href="https://wfrc.utah.gov/" target="_blank" rel="noopener">Wasatch Front Regional Council</a></span>
        <a class="credits-github" href="https://github.com/ar-puuk/APP-WFRC-Commute-Patterns" target="_blank" rel="noopener" aria-label="View source on GitHub">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.184 6.839 9.504.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.026 2.747-1.026.546 1.378.202 2.397.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.021C22 6.484 17.522 2 12 2z"/></svg>
          View source
        </a>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  function open() {
    backdrop.classList.add('is-open');
    document.getElementById('credits-close-btn').focus();
  }

  function close() {
    backdrop.classList.remove('is-open');
    document.getElementById('credits-open-btn')?.focus();
  }

  document.getElementById('credits-open-btn').addEventListener('click', open);
  document.getElementById('credits-close-btn').addEventListener('click', close);

  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) close();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !backdrop.hidden) close();
  });
}
