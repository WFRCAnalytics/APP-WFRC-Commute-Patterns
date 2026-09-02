import * as echarts from 'echarts';

let _demoChart     = null;
let _onAreaSelect  = null;
let _sankeyTooltip = null;

let _lastOutflows  = [];
let _lastInflows   = [];
let _lastTotalOut  = 0;
let _lastTotalIn   = 0;
let _lastSelfFlow  = 0;
let _lastState     = null;
let _lastAcsEntry  = null;
let _lastReachOut  = [];
let _lastReachIn   = [];

// Per-chart UI state (not reset on data change)
let _demoDimension  = 'age';      // 'age' | 'earnings' | 'industry'
let _industryDir    = 'outflow';  // 'outflow' | 'inflow'
let _balanceSort    = 'inflow';   // 'inflow'  | 'outflow'
let _reachOutVisible  = true;
let _reachInVisible   = true;
let _reachSelfVisible = true;
let _lastSelfBands    = null;

// Historical trend data — { years: [...], types: { [areaType]: { [areaName]: {out,in,self} } } }.
// Set once at boot (src/main.js fetches data/trends.json), independent of
// the current year/direction/aggregation — see setTrendsData().
let _trendsData = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Provide the precomputed historical trend dataset (data/trends.json, built
 * offline by scripts/build_trends.py). Value-only for now — out/in/self raw
 * totals per (areaType, area, year) — a percent-of-total view can be added
 * later without a schema change; see _renderFlowTrend()'s `mode` param.
 */
export function setTrendsData(data) {
  _trendsData = data;
}

export function initCharts(onAreaSelect) {
  _onAreaSelect = onAreaSelect;

  const demoEl = document.getElementById('demo-chart');
  if (demoEl) _demoChart = echarts.init(demoEl, null, { renderer: 'canvas' });

  const ro = new ResizeObserver(() => { _demoChart?.resize(); });
  if (demoEl) ro.observe(demoEl);

  // ── Collapse on header click — no .chart-section-header in new HTML;
  //    querySelectorAll returns empty NodeList so this is a safe no-op ──────
  document.querySelectorAll('.chart-section-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.closest('button:not(.chart-collapse-btn), input')) return;
      const btn     = header.querySelector('.chart-collapse-btn');
      const section = btn ? document.getElementById(btn.dataset.target) : null;
      if (!section) return;
      const nowCollapsed = section.classList.toggle('collapsed');
      if (btn) btn.setAttribute('aria-expanded', String(!nowCollapsed));
      if (!nowCollapsed) {
        requestAnimationFrame(() => { _demoChart?.resize(); });
      }
    });
  });

  // ── Worker Demographics tab switching (Age / Earnings in right panel) ────
  document.getElementById('demo-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('#demo-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
    ['age', 'earnings'].forEach(t => {
      const el = document.getElementById(`demo-rows-${t}`);
      if (el) el.hidden = t !== tab;
    });
  });

  // ── Worker Demographics dimension toggle (hidden demo chart) ──────────────
  document.querySelectorAll('#dim-toggle .mini-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#dim-toggle .mini-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _demoDimension = btn.dataset.dim;
      if (_lastState) _renderDemographics(_lastOutflows, _lastInflows, _lastState);
    });
  });

  // ── Industry Mix direction toggle ─────────────────────────────────────────
  document.querySelectorAll('#industry-dir-toggle .mini-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#industry-dir-toggle .mini-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _industryDir = btn.dataset.dir;
      if (_lastState) _renderIndustry(_lastOutflows, _lastInflows, _lastState);
    });
  });

  // ── Delegated click handler — covers elements in re-rendered sidebar ─────
  document.addEventListener('click', e => {
    // Flow Overview / Venn tab toggle (lives in re-rendered sidebar)
    const flowTabBtn = e.target.closest('#flow-tab-toggle .mini-toggle-btn');
    if (flowTabBtn) {
      document.querySelectorAll('#flow-tab-toggle .mini-toggle-btn').forEach(b => b.classList.remove('active'));
      flowTabBtn.classList.add('active');
      const tab = flowTabBtn.dataset.tab;
      const overviewPanel = document.getElementById('flow-overview-panel');
      const vennPanel     = document.getElementById('flow-venn-panel');
      const trendPanel    = document.getElementById('flow-trend-panel');
      if (overviewPanel) overviewPanel.style.display = tab === 'overview' ? '' : 'none';
      if (vennPanel)     vennPanel.style.display     = tab === 'venn'     ? '' : 'none';
      if (trendPanel)    trendPanel.style.display    = tab === 'trend'    ? '' : 'none';
      return;
    }

    // Reach direction toggle (must come before balance-sort-btn handler)
    const reachBtn = e.target.closest('.reach-dir-btn');
    if (reachBtn) {
      const dir = reachBtn.dataset.dir;
      if (dir === 'outflow')  _reachOutVisible  = !_reachOutVisible;
      if (dir === 'inflow')   _reachInVisible   = !_reachInVisible;
      if (dir === 'internal') _reachSelfVisible = !_reachSelfVisible;
      if (_lastState) _renderReach(_lastReachOut, _lastReachIn, _lastSelfBands, _lastState);
      return;
    }

    // Balance sort buttons
    const sortBtn = e.target.closest('.balance-sort-btn');
    if (sortBtn) {
      document.querySelectorAll('.balance-sort-btn').forEach(b => b.classList.remove('active'));
      sortBtn.classList.add('active');
      _balanceSort = sortBtn.dataset.sort;
      if (_lastState) _renderBar(_lastOutflows, _lastInflows, _lastTotalOut, _lastTotalIn, _lastState);
      return;
    }

    // Balance tab toggle
    const tabBtn = e.target.closest('#balance-tab-toggle .mini-toggle-btn');
    if (tabBtn) {
      document.querySelectorAll('#balance-tab-toggle .mini-toggle-btn').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');
      const tab = tabBtn.dataset.tab;
      const bPanel = document.getElementById('balance-tab-panel');
      const tPanel = document.getElementById('top-flows-tab-panel');
      if (bPanel) bPanel.style.display = tab === 'balance'   ? '' : 'none';
      if (tPanel) tPanel.style.display = tab === 'top-flows' ? '' : 'none';
    }
  });
}

export function updateCharts(outflows, inflows, totalOut, totalIn, selfFlow, appState, acsEntry, reachOut, reachIn, selfBands) {
  _lastOutflows  = outflows;
  _lastInflows   = inflows;
  _lastTotalOut  = totalOut;
  _lastTotalIn   = totalIn;
  _lastSelfFlow  = selfFlow ?? 0;
  _lastState     = appState;
  _lastAcsEntry  = acsEntry ?? null;
  _lastReachOut  = reachOut ?? outflows;
  _lastReachIn   = reachIn  ?? inflows;
  _lastSelfBands = selfBands ?? null;

  _renderBar(outflows, inflows, totalOut, totalIn, appState);
  _renderSankey(outflows, inflows, appState);
  _renderFlowWheel(totalIn, totalOut, selfFlow ?? 0, appState);
  _renderFlowSummary(totalIn, totalOut, selfFlow ?? 0, appState);
  _renderFlowTrend(appState);
  _renderDemographics(outflows, inflows, appState);
  _renderReach(_lastReachOut, _lastReachIn, _lastSelfBands, appState);
  _renderIndustry(outflows, inflows, appState);
  _renderTransport(acsEntry, appState);
  _renderTravelTime(acsEntry, appState);
}

// ── Exports ───────────────────────────────────────────────────────────────────

function _svgToPng(svgEl, filename, inlineStyle) {
  if (!svgEl || !_lastState) return;
  const dk    = _lastState.theme === 'dark';
  const bgCol = dk ? '#0a0e17' : '#f6f3eb';
  const vars  = {
    '--ink':       dk ? '#e8e5dc' : '#121726',
    '--ink-2':     dk ? '#c4c1b8' : '#2a2f40',
    '--ink-3':     dk ? '#92929a' : '#5b6071',
    '--ink-4':     dk ? '#696a73' : '#898d9c',
    '--rule':      dk ? 'rgba(232,229,220,0.09)' : 'rgba(18,23,38,0.10)',
    '--inflow':       dk ? '#5aa6a7' : '#1e6f6f',
    '--inflow-2':     dk ? '#408687' : '#155656',
    '--outflow':      dk ? '#e4895a' : '#cc683a',
    '--outflow-2':    dk ? '#c5703f' : '#b35828',
    '--internal':     dk ? '#b78564' : '#ac7453',
    '--internal-2':   dk ? '#9a6e50' : '#8c5c3c',
  };
  const vb    = svgEl.getAttribute('viewBox')?.split(' ');
  const vbW   = vb ? parseFloat(vb[2]) : 460;
  const vbH   = vb ? parseFloat(vb[3]) : 280;
  const ns    = 'http://www.w3.org/2000/svg';
  const clone = svgEl.cloneNode(true);

  if (inlineStyle) {
    const s = document.createElementNS(ns, 'style');
    s.textContent = inlineStyle;
    clone.insertBefore(s, clone.firstChild);
  }
  const bgRect = document.createElementNS(ns, 'rect');
  bgRect.setAttribute('width', String(vbW));
  bgRect.setAttribute('height', String(vbH));
  bgRect.setAttribute('fill', bgCol);
  clone.insertBefore(bgRect, clone.firstChild);

  clone.querySelectorAll('*').forEach(n => {
    ['fill', 'stroke'].forEach(attr => {
      const val = n.getAttribute(attr);
      if (!val) return;
      const m = val.match(/var\((--[^)]+)\)/);
      if (m && vars[m[1]]) n.setAttribute(attr, vars[m[1]]);
    });
  });

  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }));
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const canvas = document.createElement('canvas');
    canvas.width = vbW * 2; canvas.height = vbH * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.fillStyle = bgCol; ctx.fillRect(0, 0, vbW, vbH);
    ctx.drawImage(img, 0, 0, vbW, vbH);
    _dlUrl(canvas.toDataURL('image/png'), filename);
  };
  img.src = url;
}

