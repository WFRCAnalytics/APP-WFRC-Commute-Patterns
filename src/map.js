import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { FlowmapLayer } from '@flowmap.gl/layers';

// ── Base map vector styles (CARTO GL — no API key required) ──────────────────

// CARTO GL vector styles: full vector tile stack, glyphs and sprites included.
// Positron = light, Dark Matter = dark.
const STYLE_URLS = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark:  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};

const INITIAL_VIEW = { center: [-111.5, 39.5], zoom: 6.5 };

// ── Custom control helpers ────────────────────────────────────────────────────
const _SVG_HOME  = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
const _SVG_NORTH = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;

function _mapBtn(title, svgHtml, onClick) {
  const btn = document.createElement('button');
  btn.type  = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:29px;height:29px;padding:0;cursor:pointer;';
  btn.innerHTML = svgHtml;
  btn.addEventListener('click', onClick);
  return btn;
}

function _makeCtrlGroup(...btns) {
  const el = document.createElement('div');
  el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
  btns.forEach(b => el.appendChild(b));
  return { onAdd: () => el, onRemove: () => el.remove() };
}

// ── Color schemes (choropleth + flow lines) ───────────────────────────────────
// SCHEME_GREEN is a custom 7-stop ramp anchored on --inflow (#1e6f6f / #5aa6a7),
// keeping H≈178° throughout so it matches the green-teal used in the sidebar charts.
// SCHEME_ORANGE uses ColorBrewer Oranges (7-class) to match --outflow (#cc683a).
// For the MapLibre choropleth we reverse manually for dark mode.
// FlowmapLayer receives the same array pre-reversed for dark mode (array path
// skips flowmap.gl's internal reversal, so we handle it ourselves).
const SCHEME_GREEN  = ['#d0eeec','#a2dbd8','#74c8c3','#46b5ae','#2e9898','#1e6f6f','#0f4040'];
const SCHEME_ORANGE = ['#feedde','#fdd0a2','#fdae6b','#fd8d3c','#f16913','#d94801','#8c2d04'];

// Linear interpolation through an RGB hex color array (mirrors D3 interpolateRgbBasis
// but without the dependency; sufficient for the 7-stop choropleth ramp).
function _lerpScheme(scheme, t) {
  t = Math.max(0, Math.min(1, t));
  const n = scheme.length - 1;
  const i = Math.min(Math.floor(t * n), n - 1);
  const f = t * n - i;
  const hex = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const [r1,g1,b1] = hex(scheme[i]);
  const [r2,g2,b2] = hex(scheme[i+1]);
  return [Math.round(r1+f*(r2-r1)), Math.round(g1+f*(g2-g1)), Math.round(b1+f*(b2-b1))];
}

// ── Module state ─────────────────────────────────────────────────────────────
let map         = null;
let deckOverlay = null;
let _theme      = 'light';
let _boundaries = { county: null, city: null, house: null, senate: null };
// Stored so it can be replayed after boundary layers are added asynchronously
let _pendingChoropleth = null;
let _tooltipEl  = null;
let _flowVisible     = true;
let _polygonsVisible = true;
// Cached for replay when toggling visibility
let _lastFlowArgs = null;
let _direction    = 'outflow';
let _selfFlowCount    = 0;
let _selfOutTotal     = 0;   // total commuters who reside in selected area
let _selfInTotal      = 0;   // total workers employed in selected area
let _onPolygonClick      = null;
let _deckClickedThisTick = false;
let _infoFeatures        = [];
// Neighbor zones: {display_name -> {lat, lon, state, state_abbr}}
let _neighborMeta       = {};
// Flow index updated after each zone selection: {display_name -> {in: N, out: N}}
let _neighborFlowIndex  = {};

// ── Donut SVG helper ─────────────────────────────────────────────────────────

