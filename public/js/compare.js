function getSelectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function collectPaths() {
  const raw = document.getElementById('paths-input').value;
  const paths = raw.split('\n').map((p) => p.trim()).filter(Boolean);
  return paths.length ? paths : ['/'];
}

function collectTestProfile() {
  const ages = document
    .getElementById('qf-ages')
    .value.split(',')
    .map((a) => parseInt(a.trim(), 10))
    .filter((a) => !Number.isNaN(a));

  return {
    destination: document.getElementById('qf-destination').value.trim() || 'Bali',
    departDaysFromNow: parseInt(document.getElementById('qf-depart-days').value, 10) || 30,
    tripLengthDays: parseInt(document.getElementById('qf-trip-length').value, 10) || 7,
    travellerAges: ages.length ? ages : [35],
  };
}

function severityBadge(severity) {
  return `<span class="badge severity-${severity}">${severity}</span>`;
}

// The QA testing scope is organized around these 8 areas rather than the
// raw internal category/issue_type labels stored on each diff row.
const SCOPE_SECTIONS = [
  { label: 'Menus and navigation', match: (d) => d.category === 'Menus and navigation' },
  { label: 'Internal and external links', match: (d) => d.issue_type === 'broken_link' },
  { label: 'Hyperlinks', match: () => false }, // covered by "Internal and external links" above - no separate check exists
  { label: 'FAQs', match: (d) => d.issue_type === 'feature_mismatch_faq' },
  { label: 'Pop-ups', match: (d) => d.issue_type === 'feature_mismatch_popup' || d.issue_type === 'feature_mismatch_modal' },
  { label: 'Email Quote functionality', match: (d) => d.issue_type === 'feature_mismatch_quote' },
  { label: 'Promo codes and promotions', match: (d) => d.issue_type === 'feature_mismatch_promo' },
  { label: 'Page content and functionality across all relevant pages', match: () => true }, // catch-all for everything else
];

function groupByScope(diffs) {
  const groups = SCOPE_SECTIONS.map((section) => ({ label: section.label, diffs: [] }));
  const claimed = new Array(diffs.length).fill(false);

  SCOPE_SECTIONS.forEach((section, sectionIndex) => {
    diffs.forEach((d, i) => {
      if (!claimed[i] && section.match(d)) {
        claimed[i] = true;
        groups[sectionIndex].diffs.push(d);
      }
    });
  });

  return groups;
}

