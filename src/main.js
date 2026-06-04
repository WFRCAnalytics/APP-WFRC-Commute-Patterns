import './styles/main.css';
import './styles/sidebar.css';
import './styles/charts.css';
import './styles/toolbar.css';
import { initDB, reloadYear, queryFlows, queryTotal, querySelfFlow, queryReachFlows, queryNeighborFlows } from './db.js';
import { initMap, updateLayers, switchTheme, flyToArea, loadBoundaries, updateChoropleth, setFlowVisible, setPolygonsVisible, setSelfFlow, initPolygonInteraction, loadInfoOnlyPlaces, loadNeighborZones, updateNeighborFlowIndex, setNeighborAggregation } from './map.js';
import { initSidebar, updateSidebarStats, setInfoOnlyPlaces, syncAreaTypeToggle } from './sidebar.js';
import { initCharts, updateCharts, exportBarPng, exportBarCsv, exportSankeyPng, exportSankeyCsv, exportDemoPng, exportDemoCsv, exportReachPng, exportReachCsv, exportIndustryPng, exportIndustryCsv, exportTransportPng, exportTransportCsv, exportTravelTimePng, exportTravelTimeCsv, resizeCharts } from './charts.js';

// ── Global app state ─────────────────────────────────────────────────────────
const state = {
  theme:            document.documentElement.getAttribute('data-theme') || 'light',
  aggregation:      'city',
  direction:        'inflow',
  selectedArea:     'Salt Lake City',
  selectedAreaType: 'city',
  year:             null,
  minFlow:          50,
  loading:          false,
};

let cityMeta     = {};
let countyMeta   = {};
let houseMeta    = {};
let senateMeta   = {};
// Neighbor zone metadata: {display_name -> {lat, lon, state, state_abbr, ...}}
let neighborMeta = {};

// ACS commute data: keyed by FIPS (7-digit for places, 5-digit for counties/districts)
let _acsCity   = {};
let _acsCounty = {};
let _acsHouse  = {};
let _acsSenate = {};

// Cached results for re-rendering without re-querying
let _lastOutflows  = [];
let _lastInflows   = [];
let _lastTotalOut  = 0;
let _lastTotalIn   = 0;
let _lastSelfCount = 0;
// City-level flows used exclusively for the reach chart.
// For county selections these are cross-county city→city pairs (more accurate distances).
// For city selections these mirror _lastOutflows/_lastInflows.
let _lastReachOut  = [];
let _lastReachIn   = [];

// Track last flew state so we don't re-fly on direction/theme/filter changes
let _lastFlewArea        = null;
let _lastFlewAggregation = null;

// Available years — stored at module level so scrubber can update on year change
let _availableYears = [];

// ── Meta helpers ─────────────────────────────────────────────────────────────
function _getMetaFor(type) {
  return { city: cityMeta, county: countyMeta, house: houseMeta, senate: senateMeta }[type] ?? cityMeta;
}

// ── Haversine helper ──────────────────────────────────────────────────────────
function _haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _distanceToZoom(avgMiles) {
  // At zoom 8, ~230 miles visible; each level halves that.
  // Constant 46 ≈ 2× the avg Utah commute, giving good regional context.
  const zoom = 8 + Math.log2(46 / Math.max(avgMiles, 1));
  return Math.min(Math.max(zoom, 7.5), 11.5);
}