function _donutSvg(pct, strokeColor, size = 66) {
  const r   = size * 0.38;
  const cx  = size / 2;
  const cy  = size / 2;
  const C   = 2 * Math.PI * r;
  const arc = ((Math.min(Math.max(pct, 0), 100) / 100) * C).toFixed(2);
  const fs  = Math.round(size * 0.195);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="5.5"
      style="stroke:var(--rule-strong)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="5.5"
      stroke-linecap="round"
      stroke-dasharray="${arc} ${C.toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})"
      style="stroke:${strokeColor}"/>
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"
      font-size="${fs}" font-weight="700"
      style="fill:var(--ink);font-family:'Inter',sans-serif">${pct}%</text>
  </svg>`;
}

// ── Custom tooltip (FlowmapLayer onHover is async — can't use MapboxOverlay.getTooltip) ──

function _ensureTooltip() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'map-tooltip';
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

function _showTooltip(info, html, extraClass = '') {
  const el = _ensureTooltip();
  const container = map?.getContainer();
  if (!container) return;
  const rect = container.getBoundingClientRect();
  el.className = extraClass ? `map-tooltip ${extraClass}` : 'map-tooltip';
  el.innerHTML = html;
  el.style.display = 'block';
  el.style.left = `${rect.left + info.x + 16}px`;
  el.style.top  = `${rect.top  + info.y - 12}px`;
}

function _hideTooltip() {
  if (_tooltipEl) _tooltipEl.style.display = 'none';
}

// ── Initialization ───────────────────────────────────────────────────────────

export function initMap(containerId, theme = 'light') {
  _theme = theme;

  map = new maplibregl.Map({
    container: containerId,
    style: STYLE_URLS[theme],
    ...INITIAL_VIEW,
    maxZoom: 14,
    minZoom: 5,
    attributionControl: false,
  });

  deckOverlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
  });

  map.on('load', () => {
    _filterLabels();
    _addBoundaryLayers();
    _addInfoLayers();
    _addNeighborLayer();
    map.addControl(deckOverlay);

    // Zoom + compass (clicking compass resets bearing; visualizePitch tilts needle)
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');

    // Reset tilt & north + reset to Utah statewide view
    map.addControl(_makeCtrlGroup(
      _mapBtn('Reset tilt & north', _SVG_NORTH, () => map.easeTo({ pitch: 0, bearing: 0, duration: 300 })),
      _mapBtn('Reset view',         _SVG_HOME,  () => map.flyTo({ ...INITIAL_VIEW, pitch: 0, bearing: 0 })),
    ), 'top-right');

    // Geolocate
    map.addControl(new maplibregl.GeolocateControl({
      positionOptions:  { enableHighAccuracy: true },
      trackUserLocation: false,
    }), 'top-right');

    // Fullscreen
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');

    // Scale bar
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'imperial' }), 'bottom-left');

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  });

  return { map, deckOverlay };
}

// ── Theme switch ─────────────────────────────────────────────────────────────

export function switchTheme(theme, onReady) {
  if (!map) return;
  _theme = theme;
  _hideTooltip();

  // deck.gl is independent of MapLibre style — update flow lines immediately.
  // _lastFlowArgs holds a reference to state, which already has the new theme.
  if (_lastFlowArgs) updateLayers(..._lastFlowArgs);

  // transformStyle re-injects user-added sources and layers into the incoming style spec
  // before MapLibre processes it, so they survive the style swap without being destroyed.
  // Paint properties are updated here (not via setPaintProperty after load) because
  // MapLibre finalises spec values after style.load fires, overwriting runtime overrides.
  map.setStyle(STYLE_URLS[theme], {
    transformStyle: (prevStyle, nextStyle) => {
      if (!prevStyle) return nextStyle;
      const styleSrcIds   = new Set(Object.keys(nextStyle.sources ?? {}));
      const styleLayerIds = new Set(nextStyle.layers.map(l => l.id));

      const outlineColor     = theme === 'dark' ? 'rgba(232,229,220,0.15)' : 'rgba(18,23,38,0.18)';
      const outlineColorCity = theme === 'dark' ? 'rgba(232,229,220,0.10)' : 'rgba(18,23,38,0.12)';
      const infoFill         = theme === 'dark' ? 'rgba(251,191,36,0.07)' : 'rgba(217,119,6,0.09)';
      const infoLine         = theme === 'dark' ? '#fbbf24'               : '#b45309';

      const pc = _pendingChoropleth;

      // Direction-aware selected border — matches updateChoropleth logic exactly.
      const selIsOutflow = pc?.direction !== 'inflow';
      const selColor = selIsOutflow
        ? (theme === 'dark' ? '#5aa6a7' : '#1e6f6f')
        : (theme === 'dark' ? '#e4895a' : '#cc683a');

      const preservedLayers = (prevStyle.layers ?? [])
        .filter(l => !styleLayerIds.has(l.id))
        .map(l => {
          const paint = { ...l.paint };
          if (l.id === 'county-outline')   paint['line-color'] = outlineColor;
          if (l.id === 'house-outline')    paint['line-color'] = outlineColor;
          if (l.id === 'senate-outline')   paint['line-color'] = outlineColor;
          if (l.id === 'city-outline')     paint['line-color'] = outlineColorCity;
          if (l.id === 'county-selected')  paint['line-color'] = selColor;
          if (l.id === 'city-selected')    paint['line-color'] = selColor;
          if (l.id === 'house-selected')   paint['line-color'] = selColor;
          if (l.id === 'senate-selected')  paint['line-color'] = selColor;
          if (l.id === 'custom-info-fill')   paint['fill-color']   = infoFill;
          if (l.id === 'custom-info-line')   paint['line-color']   = infoLine;
          if (l.id === 'neighbor-zone-dots') paint['circle-color'] = theme === 'dark' ? '#9ca3af' : '#6b7280';
          if (pc) {
            const activeFill = `${pc.aggregation}-fill`;
            if (l.id === activeFill) {
              paint['fill-color'] = _buildFillExpr(pc.flows, pc.selectedArea, theme, pc.direction);
            }
          }
          return { ...l, paint };
        });

      // Insert preserved layers before the first kept place-label layer so our
      // fills stay below city/town/state labels after a theme swap.
      const labelIdx = nextStyle.layers.findIndex(
        l => l.type === 'symbol' && _KEEP_LABEL_RE.test(l.id)
      );
      const mergedLayers = labelIdx >= 0
        ? [...nextStyle.layers.slice(0, labelIdx), ...preservedLayers, ...nextStyle.layers.slice(labelIdx)]
        : [...nextStyle.layers, ...preservedLayers];

      return {
        ...nextStyle,
        sources: {
          ...nextStyle.sources,
          ...Object.fromEntries(
            Object.entries(prevStyle.sources ?? {}).filter(([k]) => !styleSrcIds.has(k))
          ),
        },
        layers: mergedLayers,
      };
    },
  });

  // style.load fires as soon as the style JSON is parsed (before tile downloads),
  // so we can update theme-sensitive paint properties immediately.
  map.once('style.load', () => {
    _filterLabels();
    if (_boundaries.county || _boundaries.city || _boundaries.house || _boundaries.senate) _addBoundaryLayers();
    _addInfoLayers();
    _addNeighborLayer();
    _enforceLayerOrder();
    onReady?.();
  });
}

// ── Flow map layer ────────────────────────────────────────────────────────────

export function setFlowVisible(v) {
  _flowVisible = v;
  if (_lastFlowArgs) updateLayers(..._lastFlowArgs);
}

export function setPolygonsVisible(v) {
  _polygonsVisible = v;
  if (!v) {
    ['county','city','house','senate'].flatMap(t => [`${t}-fill`,`${t}-outline`,`${t}-selected`]).forEach(id => {
      if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    });
  } else if (_pendingChoropleth) {
    const { flows, selectedArea, aggregation, theme, direction } = _pendingChoropleth;
    updateChoropleth(flows, selectedArea, aggregation, theme, direction);
  }
}

export function initPolygonInteraction(onAreaClick) {
  _onPolygonClick = onAreaClick;
  if (!map) return;

  ['county-fill', 'city-fill', 'house-fill', 'senate-fill'].forEach(layerId => {
    map.on('click', layerId, (e) => {
      if (_deckClickedThisTick || !_polygonsVisible) return;
      const name = e.features?.[0]?.properties?.name;
      if (name) _onPolygonClick(name);
    });
    map.on('mousemove', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
  });
}

export function setSelfFlow(count, outTotal = 0, inTotal = 0) {
  _selfFlowCount = count    ?? 0;
  _selfOutTotal  = outTotal ?? 0;
  _selfInTotal   = inTotal  ?? 0;
}

export function updateLayers(flows, state, onArcClick, total = 0) {
  if (!deckOverlay) return;
  _lastFlowArgs = [flows, state, onArcClick, total];
  _direction    = state.direction;

  if (!flows.length || !_flowVisible) {
    deckOverlay.setProps({ layers: [] });
    _hideTooltip();
    return;
  }

  const locMap = new Map();
  const flowTotals = new Map();   // "home||work" → dest_total
  flows.forEach(f => {
    if (!locMap.has(f.home_name)) locMap.set(f.home_name, { id: f.home_name, lat: f.home_lat, lon: f.home_lon, name: f.home_name });
    if (!locMap.has(f.work_name)) locMap.set(f.work_name, { id: f.work_name, lat: f.work_lat, lon: f.work_lon, name: f.work_name });
    flowTotals.set(`${f.home_name}||${f.work_name}`, Number(f.dest_total ?? 0));
  });

  // Outflow uses flowmap.gl's named 'Oranges' (auto-reversed for dark mode).
  // Inflow uses our custom SCHEME_GREEN array; arrays skip flowmap.gl's internal
  // reversal, so we pre-reverse for dark mode to match named-scheme behavior.
  const colorScheme = state.direction === 'outflow'
    ? 'Oranges'
    : (state.theme === 'dark' ? [...SCHEME_GREEN].reverse() : SCHEME_GREEN);

  const flowLayer = new FlowmapLayer({
    id: 'commute-flows',
    data: {
      locations: Array.from(locMap.values()),
      flows: flows.map(f => ({ origin: f.home_name, dest: f.work_name, count: Number(f.S000) })),
    },
    getLocationId:    loc  => loc.id,
    getLocationLat:   loc  => loc.lat,
    getLocationLon:   loc  => loc.lon,
    getLocationName:  loc  => loc.name,
    getFlowOriginId:  flow => flow.origin,
    getFlowDestId:    flow => flow.dest,
    getFlowMagnitude: flow => flow.count,
    darkMode: state.theme === 'dark',
    colorScheme,
    flowLinesRenderingMode: 'animated-straight',
    clusteringEnabled: false,
    locationTotalsEnabled: true,
    locationLabelsEnabled: false,
    fadeEnabled: true,
    adaptiveScalesEnabled: true,
    flowLineThicknessScale: 1.5,
    pickable: true,
    onHover: (info) => {
      const obj = info?.object;
      if (!obj || !info.picked) { _hideTooltip(); return; }
      if (obj.type === 'flow') {
        const count     = Number(obj.count);
        const originId  = obj.origin?.id ?? '';
        const destId    = obj.dest?.id   ?? '';
        const destTotal = flowTotals.get(`${originId}||${destId}`) ?? 0;
        const isOutflow = state.direction === 'outflow';

        // selPct: what % of the subject area's residents (outflow) or workforce (inflow)
        // does this line represent — always gross total, self-flow included.
        // dstPct: what % of the other zone's workforce (outflow) or residents (inflow)
        // does this line represent — destTotal from the query JOIN, already gross.
        const selDenom = isOutflow ? _selfOutTotal : _selfInTotal;
        const selPct = selDenom  > 0 ? parseFloat((count / selDenom  * 100).toFixed(1)) : null;
        const dstPct = destTotal > 0 ? parseFloat((count / destTotal * 100).toFixed(1)) : null;

        const selDonut = selPct != null ? _donutSvg(selPct, isOutflow ? 'var(--outflow)' : 'var(--inflow)')  : '';
        const dstDonut = dstPct != null ? _donutSvg(dstPct, isOutflow ? 'var(--inflow)'  : 'var(--outflow)') : '';

        const selLabel = isOutflow
          ? `of <strong>${originId}</strong>'s<br>residents`
          : `of <strong>${destId}</strong>'s<br>workforce`;
        const dstLabel = isOutflow
          ? `of <strong>${destId}</strong>'s<br>workforce`
          : `of <strong>${originId}</strong>'s<br>residents`;

        const donuts = (selDonut || dstDonut) ? `
          <div class="ft-divider"></div>
          <div class="ft-donuts">
            ${selDonut ? `<div class="ft-donut-wrap">${selDonut}<div class="ft-donut-label">${selLabel}</div></div>` : ''}
            ${dstDonut ? `<div class="ft-donut-wrap">${dstDonut}<div class="ft-donut-label">${dstLabel}</div></div>` : ''}
          </div>` : '';

        _showTooltip(info, `
          <div class="ft-route">${originId} <span class="ft-arrow">→</span> ${destId}</div>
          <div class="ft-count">${count.toLocaleString()}<span class="ft-unit">commuters</span></div>
          ${donuts}
        `);
      } else if (obj.type === 'location') {
        const locId = obj.name ?? obj.location?.id ?? '';
        if (locId === state.selectedArea) {
          const outPct = _selfOutTotal > 0 ? parseFloat((_selfFlowCount / _selfOutTotal * 100).toFixed(1)) : null;
          const inPct  = _selfInTotal  > 0 ? parseFloat((_selfFlowCount / _selfInTotal  * 100).toFixed(1)) : null;
          const outDonut = outPct != null ? _donutSvg(outPct, 'var(--outflow)') : '';
          const inDonut  = inPct  != null ? _donutSvg(inPct,  'var(--inflow)')  : '';
          const outWrap = outDonut ? `<div class="ft-donut-wrap">${outDonut}<div class="ft-donut-label">of <strong>${locId}</strong>'s<br>residents</div></div>` : '';
          const inWrap  = inDonut  ? `<div class="ft-donut-wrap">${inDonut}<div class="ft-donut-label">of <strong>${locId}</strong>'s<br>workforce</div></div>` : '';
          const centroidDonuts = state.direction === 'outflow' ? `${outWrap}${inWrap}` : `${inWrap}${outWrap}`;
          _showTooltip(info, `
            <div class="ft-route">${locId}</div>
            <div class="ft-count">${Number(_selfFlowCount).toLocaleString()}<span class="ft-unit">live &amp; work here</span></div>
            ${(outDonut || inDonut) ? `
            <div class="ft-divider"></div>
            <div class="ft-donuts">
              ${centroidDonuts}
            </div>` : ''}
          `);
        } else {
          const cta = state.direction === 'outflow'
            ? `Where do <strong>${locId}</strong> residents work?`
            : `Where do <strong>${locId}</strong> workers live?`;
          _showTooltip(info, `<div class="ft-cta">${cta}</div>`, 'map-tooltip--cta');
        }
      } else {
        _hideTooltip();
      }
    },
    onClick: (info) => {
      _deckClickedThisTick = true;
      setTimeout(() => { _deckClickedThisTick = false; }, 0);
      _hideTooltip();
      if (!onArcClick) return;
      const obj = info?.object;
      if (!obj) return;
      if (obj.type === 'flow') {
        const destId = obj.dest?.id;
        if (destId) onArcClick({ dest_name: destId });
      } else if (obj.type === 'location') {
        const locId = obj.location?.id;
        if (locId) onArcClick({ dest_name: locId });
      }
    },
  });

  deckOverlay.setProps({ layers: [flowLayer] });
}