function diffTable(diffs) {
  const rows = diffs
    .map(
      (d, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${d.category}</td>
          <td>${d.page_path || ''}</td>
          <td>${d.description || ''}</td>
          <td>${severityBadge(d.severity)}</td>
          <td>${d.dev_value || ''}</td>
          <td>${d.prod_value || ''}</td>
          <td>${d.recommendation || ''}</td>
        </tr>`
    )
    .join('');

  return `
    <table class="diff-table">
      <thead>
        <tr>
          <th>Issue ID</th><th>Category</th><th>Page/URL</th><th>Description</th>
          <th>Severity</th><th>Dev Value</th><th>Prod Value</th><th>Recommendation</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function screenshotsGallery(screenshots) {
  if (!screenshots || !Object.keys(screenshots).length) return '';

  const pairs = Object.entries(screenshots)
    .map(([label, pair]) => {
      const devImg = pair.dev
        ? `<figure><img src="${pair.dev}" onclick="window.open('${pair.dev}', '_blank')" alt="Dev screenshot - ${label}"><figcaption>Dev</figcaption></figure>`
        : '<figure><figcaption>Dev (not captured)</figcaption></figure>';
      const prodImg = pair.prod
        ? `<figure><img src="${pair.prod}" onclick="window.open('${pair.prod}', '_blank')" alt="Prod screenshot - ${label}"><figcaption>Prod</figcaption></figure>`
        : '<figure><figcaption>Prod (not captured)</figcaption></figure>';
      return `
        <div class="screenshot-pair">
          <div class="screenshot-pair-label">${label}</div>
          <div class="screenshot-pair-images">${devImg}${prodImg}</div>
        </div>`;
    })
    .join('');

  return `
    <div class="issue-card">
      <h3>Screenshots</h3>
      <div class="screenshot-grid">${pairs}</div>
    </div>`;
}

function renderResults(run) {
  const results = document.getElementById('results');
  const diffs = run.diffs || [];

  const stepsBanner =
    run.steps_reached_dev || run.steps_reached_prod || run.stepsReachedDev || run.stepsReachedProd
      ? `<div class="issue-card">
          <strong>Steps reached — Dev:</strong> ${(run.steps_reached_dev || run.stepsReachedDev || []).join(' → ') || '(none)'}<br>
          <strong>Steps reached — Prod:</strong> ${(run.steps_reached_prod || run.stepsReachedProd || []).join(' → ') || '(none)'}
        </div>`
      : '';

  const screenshotsSection = screenshotsGallery(run.screenshots);

  const groups = groupByScope(diffs);
  const sections = groups
    .map(
      (group) => `
        <div class="issue-card">
          <h3>${group.label} <span class="issue-area">${group.diffs.length} finding(s)</span></h3>
          ${group.diffs.length ? diffTable(group.diffs) : '<p class="muted">No differences found.</p>'}
        </div>`
    )
    .join('');

  results.innerHTML = `${stepsBanner}${screenshotsSection}${sections}`;
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function worstSeverityClass(severityCounts) {
  for (const sev of SEVERITY_ORDER) {
    if (severityCounts[sev]) return `has-${sev}`;
  }
  return 'has-none';
}

function partnerDisplayName(run) {
  return run.partner_name || `${run.dev_base_url} vs ${run.prod_base_url}`;
}

async function loadPartnerDashboard() {
  const res = await fetch('/api/compare/dashboard');
  const runs = await res.json().catch(() => []);
  const container = document.getElementById('partner-dashboard');

  if (!runs.length) {
    container.innerHTML = '<p class="muted">No comparison runs yet — run one below to see it here.</p>';
    return;
  }

  container.innerHTML = runs
    .map((run) => {
      const counts = run.severityCounts || {};
      const badges = SEVERITY_ORDER.filter((sev) => counts[sev]).map((sev) => severityBadge(sev) + ` ${counts[sev]}`);
      const badgeHtml = badges.length ? badges.map((b) => `<span>${b}</span>`).join('') : '<span class="badge badge-clean">clean</span>';

      return `
        <div class="partner-card ${worstSeverityClass(counts)}">
          <div class="partner-card-header">
            <span class="partner-card-name">${partnerDisplayName(run)}</span>
            <span class="partner-card-mode">${run.mode || 'paths'}</span>
          </div>
          <div class="partner-card-meta">Last checked ${new Date(run.finished_at).toLocaleString()} — ${run.diff_count} finding(s)</div>
          <div class="partner-card-badges">${badgeHtml}</div>
          <button class="partner-card-view" data-run-id="${run.id}">View results &rarr;</button>
        </div>`;
    })
    .join('');

  container.querySelectorAll('.partner-card-view').forEach((btn) => {
    btn.addEventListener('click', () => showRunById(btn.getAttribute('data-run-id')));
  });
}

async function showRunById(id) {
  document.getElementById('past-runs').value = id;
  await onPastRunSelected();
  document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
}

function showExportLink(comparisonRunId) {
  const link = document.getElementById('export-link');
  link.href = `/api/compare/export?runId=${comparisonRunId}`;
  link.classList.remove('hidden');
}

function updateModeSections() {
  const mode = getSelectedMode();
  document.getElementById('paths-section').classList.toggle('hidden', mode !== 'paths');
  document.getElementById('quote-flow-section').classList.toggle('hidden', mode !== 'quote-flow');
}

async function runCompare() {
  const status = document.getElementById('status');
  const button = document.getElementById('compare-btn');
  const devBaseUrl = document.getElementById('dev-url').value.trim();
  const prodBaseUrl = document.getElementById('prod-url').value.trim();
  const devUsername = document.getElementById('dev-username').value.trim();
  const devPassword = document.getElementById('dev-password').value;
  const partnerName = document.getElementById('partner-name').value.trim();
  const headed = document.getElementById('headed-mode').checked;
  const mode = getSelectedMode();

  if (!devBaseUrl || !prodBaseUrl) {
    status.textContent = 'Enter both a Dev URL and a Prod URL.';
    status.className = 'status-line error';
    return;
  }

  button.disabled = true;
  const headedNote = headed ? ' A browser window will open on this machine — watch for it.' : '';
  status.textContent =
    (mode === 'quote-flow'
      ? 'Walking the quote wizard on Dev and Prod — this can take a couple of minutes...'
      : 'Comparing Dev and Prod — this can take a minute...') + headedNote;
  status.className = 'status-line running';
  document.getElementById('results').innerHTML = '';
  document.getElementById('export-link').classList.add('hidden');

  try {
    const endpoint = mode === 'quote-flow' ? '/api/compare/quote-flow' : '/api/compare';
    const body =
      mode === 'quote-flow'
        ? { devBaseUrl, prodBaseUrl, devUsername, devPassword, partnerName, headed, testProfile: collectTestProfile() }
        : { devBaseUrl, prodBaseUrl, devUsername, devPassword, partnerName, headed, paths: collectPaths() };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Comparison failed');

    status.textContent = `Done — ${result.diffCount} difference(s) found.`;
    status.className = 'status-line success';
    renderResults(result);
    showExportLink(result.comparisonRunId);
    loadPastRuns();
    loadPartnerDashboard();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'status-line error';
  } finally {
    button.disabled = false;
  }
}

async function loadPastRuns({ autoShowLatest = false } = {}) {
  const res = await fetch('/api/compare/runs');
  const runs = await res.json();
  const select = document.getElementById('past-runs');
  select.innerHTML =
    '<option value="">Select a past run...</option>' +
    runs
      .map(
        (r) =>
          `<option value="${r.id}">#${r.id} [${r.mode || 'paths'}] — ${r.dev_base_url} vs ${r.prod_base_url} (${r.diff_count} diffs, ${new Date(r.finished_at).toLocaleString()})</option>`
      )
      .join('');

  // Runs are returned newest-first, so the first run is the latest one.
  if (autoShowLatest && runs.length) {
    select.value = String(runs[0].id);
    await onPastRunSelected();
  }
}

async function onPastRunSelected() {
  const id = document.getElementById('past-runs').value;
  if (!id) return;
  const res = await fetch(`/api/compare/runs/${id}`);
  const run = await res.json();
  if (!res.ok) return;
  document.getElementById('status').textContent = `Showing saved run #${id} — ${run.diffs.length} difference(s).`;
  document.getElementById('status').className = 'status-line success';
  renderResults(run);
  showExportLink(id);
}

document.getElementById('compare-btn').addEventListener('click', runCompare);
document.getElementById('past-runs').addEventListener('change', onPastRunSelected);
document.getElementById('mode-paths').addEventListener('change', updateModeSections);
document.getElementById('mode-quote-flow').addEventListener('change', updateModeSections);
loadPastRuns({ autoShowLatest: true });
loadPartnerDashboard();