// ── ACS loader ───────────────────────────────────────────────────────────────
async function _loadAcs(base, year) {
  const load = async (path) => {
    try {
      const r = await fetch(path);
      if (!r.ok) return {};
      const text = await r.text();
      // Guard against SPA fallback returning index.html for missing paths
      if (!text.trim().startsWith('{')) return {};
      return JSON.parse(text);
    } catch { return {}; }
  };
  [_acsCity, _acsCounty, _acsHouse, _acsSenate] = await Promise.all([
    load(`${base}data/acs/${year}/acs_city.json`),
    load(`${base}data/acs/${year}/acs_county.json`),
    load(`${base}data/acs/${year}/acs_house.json`),
    load(`${base}data/acs/${year}/acs_senate.json`),
  ]);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  _initPanelToggles(); // no data dependency — run immediately so mobile layout is correct from the start
  setProgress(5);

  const base = import.meta.env.BASE_URL ?? '/';

  // 1. Load manifest
  const manifest = await fetch(`${base}data/manifest.json`).then(r => r.json());
  const availableYears = manifest.years.map(Number).sort((a, b) => b - a);
  _availableYears = availableYears;

  // 2. Resolve year from URL or default
  const urlYear = _getUrlYear(availableYears, manifest.default);
  state.year = urlYear;

  // 3. Load year-specific metadata + ACS data
  const _safeJson = url => fetch(url).then(r => r.ok ? r.json() : []).catch(() => []);

  const [cityMetaArr, countyMetaArr, houseMetaArr, senateMetaArr, neighborMetaArr] = await Promise.all([
    fetch(`${base}data/lehd/${state.year}/city_meta.json`).then(r => r.json()),
    fetch(`${base}data/lehd/${state.year}/county_meta.json`).then(r => r.json()),
    fetch(`${base}data/lehd/${state.year}/house_meta.json`).then(r => r.json()),
    fetch(`${base}data/lehd/${state.year}/senate_meta.json`).then(r => r.json()),
    _safeJson(`${base}data/lehd/${state.year}/neighbor_meta.json`),
    _loadAcs(base, state.year),
  ]);
  cityMeta     = Object.fromEntries(cityMetaArr.map(d => [d.name, d]));
  countyMeta   = Object.fromEntries(countyMetaArr.map(d => [d.name, d]));
  houseMeta    = Object.fromEntries(houseMetaArr.map(d => [d.name, d]));
  senateMeta   = Object.fromEntries(senateMetaArr.map(d => [d.name, d]));
  neighborMeta = Object.fromEntries(neighborMetaArr.map(d => [d.display_name, d]));

  setProgress(15);

  // 4. Init DuckDB (heavyweight — give it most of the progress bar)
  await initDB(state.year, pct => setProgress(15 + pct * 0.65));

  setProgress(83);

  // 5. Init map
  initMap('map', state.theme);

  initPolygonInteraction((name) => {
    if (name === state.selectedArea) return;
    state.selectedArea     = name;
    state.selectedAreaType = state.aggregation;
    syncAreaTypeToggle(state.aggregation);
    _updateSidebarAreaLabels(name);
    refreshVisualization();
  });

  // 6. Load boundary files in background (optional — graceful if missing)
  loadBoundaries(base, state.theme);
  // 6c. Load neighbor zone dots (points only, no polygons)
  loadNeighborZones(neighborMetaArr);

  // 6b. Load custom place info for info-only display (graceful if missing)
  fetch(`${base}data/custom_places.geojson`)
    .then(r => r.ok ? r.json() : null)
    .then(gj => {
      if (!gj) return;
      const cityNames = Object.keys(cityMeta);
      const infoOnly  = gj.features.filter(f => !cityNames.includes(f.properties?.name));
      if (!infoOnly.length) return;
      loadInfoOnlyPlaces(infoOnly);
      setInfoOnlyPlaces(infoOnly);
    })
    .catch(() => {});

  setProgress(88);

  // 7. Apply URL params (area/dir/agg) now that metadata is available
  _applyUrlParams();

  // 8. Build sidebar
  const cityNames   = cityMetaArr.map(d => d.name).filter(n => !n.toLowerCase().includes('unincorporated')).sort();
  const countyNames = countyMetaArr.map(d => d.name).sort();
  const _numSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const houseNames  = houseMetaArr.map(d => d.name).sort(_numSort);
  const senateNames = senateMetaArr.map(d => d.name).sort(_numSort);

  initSidebar({
    cityNames, countyNames, houseNames, senateNames,
    cityMeta, houseMeta, senateMeta,
    state,
    onSelectionChange: () => refreshVisualization(),
    onAreaFly: () => {},
  });

  // 9. Init charts (right panel)
  initCharts((areaName, areaType) => {
    state.selectedArea     = areaName;
    state.selectedAreaType = areaType;
    _updateSidebarAreaLabels(areaName);
    refreshVisualization();
  });

  // 9. Wire export buttons
  // export-bar-* and export-sankey-* live in the re-rendered sidebar → use event delegation
  document.body.addEventListener('click', e => {
    if (e.target.id === 'export-bar-png')    exportBarPng();
    if (e.target.id === 'export-bar-csv')    exportBarCsv();
    if (e.target.id === 'export-sankey-png') exportSankeyPng();
    if (e.target.id === 'export-sankey-csv') exportSankeyCsv();
  });
  document.getElementById('export-demo-png')?.addEventListener('click', () => exportDemoPng());
  document.getElementById('export-demo-csv')?.addEventListener('click', () => exportDemoCsv());
  document.getElementById('export-reach-png')?.addEventListener('click', () => exportReachPng());
  document.getElementById('export-reach-csv')?.addEventListener('click', () => exportReachCsv());
  document.getElementById('export-industry-png')?.addEventListener('click', () => exportIndustryPng());
  document.getElementById('export-industry-csv')?.addEventListener('click', () => exportIndustryCsv());
  document.getElementById('export-transport-png')?.addEventListener('click', () => exportTransportPng());
  document.getElementById('export-transport-csv')?.addEventListener('click', () => exportTransportCsv());
  document.getElementById('export-traveltime-png')?.addEventListener('click', () => exportTravelTimePng());
  document.getElementById('export-traveltime-csv')?.addEventListener('click', () => exportTravelTimeCsv());

  // 10. Wire year scrubber
  _initYearSelect(availableYears, base);

  // 11. Wire layer toggle toolbar + resize
  _initLayerToolbar();
  _initRightPanelResize();

  // 12. Wire theme toggle — persist explicit user choice
  document.getElementById('theme-toggle').addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('theme', state.theme);
    switchTheme(state.theme, () => _applyFilter());
  });

  // Follow system preference changes when the user hasn't overridden manually
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!localStorage.getItem('theme')) {
      state.theme = e.matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', state.theme);
      switchTheme(state.theme, () => _applyFilter());
    }
  });

  setProgress(94);
  await refreshVisualization();

  document.querySelector('.sidebar-loading')?.remove();
  setProgress(100);
}