// ── Polygon choropleth ────────────────────────────────────────────────────────

/**
 * Load boundary GeoJSON files and register them as MapLibre sources.
 * Returns true if both files loaded, false if either was missing (graceful).
 */
export async function loadBoundaries(base, theme) {
  _theme = theme;

  const tryFetch = async (url) => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return r.json();
    } catch { return null; }
  };

  const [countyGj, cityGj, houseGj, senateGj] = await Promise.all([
    tryFetch(`${base}data/county_boundaries.geojson`),
    tryFetch(`${base}data/city_boundaries.geojson`),
    tryFetch(`${base}data/house_boundaries.geojson`),
    tryFetch(`${base}data/senate_boundaries.geojson`),
  ]);

  _boundaries = { county: countyGj, city: cityGj, house: houseGj, senate: senateGj };

  if (!countyGj && !cityGj) {
    console.info('Boundary files not available — polygon layer disabled. Run: uv run scripts/process_data.py --boundaries');
    return false;
  }

  if (map?.isStyleLoaded()) _addBoundaryLayers();
  return true;
}

// Builds the MapLibre match expression for choropleth fill colors.
// Extracted so it can be called both from updateChoropleth and from transformStyle
// (where setPaintProperty is not yet available).
function _buildFillExpr(flows, selectedArea, theme, direction) {
  const isOutflow  = direction === 'outflow';
  const baseScheme = isOutflow ? SCHEME_ORANGE : SCHEME_GREEN;
  const scheme     = theme === 'dark' ? [...baseScheme].reverse() : baseScheme;

  if (!flows.length) return ['rgba', 0, 0, 0, 0];

  const maxFlow    = Math.max(...flows.map(d => Number(d.S000)), 1);
  const matchPairs = [];

  if (selectedArea) {
    const [r,g,b] = _lerpScheme(scheme, 0);
    matchPairs.push(selectedArea, ['rgba', r, g, b, theme === 'dark' ? 0.22 : 0.45]);
  }

  flows.forEach(f => {
    const t       = Math.cbrt(Number(f.S000) / maxFlow);
    const [r,g,b] = _lerpScheme(scheme, t);
    const alpha   = theme === 'dark'
      ? parseFloat((0.15 + 0.75 * t).toFixed(3))
      : parseFloat((0.12 + 0.72 * t).toFixed(3));
    matchPairs.push(f.dest_name, ['rgba', r, g, b, alpha]);
  });

  return matchPairs.length
    ? ['match', ['get', 'name'], ...matchPairs, ['rgba', 0, 0, 0, 0]]
    : ['rgba', 0, 0, 0, 0];
}

