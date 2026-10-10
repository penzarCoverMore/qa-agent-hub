const path = require('node:path');
const fs = require('node:fs');
const { launchBrowser } = require('../lib/browser');

const MAX_PATHS = 25;
const MAX_LINKS_PER_PATH = 40;
const NAV_TIMEOUT_MS = 20000;
const LINK_CHECK_TIMEOUT_MS = 5000;

const SCREENSHOT_DIR = path.join(__dirname, '..', 'public', 'screenshots');

function sanitizeForFilename(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

// Screenshots are best-effort: a failure to capture one must never fail the
// comparison itself, so any error here just means that thumbnail is missing.
async function captureScreenshot(page, runId, label, side) {
  try {
    const dir = path.join(SCREENSHOT_DIR, runId);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${sanitizeForFilename(label)}-${side}.png`;
    await page.screenshot({ path: path.join(dir, filename), fullPage: true, timeout: 15000 });
    return `/screenshots/${runId}/${filename}`;
  } catch {
    return null;
  }
}

const FEATURE_KEYWORDS = ['faq', 'quote', 'promo', 'popup', 'modal', 'newsletter', 'cookie'];
const HIGH_SEVERITY_KEYWORDS = new Set(['quote', 'promo']);

function makeRunId() {
  return `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function diffRow({ category, issueType, pagePath, severity, description, devValue, prodValue, recommendation }) {
  return {
    category,
    issue_type: issueType,
    page_path: pagePath || null,
    severity,
    description: description || '',
    dev_value: devValue == null ? null : String(devValue),
    prod_value: prodValue == null ? null : String(prodValue),
    recommendation: recommendation || '',
  };
}

function resolveUrl(baseUrl, pagePath) {
  return new URL(pagePath, baseUrl).toString();
}

async function gotoSafe(page, url) {
  try {
    const response = await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    const status = response ? response.status() : null;
    if (status && status >= 400) return { ok: false, status, error: `HTTP ${status}` };
    return { ok: true, status };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}

async function readPageSnapshot(page) {
  const title = await page.title().catch(() => '');
  const metaDescription = await page
    .locator('meta[name="description"]')
    .first()
    .getAttribute('content')
    .catch(() => null);
  const h1 = await page.locator('h1').first().innerText().catch(() => '');

  const navLinks = await page
    .locator('nav a[href]')
    .evaluateAll((els) => els.map((el) => `${el.textContent.trim()}|${el.getAttribute('href')}`))
    .catch(() => []);

  const allLinks = await page
    .locator('a[href]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('href')).filter(Boolean))
    .catch(() => []);

  const keywordCounts = await page
    .evaluate((keywords) => {
      const counts = {};
      keywords.forEach((kw) => (counts[kw] = 0));
      document.querySelectorAll('*').forEach((el) => {
        const haystack = `${el.id || ''} ${el.className || ''} ${el.getAttribute('href') || ''}`.toLowerCase();
        const text = (el.childElementCount === 0 ? el.textContent || '' : '').toLowerCase();
        keywords.forEach((kw) => {
          if (haystack.includes(kw) || text.includes(kw)) counts[kw] += 1;
        });
      });
      return counts;
    }, FEATURE_KEYWORDS)
    .catch(() => ({}));

  return {
    title: (title || '').trim(),
    metaDescription: metaDescription == null ? '' : metaDescription.trim(),
    h1: (h1 || '').trim(),
    navLinks: [...new Set(navLinks)].sort(),
    allLinks: [...new Set(allLinks)],
    keywordCounts,
  };
}

function comparePathSnapshots(pagePath, devSnap, prodSnap, rows) {
  if (devSnap.title !== prodSnap.title) {
    rows.push(
      diffRow({
        category: 'Page content',
        issueType: 'content_mismatch',
        pagePath,
        severity: 'high',
        description: `Page title differs between Dev and Prod on ${pagePath}.`,
        devValue: devSnap.title,
        prodValue: prodSnap.title,
        recommendation: 'Confirm the correct title and update whichever environment is wrong.',
      })
    );
  }

  if (devSnap.metaDescription !== prodSnap.metaDescription) {
    rows.push(
      diffRow({
        category: 'Page content',
        issueType: 'content_mismatch',
        pagePath,
        severity: 'medium',
        description: `Meta description differs between Dev and Prod on ${pagePath}.`,
        devValue: devSnap.metaDescription,
        prodValue: prodSnap.metaDescription,
        recommendation: 'Align the meta description copy across environments.',
      })
    );
  }

  if (devSnap.h1 !== prodSnap.h1) {
    rows.push(
      diffRow({
        category: 'Page content',
        issueType: 'content_mismatch',
        pagePath,
        severity: 'medium',
        description: `Main heading (H1) differs between Dev and Prod on ${pagePath}.`,
        devValue: devSnap.h1,
        prodValue: prodSnap.h1,
        recommendation: 'Confirm which heading is correct and update the other environment.',
      })
    );
  }

  const devNav = devSnap.navLinks.join('\n');
  const prodNav = prodSnap.navLinks.join('\n');
  if (devNav !== prodNav) {
    rows.push(
      diffRow({
        category: 'Menus and navigation',
        issueType: 'menu_mismatch',
        pagePath,
        severity: 'medium',
        description: `Navigation menu links differ between Dev and Prod on ${pagePath}.`,
        devValue: devNav,
        prodValue: prodNav,
        recommendation: 'Compare the menu structures and align missing/extra links.',
      })
    );
  }

  FEATURE_KEYWORDS.forEach((kw) => {
    const devCount = devSnap.keywordCounts[kw] || 0;
    const prodCount = prodSnap.keywordCounts[kw] || 0;
    if (devCount !== prodCount) {
      rows.push(
        diffRow({
          category: 'Feature presence',
          issueType: `feature_mismatch_${kw}`,
          pagePath,
          severity: HIGH_SEVERITY_KEYWORDS.has(kw) ? 'high' : 'medium',
          description: `Elements related to "${kw}" appear a different number of times on Dev vs Prod for ${pagePath}.`,
          devValue: devCount,
          prodValue: prodCount,
          recommendation: `Manually verify the "${kw}" feature/section is present and working on both environments for ${pagePath}.`,
        })
      );
    }
  });
}

async function checkLinksForPath(page, currentUrl, label, pagePath, links, rows) {
  const sameOrigin = (href) => {
    try {
      return new URL(href, currentUrl).origin === new URL(currentUrl).origin;
    } catch {
      return false;
    }
  };

  const checkable = links.filter((href) => href && !href.startsWith('#') && !/^(tel|mailto|javascript):/i.test(href));
  const toCheck = checkable.slice(0, MAX_LINKS_PER_PATH);
  for (const href of toCheck) {
    let absolute;
    try {
      absolute = new URL(href, currentUrl).toString();
      if (!/^https?:/i.test(absolute)) continue;
    } catch {
      continue;
    }
    try {
      const response = await page.request.head(absolute, { timeout: LINK_CHECK_TIMEOUT_MS });
      if (response.status() >= 400) {
        rows.push(
          diffRow({
            category: 'Links',
            issueType: 'broken_link',
            pagePath,
            severity: sameOrigin(absolute) ? 'high' : 'low',
            description: `Broken link (HTTP ${response.status()}) found on ${label} page ${pagePath}.`,
            devValue: label === 'Dev' ? absolute : null,
            prodValue: label === 'Prod' ? absolute : null,
            recommendation: 'Fix or remove the broken link target.',
          })
        );
      }
    } catch (err) {
      rows.push(
        diffRow({
          category: 'Links',
          issueType: 'broken_link',
          pagePath,
          severity: sameOrigin(absolute) ? 'high' : 'low',
          description: `Link could not be reached on ${label} page ${pagePath}: ${err.message}`,
          devValue: label === 'Dev' ? absolute : null,
          prodValue: label === 'Prod' ? absolute : null,
          recommendation: 'Fix or remove the broken link target.',
        })
      );
    }
  }
}

async function runComparison({ devBaseUrl, prodBaseUrl, devUsername, devPassword, paths, headed }) {
  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  const cleanPaths = (Array.isArray(paths) && paths.length ? paths : ['/']).slice(0, MAX_PATHS);
  const rows = [];
  const screenshots = {};

  const browser = await launchBrowser({ headed });
  try {
    const devContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      ...(devUsername && devPassword ? { httpCredentials: { username: devUsername, password: devPassword } } : {}),
    });
    const prodContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const devPage = await devContext.newPage();
    const prodPage = await prodContext.newPage();

    try {
      for (const pagePath of cleanPaths) {
        const devUrl = resolveUrl(devBaseUrl, pagePath);
        const prodUrl = resolveUrl(prodBaseUrl, pagePath);

        const [devNav, prodNav] = await Promise.all([gotoSafe(devPage, devUrl), gotoSafe(prodPage, prodUrl)]);

        if (!devNav.ok) {
          rows.push(
            diffRow({
              category: 'Page availability',
              issueType: 'page_unreachable',
              pagePath,
              severity: 'critical',
              description: `Dev page could not be loaded: ${devNav.error}`,
              devValue: devNav.error,
              prodValue: null,
              recommendation: 'Confirm the Dev URL/credentials are correct and the page is deployed.',
            })
          );
        }
        if (!prodNav.ok) {
          rows.push(
            diffRow({
              category: 'Page availability',
              issueType: 'page_unreachable',
              pagePath,
              severity: 'critical',
              description: `Prod page could not be loaded: ${prodNav.error}`,
              devValue: null,
              prodValue: prodNav.error,
              recommendation: 'Confirm the Prod URL is correct and the page is live.',
            })
          );
        }

        if (!devNav.ok || !prodNav.ok) continue;

        const [devSnap, prodSnap] = await Promise.all([readPageSnapshot(devPage), readPageSnapshot(prodPage)]);
        comparePathSnapshots(pagePath, devSnap, prodSnap, rows);

        await checkLinksForPath(devPage, devPage.url(), 'Dev', pagePath, devSnap.allLinks, rows);
        await checkLinksForPath(prodPage, prodPage.url(), 'Prod', pagePath, prodSnap.allLinks, rows);

        const [devShot, prodShot] = await Promise.all([
          captureScreenshot(devPage, runId, pagePath, 'dev'),
          captureScreenshot(prodPage, runId, pagePath, 'prod'),
        ]);
        screenshots[pagePath] = { dev: devShot, prod: prodShot };
      }
    } finally {
      await devContext.close();
      await prodContext.close();
    }

    const finishedAt = new Date().toISOString();
    return {
      runId,
      startedAt,
      finishedAt,
      status: 'completed',
      devBaseUrl,
      prodBaseUrl,
      paths: cleanPaths,
      diffs: rows,
      diffCount: rows.length,
      screenshots,
    };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    rows.push(
      diffRow({
        category: 'Run error',
        issueType: 'run_error',
        pagePath: null,
        severity: 'critical',
        description: `Comparison run failed unexpectedly: ${err.message}`,
        devValue: null,
        prodValue: null,
        recommendation: 'Re-run the comparison; contact ai@covermore.com if this keeps happening.',
      })
    );
    return {
      runId,
      startedAt,
      finishedAt,
      status: 'completed_with_errors',
      devBaseUrl,
      prodBaseUrl,
      paths: cleanPaths,
      diffs: rows,
      diffCount: rows.length,
      screenshots,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  captureScreenshot,
  runComparison,
  MAX_PATHS,
  diffRow,
  resolveUrl,
  gotoSafe,
  readPageSnapshot,
  comparePathSnapshots,
  checkLinksForPath,
  FEATURE_KEYWORDS,
  HIGH_SEVERITY_KEYWORDS,
};