export function exportBarPng() {
  if (!_lastState) return;
  const activeTab = document.querySelector('#balance-tab-toggle .mini-toggle-btn.active')?.dataset.tab;
  if (activeTab === 'top-flows') {
    const dk = _lastState.theme === 'dark';
    _svgToPng(
      document.getElementById('sankey-svg'),
      `commute-balance-${_lastState.selectedArea ?? 'chart'}-${_lastState.year ?? ''}.png`,
      `.sankey-label{font-size:10.5px;font-weight:600;fill:${dk ? '#c4c1b8' : '#2a2f40'};font-family:Inter,system-ui,sans-serif;letter-spacing:-0.005em}`
      + `.sankey-label.in{fill:${dk ? '#408687' : '#155656'}}.sankey-label.out{fill:${dk ? '#c5703f' : '#b35828'}}`
      + `.sankey-label.center{fill:${dk ? '#e8e5dc' : '#121726'};font-weight:700;font-size:12px}`
      + `.sankey-num{font-size:9.5px;font-weight:500;fill:${dk ? '#696a73' : '#898d9c'};font-family:Inter,system-ui,sans-serif}`
    );
    return;
  }
  const { rows: allRows } = _mergeFlows(_lastOutflows, _lastInflows, 15);
  const rows = allRows
    .filter(r => !r.isOthers)
    .sort((a, b) => (_balanceSort === 'outflow' ? b.out - a.out : b.in - a.in));
  if (!rows.length) return;

  const dk      = _lastState.theme === 'dark';
  const W       = 560, PAD = 24;
  const NUM_W   = 50, NAME_W = 110;
  const SIDE_W  = (W - PAD * 2 - NUM_W * 2 - NAME_W) / 2;
  const ROW_H   = 22, BAR_H = 14;
  const LEGEND_H = 28, AXIS_H = 22;
  const H = PAD + LEGEND_H + AXIS_H + rows.length * ROW_H + PAD;

  const canvas = document.createElement('canvas');
  canvas.width  = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const bg       = dk ? '#0a0e17' : '#f6f3eb';
  const ink      = dk ? '#e8e5dc' : '#121726';
  const ink3     = dk ? '#92929a' : '#5b6071';
  const ink4     = dk ? '#696a73' : '#898d9c';
  const ruleStr  = dk ? 'rgba(232,229,220,0.20)' : 'rgba(18,23,38,0.22)';
  const highlight = dk ? '#1a1f30' : '#f4ecd9';
  const inflow   = dk ? '#5aa6a7' : '#1e6f6f';
  const outflow  = dk ? '#e4895a' : '#cc683a';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const max     = Math.max(...rows.flatMap(r => [r.out, r.in]));
  const step    = _niceStep(max);
  const axisMax = Math.ceil(max / step) * step || 1;
  const bw      = n => (n / axisMax) * SIDE_W;

  // x anchors
  const xInNum   = PAD;
  const xInSide  = PAD + NUM_W;
  const xName    = PAD + NUM_W + SIDE_W;
  const xOutSide = PAD + NUM_W + SIDE_W + NAME_W;
  const xOutNum  = PAD + NUM_W + SIDE_W + NAME_W + SIDE_W;

  let y = PAD;

  // Legend
  const pipS = 8;
  ctx.fillStyle = inflow;
  ctx.fillRect(W / 2 - 60, y + (LEGEND_H - pipS) / 2, pipS, pipS);
  ctx.fillStyle = ink3;
  ctx.font = '600 10.5px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('INFLOW', W / 2 - 60 + pipS + 6, y + LEGEND_H / 2);
  ctx.fillStyle = outflow;
  ctx.fillRect(W / 2 + 10, y + (LEGEND_H - pipS) / 2, pipS, pipS);
  ctx.fillStyle = ink3;
  ctx.fillText('OUTFLOW', W / 2 + 10 + pipS + 6, y + LEGEND_H / 2);
  y += LEGEND_H;

  // Axis line
  ctx.fillStyle = ruleStr;
  ctx.fillRect(xInSide, y + AXIS_H - 1, SIDE_W * 2 + NAME_W, 1);

  ctx.font = '400 9.5px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink4;
  ctx.textAlign = 'left';
  ctx.fillText(axisMax.toLocaleString(), xInNum + 2, y + AXIS_H - 4);
  ctx.textAlign = 'center';
  ctx.fillStyle = ink3;
  ctx.fillText('0', xName + NAME_W / 2, y + AXIS_H - 4);
  ctx.textAlign = 'right';
  ctx.fillStyle = ink4;
  ctx.fillText(axisMax.toLocaleString(), xOutNum + NUM_W - 2, y + AXIS_H - 4);
  y += AXIS_H;

  // Rows
  rows.forEach((r, i) => {
    if (i % 2 === 0) {
      ctx.fillStyle = highlight;
      ctx.fillRect(PAD, y, W - PAD * 2, ROW_H);
    }

    const barY = y + (ROW_H - BAR_H) / 2;

    // Inflow bar (right-aligned inside left side)
    ctx.fillStyle = inflow;
    const inW = bw(r.in);
    ctx.fillRect(xInSide + SIDE_W - inW, barY, inW, BAR_H);

    // Outflow bar (left-aligned inside right side)
    ctx.fillStyle = outflow;
    ctx.fillRect(xOutSide, barY, bw(r.out), BAR_H);

    // Numbers
    ctx.fillStyle = ink;
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText(r.in.toLocaleString(),  xInSide - 4,       y + ROW_H / 2);
    ctx.textAlign = 'left';
    ctx.fillText(r.out.toLocaleString(), xOutNum + 4,       y + ROW_H / 2);

    // City name
    ctx.fillStyle = ink3;
    ctx.font = '500 11.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(r.name, xName + NAME_W / 2, y + ROW_H / 2, NAME_W - 8);

    y += ROW_H;
  });

  const area = _lastState.selectedArea ?? 'chart';
  _dlUrl(canvas.toDataURL('image/png'), `commute-balance-${area}-${_lastState.year ?? ''}.png`);
}
export function exportSankeyPng() {
  if (!_lastState) return;
  const area      = _lastState.selectedArea ?? 'chart';
  const year      = _lastState.year ?? '';
  const activeTab = document.querySelector('#flow-tab-toggle .mini-toggle-btn.active')?.dataset.tab;
  if (activeTab === 'trend') {
    _svgToPng(document.getElementById('flow-trend-chart')?.querySelector('svg'), `commute-trend-${area}.png`);
    return;
  }
  const svgEl = activeTab === 'overview'
    ? document.getElementById('flow-wheel')?.querySelector('svg')
    : document.getElementById('flow-summary')?.querySelector('svg');
  _svgToPng(svgEl, `commute-flow-${area}-${year}.png`);
}
export function exportDemoPng() {
  _pngDownload(_demoChart, `worker-demographics-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}`);
}
export function exportReachPng() {
  if (!_lastState) return;
  const outB  = _bucketFlows(_lastReachOut);
  const inB   = _bucketFlows(_lastReachIn);
  const selfB = _lastSelfBands ?? [0, 0, 0, 0, 0, 0];
  const dk    = _lastState.theme === 'dark';

  const outColor  = dk ? '#e4895a' : '#cc683a';
  const inColor   = dk ? '#5aa6a7' : '#1e6f6f';
  const selfColor = dk ? '#b78564' : '#ac7453';
  const bg        = dk ? '#0a0e17' : '#f6f3eb';
  const ink4      = dk ? '#696a73' : '#898d9c';
  const axisLine  = dk ? 'rgba(232,229,220,0.09)' : 'rgba(18,23,38,0.10)';

  // Mirror the on-screen chart: same series, same show/hide state.
  const series = [
    { label: 'Inflow',     color: inColor,   bars: inB,   visible: _reachInVisible },
    { label: 'Live & Work', color: selfColor, bars: selfB, visible: _reachSelfVisible },
    { label: 'Outflow',    color: outColor,  bars: outB,   visible: _reachOutVisible },
  ].filter(s => s.visible);
  const shown = series.length ? series : [{ label: 'Inflow', color: inColor, bars: inB }];
  shown.forEach(s => { s.total = s.bars.reduce((a, v) => a + v, 0) || 1; });

  const W = 560, H = 260;
  const ml = 48, mr = 16, mt = 24, mb = 44, lgdH = 22;
  const ch = H - mt - mb - lgdH;
  const cw = W - ml - mr;

  const canvas = document.createElement('canvas');
  canvas.width = W * 2; canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const maxCount = Math.max(1, ...shown.flatMap(s => s.bars)) || 1;
  const step = _niceStep(maxCount);
  const yMax = Math.ceil(maxCount / step) * step || 1;
  const yFmt = v => v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M'
    : v >= 1000 ? Math.round(v / 1000) + 'k' : v.toString();

  // Gridlines + Y labels
  for (let i = 0; i <= 4; i++) {
    const val = (yMax / 4) * i;
    const y   = mt + ch - (val / yMax) * ch;
    ctx.strokeStyle = axisLine; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(W - mr, y); ctx.stroke();
    ctx.fillStyle = ink4;
    ctx.font = '500 9.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(yFmt(val), ml - 5, y);
  }

  // Baseline
  const bly = mt + ch;
  ctx.strokeStyle = axisLine; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ml, bly); ctx.lineTo(W - mr, bly); ctx.stroke();

  const groupW = cw / 6;
  const barGap = shown.length > 2 ? 3 : 4;
  const barW   = Math.min(22, (groupW * 0.82 - (shown.length - 1) * barGap) / shown.length);
  const rowOff = (groupW - barW * shown.length - barGap * (shown.length - 1)) / 2;

  REACH_LABELS.forEach((lbl, i) => {
    const gx = ml + i * groupW;

    shown.forEach((s, si) => {
      const v  = s.bars[i];
      const bx = gx + rowOff + si * (barW + barGap);
      const bh = (v / yMax) * ch;
      const by = mt + ch - bh;
      ctx.fillStyle = s.color;
      ctx.fillRect(Math.round(bx), Math.round(by), Math.round(barW), Math.round(bh));
      // Match the on-screen chart: label every non-zero band, not just tall bars.
      const pct = Math.round((v / s.total) * 100);
      if (pct > 0) {
        ctx.fillStyle = ink4;
        ctx.font = '500 9px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(`${pct}%`, bx + barW / 2, by - 2);
      }
    });

    ctx.fillStyle = ink4;
    ctx.font = '500 9.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(lbl, gx + groupW / 2, bly + 6);
  });

  // Legend
  const lgdY = H - lgdH + 4;
  const SW = 10;
  let lx = ml;
  shown.forEach(({ label, color }) => {
    ctx.fillStyle = color;
    ctx.fillRect(lx, lgdY, SW, SW);
    ctx.fillStyle = ink4;
    ctx.font = '500 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + SW + 4, lgdY + SW / 2);
    lx += SW + 4 + ctx.measureText(label).width + 16;
  });

  _dlUrl(canvas.toDataURL('image/png'), `commute-reach-${_lastState.selectedArea ?? 'chart'}-${_lastState.year ?? ''}.png`);
}

export function exportBarCsv() {
  if (!_lastState) return;
  // CSV lists every city (the chart itself is capped at 15 via _mergeFlows);
  // _mergeFlows returns the full uncapped, sorted list as `all`.
  const { all } = _mergeFlows(_lastOutflows, _lastInflows, 15);
  const rows = all
    .slice()
    .sort((a, b) => (_balanceSort === 'outflow' ? b.out - a.out : b.in - a.in));
  const header = ['Area', 'Inflow (Workers In)', 'Inflow %', 'Outflow (Residents Out)', 'Outflow %'];
  const data = rows.map(d => [
    d.name,
    d.in,
    _lastTotalIn  > 0 ? ((d.in  / _lastTotalIn)  * 100).toFixed(1) + '%' : '0.0%',
    d.out,
    _lastTotalOut > 0 ? ((d.out / _lastTotalOut) * 100).toFixed(1) + '%' : '0.0%',
  ]);
  _csvDownload([header, ...data], `commute-balance-${_lastState.selectedArea}-${_lastState.year}`);
}