/**
 * Update choropleth fill colours to reflect the current flow data.
 * Called after each data refresh.
 *
 * selectedAreaType: the type of the currently selected subject area. When it
 * differs from aggregation, an additional outline is drawn for the subject area
 * so the user can see its geography even when a different zone layer is active.
 */
export function updateChoropleth(flows, selectedArea, aggregation, theme, direction = 'outflow', selectedAreaType = null) {
  _pendingChoropleth = { flows, selectedArea, aggregation, theme, direction, selectedAreaType };
  if (!map) return;

  const fillId = `${aggregation}-fill`;
  const selId  = `${aggregation}-selected`;

  if (!map.getLayer(fillId)) return;

  // If polygons hidden, keep everything invisible
  if (!_polygonsVisible) {
    ['county','city','house','senate'].flatMap(t => [`${t}-fill`,`${t}-outline`,`${t}-selected`]).forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    });
    return;
  }

  // Subject area type differs from aggregation — show its selected outline too
  const showSubjOutline = selectedAreaType && selectedAreaType !== aggregation;
  const subjSelId = showSubjOutline ? `${selectedAreaType}-selected` : null;

  ['county', 'city', 'house', 'senate'].forEach(t => {
    const isAgg  = t === aggregation;
    const isSubj = showSubjOutline && t === selectedAreaType;
    if (map.getLayer(`${t}-fill`))     map.setLayoutProperty(`${t}-fill`,     'visibility', isAgg  ? 'visible' : 'none');
    if (map.getLayer(`${t}-outline`))  map.setLayoutProperty(`${t}-outline`,  'visibility', isAgg  ? 'visible' : 'none');
    if (map.getLayer(`${t}-selected`)) map.setLayoutProperty(`${t}-selected`, 'visibility', (isAgg || isSubj) ? 'visible' : 'none');
  });

  // Direction-aware highlight color — inverted so the selected subject area
  // contrasts with the flow-colored destination zones.
  const isOutflow    = direction === 'outflow';
  const selLineColor = isOutflow
    ? (theme === 'dark' ? '#5aa6a7' : '#1e6f6f')
    : (theme === 'dark' ? '#e4895a' : '#cc683a');

  // Aggregation zone selected highlight — always reset dasharray in case this
  // layer was previously used as the dashed subject-area overlay.
  map.setFilter(selId, ['==', ['get', 'name'], selectedArea ?? '']);
  if (map.getLayer(selId)) {
    map.setPaintProperty(selId, 'line-color', selLineColor);
    map.setPaintProperty(selId, 'line-width', 2.5);
    map.setPaintProperty(selId, 'line-dasharray', null);
  }

  // Subject area boundary overlay (thicker dashed line to visually distinguish it)
  if (subjSelId && map.getLayer(subjSelId)) {
    map.setFilter(subjSelId, ['==', ['get', 'name'], selectedArea ?? '']);
    map.setPaintProperty(subjSelId, 'line-color', selLineColor);
    map.setPaintProperty(subjSelId, 'line-width', 2.5);
    map.setPaintProperty(subjSelId, 'line-dasharray', [3, 2]);
  }

  map.setPaintProperty(fillId, 'fill-color', _buildFillExpr(flows, selectedArea, theme, direction));
}