// ── Panel collapse toggles ────────────────────────────────────────────────────
function _initPanelToggles() {
  const grid = document.querySelector('.body-grid');
  if (!grid) return;

  grid.classList.add('no-transition');
  if (window.innerWidth <= 480) {
    // Phone: collapse both, right first then left
    grid.classList.add('right-collapsed', 'left-collapsed');
  } else if (window.innerWidth <= 768) {
    // Small tablet / large phone landscape: collapse right panel only
    grid.classList.add('right-collapsed');
  } else {
    // Desktop: restore last user preference
    const stored = JSON.parse(localStorage.getItem('wfrc-panels') || '{}');
    if (stored.leftCollapsed)  grid.classList.add('left-collapsed');
    if (stored.rightCollapsed) grid.classList.add('right-collapsed');
  }
  requestAnimationFrame(() => requestAnimationFrame(() => grid.classList.remove('no-transition')));
  _updateToggleLabels(grid);

  document.getElementById('left-panel-toggle')?.addEventListener('click', () => {
    grid.classList.toggle('left-collapsed');
    _savePanelState(grid);
    _updateToggleLabels(grid);
    setTimeout(resizeCharts, 300);
  });

  document.getElementById('right-panel-toggle')?.addEventListener('click', () => {
    grid.classList.toggle('right-collapsed');
    _savePanelState(grid);
    _updateToggleLabels(grid);
    setTimeout(resizeCharts, 300);
  });
}

function _savePanelState(grid) {
  if (window.innerWidth <= 768) return; // don't let mobile state bleed into desktop prefs
  localStorage.setItem('wfrc-panels', JSON.stringify({
    leftCollapsed:  grid.classList.contains('left-collapsed'),
    rightCollapsed: grid.classList.contains('right-collapsed'),
  }));
}

function _updateToggleLabels(grid) {
  const leftBtn  = document.getElementById('left-panel-toggle');
  const rightBtn = document.getElementById('right-panel-toggle');
  if (leftBtn)  leftBtn.setAttribute('aria-label',  grid.classList.contains('left-collapsed')  ? 'Expand left panel'  : 'Collapse left panel');
  if (rightBtn) rightBtn.setAttribute('aria-label', grid.classList.contains('right-collapsed') ? 'Expand right panel' : 'Collapse right panel');
}