export function exportSankeyCsv() {
  if (!_lastState) return;
  const area      = _lastState.selectedArea;
  const activeTab = document.querySelector('#flow-tab-toggle .mini-toggle-btn.active')?.dataset.tab;
  if (activeTab === 'trend') {
    const years  = _trendsData?.years ?? [];
    const series = _trendsData?.types?.[_lastState.selectedAreaType]?.[area];
    const net    = series ? _netTrendSeries(series) : null;
    const header = ['Year', 'Inflow (Workers In)', 'Outflow (Residents Out)', 'Live & Work'];
    const rows = years.map((y, i) => [
      y,
      net?.in[i]   ?? '',
      net?.out[i]  ?? '',
      net?.self[i] ?? '',
    ]);
    _csvDownload([header, ...rows], `commute-trend-${area}`);
    return;
  }
  const header = ['Direction', 'From', 'To', 'Commuters'];
  const rows = [
    ..._lastInflows.slice(0, 5).map(f  => ['Inflow',  f.dest_name, area,        Number(f.S000)]),
    ..._lastOutflows.slice(0, 5).map(f => ['Outflow', area,        f.dest_name, Number(f.S000)]),
  ];
  _csvDownload([header, ...rows], `commute-flow-${area}-${_lastState.year}`);
}

export function exportDemoCsv() {
  if (!_lastState) return;
  const aggrOut = _aggregate(_lastOutflows);
  const aggrIn  = _aggregate(_lastInflows);
  const header = ['Dimension', 'Category', 'Outflow (Residents Out)', 'Inflow (Workers In)'];
  const rows = [
    ['Age', 'Under 30',  aggrOut.SA01, aggrIn.SA01],
    ['Age', '30–54',     aggrOut.SA02, aggrIn.SA02],
    ['Age', '55+',       aggrOut.SA03, aggrIn.SA03],
    ['Earnings', '≤$1,250/mo',    aggrOut.SE01, aggrIn.SE01],
    ['Earnings', '$1,251–3,333',  aggrOut.SE02, aggrIn.SE02],
    ['Earnings', '>$3,333',       aggrOut.SE03, aggrIn.SE03],
    ['Industry', 'Goods',         aggrOut.SI01, aggrIn.SI01],
    ['Industry', 'Trade/Transport', aggrOut.SI02, aggrIn.SI02],
    ['Industry', 'Services',      aggrOut.SI03, aggrIn.SI03],
  ];
  _csvDownload([header, ...rows], `worker-demographics-${_lastState.selectedArea}-${_lastState.year}`);
}

export function exportReachCsv() {
  if (!_lastState) return;
  const outB  = _bucketFlows(_lastReachOut);
  const inB   = _bucketFlows(_lastReachIn);
  const selfB = _lastSelfBands ?? [0, 0, 0, 0, 0, 0];
  const header = ['Direction', ...REACH_LABELS, 'Total'];
  const rows = [
    ['Inflow',   ...inB,   inB.reduce((s, v) => s + v, 0)],
    ['Live & Work', ...selfB, selfB.reduce((s, v) => s + v, 0)],
    ['Outflow',  ...outB,  outB.reduce((s, v) => s + v, 0)],
  ];
  _csvDownload([header, ...rows], `commute-reach-${_lastState.selectedArea}-${_lastState.year}`);
}

export function exportIndustryPng() {
  if (!_lastState) return;
  const flows = _industryDir === 'outflow' ? _lastOutflows : _lastInflows;
  const top5  = flows.slice(0, 5);
  if (!top5.length) return;

  const totals   = top5.map(f => Number(f.SI01||0) + Number(f.SI02||0) + Number(f.SI03||0));
  const maxTotal = Math.max(...totals) || 1;
  const dk       = _lastState.theme === 'dark';

  const W = 560, PAD = 24, BAR_H = 12, ROW_GAP = 14, HEAD_H = 18;
  const ROW_H = HEAD_H + BAR_H + ROW_GAP;
  const H = PAD + top5.length * ROW_H + 20 + 22 + PAD; // rows + legend rule + legend + padding

  const canvas = document.createElement('canvas');
  canvas.width  = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const bg      = dk ? '#0a0e17' : '#f6f3eb';
  const ink     = dk ? '#e8e5dc' : '#121726';
  const ink3    = dk ? '#92929a' : '#5b6071';
  const ruleBg  = dk ? 'rgba(232,229,220,0.09)' : 'rgba(18,23,38,0.10)';
  const ruleStr = dk ? 'rgba(232,229,220,0.20)' : 'rgba(18,23,38,0.22)';
  const paper   = dk ? '#0a0e17' : '#f6f3eb';
  // Single color ramp (8/30/52% paper mix), direction-aware, matching CSS
  const isInflow = _industryDir === 'inflow';
  const [goodsC, tradeC, servC] = isInflow
    ? (dk ? ['#4a9394', '#376f6f', '#244b4b'] : ['#1c6b6b', '#125252', '#083939'])
    : (dk ? ['#d47f52', '#a8603a', '#7d4222'] : ['#c4613a', '#a24926', '#803112']);

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const maxBarW = W - PAD * 2;
  let y = PAD;

  top5.forEach((f, i) => {
    const total = totals[i];
    const gN = Number(f.SI01 || 0);
    const tN = Number(f.SI02 || 0);
    const sN = Number(f.SI03 || 0);
    const barW = (total / maxTotal) * maxBarW;

    // ir-head
    ctx.fillStyle = ink;
    ctx.font = '600 11.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(f.dest_name, PAD, y + HEAD_H / 2);
    ctx.fillStyle = ink3;
    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(total.toLocaleString(), W - PAD, y + HEAD_H / 2);

    y += HEAD_H;

    // Bar background
    ctx.fillStyle = ruleBg;
    ctx.fillRect(PAD, y, maxBarW, BAR_H);

    // Segments
    let x = PAD;
    [{ n: gN, c: goodsC }, { n: tN, c: tradeC }, { n: sN, c: servC }].forEach(seg => {
      const sw = total > 0 ? (seg.n / total) * barW : 0;
      if (sw < 0.5) { x += sw; return; }
      ctx.fillStyle = seg.c;
      ctx.fillRect(x, y, sw, BAR_H);
      const pct = total > 0 ? seg.n / total : 0;
      if (pct >= 0.18) {
        ctx.fillStyle = paper;
        ctx.font = '700 9px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(pct * 100)}%`, x + sw / 2, y + BAR_H / 2);
      }
      x += sw;
    });

    y += BAR_H + ROW_GAP;
  });

  // Legend
  ctx.fillStyle = ruleStr;
  ctx.fillRect(PAD, y, maxBarW, 1);
  y += 11;

  let lx = PAD;
  [{ label: 'GOODS', c: goodsC }, { label: 'TRADE', c: tradeC }, { label: 'SERVICES', c: servC }].forEach(item => {
    ctx.fillStyle = item.c;
    ctx.fillRect(lx, y, 10, 10);
    ctx.fillStyle = ink3;
    ctx.font = '600 10.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.label, lx + 14, y + 5);
    lx += 14 + ctx.measureText(item.label).width + 16;
  });

  const area = _lastState.selectedArea ?? 'chart';
  _dlUrl(canvas.toDataURL('image/png'), `industry-mix-${area}-${_lastState.year ?? ''}.png`);
}

export function exportIndustryCsv() {
  if (!_lastState) return;
  const flows = _industryDir === 'outflow' ? _lastOutflows : _lastInflows;
  const top5  = flows.slice(0, 5);
  const header = ['City', 'Goods (SI01)', 'Trade/Transport (SI02)', 'Services (SI03)', 'Total'];
  const rows = top5.map(f => [
    f.dest_name,
    Number(f.SI01 || 0),
    Number(f.SI02 || 0),
    Number(f.SI03 || 0),
    Number(f.S000),
  ]);
  _csvDownload([header, ...rows], `industry-mix-${_lastState.selectedArea}-${_lastState.year}`);
}

export function resizeCharts() {
  _demoChart?.resize();
}

// ── Shared data helpers ───────────────────────────────────────────────────────

function _mergeFlows(outflows, inflows, topN) {
  const byCity = {};
  outflows.forEach(f => {
    byCity[f.dest_name] = byCity[f.dest_name] || { name: f.dest_name, out: 0, in: 0, isNeighbor: !!f.isNeighbor };
    byCity[f.dest_name].out = Number(f.S000);
    if (f.isNeighbor) byCity[f.dest_name].isNeighbor = true;
  });
  inflows.forEach(f => {
    byCity[f.dest_name] = byCity[f.dest_name] || { name: f.dest_name, out: 0, in: 0, isNeighbor: !!f.isNeighbor };
    byCity[f.dest_name].in = Number(f.S000);
    if (f.isNeighbor) byCity[f.dest_name].isNeighbor = true;
  });
  const sorted = Object.values(byCity).sort((a, b) => (b.out + b.in) - (a.out + a.in));
  const rows   = sorted.slice(0, topN);
  const rest   = sorted.slice(topN);
  if (rest.length > 0) {
    rows.push({
      name: 'Others',
      out: rest.reduce((s, d) => s + d.out, 0),
      in:  rest.reduce((s, d) => s + d.in,  0),
      isOthers: true,
    });
  }
  return { rows, all: sorted };
}

function _aggregate(flows) {
  return flows.reduce((acc, f) => ({
    SA01: acc.SA01 + Number(f.SA01 || 0),
    SA02: acc.SA02 + Number(f.SA02 || 0),
    SA03: acc.SA03 + Number(f.SA03 || 0),
    SE01: acc.SE01 + Number(f.SE01 || 0),
    SE02: acc.SE02 + Number(f.SE02 || 0),
    SE03: acc.SE03 + Number(f.SE03 || 0),
    SI01: acc.SI01 + Number(f.SI01 || 0),
    SI02: acc.SI02 + Number(f.SI02 || 0),
    SI03: acc.SI03 + Number(f.SI03 || 0),
  }), { SA01:0, SA02:0, SA03:0, SE01:0, SE02:0, SE03:0, SI01:0, SI02:0, SI03:0 });
}

const REACH_BANDS  = [5, 10, 25, 50, 100, Infinity];
const REACH_LABELS = ['< 5 mi', '5–10 mi', '10–25 mi', '25–50 mi', '50–100 mi', '100+ mi'];

function _bucketFlows(flows) {
  if (!flows.length) return [0, 0, 0, 0, 0, 0];
  // Use precomputed block-centroid distance bands when available (more accurate than city centroids)
  if (flows[0].d0_5 != null) {
    return flows.reduce((acc, f) => {
      acc[0] += Number(f.d0_5    || 0);
      acc[1] += Number(f.d5_10   || 0);
      acc[2] += Number(f.d10_25  || 0);
      acc[3] += Number(f.d25_50  || 0);
      acc[4] += Number(f.d50_100 || 0);
      acc[5] += Number(f.d100p   || 0);
      return acc;
    }, [0, 0, 0, 0, 0, 0]);
  }
  // Fallback: compute from city/county centroids (legacy data without band columns)
  const counts = [0, 0, 0, 0, 0, 0];
  flows.forEach(f => {
    if (f.home_lat == null || f.work_lat == null) return;
    const mi = _haversineMiles(f.home_lat, f.home_lon, f.work_lat, f.work_lon);
    const n  = Number(f.S000);
    for (let i = 0; i < REACH_BANDS.length; i++) {
      if (mi < REACH_BANDS[i]) { counts[i] += n; break; }
    }
  });
  return counts;
}