// ── Fly / fit ─────────────────────────────────────────────────────────────────

export function flyToArea(lat, lon, zoom = 10) {
  map?.flyTo({ center: [lon, lat], zoom, duration: 1000 });
}

export function fitToFlows(flows) {
  if (!map || !flows.length) return;
  const lons = flows.flatMap(d => [d.home_lon, d.work_lon]).filter(Boolean);
  const lats = flows.flatMap(d => [d.home_lat, d.work_lat]).filter(Boolean);
  if (!lons.length) return;
  map.fitBounds(
    [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 60, duration: 800, maxZoom: 11 }
  );
}

// ── Neighbor zone dots ────────────────────────────────────────────────────────

/**
 * Load neighbor zone metadata and render point dots on the map.
 * metaArr: array from neighbor_meta.json — each entry has display_name, lat, lon, state, state_abbr.
 */
export function loadNeighborZones(metaArr) {
  _neighborMeta = Object.fromEntries((metaArr ?? []).map(z => [z.display_name, z]));
  if (map?.isStyleLoaded()) _addNeighborLayer();
}

/**
 * Update the flow counts shown in neighbor zone tooltips.
 * index: {display_name -> {in: N, out: N}}  (built from queryNeighborFlows results)
 */
export function updateNeighborFlowIndex(index) {
  _neighborFlowIndex = index ?? {};
}

