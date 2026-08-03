import * as duckdb from '@duckdb/duckdb-wasm';

let _db               = null;
let _conn             = null;
let _hasDistanceBands = false;
let _hasDistWsum      = false;
let _hasNeighborFlows = false;

/**
 * Initialize DuckDB-WASM and load Parquet files for the given year.
 * selectBundle auto-picks the MVP (non-SAB) bundle on GitHub Pages
 * since SharedArrayBuffer requires COOP/COEP headers that GH Pages can't set.
 */
export async function initDB(year, onProgress) {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );

  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const worker = new Worker(workerUrl);
  _db = new duckdb.AsyncDuckDB(logger, worker);
  await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  onProgress?.(10);

  _conn = await _db.connect();
  await _loadYearFiles(year, onProgress);

  return _db;
}

/**
 * Swap out the loaded Parquet files for a different year without
 * reinitializing the DuckDB engine or worker.
 */
export async function reloadYear(year, onProgress) {
  if (!_db || !_conn) throw new Error('DB not initialized');
  await _loadYearFiles(year, onProgress);
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function _loadYearFiles(year, onProgress) {
  const base = import.meta.env.BASE_URL ?? '/';

  const [cityBuf, districtBuf] = await Promise.all([
    fetch(`${base}data/lehd/${year}/city_flows.parquet`).then(r => {
      if (!r.ok) throw new Error(`city_flows.parquet: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(`${base}data/lehd/${year}/district_flows.parquet`).then(r => {
      if (!r.ok) throw new Error(`district_flows.parquet: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  onProgress?.(70);

  // Use year-stamped filenames so re-registration across year switches never conflicts.
  const cityFile     = `city_flows_${year}.parquet`;
  const districtFile = `district_flows_${year}.parquet`;

  for (const f of [cityFile, districtFile]) {
    try { await _db.dropFile(f); } catch {}
  }

  await _db.registerFileBuffer(cityFile,     new Uint8Array(cityBuf));
  await _db.registerFileBuffer(districtFile, new Uint8Array(districtBuf));

  await _conn.query(
    `CREATE OR REPLACE VIEW city_flows     AS SELECT * FROM read_parquet('${cityFile}');`
  );
  await _conn.query(
    `CREATE OR REPLACE VIEW district_flows AS SELECT * FROM read_parquet('${districtFile}');`
  );

  // planning_flows.parquet (Planning Boundaries mode) — optional, gracefully
  // absent for years the pipeline hasn't been re-run for yet.
  const planningFile = `planning_flows_${year}.parquet`;
  try { await _db.dropFile(planningFile); } catch {}
  try {
    const planningBuf = await fetch(`${base}data/lehd/${year}/planning_flows.parquet`).then(r => {
      if (!r.ok) throw new Error(r.status);
      return r.arrayBuffer();
    });
    await _db.registerFileBuffer(planningFile, new Uint8Array(planningBuf));
    await _conn.query(
      `CREATE OR REPLACE VIEW planning_flows AS SELECT * FROM read_parquet('${planningFile}');`
    );
  } catch {
    await _conn.query(`CREATE OR REPLACE VIEW planning_flows AS
      SELECT '' AS home_small, '' AS work_small, '' AS home_medium, '' AS work_medium,
             '' AS home_large, '' AS work_large, '' AS home_super, '' AS work_super,
             0 AS S000, 0 AS SA01, 0 AS SA02, 0 AS SA03,
             0 AS SE01, 0 AS SE02, 0 AS SE03,
             0 AS SI01, 0 AS SI02, 0 AS SI03,
             0 AS d0_5, 0 AS d5_10, 0 AS d10_25, 0 AS d25_50, 0 AS d50_100, 0 AS d100p,
             0.0 AS dist_wsum, 0 AS dist_n
      WHERE false`);
  }

  // Detect distance band columns (older years may not have them).
  const colResult = await _conn.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'city_flows'`
  );
  const colNames = new Set(colResult.toArray().map(r => r.toJSON().column_name));
  _hasDistanceBands = ['d0_5', 'd5_10', 'd10_25', 'd25_50', 'd50_100', 'd100p'].every(c => colNames.has(c));
  _hasDistWsum      = colNames.has('dist_wsum');

  // neighbor_flows.parquet — optional, gracefully absent for older years
  const neighborFile = `neighbor_flows_${year}.parquet`;
  try { await _db.dropFile(neighborFile); } catch {}
  try {
    const nbBuf = await fetch(`${base}data/lehd/${year}/neighbor_flows.parquet`).then(r => {
      if (!r.ok) throw new Error(r.status);
      return r.arrayBuffer();
    });
    await _db.registerFileBuffer(neighborFile, new Uint8Array(nbBuf));
    await _conn.query(
      `CREATE OR REPLACE VIEW neighbor_flows AS SELECT * FROM read_parquet('${neighborFile}');`
    );
    _hasNeighborFlows = true;
  } catch {
    _hasNeighborFlows = false;
    await _conn.query(`CREATE OR REPLACE VIEW neighbor_flows AS
      SELECT '' AS utah_zone, '' AS neighbor_zone, '' AS state_abbr, '' AS direction,
             0 AS S000, 0 AS SA01, 0 AS SA02, 0 AS SA03,
             0 AS SE01, 0 AS SE02, 0 AS SE03,
             0 AS SI01, 0 AS SI02, 0 AS SI03,
             0 AS d0_5, 0 AS d5_10, 0 AS d10_25, 0 AS d25_50, 0 AS d50_100, 0 AS d100p,
             0.0 AS dist_wsum, 0 AS dist_n
      WHERE false`);
  }

  onProgress?.(100);
}

// ── Geography helpers ─────────────────────────────────────────────────────────

// Map area type → column names for home/work sides.
const _COLS = {
  city:   { home: 'home_name',   work: 'work_name'   },
  county: { home: 'home_county', work: 'work_county' },
  house:  { home: 'home_house',  work: 'work_house'  },
  senate: { home: 'home_senate', work: 'work_senate' },
  small:  { home: 'home_small',  work: 'work_small'  },
  medium: { home: 'home_medium', work: 'work_medium' },
  large:  { home: 'home_large',  work: 'work_large'  },
  super:  { home: 'home_super',  work: 'work_super'  },
};

const _PLANNING_TYPES = ['small', 'medium', 'large', 'super'];

function _cols(type) {
  return _COLS[type] ?? _COLS.city;
}

// Route to the flow table that carries both sides' geography columns.
// Civic Boundaries (house/senate involved) uses district_flows; Planning
// Boundaries (small/medium/large/super involved) uses planning_flows; plain
// city/county uses city_flows. The two modes never mix within one query —
// the UI never constructs a cross-mode areaType/aggregation pair.
function _table(areaType, aggregation) {
  if (_PLANNING_TYPES.includes(areaType) || _PLANNING_TYPES.includes(aggregation)) {
    return 'planning_flows';
  }
  return (areaType === 'house' || areaType === 'senate' ||
          aggregation === 'house' || aggregation === 'senate')
    ? 'district_flows'
    : 'city_flows';
}

/**
 * Query destination flows for a selected area.
 *
 * Supports all combinations of {city, county, house, senate} for both
 * areaType (subject filter) and aggregation (destination grouping).
 * Cross-district queries (house↔senate) use district_flows which carries
 * all four geography columns.
 */
export async function queryFlows(area, areaType, direction, aggregation) {
  if (!_conn) throw new Error('DB not initialized');

  const safe  = area.replace(/'/g, "''");
  const table = _table(areaType, aggregation);

  const srcCols  = _cols(areaType);
  const destCols = _cols(aggregation);

  const filterCol = direction === 'outflow' ? srcCols.home  : srcCols.work;
  const destCol   = direction === 'outflow' ? destCols.work : destCols.home;

  // Exclude workers who both live and work in the exact subject place, regardless
  // of the display geography. Always filtered on the subject's OWN-type column
  // (srcCols), not the aggregation's column — the flow tables carry every
  // geography level per row, so this correctly strips self-containment out of a
  // parent-geography bucket (e.g. City subject + County display) too, not just
  // same-type selections.
  const selfCol    = direction === 'outflow' ? srcCols.work : srcCols.home;
  const selfClause = `AND cf.${selfCol} != '${safe}'`;

  const bandCols = _hasDistanceBands
    ? 'SUM(cf.d0_5) AS d0_5, SUM(cf.d5_10) AS d5_10, SUM(cf.d10_25) AS d10_25, SUM(cf.d25_50) AS d25_50, SUM(cf.d50_100) AS d50_100, SUM(cf.d100p) AS d100p,'
    : '0 AS d0_5, 0 AS d5_10, 0 AS d10_25, 0 AS d25_50, 0 AS d50_100, 0 AS d100p,';

  const distCols = _hasDistWsum
    ? 'SUM(cf.dist_wsum) AS dist_wsum, SUM(cf.dist_n) AS dist_n,'
    : '0 AS dist_wsum, 0 AS dist_n,';

  const sql = `
    SELECT
      cf.${destCol} AS dest_name,
      SUM(cf.S000)  AS S000,
      SUM(cf.SA01)  AS SA01, SUM(cf.SA02) AS SA02, SUM(cf.SA03) AS SA03,
      SUM(cf.SE01)  AS SE01, SUM(cf.SE02) AS SE02, SUM(cf.SE03) AS SE03,
      SUM(cf.SI01)  AS SI01, SUM(cf.SI02) AS SI02, SUM(cf.SI03) AS SI03,
      ${bandCols}
      ${distCols}
      dt.dest_total
    FROM ${table} cf
    JOIN (
      SELECT ${destCol} AS key, SUM(S000) AS dest_total
      FROM ${table}
      GROUP BY ${destCol}
    ) dt ON dt.key = cf.${destCol}
    WHERE cf.${filterCol} = '${safe}'
    ${selfClause}
    GROUP BY cf.${destCol}, dt.dest_total
    ORDER BY S000 DESC
  `;

  const result = await _conn.query(sql);
  return result.toArray().map(r => r.toJSON());
}

/**
 * Count of workers who both live and work in the same area (self-flow).
 */
export async function querySelfFlow(area, areaType) {
  if (!_conn) return 0;
  const safe  = area.replace(/'/g, "''");
  const table = _table(areaType, areaType);
  const col   = _cols(areaType);
  const result = await _conn.query(
    `SELECT COALESCE(SUM(S000), 0) AS self
     FROM ${table}
     WHERE ${col.home} = '${safe}' AND ${col.work} = '${safe}'`
  );
  return Number(result.toArray()[0].toJSON().self);
}

/**
 * Distance-band breakdown for workers who both live and work in the same area.
 * Returns [d0_5, d5_10, d10_25, d25_50, d50_100, d100p] counts.
 */
export async function querySelfFlowBands(area, areaType) {
  if (!_conn) return [0, 0, 0, 0, 0, 0];
  const safe   = area.replace(/'/g, "''");
  const table  = _table(areaType, areaType);
  const col    = _cols(areaType);
  const bands  = _hasDistanceBands
    ? 'COALESCE(SUM(d0_5),0) AS d0_5, COALESCE(SUM(d5_10),0) AS d5_10, COALESCE(SUM(d10_25),0) AS d10_25, COALESCE(SUM(d25_50),0) AS d25_50, COALESCE(SUM(d50_100),0) AS d50_100, COALESCE(SUM(d100p),0) AS d100p'
    : '0 AS d0_5, 0 AS d5_10, 0 AS d10_25, 0 AS d25_50, 0 AS d50_100, 0 AS d100p';
  const result = await _conn.query(
    `SELECT ${bands} FROM ${table} WHERE ${col.home} = '${safe}' AND ${col.work} = '${safe}'`
  );
  const row = result.toArray()[0]?.toJSON() ?? {};
  return [
    Number(row.d0_5 || 0),
    Number(row.d5_10 || 0),
    Number(row.d10_25 || 0),
    Number(row.d25_50 || 0),
    Number(row.d50_100 || 0),
    Number(row.d100p || 0),
  ];
}

/**
 * City-level pair flows for the commute reach chart when a county is selected.
 * For district selections, uses district_flows to get city-level detail.
 */
export async function queryReachFlows(area, areaType, direction) {
  if (!_conn) throw new Error('DB not initialized');
  const safe      = area.replace(/'/g, "''");
  const isDistrict = areaType === 'house' || areaType === 'senate';
  const isPlanning = _PLANNING_TYPES.includes(areaType);
  const distCol   = _cols(areaType);
  const reachBands = _hasDistanceBands
    ? 'd0_5, d5_10, d10_25, d25_50, d50_100, d100p'
    : '0 AS d0_5, 0 AS d5_10, 0 AS d10_25, 0 AS d25_50, 0 AS d50_100, 0 AS d100p';

  if (isDistrict) {
    // For district subject: return city-level pairs within/outside the district
    const filterCol  = direction === 'outflow' ? distCol.home : distCol.work;
    const excludeCol = direction === 'outflow' ? distCol.work : distCol.home;
    const result = await _conn.query(`
      SELECT home_name, work_name, home_county, work_county, S000,
             ${reachBands}
      FROM district_flows
      WHERE ${filterCol} = '${safe}' AND ${excludeCol} != '${safe}'
    `);
    return result.toArray().map(r => r.toJSON());
  }

  if (isPlanning) {
    // For Planning Boundaries subjects: drill to Small District (the finest
    // unit within the mode), mirroring the house/senate -> city drill above
    // but staying within Planning Boundaries rather than reaching into
    // Civic Boundaries (no cross-mode geography columns to join against).
    const filterCol  = direction === 'outflow' ? distCol.home : distCol.work;
    const excludeCol = direction === 'outflow' ? distCol.work : distCol.home;
    const result = await _conn.query(`
      SELECT home_small AS home_name, work_small AS work_name,
             home_medium AS home_county, work_medium AS work_county, S000,
             ${reachBands}
      FROM planning_flows
      WHERE ${filterCol} = '${safe}' AND ${excludeCol} != '${safe}'
    `);
    return result.toArray().map(r => r.toJSON());
  }

  // County subject: unchanged behaviour
  const filterCol  = direction === 'outflow' ? 'home_county' : 'work_county';
  const excludeCol = direction === 'outflow' ? 'work_county' : 'home_county';
  const result = await _conn.query(`
    SELECT home_name, work_name, home_county, work_county, S000,
           ${reachBands}
    FROM city_flows
    WHERE ${filterCol} = '${safe}' AND ${excludeCol} != '${safe}'
  `);
  return result.toArray().map(r => r.toJSON());
}

/**
 * Cross-state neighbor flows for the selected Utah area.
 *
 * areaType    — 'city' | 'county'  (subject area type, controls filter column)
 * direction   — 'outflow' | 'inflow'
 * aggregation — 'city' | 'county'  (destination granularity, controls group column)
 *
 * Mirrors the queryFlows() areaType/aggregation split so the neighbor layer
 * follows the same map zone setting as the main Utah choropleth.
 */
export async function queryNeighborFlows(area, areaType, direction, aggregation) {
  if (!_conn || !_hasNeighborFlows) return [];
  // neighbor_flows only carries city/county columns (utah_zone/utah_county).
  // Every other areaType (house/senate/small/medium/large/super) must return
  // early rather than falling through to the 'utah_zone' default below —
  // some Planning District display names are identical to real city names
  // (e.g. Small District "Salt Lake City"), which would otherwise silently
  // match unrelated city-level neighbor-flow rows.
  if (areaType !== 'city' && areaType !== 'county') return [];
  const safe = area.replace(/'/g, "''");

  // Filter column: city → utah_zone, county → utah_county
  const filterCol = (areaType === 'county') ? 'utah_county' : 'utah_zone';
  // Destination column: city → neighbor_zone, county → neighbor_county
  const destCol   = (aggregation === 'county') ? 'neighbor_county' : 'neighbor_zone';
  const dirFilter = direction === 'outflow' ? "AND direction = 'out'" : "AND direction = 'in'";

  const sql = `
    SELECT
      ${destCol} AS dest_name,
      state_abbr,
      SUM(S000)      AS S000,
      SUM(SA01) AS SA01, SUM(SA02) AS SA02, SUM(SA03) AS SA03,
      SUM(SE01) AS SE01, SUM(SE02) AS SE02, SUM(SE03) AS SE03,
      SUM(SI01) AS SI01, SUM(SI02) AS SI02, SUM(SI03) AS SI03,
      SUM(d0_5) AS d0_5, SUM(d5_10) AS d5_10, SUM(d10_25) AS d10_25,
      SUM(d25_50) AS d25_50, SUM(d50_100) AS d50_100, SUM(d100p) AS d100p,
      SUM(dist_wsum) AS dist_wsum, SUM(dist_n) AS dist_n,
      0 AS dest_total
    FROM neighbor_flows
    WHERE ${filterCol} = '${safe}' ${dirFilter}
      AND ${destCol} IS NOT NULL
    GROUP BY ${destCol}, state_abbr
    ORDER BY S000 DESC
  `;
  const result = await _conn.query(sql);
  return result.toArray().map(r => ({ ...r.toJSON(), isNeighbor: true }));
}

/**
 * Total commuter count for the selected area (all destinations, including self).
 */
export async function queryTotal(area, areaType, direction) {
  if (!_conn) return 0;
  const safe      = area.replace(/'/g, "''");
  const table     = _table(areaType, areaType);
  const filterCol = direction === 'outflow' ? _cols(areaType).home : _cols(areaType).work;
  const result = await _conn.query(
    `SELECT COALESCE(SUM(S000), 0) AS total FROM ${table} WHERE ${filterCol} = '${safe}'`
  );
  return Number(result.toArray()[0].toJSON().total);
}