function _haversineMiles(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Theme colors ──────────────────────────────────────────────────────────────

function _tc(theme) {
  const dk = theme === 'dark';
  return {
    text:         dk ? '#c4c1b8' : '#2a2f40',
    muted:        dk ? '#696a73' : '#898d9c',
    axis:         dk ? 'rgba(232,229,220,0.09)' : 'rgba(18,23,38,0.10)',
    outflow:      dk ? '#e4895a' : '#cc683a',
    outflowMuted: dk ? 'rgba(228,137,90,0.32)'  : 'rgba(204,104,58,0.32)',
    inflow:       dk ? '#5aa6a7' : '#1e6f6f',
    inflowMuted:  dk ? 'rgba(90,166,167,0.32)'  : 'rgba(30,111,111,0.32)',
    mid:          dk ? '#7fa8a9' : '#4a8080',
    selectedNode: dk ? '#1b2031' : '#efebde',
    ttBg:         dk ? '#0a0e17' : '#f6f3eb',
    ttBorder:     dk ? 'rgba(232,229,220,0.20)' : 'rgba(18,23,38,0.22)',
  };
}

// Returns the smallest "nice" step so that ceil(max/step)*step gives a round axis ceiling.
function _niceStep(max) {
  if (max <= 0) return 1;
  const raw  = max / 3;
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm < 1.5) return mag;
  if (norm < 3.5) return 2 * mag;
  if (norm < 7.5) return 5 * mag;
  return 10 * mag;
}

// ── 1. Commute Balance — hand-built diverging bar (design-spec HTML) ──────────

function _renderBar(outflows, inflows, totalOut, totalIn, state) {
  const rowsEl = document.getElementById('balance-rows');
  const axisL  = document.getElementById('balance-axis-l');
  const axisR  = document.getElementById('balance-axis-r');
  if (!rowsEl) return;

  const { rows: allRows } = _mergeFlows(outflows, inflows, 15);
  const rows = allRows.filter(r => !r.isOthers)
    .sort((a, b) => (_balanceSort === 'outflow' ? b.out - a.out : b.in - a.in));
  if (!rows.length) { rowsEl.innerHTML = ''; return; }

  const max     = Math.max(...rows.flatMap(r => [r.out, r.in]));
  const step    = _niceStep(max);
  const axisMax = Math.ceil(max / step) * step || 1;
  const bw      = n => ((n / axisMax) * 100).toFixed(2);

  if (axisL) axisL.textContent = axisMax.toLocaleString();
  if (axisR) axisR.textContent = axisMax.toLocaleString();

  // Sync sort button state after sidebar re-render
  document.querySelectorAll('.balance-sort-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sort === _balanceSort);
  });

  const VISIBLE = 8;
  const rowHTML = r => `
    <div class="balance-row${r.isNeighbor ? ' neighbor-zone' : ''}" data-peer="${r.name}" data-neighbor="${r.isNeighbor ? 'true' : ''}">
      <div class="b-num left">${r.in.toLocaleString()}</div>
      <div class="b-side left"><div class="b-bar in" style="width:${bw(r.in)}%"></div></div>
      <div class="b-name">${r.name}</div>
      <div class="b-side right"><div class="b-bar" style="width:${bw(r.out)}%"></div></div>
      <div class="b-num right">${r.out.toLocaleString()}</div>
    </div>`;

  const top  = rows.slice(0, VISIBLE);
  const rest = rows.slice(VISIBLE);

  rowsEl.innerHTML =
    top.map(rowHTML).join('') +
    (rest.length ? `
      <div class="balance-overflow" id="balance-overflow" style="display:none;">
        ${rest.map(rowHTML).join('')}
      </div>
      <div class="balance-expand-row">
        <button class="balance-expand-btn" id="balance-expand-btn">
          <span class="balance-expand-label">Expand</span>
          <span class="balance-expand-icon">&#9660;</span>
        </button>
      </div>` : '');

  rowsEl.querySelectorAll('.balance-row').forEach(el => {
    if (el.dataset.neighbor === 'true') return; // neighbor zones are display-only
    el.addEventListener('click', () => {
      _onAreaSelect?.(el.dataset.peer, state.aggregation);
    });
  });

  const expandBtn = document.getElementById('balance-expand-btn');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const overflow = document.getElementById('balance-overflow');
      const label    = expandBtn.querySelector('.balance-expand-label');
      const icon     = expandBtn.querySelector('.balance-expand-icon');
      const expanded = overflow.style.display !== 'none';
      overflow.style.display = expanded ? 'none' : '';
      label.textContent = expanded ? 'Expand' : 'Collapse';
      icon.style.transform = expanded ? '' : 'rotate(180deg)';
      if (!expanded) {
        overflow.querySelectorAll('.balance-row').forEach(el => {
          if (el.dataset.neighbor === 'true') return;
          el.addEventListener('click', () => {
            _onAreaSelect?.(el.dataset.peer, state.aggregation);
          });
        });
      }
    });
  }
}