/**
 * Filter the neighbor zone dot layer to match the current map zone aggregation.
 * aggregation: 'city' | 'county'
 * Shows city dots when map zone is Cities, county dots when map zone is Counties.
 */
export function setNeighborAggregation(aggregation) {
  if (!map || !map.getLayer('neighbor-zone-dots')) return;
  const type = aggregation === 'county' ? 'county' : 'city';
  map.setFilter('neighbor-zone-dots', ['==', ['get', 'zone_type'], type]);
}

function _neighborDotColor() {
  return _theme === 'dark' ? '#9ca3af' : '#6b7280';
}

function _addNeighborLayer() {
  if (!map || !Object.keys(_neighborMeta).length) return;

  const geojson = {
    type: 'FeatureCollection',
    features: Object.values(_neighborMeta).map(z => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [z.lon, z.lat] },
      properties: {
        display_name: z.display_name,
        state:        z.state,
        state_abbr:   z.state_abbr,
        zone_type:    z.type,   // 'city' | 'county' — used by setNeighborAggregation filter
      },
    })),
  };

  const dotColor = _neighborDotColor();

  if (map.getSource('neighbor-zones')) {
    map.getSource('neighbor-zones').setData(geojson);
    map.setPaintProperty('neighbor-zone-dots', 'circle-color', dotColor);
    return;
  }

  map.addSource('neighbor-zones', { type: 'geojson', data: geojson });

  // Insert above selected borders but below custom-info-fill (HAFB overlay)
  const before = map.getLayer('custom-info-fill') ? 'custom-info-fill' : _fillInsertionLayer();
  map.addLayer({
    id: 'neighbor-zone-dots',
    type: 'circle',
    source: 'neighbor-zones',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 10, 5],
      'circle-color': dotColor,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.85,
    },
  }, before);

  map.on('mousemove', 'neighbor-zone-dots', (e) => {
    if (!e.features?.length) return;
    const p   = e.features[0].properties;
    const rec = map.getContainer().getBoundingClientRect();
    const el  = _ensureTooltip();
    el.innerHTML = _neighborTooltipHtml(p);
    el.style.display = 'block';
    el.style.left = `${rec.left + e.point.x + 16}px`;
    el.style.top  = `${rec.top  + e.point.y - 12}px`;
  });
  map.on('mouseleave', 'neighbor-zone-dots', () => _hideTooltip());
}

function _neighborTooltipHtml(props) {
  const name  = props.display_name;
  const flows = _neighborFlowIndex[name];
  const fmt   = n => Number(n ?? 0).toLocaleString();
  if (!flows) return `<div class="ft-route">${name}</div>`;
  const outLine = flows.out > 0 ? `<div class="ft-unit" style="margin-top:4px">Out: ${fmt(flows.out)} UT residents</div>` : '';
  const inLine  = flows.in  > 0 ? `<div class="ft-unit" style="margin-top:2px">In: ${fmt(flows.in)} workers to UT</div>`  : '';
  return `<div class="ft-route">${name}</div>${outLine}${inLine}`;
}

