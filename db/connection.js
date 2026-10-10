const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'qa-agent-hub.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    source TEXT NOT NULL,
    area TEXT NOT NULL,
    product_name TEXT,
    user TEXT,
    issue_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    url TEXT,
    fingerprint TEXT NOT NULL UNIQUE,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_group_id TEXT NOT NULL,
    test_key TEXT NOT NULL,
    test_name TEXT NOT NULL,
    user TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS test_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_run_id INTEGER NOT NULL,
    step_order INTEGER NOT NULL,
    step_name TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    duration_ms INTEGER
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS comparison_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    dev_base_url TEXT NOT NULL,
    prod_base_url TEXT NOT NULL,
    paths TEXT NOT NULL,
    status TEXT NOT NULL,
    diff_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  );

`);

// node:sqlite has no "add column if not exists" - these are best-effort,
// one-time migrations for installs created before mode/steps_reached existed.
for (const alterSql of [
  "ALTER TABLE comparison_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'paths'",
  'ALTER TABLE comparison_runs ADD COLUMN steps_reached_dev TEXT',
  'ALTER TABLE comparison_runs ADD COLUMN steps_reached_prod TEXT',
  'ALTER TABLE comparison_runs ADD COLUMN partner_name TEXT',
  'ALTER TABLE comparison_runs ADD COLUMN screenshots TEXT',
]) {
  try {
    db.exec(alterSql);
  } catch {
    // column already exists
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS comparison_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comparison_run_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    page_path TEXT,
    severity TEXT NOT NULL,
    description TEXT,
    dev_value TEXT,
    prod_value TEXT,
    recommendation TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_url TEXT NOT NULL,
    x_percent REAL NOT NULL,
    y_percent REAL NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

function makeFingerprint({ source, area, product_name, issue_type, user }) {
  return [source, area, product_name || '', issue_type, user || ''].join('||');
}

// Re-running a scrape shouldn't create duplicate rows for the same issue -
// it just bumps last_seen so the Issues tab reflects "still happening".
function upsertIssue(issue) {
  const now = new Date().toISOString();
  const fingerprint = makeFingerprint(issue);
  const existing = db.prepare('SELECT id FROM issues WHERE fingerprint = ?').get(fingerprint);

  if (existing) {
    db.prepare('UPDATE issues SET last_seen = ? WHERE id = ?').run(now, existing.id);
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO issues
        (run_id, source, area, product_name, user, issue_type, title, description, severity, status, url, fingerprint, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    )
    .run(
      issue.run_id,
      issue.source,
      issue.area,
      issue.product_name || null,
      issue.user || null,
      issue.issue_type,
      issue.title,
      issue.description || '',
      issue.severity,
      issue.url || null,
      fingerprint,
      now,
      now
    );

  return result.lastInsertRowid;
}

function listIssues({ status } = {}) {
  if (status) {
    return db.prepare('SELECT * FROM issues WHERE status = ? ORDER BY last_seen DESC').all(status);
  }
  return db.prepare('SELECT * FROM issues ORDER BY last_seen DESC').all();
}

function getIssue(id) {
  return db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
}

function updateIssueStatus(id, status) {
  db.prepare('UPDATE issues SET status = ? WHERE id = ?').run(status, id);
  return getIssue(id);
}

// Stat tiles always reflect the true totals; only the type breakdown
// (for the pie chart) is scoped to the status filter.
function getDashboardSummary({ status } = {}) {
  const all = listIssues();
  const totals = {
    total: all.length,
    open: all.filter((i) => i.status === 'open').length,
    fixed: all.filter((i) => i.status === 'fixed').length,
    resolved: all.filter((i) => i.status === 'resolved').length,
    closed: all.filter((i) => i.status === 'closed').length,
  };

  const scoped = status ? all.filter((i) => i.status === status) : all;
  const counts = {};
  scoped.forEach((issue) => {
    counts[issue.issue_type] = (counts[issue.issue_type] || 0) + 1;
  });
  const byType = Object.entries(counts).map(([issue_type, count]) => ({ issue_type, count }));

  return { totals, byType, scopedTotal: scoped.length };
}

function recordTestRun({ runGroupId, testKey, testName, user, status, startedAt, finishedAt, steps }) {
  const result = db
    .prepare(
      `INSERT INTO test_runs (run_group_id, test_key, test_name, user, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(runGroupId, testKey, testName, user, status, startedAt, finishedAt);

  const testRunId = result.lastInsertRowid;
  const insertStep = db.prepare(
    `INSERT INTO test_steps (test_run_id, step_order, step_name, status, error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  steps.forEach((step, index) => {
    insertStep.run(testRunId, index + 1, step.name, step.status, step.error || null, step.duration_ms || 0);
  });

  return testRunId;
}

function listTestRunsWithSteps({ limit = 200 } = {}) {
  const runs = db.prepare('SELECT * FROM test_runs ORDER BY id DESC LIMIT ?').all(limit);
  const stepStmt = db.prepare('SELECT * FROM test_steps WHERE test_run_id = ? ORDER BY step_order');
  return runs.map((run) => ({ ...run, steps: stepStmt.all(run.id) }));
}

function recordComparisonRun({
  runId,
  devBaseUrl,
  prodBaseUrl,
  paths,
  status,
  startedAt,
  finishedAt,
  diffs,
  mode = 'paths',
  stepsReachedDev = null,
  stepsReachedProd = null,
  partnerName = null,
  screenshots = null,
}) {
  const result = db
    .prepare(
      `INSERT INTO comparison_runs
        (run_id, dev_base_url, prod_base_url, paths, status, diff_count, started_at, finished_at, mode, steps_reached_dev, steps_reached_prod, partner_name, screenshots)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      devBaseUrl,
      prodBaseUrl,
      JSON.stringify(paths),
      status,
      diffs.length,
      startedAt,
      finishedAt,
      mode,
      stepsReachedDev ? JSON.stringify(stepsReachedDev) : null,
      stepsReachedProd ? JSON.stringify(stepsReachedProd) : null,
      partnerName || null,
      screenshots ? JSON.stringify(screenshots) : null
    );

  const comparisonRunId = result.lastInsertRowid;
  const insertDiff = db.prepare(
    `INSERT INTO comparison_diffs
      (comparison_run_id, category, issue_type, page_path, severity, description, dev_value, prod_value, recommendation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  diffs.forEach((diff) => {
    insertDiff.run(
      comparisonRunId,
      diff.category,
      diff.issue_type,
      diff.page_path || null,
      diff.severity,
      diff.description || '',
      diff.dev_value,
      diff.prod_value,
      diff.recommendation || ''
    );
  });

  return comparisonRunId;
}

function parseComparisonRun(run) {
  return {
    ...run,
    paths: JSON.parse(run.paths),
    steps_reached_dev: run.steps_reached_dev ? JSON.parse(run.steps_reached_dev) : null,
    steps_reached_prod: run.steps_reached_prod ? JSON.parse(run.steps_reached_prod) : null,
    screenshots: run.screenshots ? JSON.parse(run.screenshots) : null,
  };
}

function listComparisonRuns({ limit = 100 } = {}) {
  return db.prepare('SELECT * FROM comparison_runs ORDER BY id DESC LIMIT ?').all(limit).map(parseComparisonRun);
}

function getComparisonRun(id) {
  const run = db.prepare('SELECT * FROM comparison_runs WHERE id = ?').get(id);
  if (!run) return null;
  const diffs = db.prepare('SELECT * FROM comparison_diffs WHERE comparison_run_id = ? ORDER BY id').all(id);
  return { ...parseComparisonRun(run), diffs };
}

// One tile per partner: whichever run is most recent for that partner (runs
// without a partner_name are grouped by their Dev/Prod URL pair instead, so
// unnamed one-off comparisons still get their own tile).
function listLatestRunPerPartner() {
  const runs = db
    .prepare(
      `SELECT cr.* FROM comparison_runs cr
       WHERE cr.id = (
         SELECT id FROM comparison_runs cr2
         WHERE COALESCE(cr2.partner_name, cr2.dev_base_url || '|' || cr2.prod_base_url)
             = COALESCE(cr.partner_name, cr.dev_base_url || '|' || cr.prod_base_url)
         ORDER BY id DESC LIMIT 1
       )
       ORDER BY id DESC`
    )
    .all();

  const severityStmt = db.prepare(
    'SELECT severity, COUNT(*) as count FROM comparison_diffs WHERE comparison_run_id = ? GROUP BY severity'
  );

  return runs.map((run) => {
    const severityCounts = {};
    severityStmt.all(run.id).forEach((row) => {
      severityCounts[row.severity] = row.count;
    });
    return { ...parseComparisonRun(run), severityCounts };
  });
}

function getPin(id) {
  return db.prepare('SELECT * FROM pins WHERE id = ?').get(id);
}

function createPin({ page_url, x_percent, y_percent, name, description, severity }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO pins (page_url, x_percent, y_percent, name, description, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(page_url, x_percent, y_percent, name, description || '', severity, now);
  return getPin(result.lastInsertRowid);
}

function listPinsForPage(pageUrl) {
  return db.prepare('SELECT * FROM pins WHERE page_url = ? ORDER BY id').all(pageUrl);
}

function listAllPins() {
  return db.prepare('SELECT * FROM pins ORDER BY id DESC').all();
}

function deletePin(id) {
  db.prepare('DELETE FROM pins WHERE id = ?').run(id);
}

module.exports = {
  db,
  upsertIssue,
  listIssues,
  getIssue,
  updateIssueStatus,
  recordTestRun,
  listTestRunsWithSteps,
  getDashboardSummary,
  recordComparisonRun,
  listComparisonRuns,
  getComparisonRun,
  listLatestRunPerPartner,
  createPin,
  listPinsForPage,
  listAllPins,
  deletePin,
};