// ── Shared ribbon path (used by Sankey + flow summary) ───────────────────────
function _ribbonPath(x1, y1, h1, x2, y2, h2) {
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1},${cx} ${y2},${x2} ${y2} L ${x2} ${y2+h2} C ${cx} ${y2+h2},${cx} ${y1+h1},${x1} ${y1+h1} Z`;
}

function _ensureSankeyTooltip() {
  if (!_sankeyTooltip) {
    _sankeyTooltip = document.createElement('div');
    _sankeyTooltip.className = 'sankey-tooltip';
    document.body.appendChild(_sankeyTooltip);
  }
  return _sankeyTooltip;
}

// ── 2. Flow Diagram — bilateral SVG alluvial ──────────────────────────────────

function _renderSankey(outflows, inflows, state) {
  const svgEl = document.getElementById('sankey-svg');
  if (!svgEl) return;

  const sel = state.selectedArea;
  if (!inflows.length && !outflows.length) { svgEl.innerHTML = ''; return; }

  function trunc(str, max = 14) {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  // Include cities that represent ≥5% of their side's total, up to 6. Fall back to top 3.
  function buildSide(flows) {
    const sideTotal = flows.reduce((s, f) => s + Number(f.S000), 0) || 1;
    const included  = [];
    for (const f of flows) {
      const n = Number(f.S000);
      if (n / sideTotal >= 0.05 && included.length < 6) included.push({ name: f.dest_name, n });
      else break;
    }
    if (included.length < 3) {
      included.length = 0;
      flows.slice(0, 3).forEach(f => included.push({ name: f.dest_name, n: Number(f.S000) }));
    }
    const othersN = flows.slice(included.length).reduce((s, f) => s + Number(f.S000), 0);
    return othersN > 0 ? [...included, { name: 'Others', n: othersN, isOthers: true }] : included;
  }

  const inSide   = buildSide(inflows);
  const outSide  = buildSide(outflows);
  const inTotal  = inSide.reduce((s, d) => s + d.n, 0);
  const outTotal = outSide.reduce((s, d) => s + d.n, 0);

  const nShown = Math.max(inSide.filter(d => !d.isOthers).length, outSide.filter(d => !d.isOthers).length);
  const subEl  = document.getElementById('sankey-sub');
  if (subEl) subEl.textContent = `01 · Summary`;

  const W = 460, H = 280, PAD = 10;
  const LABEL_PAD = 90, CENTER_W = 120, SIDE_W = 14;
  const totalH   = H - PAD * 2;
  const maxTotal = Math.max(inTotal, outTotal, 1);
  const scale    = totalH / maxTotal;

  function makeBlocks(side, total, x) {
    let y = PAD + (totalH - total * scale) / 2;
    return side.map(s => {
      const h = Math.max(s.n * scale, 2);
      const b = { ...s, x, y, w: SIDE_W, h };
      y += h;
      return b;
    });
  }

  const leftBlocks  = makeBlocks(inSide,  inTotal,  LABEL_PAD);
  const rightBlocks = makeBlocks(outSide, outTotal, W - LABEL_PAD - SIDE_W);

  const centerX    = (W - CENTER_W) / 2;
  const centerInH  = inTotal  * scale;
  const centerOutH = outTotal * scale;
  const centerInY  = PAD + (totalH - centerInH)  / 2;
  const centerOutY = PAD + (totalH - centerOutH) / 2;

  // ribbonData includes n + sideTotal for tooltip percentage
  const ribbonData = [];
  let leftY = centerInY;
  leftBlocks.forEach(b => {
    ribbonData.push({ d: _ribbonPath(b.x + b.w, b.y, b.h, centerX, leftY, b.h), color: 'var(--inflow)', name: b.name, n: b.n, sideTotal: inTotal, isOthers: b.isOthers });
    leftY += b.h;
  });
  let rightY = centerOutY;
  rightBlocks.forEach(b => {
    ribbonData.push({ d: _ribbonPath(centerX + CENTER_W, rightY, b.h, b.x, b.y, b.h), color: 'var(--outflow)', name: b.name, n: b.n, sideTotal: outTotal, isOthers: b.isOthers });
    rightY += b.h;
  });

  const BASE_OPACITY = 0.52;

  const ribbonMarkup = ribbonData.map((r, i) =>
    `<path class="sankey-ribbon" data-idx="${i}" d="${r.d}" fill="${r.color}" opacity="${r.isOthers ? BASE_OPACITY * 0.55 : BASE_OPACITY}"/>`
  ).join('');

  const leftMarkup = leftBlocks.map(b => {
    const my = b.y + b.h / 2;
    const op = b.isOthers ? '0.4' : '0.82';
    return `<g class="sankey-block">
      <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="var(--inflow)" opacity="${op}" rx="1"/>
      <text x="${b.x - 7}" y="${my + 3}" text-anchor="end" class="sankey-label in">${trunc(b.name)}</text>
      <text x="${b.x - 7}" y="${my + 14}" text-anchor="end" class="sankey-num">${b.n.toLocaleString()}</text>
    </g>`;
  }).join('');

  const rightMarkup = rightBlocks.map(b => {
    const my = b.y + b.h / 2;
    const op = b.isOthers ? '0.4' : '0.82';
    return `<g class="sankey-block">
      <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="var(--outflow)" opacity="${op}" rx="1"/>
      <text x="${b.x + b.w + 7}" y="${my + 3}" text-anchor="start" class="sankey-label out">${trunc(b.name)}</text>
      <text x="${b.x + b.w + 7}" y="${my + 14}" text-anchor="start" class="sankey-num">${b.n.toLocaleString()}</text>
    </g>`;
  }).join('');

  // Center node: split halves showing inflow/outflow proportion, area name centered
  const centerTopY    = Math.min(centerInY, centerOutY);
  const centerBottomY = Math.max(centerInY + centerInH, centerOutY + centerOutH);
  const centerMarkup  = `
    <rect x="${centerX}"              y="${centerInY}"  width="${CENTER_W/2}" height="${centerInH}"  fill="var(--inflow-2)"  opacity="0.82" rx="1"/>
    <rect x="${centerX + CENTER_W/2}" y="${centerOutY}" width="${CENTER_W/2}" height="${centerOutH}" fill="var(--outflow-2)" opacity="0.82" rx="1"/>
    <text x="${W/2}" y="${(centerTopY + centerBottomY) / 2 + 4}" text-anchor="middle" class="sankey-label center">${trunc(sel, 16)}</text>`;

  svgEl.innerHTML = ribbonMarkup + leftMarkup + centerMarkup + rightMarkup;

  // Hover: highlight matching ribbons, show custom tooltip
  const paths = svgEl.querySelectorAll('.sankey-ribbon');
  paths.forEach((path, i) => {
    const rd = ribbonData[i];

    path.addEventListener('mouseenter', () => {
      paths.forEach((p, j) => {
        const jBase = ribbonData[j].isOthers ? BASE_OPACITY * 0.55 : BASE_OPACITY;
        p.setAttribute('opacity', ribbonData[j].name === rd.name ? String(Math.min(jBase + 0.25, 1)) : '0.12');
      });
    });

    path.addEventListener('mousemove', (e) => {
      const tt        = _ensureSankeyTooltip();
      // Always use gross totals (self-flow included) so the % reads:
      // inflow ribbon  → "X% of subject area's workforce lives here"
      // outflow ribbon → "X% of subject area's residents work here"
      const grossOut = _lastTotalOut + _lastSelfFlow;
      const grossIn  = _lastTotalIn  + _lastSelfFlow;
      const denom = rd.color === 'var(--inflow)' ? grossIn : grossOut;
      const pct = denom > 0 ? Math.round(rd.n / denom * 100) : 0;
      tt.innerHTML = `<strong>${rd.name}</strong><br>${rd.n.toLocaleString()} commuters · ${pct}%`;
      tt.style.display = 'block';
      tt.style.left    = `${e.clientX + 14}px`;
      tt.style.top     = `${e.clientY - 32}px`;
    });

    path.addEventListener('mouseleave', () => {
      paths.forEach((p, j) => {
        p.setAttribute('opacity', String(ribbonData[j].isOthers ? BASE_OPACITY * 0.55 : BASE_OPACITY));
      });
      if (_sankeyTooltip) _sankeyTooltip.style.display = 'none';
    });

    path.style.cursor = rd.isOthers ? 'default' : 'pointer';
    if (!rd.isOthers) path.addEventListener('click', () => _onAreaSelect?.(rd.name, state.aggregation));
  });
}

// ── 2b. Flow Venn — proportional overlapping circles ─────────────────────────

function _renderFlowWheel(totalIn, totalOut, selfFlow, state) {
  const el = document.getElementById('flow-wheel');
  if (!el) return;

  function fmt(n) {
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000)  return `${parseFloat((n / 1000).toFixed(1))}k`;
    return n ? n.toLocaleString() : '—';
  }

  if (!totalIn && !totalOut && !selfFlow) { el.innerHTML = ''; return; }

  const font = 'Inter, system-ui, sans-serif';
  const W = 460, H = 270;
  const cx = W / 2, cy = H / 2;  // 230, 135
  const R  = 88;

  const hasSelf = selfFlow > 0;
  const selfPct = (totalOut + selfFlow) > 0
    ? Math.round(selfFlow / (totalOut + selfFlow) * 100) : 0;

  // Same overlap color as the Venn diagram's LIVE & WORK lens
  const overlapColor = state.theme === 'dark' ? '#b78564' : '#ac7453';

  // Rotation arc geometry — two CW 150° arcs, 30° gaps at top/bottom
  const topY = cy - R;
  const botY = cy + R;
  const sw   = 12;
  const ahW  = 8;
  const ahL  = 11;
  const a1sx = (cx + R * 0.5).toFixed(1);
  const a1sy = (cy - R * 0.866).toFixed(1);
  const a2sx = (cx - R * 0.5).toFixed(1);
  const a2sy = (cy + R * 0.866).toFixed(1);
  const topAH = `${cx + ahL},${topY} ${cx - 2},${topY - ahW} ${cx - 2},${topY + ahW}`;
  const botAH = `${cx - ahL},${botY} ${cx + 2},${botY - ahW} ${cx + 2},${botY + ahW}`;

  // Ribbon sizing ∝ sqrt(flow/max) — same scale as Venn radii
  const RW_MAX = 78, RW_MIN = 22, W_TIP = 10;
  const tipLen = 22, overlap = 36;
  const maxFlow = Math.max(totalIn, totalOut, 1);
  const rw_in  = Math.max(RW_MAX * (totalIn  / maxFlow), RW_MIN);
  const rw_out = Math.max(RW_MAX * (totalOut / maxFlow), RW_MIN);

  // Left ribbon: wide at x=0, tapers via bezier to W_TIP at circle,
  // arrowhead tip overlaps ring by `overlap` px
  const lTipX  = cx - R + overlap;     // tip point (inside ring stroke)
  const lBodyX = lTipX - tipLen;       // arrowhead base / ribbon right end
  const lCP1   = lBodyX * 0.38;
  const lCP2   = lBodyX * 0.78;
  const ltx    = lBodyX / 2;
  const lAhW   = W_TIP / 2 + 10;

  const lRibbon = `M 0,${cy - rw_in/2} `
    + `C ${lCP1},${cy - rw_in/2} ${lCP2},${cy - W_TIP/2} ${lBodyX},${cy - W_TIP/2} `
    + `L ${lBodyX},${cy + W_TIP/2} `
    + `C ${lCP2},${cy + rw_in/2} ${lCP1},${cy + rw_in/2} 0,${cy + rw_in/2} Z`;

  // Right ribbon: narrow at circle, widens to full width, proper → arrowhead at far right
  const rTipX   = cx + R - overlap;
  const rBodyEnd = W - tipLen;
  const rCP1    = rTipX + (rBodyEnd - rTipX) * 0.22;
  const rCP2    = rTipX + (rBodyEnd - rTipX) * 0.62;
  const rtx     = rTipX + (rBodyEnd - rTipX) / 2;
  const rAhW    = rw_out / 2 + 8;

  const rRibbon = `M ${rTipX},${cy - W_TIP/2} `
    + `C ${rCP1},${cy - W_TIP/2} ${rCP2},${cy - rw_out/2} ${rBodyEnd},${cy - rw_out/2} `
    + `L ${rBodyEnd},${cy + rw_out/2} `
    + `C ${rCP2},${cy + rw_out/2} ${rCP1},${cy + W_TIP/2} ${rTipX},${cy + W_TIP/2} Z`;

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block;overflow:visible">

      <!-- Flow ribbons (drawn first; track ring masks overlap zone) -->
      <path d="${lRibbon}" fill="var(--inflow)"  opacity="0.16"/>
      <path d="${lRibbon}" fill="none" stroke="var(--inflow)"  stroke-width="1" opacity="0.32"/>
      <path d="${rRibbon}" fill="var(--outflow)" opacity="0.16"/>
      <path d="${rRibbon}" fill="none" stroke="var(--outflow)" stroke-width="1" opacity="0.32"/>

      <!-- Track ring — masks ribbon tips where they overlap, anchors the arcs -->
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="none"
              stroke="var(--rule)" stroke-width="${sw + 2}" opacity="1"/>

      <!-- Labels inside ribbon bodies -->
      <text x="${ltx.toFixed(1)}" y="${cy - 7}" text-anchor="middle"
            font-size="22" font-weight="700" font-family="${font}"
            fill="var(--inflow)">${fmt(totalIn)}</text>
      <text x="${ltx.toFixed(1)}" y="${cy + 13}" text-anchor="middle"
            font-size="12" font-family="${font}" fill="var(--inflow)"
            opacity="0.70" letter-spacing="0.03em">WORKERS IN</text>

      <text x="${rtx.toFixed(1)}" y="${cy - 7}" text-anchor="middle"
            font-size="22" font-weight="700" font-family="${font}"
            fill="var(--outflow)">${fmt(totalOut)}</text>
      <text x="${rtx.toFixed(1)}" y="${cy + 13}" text-anchor="middle"
            font-size="12" font-family="${font}" fill="var(--outflow)"
            opacity="0.70" letter-spacing="0.03em">RESIDENTS OUT</text>

      <!-- Arrowheads: left → tip at circle, right → tip at right edge -->
      <polygon points="${lTipX},${cy} ${lBodyX},${cy - lAhW} ${lBodyX},${cy + lAhW}"
               fill="var(--inflow)" opacity="0.75"/>
      <polygon points="${W},${cy} ${rBodyEnd},${cy - rAhW} ${rBodyEnd},${cy + rAhW}"
               fill="var(--outflow)" opacity="0.75"/>

      <!-- Rotation arcs — same color as Venn LIVE & WORK lens -->
      <path d="M ${a1sx},${a1sy} A ${R},${R} 0 0,1 ${cx},${botY}"
            fill="none" stroke="${overlapColor}" stroke-width="${sw}"
            opacity="0.60" stroke-linecap="round"/>
      <polygon points="${botAH}" fill="${overlapColor}" opacity="0.80"/>
      <path d="M ${a2sx},${a2sy} A ${R},${R} 0 0,1 ${cx},${topY}"
            fill="none" stroke="${overlapColor}" stroke-width="${sw}"
            opacity="0.60" stroke-linecap="round"/>
      <polygon points="${topAH}" fill="${overlapColor}" opacity="0.80"/>

      <!-- Center text: label → number → pct -->
      ${hasSelf ? `
        <text x="${cx}" y="${cy - 22}" text-anchor="middle"
              font-size="13" font-family="${font}" fill="${overlapColor}"
              letter-spacing="0.06em">LIVE &amp; WORK</text>
        <text x="${cx}" y="${cy + 8}" text-anchor="middle"
              font-size="32" font-weight="700" font-family="${font}"
              fill="var(--ink)">${fmt(selfFlow)}</text>
        <text x="${cx}" y="${cy + 30}" text-anchor="middle"
              font-size="17" font-weight="600" font-family="${font}"
              fill="${overlapColor}">${selfPct}%</text>
      ` : `
        <text x="${cx}" y="${cy + 4}" text-anchor="middle"
              font-size="12" font-family="${font}" fill="var(--ink-4)"
              letter-spacing="0.06em">NO LOCAL DATA</text>
      `}

    </svg>`;
}