// ── Info-only custom places (non-selectable polygons with click popup) ────────

export function loadInfoOnlyPlaces(features) {
  _infoFeatures = features ?? [];
  if (map?.isStyleLoaded()) _addInfoLayers();
}

function _addInfoLayers() {
  if (!map || !_infoFeatures.length) return;

  const geojson    = { type: 'FeatureCollection', features: _infoFeatures };
  const fillColor  = _theme === 'dark' ? 'rgba(251,191,36,0.07)' : 'rgba(217,119,6,0.09)';
  const lineColor  = _theme === 'dark' ? '#fbbf24'               : '#b45309';
  const before     = _fillInsertionLayer();

  if (map.getSource('custom-info')) {
    map.getSource('custom-info').setData(geojson);
    if (map.getLayer('custom-info-fill')) map.setPaintProperty('custom-info-fill', 'fill-color', fillColor);
    if (map.getLayer('custom-info-line')) map.setPaintProperty('custom-info-line', 'line-color', lineColor);
    return;
  }

  map.addSource('custom-info', { type: 'geojson', data: geojson });
  map.addLayer({
    id: 'custom-info-fill', type: 'fill', source: 'custom-info',
    paint: { 'fill-color': fillColor },
  }, before);
  map.addLayer({
    id: 'custom-info-line', type: 'line', source: 'custom-info',
    paint: { 'line-color': lineColor, 'line-width': 1.5, 'line-dasharray': [3, 2] },
  }, before);
  _ensureLabelsOnTop();
  _enforceLayerOrder();

  map.on('mouseenter', 'custom-info-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'custom-info-fill', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'custom-info-fill', (e) => {
    if (_deckClickedThisTick) return;
    const p = e.features?.[0]?.properties;
    if (!p) return;
    new maplibregl.Popup({ maxWidth: '280px', className: 'custom-info-popup' })
      .setLngLat(e.lngLat)
      .setHTML(`
        <div class="ci-name">${p.name}</div>
        ${p.employees_approx ? `<div class="ci-employees">${p.employees_approx} employees</div>` : ''}
        <div class="ci-note">${p.note}</div>
      `)
      .addTo(map);
  });
}

// ── Internal: add boundary layers after style load ────────────────────────────

// ── Zoom / reset helpers (wired from main.js) ─────────────────────────────────

export function zoomIn()    { map?.zoomIn(); }
export function zoomOut()   { map?.zoomOut(); }
export function resetView() { map?.flyTo({ ...INITIAL_VIEW, duration: 800 }); }

const _KEEP_LABEL_RE = /^place_(continent|country_|state|city|capital|town|village)/;

// Returns the ID of the first kept place-label layer.
// Fills are inserted immediately before it, so:
//   roads/buildings → [moved non-kept labels] → [our fills] → kept place labels
function _fillInsertionLayer() {
  const layers = map.getStyle()?.layers ?? [];
  const first = layers.find(l => l.type === 'symbol' && _KEEP_LABEL_RE.test(l.id));
  if (first) return first.id;
  // Fallback: after country boundary lines
  for (const anchor of ['boundary_country_inner', 'building-top', 'building']) {
    const i = layers.findIndex(l => l.id === anchor);
    if (i >= 0 && i + 1 < layers.length) return layers[i + 1].id;
  }
  return undefined;
}

// Enforces z-order: *-selected borders sit just below custom-info-* layers so the
// selected zone outline renders above the choropleth but below HAFB and tooltips.
// Called after any layer-adding operation to guard against fetch-order races.
function _enforceLayerOrder() {
  if (!map || !map.getLayer('custom-info-fill')) return;
  // selected borders → below neighbor dots → below custom-info (HAFB)
  for (const t of ['county', 'city', 'house', 'senate']) {
    const id = `${t}-selected`;
    if (map.getLayer(id)) map.moveLayer(id, 'custom-info-fill');
  }
  if (map.getLayer('neighbor-zone-dots')) map.moveLayer('neighbor-zone-dots', 'custom-info-fill');
}

// Moves all kept place-label layers to the very top of the layer stack so they
// always render above our choropleth fills, regardless of how layers were added.
function _ensureLabelsOnTop() {
  if (!map) return;
  const layers = map.getStyle()?.layers ?? [];
  layers.forEach(l => {
    if (l.type === 'symbol' && _KEEP_LABEL_RE.test(l.id)) map.moveLayer(l.id);
  });
}

// Moves all non-kept symbol layers (road labels, POIs, water names, hamlets,
// suburbs, …) to just before the fill insertion point so they render below our
// choropleth fills rather than being hidden entirely.
function _filterLabels() {
  if (!map) return;
  const anchor = _fillInsertionLayer();
  if (!anchor) return;
  const layers = [...(map.getStyle()?.layers ?? [])]; // snapshot before mutations
  layers.forEach(layer => {
    if (layer.type !== 'symbol') return;
    if (!_KEEP_LABEL_RE.test(layer.id)) map.moveLayer(layer.id, anchor);
  });
}

