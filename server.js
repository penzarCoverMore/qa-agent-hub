const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { USERS, findUser } = require('./lib/users');
const { runScrape } = require('./scraper/contentScraper');
const { runComparison } = require('./scraper/urlComparator');
const { runQuoteFlowComparison } = require('./scraper/quoteFlowComparator');
const {
  listIssues,
  updateIssueStatus,
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
} = require('./db/connection');
const { runFunctionalTests, listSuites } = require('./functional/runner');

const PORT = process.env.QA_HUB_PORT || 4317;
const PUBLIC_DIR = path.join(__dirname, 'public');

// The Review Pins bookmarklet runs on saucedemo.com pages, so its calls back
// to this server are cross-origin - only that one origin is allowed.
const BOOKMARKLET_ORIGIN = 'https://www.saucedemo.com';

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', BOOKMARKLET_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome's Private Network Access check: saucedemo.com is a "public" page
  // reaching into "private" localhost, so this header must be present on
  // both the preflight and the real response, or the browser blocks it.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const filePath = pathname === '/' ? '/dashboard.html' : pathname;
  const resolved = path.join(PUBLIC_DIR, filePath);

  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/users' && req.method === 'GET') {
    return sendJson(res, 200, USERS.map((u) => u.username));
  }

  if (pathname === '/api/scrape' && req.method === 'POST') {
    const { username } = await readJsonBody(req);
    const user = findUser(username);
    if (!user) return sendJson(res, 400, { error: `Unknown user "${username}"` });
    const result = await runScrape(user.username, user.password);
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/issues/export' && req.method === 'GET') {
    const XLSX = require('xlsx');
    const issues = listIssues();
    const sheet = XLSX.utils.json_to_sheet(issues);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Issues');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="qa-agent-hub-issues.xlsx"',
      'Content-Length': buffer.length,
    });
    return res.end(buffer);
  }

  if (pathname === '/api/issues' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const status = url.searchParams.get('status') || undefined;
    return sendJson(res, 200, listIssues({ status }));
  }

  const patchMatch = pathname.match(/^\/api\/issues\/(\d+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const { status } = await readJsonBody(req);
    const allowed = ['open', 'fixed', 'resolved', 'closed'];
    if (!allowed.includes(status)) return sendJson(res, 400, { error: `Invalid status "${status}"` });
    const updated = updateIssueStatus(Number(patchMatch[1]), status);
    return sendJson(res, 200, updated);
  }

  if (pathname === '/api/dashboard/summary' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const status = url.searchParams.get('status') || undefined;
    return sendJson(res, 200, getDashboardSummary({ status }));
  }

  if (pathname === '/api/functional/tests' && req.method === 'GET') {
    return sendJson(res, 200, listSuites());
  }

  if (pathname === '/api/functional/run' && req.method === 'POST') {
    const { testKeys, usernames } = await readJsonBody(req);
    if (!Array.isArray(testKeys) || !testKeys.length) return sendJson(res, 400, { error: 'Pick at least one test' });
    if (!Array.isArray(usernames) || !usernames.length) return sendJson(res, 400, { error: 'Pick at least one user' });
    const result = await runFunctionalTests({ testKeys, usernames });
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/functional/runs' && req.method === 'GET') {
    return sendJson(res, 200, listTestRunsWithSteps());
  }

  if (pathname === '/api/compare' && req.method === 'POST') {
    const { devBaseUrl, prodBaseUrl, devUsername, devPassword, paths, partnerName, headed } = await readJsonBody(req);
    try {
      new URL(devBaseUrl);
      new URL(prodBaseUrl);
    } catch {
      return sendJson(res, 400, { error: 'devBaseUrl and prodBaseUrl must be valid URLs' });
    }
    const result = await runComparison({ devBaseUrl, prodBaseUrl, devUsername, devPassword, paths, headed });
    const comparisonRunId = recordComparisonRun({
      runId: result.runId,
      devBaseUrl: result.devBaseUrl,
      prodBaseUrl: result.prodBaseUrl,
      paths: result.paths,
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      diffs: result.diffs,
      partnerName,
      screenshots: result.screenshots,
    });
    return sendJson(res, 200, { ...result, comparisonRunId });
  }

  if (pathname === '/api/compare/quote-flow' && req.method === 'POST') {
    const { devBaseUrl, prodBaseUrl, devUsername, devPassword, testProfile, partnerName, headed } = await readJsonBody(req);
    try {
      new URL(devBaseUrl);
      new URL(prodBaseUrl);
    } catch {
      return sendJson(res, 400, { error: 'devBaseUrl and prodBaseUrl must be valid URLs' });
    }
    const result = await runQuoteFlowComparison({ devBaseUrl, prodBaseUrl, devUsername, devPassword, testProfile, headed });
    const comparisonRunId = recordComparisonRun({
      runId: result.runId,
      devBaseUrl: result.devBaseUrl,
      prodBaseUrl: result.prodBaseUrl,
      paths: result.paths,
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      diffs: result.diffs,
      mode: 'quote_flow',
      stepsReachedDev: result.stepsReachedDev,
      stepsReachedProd: result.stepsReachedProd,
      partnerName,
      screenshots: result.screenshots,
    });
    return sendJson(res, 200, { ...result, comparisonRunId });
  }

  if (pathname === '/api/compare/runs' && req.method === 'GET') {
    return sendJson(res, 200, listComparisonRuns());
  }

  if (pathname === '/api/compare/dashboard' && req.method === 'GET') {
    return sendJson(res, 200, listLatestRunPerPartner());
  }

  if (pathname === '/api/compare/export' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const runId = Number(url.searchParams.get('runId'));
    const run = getComparisonRun(runId);
    if (!run) return sendJson(res, 404, { error: 'Comparison run not found' });

    const XLSX = require('xlsx');
    const rows = run.diffs.map((diff, index) => ({
      'Issue ID': index + 1,
      Category: diff.category,
      'Page/URL': diff.page_path || '',
      Description: diff.description || '',
      Severity: diff.severity,
      'Dev Value': diff.dev_value || '',
      'Prod Value': diff.prod_value || '',
      Recommendation: diff.recommendation || '',
    }));
    const sheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Comparison');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="url-comparison-run-${runId}.xlsx"`,
      'Content-Length': buffer.length,
    });
    return res.end(buffer);
  }

  const compareRunMatch = pathname.match(/^\/api\/compare\/runs\/(\d+)$/);
  if (compareRunMatch && req.method === 'GET') {
    const run = getComparisonRun(Number(compareRunMatch[1]));
    if (!run) return sendJson(res, 404, { error: 'Comparison run not found' });
    return sendJson(res, 200, run);
  }

  if (pathname === '/api/pins' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pageUrl = url.searchParams.get('page_url');
    return sendJson(res, 200, pageUrl ? listPinsForPage(pageUrl) : listAllPins());
  }

  if (pathname === '/api/pins' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { page_url, x_percent, y_percent, name, severity } = body;
    if (!page_url || typeof x_percent !== 'number' || typeof y_percent !== 'number' || !name || !severity) {
      return sendJson(res, 400, { error: 'page_url, x_percent, y_percent, name, and severity are required' });
    }
    return sendJson(res, 201, createPin(body));
  }

  const pinDeleteMatch = pathname.match(/^\/api\/pins\/(\d+)$/);
  if (pinDeleteMatch && req.method === 'DELETE') {
    deletePin(Number(pinDeleteMatch[1]));
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];

  if (pathname.startsWith('/api/')) {
    applyCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  serveStatic(res, pathname);
});

server.listen(PORT, () => {
  console.log(`QA Agent Hub running at http://localhost:${PORT}`);
});