function _renderFlowSummary(totalIn, totalOut, selfFlow, state) {
  const el = document.getElementById('flow-summary');
  if (!el) return;

  function fmt(n) {
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000)  return `${parseFloat((n / 1000).toFixed(1))}k`;
    return n ? n.toLocaleString() : '—';
  }

  if (!totalIn && !totalOut && !selfFlow) { el.innerHTML = ''; return; }

  // ── Lens-area solver ─────────────────────────────────────────
  function lensArea(r1, r2, d) {
    if (d >= r1 + r2) return 0;
    if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    const a = Math.acos(clamp((d*d + r1*r1 - r2*r2) / (2*d*r1)));
    const b = Math.acos(clamp((d*d + r2*r2 - r1*r1) / (2*d*r2)));
    return r1*r1*a + r2*r2*b
      - 0.5 * Math.sqrt(Math.max(0, (-d+r1+r2)*(d+r1-r2)*(d-r1+r2)*(d+r1+r2)));
  }

  function solveD(r1, r2, target) {
    if (target <= 0) return r1 + r2;
    if (target >= Math.PI * Math.min(r1, r2) ** 2) return Math.abs(r1 - r2);
    let lo = Math.abs(r1 - r2), hi = r1 + r2;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      lensArea(r1, r2, mid) > target ? lo = mid : hi = mid;
    }
    return (lo + hi) / 2;
  }

  const W = 460, H = 270;
  const cy = 112;
  const R_MAX = 112, MIN_R = 26;
  const font = 'Inter, system-ui, sans-serif';

  // Circles sized by total populations (cross-boundary + live&work) so the
  // overlap geometry stays solvable even when selfFlow >> cross-boundary flows.
  // Displayed numbers remain the net cross-boundary values (totalIn / totalOut).
  const rawIn  = totalIn  + selfFlow;
  const rawOut = totalOut + selfFlow;
  const maxVal = Math.max(rawIn, rawOut, 1);

  const r_in  = Math.max(R_MAX * Math.sqrt(rawIn  / maxVal), MIN_R);
  const r_out = Math.max(R_MAX * Math.sqrt(rawOut / maxVal), MIN_R);

  // Find d so lens area ∝ selfFlow
  const targetArea = Math.PI * R_MAX * R_MAX * (selfFlow / maxVal);
  const d   = solveD(r_in, r_out, targetArea);
  const cx1 = W / 2 - d / 2;
  const cx2 = W / 2 + d / 2;

  // chordX: x where the two circle edges intersect (right boundary of exclusive left cap)
  const chordX     = d > 0 ? cx1 + (d*d + r_in*r_in - r_out*r_out) / (2*d) : W / 2;
  // lensCenterX: x-midpoint of the lens bounding box [(cx2-r_out) to (cx1+r_in)]
  const lensCenterX = (W + r_in - r_out) / 2;
  // Use each circle's center for the label, clamped to stay clear of the chord
  const numInX  = Math.min(cx1, chordX - 30);
  const numOutX = Math.max(cx2, chordX + 30);

  const selfPct = (totalOut + selfFlow) > 0
    ? Math.round(selfFlow / (totalOut + selfFlow) * 100) : 0;

  // Legend below circles — legendY pinned to H=270 to match flow wheel height
  const legendY = H - 28;
  const dotR = 5, textOff = dotR * 2 + 6;
  const hasSelf = selfFlow > 0;
  const overlapColor = state.theme === 'dark' ? '#b78564' : '#ac7453';
  // Distribute legend items: 2 or 3 items centered in W
  const leg1X = hasSelf ? 38  : 110;
  const leg2X = 175;
  const leg3X = hasSelf ? 330 : 278;

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block;overflow:visible">
      <circle cx="${cx1.toFixed(1)}" cy="${cy}" r="${r_in.toFixed(1)}"  fill="var(--inflow)"  opacity="0.72"/>
      <circle cx="${cx2.toFixed(1)}" cy="${cy}" r="${r_out.toFixed(1)}" fill="var(--outflow)" opacity="0.72"/>

      <text x="${numInX.toFixed(1)}" y="${cy + 6}" text-anchor="middle"
            font-size="18" font-weight="700" font-family="${font}" fill="white" opacity="0.95">${fmt(totalIn)}</text>

      <text x="${numOutX.toFixed(1)}" y="${cy + 6}" text-anchor="middle"
            font-size="18" font-weight="700" font-family="${font}" fill="white" opacity="0.95">${fmt(totalOut)}</text>

      ${hasSelf ? `
      <text x="${lensCenterX.toFixed(1)}" y="${cy + 6}" text-anchor="middle"
            font-size="15" font-weight="700" font-family="${font}" fill="white" opacity="0.95">${fmt(selfFlow)}</text>
      ` : ''}

      <circle cx="${leg1X + dotR}" cy="${legendY + 6}" r="${dotR}" fill="var(--inflow)" opacity="0.72"/>
      <text x="${leg1X + textOff}" y="${legendY + 10}" font-size="12" font-family="${font}"
            fill="var(--ink-3)" letter-spacing="0.03em">WORKERS IN</text>

      ${hasSelf ? `
      <circle cx="${leg2X + dotR}" cy="${legendY + 6}" r="${dotR}" fill="${overlapColor}"/>
      <text x="${leg2X + textOff}" y="${legendY + 10}" font-size="12" font-family="${font}"
            fill="var(--ink-3)" letter-spacing="0.03em">LIVE &amp; WORK · ${selfPct}%</text>
      ` : ''}

      <circle cx="${leg3X + dotR}" cy="${legendY + 6}" r="${dotR}" fill="var(--outflow)" opacity="0.72"/>
      <text x="${leg3X + textOff}" y="${legendY + 10}" font-size="12" font-family="${font}"
            fill="var(--ink-3)" letter-spacing="0.03em">RESIDENTS OUT</text>
    </svg>`;
}

// ── 2c. Flow Trend — historical line chart ────────────────────────────────────
//
// Three lines (out / in / self) across every year in data/trends.json, for
// whichever Area of Interest is currently selected — independent of the
// Direction/Aggregation toggles and the year scrubber, same as the
// Overview/Venn tabs it sits beside. `mode` is a placeholder seam for a
// future percent-of-total view (each line has its own natural denominator —
// residents for out, jobs for in — so it isn't a simple flag flip; left as
// 'value' only for now).

/**
 * data/trends.json stores raw totals (workers who live/work in the area at
 * all -- self-contained workers included in both `out` and `in`). Derive
 * the same net in/out the rest of the app already shows (dataline,
 * flow-wheel, Venn -- see _applyFilter()'s netOut/netIn in src/main.js) by
 * subtracting self, so this chart/export agrees with those panels for the
 * same year instead of double-counting self-contained workers into both
 * the out and in lines.
 */
function _netTrendSeries(series) {
  return {
    out:  series.out.map((v, i) => (v == null || series.self[i] == null) ? null : v - series.self[i]),
    in:   series.in.map((v, i)  => (v == null || series.self[i] == null) ? null : v - series.self[i]),
    self: series.self,
  };
}

function _renderFlowTrend(state, mode = 'value') {
  const el = document.getElementById('flow-trend-chart');
  if (!el) return;

  const years  = _trendsData?.years ?? [];
  const series = _trendsData?.types?.[state.selectedAreaType]?.[state.selectedArea];
  // A real but effectively empty geography (e.g. a TAZ district with zero
  // recorded commuters in every year) still has a `series` entry -- all
  // three arrays are just null throughout -- so check for any actual value,
  // not just presence of the entry.
  const hasAnyValue = series && [...series.out, ...series.in, ...series.self].some(v => v != null);

  if (!years.length || !hasAnyValue) {
    el.innerHTML = `<div style="padding:24px 4px;text-align:center;font-size:12px;color:var(--ink-4);">
      No historical data for this area.
    </div>`;
    return;
  }

  const netSeries = _netTrendSeries(series);

  function fmt(n) {
    if (n == null) return '—';
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000)  return `${parseFloat((n / 1000).toFixed(1))}k`;
    return n.toLocaleString();
  }

  const W = 460, H = 220;
  const ml = 40, mr = 10, mt = 12, mb = 24;
  const cw = W - ml - mr, ch = H - mt - mb;

  const allVals = [...netSeries.out, ...netSeries.in, ...netSeries.self].filter(v => v != null);
  const maxVal  = Math.max(...allVals, 1);
  const step    = _niceStep(maxVal);
  const yMax    = Math.ceil(maxVal / step) * step || 1;

  const xAt = i => ml + (years.length > 1 ? (i / (years.length - 1)) * cw : cw / 2);
  const yAt = v => mt + ch - (v / yMax) * ch;

  // Break each line into separate M..L.. segments at null gaps, so a year
  // an area didn't yet exist in (e.g. a newly incorporated city) renders as
  // a gap rather than a false dip to zero.
  function pathFor(arr) {
    let d = '', open = false;
    arr.forEach((v, i) => {
      if (v == null) { open = false; return; }
      const x = xAt(i).toFixed(1), y = yAt(v).toFixed(1);
      d += (open ? ' L ' : (d ? ' M ' : 'M ')) + `${x} ${y}`;
      open = true;
    });
    return d;
  }

  // Axis label sizing matches the Commute Length chart's live SVG axes
  // (_renderReach below) — 12px / weight 500 / --ink-4, not the smaller
  // sizes used only in canvas PNG-export renders elsewhere in this file.
  let gridSvg = '';
  for (let i = 0; i <= 2; i++) {
    const val = (yMax / 2) * i;
    const y = yAt(val).toFixed(1);
    gridSvg += `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" stroke="var(--rule)" stroke-width="1"/>`;
    gridSvg += `<text x="${ml - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" style="font-size:12px;fill:var(--ink-4);font-weight:500;">${fmt(val)}</text>`;
  }

  // Sparse X labels — first/last year plus every 5th, mirroring the year
  // scrubber's own major-tick convention (src/main.js _buildScrubberTicks).
  let xLabels = '';
  years.forEach((y, i) => {
    if (i === 0 || i === years.length - 1 || y % 5 === 0) {
      xLabels += `<text x="${xAt(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" style="font-size:12px;fill:var(--ink-4);font-weight:500;">${y}</text>`;
    }
  });

  // Guide marking the year currently shown on the map — ties this
  // always-full-history chart back to the single-year scrubber above it.
  const curIdx = years.indexOf(state.year);
  let guideSvg = '';
  if (curIdx >= 0) {
    const x = xAt(curIdx).toFixed(1);
    guideSvg = `<line x1="${x}" y1="${mt}" x2="${x}" y2="${mt + ch}" stroke="var(--ink-4)" stroke-width="1" stroke-dasharray="2,3" opacity="0.6"/>`;
    [['out', 'var(--outflow)'], ['in', 'var(--inflow)'], ['self', 'var(--internal)']].forEach(([key, color]) => {
      const v = netSeries[key][curIdx];
      if (v == null) return;
      guideSvg += `<circle cx="${x}" cy="${yAt(v).toFixed(1)}" r="3" fill="${color}" stroke="var(--paper)" stroke-width="1.5"/>`;
    });
  }

  // Invisible per-year hover columns for the tooltip
  let hoverSvg = '';
  years.forEach((y, i) => {
    const x0 = i === 0 ? ml : (xAt(i - 1) + xAt(i)) / 2;
    const x1 = i === years.length - 1 ? W - mr : (xAt(i) + xAt(i + 1)) / 2;
    hoverSvg += `<rect class="trend-hover-col" data-idx="${i}" x="${x0.toFixed(1)}" y="${mt}" width="${Math.max(x1 - x0, 0).toFixed(1)}" height="${ch}" fill="transparent"/>`;
  });

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block;overflow:visible;font-family:inherit;">
      ${gridSvg}
      <path d="${pathFor(netSeries.out)}"  fill="none" stroke="var(--outflow)"  stroke-width="2"/>
      <path d="${pathFor(netSeries.in)}"   fill="none" stroke="var(--inflow)"   stroke-width="2"/>
      <path d="${pathFor(netSeries.self)}" fill="none" stroke="var(--internal)" stroke-width="2"/>
      ${guideSvg}
      ${xLabels}
      ${hoverSvg}
    </svg>`;

  el.querySelectorAll('.trend-hover-col').forEach(rect => {
    rect.addEventListener('mousemove', e => {
      const idx = Number(rect.dataset.idx);
      const y   = years[idx];
      const tt  = _ensureSankeyTooltip();
      tt.innerHTML = `<strong>${y}</strong><br>`
        + `<span style="color:var(--inflow)">Workers In</span> ${fmt(netSeries.in[idx])}<br>`
        + `<span style="color:var(--outflow)">Residents Out</span> ${fmt(netSeries.out[idx])}<br>`
        + `<span style="color:var(--internal)">Live &amp; Work</span> ${fmt(netSeries.self[idx])}`;
      tt.style.display = 'block';
      tt.style.left    = `${e.clientX + 14}px`;
      tt.style.top     = `${e.clientY - 32}px`;
    });
    rect.addEventListener('mouseleave', () => {
      if (_sankeyTooltip) _sankeyTooltip.style.display = 'none';
    });
  });
}

// ── 3. Worker Demographics — diverging grouped bar ────────────────────────────

function _renderDemographics(outflows, inflows, state) {
  if (!_demoChart) return;
  const tc      = _tc(state.theme);
  const aggrOut = _aggregate(outflows);
  const aggrIn  = _aggregate(inflows);

  let categories, outVals, inVals;
  if (_demoDimension === 'age') {
    categories = ['55+', '30–54', 'Under 30'];
    outVals    = [aggrOut.SA03, aggrOut.SA02, aggrOut.SA01];
    inVals     = [aggrIn.SA03,  aggrIn.SA02,  aggrIn.SA01];
  } else if (_demoDimension === 'earnings') {
    categories = ['>$3,333/mo', '$1,251–3,333', '≤$1,250/mo'];
    outVals    = [aggrOut.SE03, aggrOut.SE02, aggrOut.SE01];
    inVals     = [aggrIn.SE03,  aggrIn.SE02,  aggrIn.SE01];
  } else { // industry
    categories = ['Services', 'Trade/Transport', 'Goods'];
    outVals    = [aggrOut.SI03, aggrOut.SI02, aggrOut.SI01];
    inVals     = [aggrIn.SI03,  aggrIn.SI02,  aggrIn.SI01];
  }

  if (!outVals.some(v => v) && !inVals.some(v => v)) { _demoChart.clear(); return; }

  _demoChart.setOption({
    backgroundColor: 'transparent', animation: true, animationDuration: 400,
    legend: {
      top: 2, left: 'center', itemWidth: 10, itemHeight: 8,
      textStyle: { color: tc.muted, fontSize: 9 },
      data: [
        { name: 'Inflow',  icon: 'rect', itemStyle: { color: tc.inflow  } },
        { name: 'Outflow', icon: 'rect', itemStyle: { color: tc.outflow } },
      ],
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: tc.ttBg, borderColor: tc.ttBorder,
      textStyle: { color: tc.text, fontSize: 11 },
      formatter: params => {
        const cat = params[0]?.name;
        const idx = categories.indexOf(cat);
        const iv  = idx >= 0 ? inVals[idx] : 0;
        const ov  = idx >= 0 ? outVals[idx] : 0;
        return [
          `<strong>${cat}</strong>`,
          `<span style="color:${tc.inflow}">← ${iv.toLocaleString()}</span> inflow`,
          `<span style="color:${tc.outflow}">→ ${ov.toLocaleString()}</span> outflow`,
        ].join('<br/>');
      },
    },
    grid: { top: 22, right: 44, bottom: 4, left: 4, containLabel: true },
    xAxis: {
      type: 'value',
      axisLabel: { color: tc.muted, fontSize: 9, formatter: v => { const a = Math.abs(v); return a >= 1000 ? `${(a/1000).toFixed(0)}k` : String(a); } },
      splitLine: { lineStyle: { color: tc.axis } },
      axisLine: { show: false }, axisTick: { show: false },
    },
    yAxis: {
      type: 'category', data: categories,
      axisLabel: { color: tc.text, fontSize: 10 },
      axisLine: { lineStyle: { color: tc.axis } }, axisTick: { show: false },
    },
    series: [
      {
        name: 'Inflow', type: 'bar', barMaxWidth: 18,
        data: inVals.map(v => ({ value: -v, itemStyle: { color: tc.inflow, borderRadius: [1,0,0,1] } })),
        label: { show: true, position: 'left', color: tc.muted, fontSize: 8, hideOverlap: true, formatter: p => p.value < -99 ? Number(-p.value).toLocaleString() : '' },
        emphasis: { itemStyle: { opacity: 0.8 } },
      },
      {
        name: 'Outflow', type: 'bar', barMaxWidth: 18,
        data: outVals.map(v => ({ value: v, itemStyle: { color: tc.outflow, borderRadius: [0,1,1,0] } })),
        label: { show: true, position: 'right', color: tc.muted, fontSize: 8, hideOverlap: true, formatter: p => p.value > 99 ? Number(p.value).toLocaleString() : '' },
        emphasis: { itemStyle: { opacity: 0.8 } },
      },
    ],
  }, true);

  _demoChart.resize();
}

// ── 4. Commute Length — frequency-distribution column chart ──────────────────

function _renderReach(outflows, inflows, selfBands, state) {
  const bandsEl  = document.getElementById('reach-bands');
  const legendEl = document.getElementById('reach-legend');
  if (!bandsEl) return;

  const outB  = _bucketFlows(outflows);
  const inB   = _bucketFlows(inflows);
  const selfB = selfBands ?? [0, 0, 0, 0, 0, 0];
  const outT  = outB.reduce((s, v) => s + v, 0) || 1;
  const inT   = inB.reduce((s, v) => s + v, 0) || 1;
  const selfT = selfB.reduce((s, v) => s + v, 0) || 1;

  const visibleCounts = [
    ...(_reachSelfVisible ? selfB : []),
    ...(_reachInVisible   ? inB   : []),
    ...(_reachOutVisible  ? outB  : []),
  ];
  const maxCount = Math.max(...visibleCounts, 1);
  const step = _niceStep(maxCount);
  const yMax = Math.ceil(maxCount / step) * step || 1;
  const yPx  = n => ch - (n / yMax) * ch;
  const yFmt = v => v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M'
    : v >= 1000 ? Math.round(v / 1000) + 'k' : v.toString();

  const W = 460, H = 190;
  const ml = 38, mr = 4, mt = 20, mb = 34;
  const cw = W - ml - mr;
  const ch = H - mt - mb;

  const groupW  = cw / REACH_LABELS.length;
  const barSep  = 1;
  const nVis    = (_reachInVisible ? 1 : 0) + (_reachSelfVisible ? 1 : 0) + (_reachOutVisible ? 1 : 0);
  const barW    = nVis > 0 ? (groupW - (nVis - 1) * barSep) / nVis : groupW;

  let svg = '';

  for (let i = 0; i <= 4; i++) {
    const val = (yMax / 4) * i;
    const y   = (mt + yPx(val)).toFixed(1);
    svg += `<line x1="${ml}" x2="${W - mr}" y1="${y}" y2="${y}" style="stroke:var(--rule);stroke-width:1"/>`;
    svg += `<text x="${ml - 5}" y="${(parseFloat(y) + 4).toFixed(1)}" text-anchor="end" style="font-size:12px;fill:var(--ink-4);font-weight:500;">${yFmt(val)}</text>`;
  }

  svg += `<line x1="${ml}" x2="${W - mr}" y1="${(mt + ch).toFixed(1)}" y2="${(mt + ch).toFixed(1)}" style="stroke:var(--rule-strong);stroke-width:1.5"/>`;

  // Bars — inflow / internal / outflow; only visible groups rendered, filling available width
  REACH_LABELS.forEach((lbl, i) => {
    const gx = ml + i * groupW;
    let slot = 0;

    const drawBar = (val, total, cssVar) => {
      const pct = Math.round((val / total) * 100);
      const bx  = gx + slot * (barW + barSep);
      const bh  = ((val / yMax) * ch).toFixed(1);
      const by  = (mt + ch - parseFloat(bh)).toFixed(1);
      svg += `<rect x="${bx.toFixed(1)}" y="${by}" width="${barW.toFixed(1)}" height="${bh}" style="fill:var(${cssVar})"/>`;
      if (pct > 0)
        svg += `<text x="${(bx + barW / 2).toFixed(1)}" y="${(parseFloat(by) - 3).toFixed(1)}" text-anchor="middle" style="font-size:12px;fill:var(--ink-4);font-weight:600;">${pct}%</text>`;
      slot++;
    };

    if (_reachInVisible)   drawBar(inB[i],   inT,   '--inflow');
    if (_reachSelfVisible) drawBar(selfB[i],  selfT, '--internal');
    if (_reachOutVisible)  drawBar(outB[i],   outT,  '--outflow');

    svg += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${H - mb + 14}" text-anchor="middle" style="font-size:12px;fill:var(--ink-4);font-weight:500;">${lbl}</text>`;
  });

  bandsEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;overflow:visible;font-family:inherit;">${svg}</svg>`;

  if (legendEl) {
    legendEl.innerHTML =
      `<button class="balance-sort-btn reach-dir-btn${_reachInVisible   ? ' active' : ''}" data-dir="inflow"><span class="pip in"></span>Inflow</button>` +
      `<button class="balance-sort-btn reach-dir-btn${_reachSelfVisible ? ' active' : ''}" data-dir="internal"><span class="pip self"></span>Live &amp; Work</button>` +
      `<button class="balance-sort-btn reach-dir-btn${_reachOutVisible  ? ' active' : ''}" data-dir="outflow"><span class="pip out"></span>Outflow</button>`;
  }
}