// ── Right panel resize handle ─────────────────────────────────────────────────
function _initRightPanelResize() {
  const handle = document.getElementById('right-resize-handle');
  if (!handle) return;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--right-rail-width'), 10
    ) || 432;

    handle.classList.add('dragging');
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = ev => {
      const delta    = startX - ev.clientX;   // drag left = wider
      const newWidth = Math.min(Math.max(startWidth + delta, 300), 900);
      document.documentElement.style.setProperty('--right-rail-width', `${newWidth}px`);
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor    = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      resizeCharts();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// ── Layer toggle toolbar ──────────────────────────────────────────────────────
function _initLayerToolbar() {
  const flowsBtn     = document.getElementById('tb-flows');
  const zonesBtn     = document.getElementById('tb-zones');
  const minFlowInput = document.getElementById('min-flow-input');
  const mfVal        = document.getElementById('mf-val');

  if (!flowsBtn || !zonesBtn) return;

  let flowVisible  = true;
  let zonesVisible = true;

  flowsBtn.addEventListener('click', () => {
    flowVisible = !flowVisible;
    flowsBtn.classList.toggle('active', flowVisible);
    flowsBtn.setAttribute('aria-pressed', String(flowVisible));
    setFlowVisible(flowVisible);
  });

  zonesBtn.addEventListener('click', () => {
    zonesVisible = !zonesVisible;
    zonesBtn.classList.toggle('active', zonesVisible);
    zonesBtn.setAttribute('aria-pressed', String(zonesVisible));
    setPolygonsVisible(zonesVisible);
  });

  if (minFlowInput) {
    minFlowInput.addEventListener('input', () => {
      const val = parseInt(minFlowInput.value);
      if (!isNaN(val) && val >= 0) {
        state.minFlow = val;
        if (mfVal) mfVal.textContent = val;
        _applyFilter();
      }
    });
  }
}

// ── Year scrubber ─────────────────────────────────────────────────────────────
let _changingYear = false;

function _initYearSelect(availableYears, base) {
  // Populate hidden select for screen reader fallback
  const sel = document.getElementById('year-select');
  if (sel) {
    sel.innerHTML = availableYears.map(y =>
      `<option value="${y}"${y === state.year ? ' selected' : ''}>${y}</option>`
    ).join('');
    sel.addEventListener('change', () => _changeYear(parseInt(sel.value), base));
  }

  // Build tick scrubber
  _buildScrubberTicks(availableYears, base);
  _updateScrubber(state.year, availableYears);
}

function _buildScrubberTicks(availableYears, base) {
  const track = document.getElementById('ys-track');
  if (!track) return;
  // Remove existing ticks (but keep .ys-axis and .ys-fill)
  track.querySelectorAll('.ys-tick').forEach(t => t.remove());

  const sorted     = [...availableYears].sort((a, b) => a - b);
  const minYear    = sorted[0];
  const maxYear    = sorted[sorted.length - 1];
  const majorYears = new Set([2005, 2010, 2015, 2020]);

  sorted.forEach(year => {
    const tick = document.createElement('button');
    tick.type  = 'button';
    tick.className = 'ys-tick';
    tick.dataset.year = year;
    tick.setAttribute('aria-label', `Select year ${year}`);

    if (majorYears.has(year)) tick.classList.add('major');

    if (year === minYear || year === maxYear) {
      tick.classList.add('endcap');
      const cap = document.createElement('span');
      cap.className   = 'ys-tick-cap';
      cap.textContent = year;
      tick.appendChild(cap);
    }

    tick.addEventListener('click', () => _changeYear(year, base));
    track.appendChild(tick);
  });
}

function _updateScrubber(year, availableYears) {
  const sorted = [...availableYears].sort((a, b) => a - b);
  const idx    = sorted.indexOf(year);
  const pct    = sorted.length > 1 ? (idx / (sorted.length - 1)) * 100 : 0;

  const fill = document.getElementById('ys-fill');
  if (fill) fill.style.width = `${pct}%`;

  const display = document.getElementById('ys-year-display');
  if (display) display.textContent = year;

  const sel = document.getElementById('year-select');
  if (sel) sel.value = year;

  document.querySelectorAll('.ys-tick').forEach(t => {
    t.classList.toggle('active', parseInt(t.dataset.year) === year);
  });
}

async function _changeYear(newYear, base) {
  if (_changingYear || state.loading || newYear === state.year) return;
  _changingYear = true;

  const sel = document.getElementById('year-select');
  if (sel) sel.disabled = true;

  try {
    setProgress(5);

    const [cityMetaArr, countyMetaArr, houseMetaArr, senateMetaArr, neighborMetaArr] = await Promise.all([
      fetch(`${base}data/lehd/${newYear}/city_meta.json`).then(r => r.json()),
      fetch(`${base}data/lehd/${newYear}/county_meta.json`).then(r => r.json()),
      fetch(`${base}data/lehd/${newYear}/house_meta.json`).then(r => r.json()),
      fetch(`${base}data/lehd/${newYear}/senate_meta.json`).then(r => r.json()),
      fetch(`${base}data/lehd/${newYear}/neighbor_meta.json`).then(r => r.ok ? r.json() : []).catch(() => []),
      _loadAcs(base, newYear),
    ]);
    cityMeta     = Object.fromEntries(cityMetaArr.map(d => [d.name, d]));
    countyMeta   = Object.fromEntries(countyMetaArr.map(d => [d.name, d]));
    houseMeta    = Object.fromEntries(houseMetaArr.map(d => [d.name, d]));
    senateMeta   = Object.fromEntries(senateMetaArr.map(d => [d.name, d]));
    neighborMeta = Object.fromEntries(neighborMetaArr.map(d => [d.display_name, d]));
    loadNeighborZones(neighborMetaArr);

    setProgress(20);
    await reloadYear(newYear, pct => setProgress(20 + pct * 0.6));
    setProgress(85);

    state.year = newYear;
    _updateScrubber(newYear, _availableYears);

    if (!_getMetaFor(state.selectedAreaType)[state.selectedArea]) {
      state.selectedArea     = 'Salt Lake City';
      state.selectedAreaType = 'city';
    }

    initSidebar({
      cityNames:   cityMetaArr.map(d => d.name).filter(n => !n.toLowerCase().includes('unincorporated')).sort(),
      countyNames: countyMetaArr.map(d => d.name).sort(),
      houseNames:  houseMetaArr.map(d => d.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      senateNames: senateMetaArr.map(d => d.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      cityMeta, houseMeta, senateMeta,
      state,
      onSelectionChange: () => refreshVisualization(),
      onAreaFly: () => {},
    });

    await refreshVisualization();
    setProgress(100);

  } catch (err) {
    console.error('Year switch failed:', err);
    setProgress(0);
  } finally {
    _changingYear = false;
    if (sel) sel.disabled = false;
  }
}

// ── Refresh visualization ─────────────────────────────────────────────────────
async function refreshVisualization() {
  _syncUrl();
  if (state.loading) return;
  state.loading = true;

  try {
    const isNonCitySubject = state.selectedAreaType !== 'city';

    const [outflows, inflows, totalOut, totalIn, selfCount, reachRawOut, reachRawIn,
           neighborOut, neighborIn] = await Promise.all([
      queryFlows(state.selectedArea, state.selectedAreaType, 'outflow', state.aggregation),
      queryFlows(state.selectedArea, state.selectedAreaType, 'inflow',  state.aggregation),
      queryTotal(state.selectedArea, state.selectedAreaType, 'outflow'),
      queryTotal(state.selectedArea, state.selectedAreaType, 'inflow'),
      querySelfFlow(state.selectedArea, state.selectedAreaType),
      isNonCitySubject ? queryReachFlows(state.selectedArea, state.selectedAreaType, 'outflow') : Promise.resolve(null),
      isNonCitySubject ? queryReachFlows(state.selectedArea, state.selectedAreaType, 'inflow')  : Promise.resolve(null),
      queryNeighborFlows(state.selectedArea, state.selectedAreaType, 'outflow', state.aggregation),
      queryNeighborFlows(state.selectedArea, state.selectedAreaType, 'inflow',  state.aggregation),
    ]);

    const srcMeta = _getMetaFor(state.selectedAreaType);
    const dstMeta = _getMetaFor(state.aggregation);
    const src = srcMeta[state.selectedArea];

    const enrichedOut = outflows
      .map(f => {
        const dst = dstMeta[f.dest_name];
        return { ...f, home_name: state.selectedArea, work_name: f.dest_name,
                       home_lat: src?.lat, home_lon: src?.lon, work_lat: dst?.lat, work_lon: dst?.lon };
      })
      .filter(f => f.home_lat != null && f.work_lat != null);

    const enrichedIn = inflows
      .map(f => {
        const dst = dstMeta[f.dest_name];
        return { ...f, home_name: f.dest_name, work_name: state.selectedArea,
                       home_lat: dst?.lat, home_lon: dst?.lon, work_lat: src?.lat, work_lon: src?.lon };
      })
      .filter(f => f.home_lat != null && f.work_lat != null);

    // Enrich neighbor flows with lat/lon (Utah centroid from src; neighbor from neighborMeta)
    const enrichNeighbor = (nbFlows, dir) => nbFlows
      .map(f => {
        const nb = neighborMeta[f.dest_name];
        if (!nb) return null;
        const [hLat, hLon, wLat, wLon] = dir === 'outflow'
          ? [src?.lat, src?.lon, nb.lat, nb.lon]
          : [nb.lat, nb.lon, src?.lat, src?.lon];
        return { ...f,
          home_name: dir === 'outflow' ? state.selectedArea : f.dest_name,
          work_name: dir === 'outflow' ? f.dest_name        : state.selectedArea,
          home_lat: hLat, home_lon: hLon, work_lat: wLat, work_lon: wLon,
        };
      })
      .filter(f => f && f.home_lat != null && f.work_lat != null);

    const enrichedNbOut = enrichNeighbor(neighborOut, 'outflow');
    const enrichedNbIn  = enrichNeighbor(neighborIn,  'inflow');

    _lastOutflows  = [...enrichedOut,  ...enrichedNbOut];
    _lastInflows   = [...enrichedIn,   ...enrichedNbIn];
    _lastTotalOut  = totalOut;
    _lastTotalIn   = totalIn;
    _lastSelfCount = selfCount;

    // Reach chart: use city-level pairs for non-city subjects so distances are
    // measured between city centroids rather than a single area centroid.
    // Fallback to county or subject-area centroid for unincorporated areas.
    if (isNonCitySubject && reachRawOut) {
      const enrichReach = flows => flows.map(f => {
        const hm = cityMeta[f.home_name] ?? countyMeta[f.home_county] ?? _getMetaFor(state.selectedAreaType)[f.home_name];
        const wm = cityMeta[f.work_name] ?? countyMeta[f.work_county] ?? _getMetaFor(state.aggregation)[f.work_name];
        return { ...f, home_lat: hm?.lat, home_lon: hm?.lon, work_lat: wm?.lat, work_lon: wm?.lon };
      }).filter(f => f.home_lat != null && f.work_lat != null);
      _lastReachOut = enrichReach(reachRawOut);
      _lastReachIn  = enrichReach(reachRawIn);
    } else {
      _lastReachOut = enrichedOut;
      _lastReachIn  = enrichedIn;
    }

    setSelfFlow(selfCount, totalOut, totalIn);

    // Fly only when the selected area or aggregation level changes
    const areaChanged = state.selectedArea !== _lastFlewArea
                     || state.aggregation  !== _lastFlewAggregation;
    if (src?.lat && areaChanged) {
      let zoom;
      if (state.aggregation === 'county') {
        zoom = 8;
      } else {
        let distNum = 0, distDen = 0;
        enrichedOut.forEach(f => {
          const n = Number(f.S000);
          distNum += _haversineMiles(f.home_lat, f.home_lon, f.work_lat, f.work_lon) * n;
          distDen += n;
        });
        const avgMiles = distDen > 0 ? distNum / distDen : 20;
        zoom = _distanceToZoom(avgMiles);
      }
      flyToArea(src.lat, src.lon, zoom);
      _lastFlewArea        = state.selectedArea;
      _lastFlewAggregation = state.aggregation;
    }

    _applyFilter();

  } finally {
    state.loading = false;
  }
}

function _applyFilter() {
  const dirFlows = state.direction === 'outflow' ? _lastOutflows : _lastInflows;
  const netOut   = Math.max(_lastTotalOut - _lastSelfCount, 0);
  const netIn    = Math.max(_lastTotalIn  - _lastSelfCount, 0);
  const total    = state.direction === 'outflow' ? netOut : netIn;

  const filtered = state.aggregation === 'county'
    ? dirFlows
    : dirFlows.filter(f => Number(f.S000) >= state.minFlow);

  // Resolve ACS entry for the currently selected area
  let acsEntry = null;
  if (state.selectedAreaType === 'city') {
    const fips = cityMeta[state.selectedArea]?.place_fips;
    if (fips) acsEntry = _acsCity[fips] ?? null;
  } else if (state.selectedAreaType === 'county') {
    const fips = countyMeta[state.selectedArea]?.county_fips;
    if (fips) acsEntry = _acsCounty[fips] ?? null;
  } else if (state.selectedAreaType === 'house') {
    const fips = houseMeta[state.selectedArea]?.house_fips;
    if (fips) acsEntry = _acsHouse[fips] ?? null;
  } else if (state.selectedAreaType === 'senate') {
    const fips = senateMeta[state.selectedArea]?.senate_fips;
    if (fips) acsEntry = _acsSenate[fips] ?? null;
  }

  // Build neighbor flow index for dot tooltips {display_name -> {in, out}}
  const nbIndex = {};
  _lastOutflows.filter(f => f.isNeighbor).forEach(f => {
    nbIndex[f.dest_name] = nbIndex[f.dest_name] ?? { in: 0, out: 0 };
    nbIndex[f.dest_name].out += Number(f.S000);
  });
  _lastInflows.filter(f => f.isNeighbor).forEach(f => {
    nbIndex[f.dest_name] = nbIndex[f.dest_name] ?? { in: 0, out: 0 };
    nbIndex[f.dest_name].in += Number(f.S000);
  });
  updateNeighborFlowIndex(nbIndex);
  setNeighborAggregation(state.aggregation);

  updateLayers(filtered, state, arcClickHandler, total);
  // Charts always show both directions unfiltered — top N by volume handles their own slicing
  updateCharts(_lastOutflows, _lastInflows, netOut, netIn, _lastSelfCount, state, acsEntry, _lastReachOut, _lastReachIn);
  updateChoropleth(dirFlows, state.selectedArea, state.aggregation, state.theme, state.direction, state.selectedAreaType);
  updateSidebarStats(dirFlows, state);
  _updateDataline(total, state);
  _updateLegend(filtered, state.direction, state.theme);
}

// ── Dataline map overlay update ───────────────────────────────────────────────
function _updateDataline(total, appState) {
  const dl      = document.getElementById('map-dataline');
  const dlLabel = document.getElementById('dl-label');
  const dlValue = document.getElementById('dl-value');
  const dlFrom  = document.getElementById('dl-from');
  const dlArrow = document.getElementById('dl-arrow');
  if (!dlLabel || !dlValue || !dlFrom) return;

  const isOut = appState.direction === 'outflow';
  dlLabel.textContent = isOut ? 'RESIDENTS COMMUTING OUT' : 'WORKERS COMMUTING IN';
  dlValue.textContent = total > 0 ? total.toLocaleString() : '—';
  dlFrom.textContent  = `${isOut ? 'From' : 'To'} ${appState.selectedArea} · ${appState.year}`;
  dlArrow.textContent = isOut ? '↗' : '↘';
  if (dl) dl.classList.toggle('inflow', !isOut);
}

// ── Flow legend ───────────────────────────────────────────────────────────────
// Color arrays match @flowmap.gl/data COLOR_SCHEMES exactly.
// With adaptiveScalesEnabled=true, flowmap.gl maps the visible flow range to
// the full scheme — so scheme[0] = minVal and scheme[last] = maxVal.
const _LEGEND_ORANGES = ['#fff5eb','#fee6ce','#fdd0a2','#fdae6b','#fd8d3c','#f16913','#d94801','#a63603','#7f2704'];
const _LEGEND_GREEN   = ['#d0eeec','#a2dbd8','#74c8c3','#46b5ae','#2e9898','#1e6f6f','#0f4040'];

function _updateLegend(flows, direction, theme) {
  const el = document.getElementById('map-legend');
  if (!el) return;

  const counts = flows.map(f => Number(f.S000)).filter(n => n > 0);
  if (!counts.length) { el.innerHTML = ''; return; }

  const minVal = Math.min(...counts);
  const maxVal = Math.max(...counts);

  function fmtN(n) {
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000)  return `${parseFloat((n / 1000).toFixed(1))}k`;
    return n.toLocaleString();
  }

  const scheme = direction === 'inflow' ? _LEGEND_GREEN : _LEGEND_ORANGES;
  const colors = theme === 'dark' ? [...scheme].reverse() : scheme;
  const gradient = `linear-gradient(to right, ${colors.join(',')})`;

  const label = direction === 'inflow' ? 'Inflow' : 'Outflow';

  el.innerHTML = `
    <div class="lg-label">${label} · commuters</div>
    <div class="lg-gradient-bar" style="background:${gradient}"></div>
    <div class="lg-gradient-labels">
      <span>${fmtN(minVal)}</span>
      <span>${fmtN(maxVal)}</span>
    </div>`;
}

// ── Arc click → select destination as new area ────────────────────────────────
function arcClickHandler(flow) {
  const newArea = flow.dest_name ?? (state.direction === 'outflow' ? flow.work_name : flow.home_name);
  if (!newArea || newArea === state.selectedArea) return;

  // Neighbor zones are display-only — don't allow selecting them as a subject area
  if (!_getMetaFor(state.aggregation)[newArea]) return;

  state.selectedArea     = newArea;
  state.selectedAreaType = state.aggregation;
  syncAreaTypeToggle(state.aggregation);

  _updateSidebarAreaLabels(newArea);
  refreshVisualization();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _updateSidebarAreaLabels(areaName) {
  const input = document.getElementById('area-search');
  if (input) input.value = areaName;
  // area-label-out and area-label-in no longer exist in new HTML; safe no-ops
  const outEl = document.getElementById('area-label-out');
  const inEl  = document.getElementById('area-label-in');
  const short = areaName.length > 18 ? areaName.slice(0, 16) + '…' : areaName;
  if (outEl) outEl.textContent = short;
  if (inEl)  inEl.textContent  = short;
}

function _getUrlYear(availableYears, defaultYear) {
  const params  = new URLSearchParams(window.location.search);
  const urlYear = parseInt(params.get('year'));
  return (urlYear && availableYears.includes(urlYear)) ? urlYear : defaultYear;
}

function _applyUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const agg = p.get('agg');
  // TO RE-ENABLE district map zones: replace the line below with the commented-out one
  if (['city', 'county'].includes(agg)) state.aggregation = agg;
  // if (['city', 'county', 'house', 'senate'].includes(agg)) state.aggregation = agg;
  const area = p.get('area');
  if (area) {
    const meta = _getMetaFor(state.aggregation);
    if (meta[area]) {
      state.selectedArea     = area;
      state.selectedAreaType = state.aggregation;
    }
  }
  const dir = p.get('dir');
  if (dir === 'outflow' || dir === 'inflow') state.direction = dir;
}

function _syncUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('year', state.year);
  url.searchParams.set('area', state.selectedArea);
  url.searchParams.set('dir',  state.direction);
  url.searchParams.set('agg',  state.aggregation);
  history.replaceState(null, '', url);
}

function setProgress(pct) {
  const bar = document.getElementById('load-progress');
  if (bar) bar.style.width = `${pct}%`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('WFRC app failed to initialize:', err);
  const panel = document.getElementById('left-panel');
  if (panel) {
    panel.innerHTML = `
      <div class="sidebar-error">
        <p><strong>Failed to load data.</strong></p>
        <p>${err.message}</p>
        <p>Run <code>uv run scripts/process_data.py</code> to generate the data files.</p>
      </div>
    `;
  }
});