function _addBoundaryLayers() {
  if (!map) return;

  const outlineColor     = _theme === 'dark' ? 'rgba(232,229,220,0.15)' : 'rgba(18,23,38,0.18)';
  const outlineColorCity = _theme === 'dark' ? 'rgba(232,229,220,0.10)' : 'rgba(18,23,38,0.12)';
  const selColor         = _theme === 'dark' ? '#e4895a'                : '#cc683a';

  const before = _fillInsertionLayer();

  const _addOrUpdate = (srcId, layerId, data, addFn, updateFn) => {
    if (!data) return;
    if (map.getSource(srcId)) {
      map.getSource(srcId).setData(data);
      updateFn();
    } else {
      map.addSource(srcId, { type: 'geojson', data });
      addFn();
    }
  };

  if (_boundaries.county) {
    _addOrUpdate(
      'county-zones', 'county-fill', _boundaries.county,
      () => {
        map.addLayer({ id: 'county-fill',     type: 'fill', source: 'county-zones', paint: { 'fill-color': 'rgba(0,0,0,0)' } }, before);
        map.addLayer({ id: 'county-outline',  type: 'line', source: 'county-zones', paint: { 'line-color': outlineColor, 'line-width': 1 } }, before);
        map.addLayer({ id: 'county-selected', type: 'line', source: 'county-zones', filter: ['==', ['get', 'name'], ''], paint: { 'line-color': selColor, 'line-width': 2.5 } }, before);
      },
      () => {
        map.setPaintProperty('county-outline',  'line-color', outlineColor);
        map.setPaintProperty('county-selected', 'line-color', selColor);
      },
    );
  }

  if (_boundaries.city) {
    _addOrUpdate(
      'city-zones', 'city-fill', _boundaries.city,
      () => {
        map.addLayer({ id: 'city-fill',     type: 'fill', source: 'city-zones', layout: { visibility: 'none' }, paint: { 'fill-color': 'rgba(0,0,0,0)' } }, before);
        map.addLayer({ id: 'city-outline',  type: 'line', source: 'city-zones', layout: { visibility: 'none' }, paint: { 'line-color': outlineColorCity, 'line-width': 0.5 } }, before);
        map.addLayer({ id: 'city-selected', type: 'line', source: 'city-zones', layout: { visibility: 'none' }, filter: ['==', ['get', 'name'], ''], paint: { 'line-color': selColor, 'line-width': 2.5 } }, before);
      },
      () => {
        map.setPaintProperty('city-outline',  'line-color', outlineColorCity);
        map.setPaintProperty('city-selected', 'line-color', selColor);
      },
    );
  }

  if (_boundaries.house) {
    _addOrUpdate(
      'house-zones', 'house-fill', _boundaries.house,
      () => {
        map.addLayer({ id: 'house-fill',     type: 'fill', source: 'house-zones', layout: { visibility: 'none' }, paint: { 'fill-color': 'rgba(0,0,0,0)' } }, before);
        map.addLayer({ id: 'house-outline',  type: 'line', source: 'house-zones', layout: { visibility: 'none' }, paint: { 'line-color': outlineColor, 'line-width': 0.8 } }, before);
        map.addLayer({ id: 'house-selected', type: 'line', source: 'house-zones', layout: { visibility: 'none' }, filter: ['==', ['get', 'name'], ''], paint: { 'line-color': selColor, 'line-width': 2.5 } }, before);
      },
      () => {
        map.setPaintProperty('house-outline',  'line-color', outlineColor);
        map.setPaintProperty('house-selected', 'line-color', selColor);
      },
    );
  }

  if (_boundaries.senate) {
    _addOrUpdate(
      'senate-zones', 'senate-fill', _boundaries.senate,
      () => {
        map.addLayer({ id: 'senate-fill',     type: 'fill', source: 'senate-zones', layout: { visibility: 'none' }, paint: { 'fill-color': 'rgba(0,0,0,0)' } }, before);
        map.addLayer({ id: 'senate-outline',  type: 'line', source: 'senate-zones', layout: { visibility: 'none' }, paint: { 'line-color': outlineColor, 'line-width': 1 } }, before);
        map.addLayer({ id: 'senate-selected', type: 'line', source: 'senate-zones', layout: { visibility: 'none' }, filter: ['==', ['get', 'name'], ''], paint: { 'line-color': selColor, 'line-width': 2.5 } }, before);
      },
      () => {
        map.setPaintProperty('senate-outline',  'line-color', outlineColor);
        map.setPaintProperty('senate-selected', 'line-color', selColor);
      },
    );
  }

  if (_pendingChoropleth) {
    const { flows, selectedArea, aggregation, direction } = _pendingChoropleth;
    updateChoropleth(flows, selectedArea, aggregation, _theme, direction);
  }

  _ensureLabelsOnTop();
  _enforceLayerOrder();
}