// ── 5. Industry Mix — hand-built horizontal stacked bars (design-spec HTML) ───

function _renderIndustry(outflows, inflows, state) {
  const stackEl = document.getElementById('industry-stack');
  if (!stackEl) return;

  const blockEl = document.getElementById('industry-chart-block');
  if (blockEl) blockEl.dataset.industryDir = _industryDir;

  const flows = _industryDir === 'outflow' ? outflows : inflows;
  const top5  = flows.slice(0, 5);
  if (!top5.length) { stackEl.innerHTML = ''; return; }

  const totals   = top5.map(f => Number(f.SI01||0) + Number(f.SI02||0) + Number(f.SI03||0));
  const maxTotal = Math.max(...totals) || 1;

  stackEl.innerHTML = top5.map((f, i) => {
    const total    = totals[i];
    const goods    = Number(f.SI01 || 0);
    const trade    = Number(f.SI02 || 0);
    const services = Number(f.SI03 || 0);
    const barW     = ((total / maxTotal) * 100).toFixed(1);
    const gPct = total > 0 ? goods    / total : 0;
    const tPct = total > 0 ? trade    / total : 0;
    const sPct = total > 0 ? services / total : 0;
    return `
      <div class="industry-row">
        <div class="ir-head">
          <span class="ir-name">${f.dest_name}</span>
          <span class="ir-total">${total.toLocaleString()}</span>
        </div>
        <div class="ir-bar" style="width:${barW}%">
          <span class="seg-goods"    style="width:${(gPct*100).toFixed(1)}%">${gPct >= 0.18 ? Math.round(gPct*100)+'%' : ''}</span>
          <span class="seg-trade"    style="width:${(tPct*100).toFixed(1)}%">${tPct >= 0.18 ? Math.round(tPct*100)+'%' : ''}</span>
          <span class="seg-services" style="width:${(sPct*100).toFixed(1)}%">${sPct >= 0.18 ? Math.round(sPct*100)+'%' : ''}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ── 05 · Means of Transportation (ACS) ───────────────────────────────────────

// keys are summed together; 'other' (020E) = taxicab, motorcycle, other means
const _TRANS_ROWS = [
  { keys: ['drove', 'other'], label: 'Drove alone' },
  { keys: ['carpool'],        label: 'Carpool' },
  { keys: ['transit'],        label: 'Public transit' },
  { keys: ['bike', 'walk'],   label: 'Bike / Walk' },
  { keys: ['wfh'],            label: 'Work from home' },
];

function _renderTransport(acsEntry, appState) {
  const el = document.getElementById('transport-body');
  if (!el) return;

  if (!acsEntry) {
    el.innerHTML = `<div class="acs-na">ACS data not available for ${appState?.year < 2009 ? 'years before 2009' : 'this area'}.</div>`;
    return;
  }

  // inflow → workers commuting IN → workplace geography (where they work)
  // outflow → residents commuting OUT → residence geography (where they live)
  const isInflow = appState?.direction === 'inflow';
  const data  = isInflow ? (acsEntry.wrk?.trans ?? null) : (acsEntry.res?.trans ?? null);
  const geoLabel = isInflow ? 'Workers at this location' : 'Residents of this area';

  if (!data) {
    el.innerHTML = `<div class="acs-na">Workplace geography data not available for this area.</div>
      <div class="acs-source">ACS 5-Year Estimates · ${appState?.year ?? ''} · Census Bureau</div>`;
    return;
  }

  const total = data.total || 1;
  const rows = _TRANS_ROWS.map(({ keys, label }) => {
    const val = keys.reduce((sum, k) => sum + (data[k] ?? 0), 0);
    const pct = total > 0 ? (val / total) * 100 : 0;
    return `<div class="acs-row">
      <span class="acs-lbl">${label}</span>
      <div class="acs-bar-track"><div class="acs-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <span class="acs-pct">${pct.toFixed(0)}%</span>
      <span class="acs-count">${val.toLocaleString()}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="acs-geo-label">${geoLabel}</div>${rows}
    <div class="acs-source">ACS 5-Year Estimates · ${appState?.year ?? ''} · Census Bureau</div>`;
}

// ── 06 · Travel Time to Work (ACS) ───────────────────────────────────────────

const _TIME_ROWS = [
  { key: 'lt10',    label: '< 10 min' },
  { key: 't10_19',  label: '10–19 min' },
  { key: 't20_29',  label: '20–29 min' },
  { key: 't30_44',  label: '30–44 min' },
  { key: 't45_59',  label: '45–59 min' },
  { key: 't60plus', label: '60+ min' },
];

function _renderTravelTime(acsEntry, appState) {
  const el = document.getElementById('traveltime-body');
  if (!el) return;

  if (!acsEntry) {
    el.innerHTML = `<div class="acs-na">ACS data not available for ${appState?.year < 2009 ? 'years before 2009' : 'this area'}.</div>`;
    return;
  }

  const isInflow = appState?.direction === 'inflow';
  const data  = isInflow ? (acsEntry.wrk?.time ?? null) : (acsEntry.res?.time ?? null);
  const geoLabel = isInflow ? 'Workers at this location' : 'Residents of this area';

  if (!data) {
    el.innerHTML = `<div class="acs-na">Workplace geography data not available for this area.</div>
      <div class="acs-source">ACS 5-Year Estimates · ${appState?.year ?? ''} · Census Bureau</div>`;
    return;
  }

  const total = data.total || 1;
  const rows = _TIME_ROWS.map(({ key, label }) => {
    const val = data[key] ?? 0;
    const pct = total > 0 ? (val / total) * 100 : 0;
    return `<div class="acs-row">
      <span class="acs-lbl">${label}</span>
      <div class="acs-bar-track"><div class="acs-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <span class="acs-pct">${pct.toFixed(0)}%</span>
      <span class="acs-count">${val.toLocaleString()}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="acs-geo-label">${geoLabel}</div>${rows}
    <div class="acs-source">ACS 5-Year Estimates · ${appState?.year ?? ''} · Census Bureau</div>`;
}

// ── ACS exports ───────────────────────────────────────────────────────────────

export function exportTransportPng() {
  if (!_lastState || !_lastAcsEntry) return;
  const dk       = _lastState.theme === 'dark';
  const isInflow = _lastState.direction === 'inflow';
  const data     = isInflow ? (_lastAcsEntry.wrk?.trans ?? null) : (_lastAcsEntry.res?.trans ?? null);
  if (!data) return;
  const total = data.total || 1;
  const rows  = _TRANS_ROWS.map(({ keys, label }) => {
    const val = keys.reduce((sum, k) => sum + (data[k] ?? 0), 0);
    return { label, val, pct: val / total };
  });
  const geoLabel = isInflow ? 'Workers at this location' : 'Residents of this area';
  _acsChartPng(rows, geoLabel, dk, isInflow,
    `transport-${_lastState.selectedArea ?? 'chart'}-${_lastState.year ?? ''}`);
}

export function exportTravelTimePng() {
  if (!_lastState || !_lastAcsEntry) return;
  const dk       = _lastState.theme === 'dark';
  const isInflow = _lastState.direction === 'inflow';
  const data     = isInflow ? (_lastAcsEntry.wrk?.time ?? null) : (_lastAcsEntry.res?.time ?? null);
  if (!data) return;
  const total = data.total || 1;
  const rows  = _TIME_ROWS.map(({ key, label }) => {
    const val = data[key] ?? 0;
    return { label, val, pct: val / total };
  });
  const geoLabel = isInflow ? 'Workers at this location' : 'Residents of this area';
  _acsChartPng(rows, geoLabel, dk, isInflow,
    `traveltime-${_lastState.selectedArea ?? 'chart'}-${_lastState.year ?? ''}`);
}

function _acsChartPng(rows, geoLabel, dk, isInflow, filename) {
  const W      = 480, PAD = 24;
  const LBL_W  = 100;
  const PCT_W  = 40, CNT_W = 64;
  const BAR_X  = PAD + LBL_W + 8;
  const BAR_W  = W - BAR_X - PCT_W - CNT_W - PAD;
  const ROW_H  = 26, BAR_H = 13;
  const HDR_H  = 30, FOOT_H = 22;
  const H      = PAD + HDR_H + rows.length * ROW_H + FOOT_H + PAD;

  const canvas = document.createElement('canvas');
  canvas.width  = W * 2; canvas.height = H * 2;
  const ctx    = canvas.getContext('2d');
  ctx.scale(2, 2);

  const bg     = dk ? '#0a0e17' : '#f6f3eb';
  const ink    = dk ? '#e8e5dc' : '#121726';
  const ink3   = dk ? '#92929a' : '#5b6071';
  const ink4   = dk ? '#696a73' : '#898d9c';
  const track  = dk ? 'rgba(232,229,220,0.09)' : 'rgba(18,23,38,0.10)';
  const barCol = isInflow
    ? (dk ? '#5aa6a7' : '#1e6f6f')
    : (dk ? '#e4895a' : '#cc683a');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  let y = PAD;

  ctx.fillStyle = ink3;
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(geoLabel.toUpperCase(), PAD, y + HDR_H / 2);
  y += HDR_H;

  rows.forEach(({ label, val, pct }) => {
    const barFillW = pct * BAR_W;
    const rowMidY  = y + ROW_H / 2;
    const barY     = y + (ROW_H - BAR_H) / 2;

    ctx.fillStyle = ink;
    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, PAD, rowMidY, LBL_W - 4);

    ctx.fillStyle = track;
    ctx.fillRect(BAR_X, barY, BAR_W, BAR_H);

    if (barFillW >= 0.5) {
      ctx.fillStyle = barCol;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(BAR_X, barY, barFillW, BAR_H);
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = ink3;
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(pct * 100)}%`, BAR_X + BAR_W + PCT_W - 4, rowMidY);

    ctx.fillStyle = ink4;
    ctx.font = '400 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(val.toLocaleString(), W - PAD, rowMidY);

    y += ROW_H;
  });

  ctx.fillStyle = ink4;
  ctx.font = '400 9.5px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(`ACS 5-Year Estimates · ${_lastState.year ?? ''} · Census Bureau`, PAD, y + FOOT_H / 2);

  _dlUrl(canvas.toDataURL('image/png'), `${filename}.png`);
}

export function exportTransportCsv() {
  if (!_lastState || !_lastAcsEntry) return;
  const area = _lastState.selectedArea;
  const year = _lastState.year;
  const header = ['Area', 'Year', 'Geography', 'Mode', 'Count', 'Pct'];
  const rows   = [header];

  for (const [geoKey, geoLabel] of [['res', 'Residence'], ['wrk', 'Workplace']]) {
    const data = _lastAcsEntry[geoKey]?.trans;
    if (!data) continue;
    const total = data.total || 1;
    for (const { keys, label } of _TRANS_ROWS) {
      const val = keys.reduce((sum, k) => sum + (data[k] ?? 0), 0);
      rows.push([area, year, geoLabel, label, val, ((val / total) * 100).toFixed(1)]);
    }
  }
  _csvDownload(rows, `transport_${area}_${year}`);
}

export function exportTravelTimeCsv() {
  if (!_lastState || !_lastAcsEntry) return;
  const area = _lastState.selectedArea;
  const year = _lastState.year;
  const header = ['Area', 'Year', 'Geography', 'TravelTime', 'Count', 'Pct'];
  const rows   = [header];

  for (const [geoKey, geoLabel] of [['res', 'Residence'], ['wrk', 'Workplace']]) {
    const data = _lastAcsEntry[geoKey]?.time;
    if (!data) continue;
    const total = data.total || 1;
    for (const { key, label } of _TIME_ROWS) {
      const val = data[key] ?? 0;
      rows.push([area, year, geoLabel, label, val, ((val / total) * 100).toFixed(1)]);
    }
  }
  _csvDownload(rows, `traveltime_${area}_${year}`);
}

// ── Download helpers ──────────────────────────────────────────────────────────

function _pngDownload(chart, filename) {
  if (!chart || !_lastState) return;
  const bg = _lastState.theme === 'dark' ? '#0a0e17' : '#f6f3eb';
  _dlUrl(chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: bg }), `${filename}.png`);
}

function _csvDownload(rows, filename) {
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  _dlUrl(url, `${filename}.csv`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _dlUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
}
