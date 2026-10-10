const { launchBrowser } = require('../lib/browser');
const { diffRow, gotoSafe, readPageSnapshot, comparePathSnapshots, checkLinksForPath, captureScreenshot } = require('./urlComparator');

const STEP_TIMEOUT_MS = 20000;
const STEP_NAMES = ['Get Quote', 'Plan Options', 'Travellers', 'Payment'];

// Birthday fixed on Jan 9 so the computed age stays correct for most of the
// year; a traveller declared as age N on Get Quote whose DOB doesn't match
// that age can fail the Travellers form's own validation.
function dobForAge(age) {
  return `${new Date().getFullYear() - age}-01-09`;
}

const DEFAULT_TEST_PROFILE = {
  destination: 'Bali',
  departDaysFromNow: 30,
  tripLengthDays: 7,
  travellerAges: [35],
  resident: true,
  traveller: {
    firstName: 'Test',
    lastName: 'Ramesh',
    dob: dobForAge(35),
    email: 'penzar.merchant@covermore.com',
    phone: '0400000000',
    address: 'Teston 137 Teston Lane, Maules Creek NSW 2382',
  },
};

function makeRunId() {
  return `qf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function waitForSettle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function fillDestination(page, destination) {
  const selectizeInput = page.locator('input[id$="-selectized"]').first();
  if (await selectizeInput.count().catch(() => 0)) {
    // Verify the actually-clicked option really matches the requested
    // destination (not just whatever happened to be first in the list) -
    // a slow/unfiltered dropdown can otherwise cause an unrelated country
    // (e.g. "Algeria") to be selected instead of the intended one.
    for (let attempt = 0; attempt < 3; attempt++) {
      await selectizeInput.click();
      // Selectize's live-search listens for real keystrokes - .fill() sets the
      // value directly and can leave the dropdown showing its unfiltered
      // default list, so the typed text must go in character-by-character.
      await selectizeInput.fill('').catch(() => {});
      await selectizeInput.pressSequentially(destination, { delay: 70 });
      await page.waitForTimeout(1000 + attempt * 500);
      // Selectize keeps a hidden "no results" placeholder div in the DOM at
      // all times - it must be excluded, and only an actually visible match
      // clicked.
      const option = page.locator('.selectize-dropdown-content [data-value]:visible').first();
      if (await option.count().catch(() => 0)) {
        const optionText = (await option.innerText().catch(() => '')).toLowerCase();
        if (optionText.includes(destination.toLowerCase())) {
          await option.click({ timeout: 3000 }).catch(() => {});
          return true;
        }
        // Wrong/unfiltered match - close the dropdown and retry.
        await page.keyboard.press('Escape').catch(() => {});
      } else {
        await selectizeInput.press('Enter').catch(() => {});
        await page.waitForTimeout(300);
        return true;
      }
    }
    return false;
  }

  const generic = page
    .locator('input[name*="destination" i], input[placeholder*="destination" i], input[id*="destination" i], input[placeholder*="country" i]')
    .first();
  if (await generic.count().catch(() => 0)) {
    await generic.click();
    await generic.fill(destination);
    await page.waitForTimeout(500);
    await generic.press('Enter').catch(() => {});
    return true;
  }

  return false;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthYearLabel(date) {
  return `${MONTH_LABELS[date.getMonth()]} ${date.getFullYear()}`;
}

async function findRangePickerPanel(page, label) {
  const left = page.locator('.daterangepicker .drp-calendar.left .month').first();
  const right = page.locator('.daterangepicker .drp-calendar.right .month').first();
  if ((await left.innerText().catch(() => '')).trim() === label) return '.drp-calendar.left';
  if ((await right.innerText().catch(() => '')).trim() === label) return '.drp-calendar.right';
  return null;
}

async function clickRangePickerDay(page, panelSelector, day) {
  const cell = page
    .locator(`.daterangepicker ${panelSelector} td.available:not(.off)`)
    .filter({ hasText: new RegExp(`^${day}$`) })
    .first();
  if (await cell.count().catch(() => 0)) {
    await cell.click({ timeout: 3000 }).catch(() => {});
    return true;
  }
  return false;
}

async function selectRangePickerDate(page, date) {
  const label = monthYearLabel(date);
  const day = String(date.getDate());
  for (let i = 0; i < 14; i++) {
    const panel = await findRangePickerPanel(page, label);
    if (panel) return clickRangePickerDay(page, panel, day);
    const nextBtn = page.locator('.daterangepicker .next').first();
    if (!(await nextBtn.count().catch(() => 0))) return false;
    await nextBtn.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  return false;
}

async function fillDates(page, departDaysFromNow, tripLengthDays) {
  const depDate = new Date(Date.now() + departDaysFromNow * 86400000);
  const retDate = new Date(depDate.getTime() + tripLengthDays * 86400000);

  const travelDateField = page.locator('input[name="travelDate"]').first();
  if (await travelDateField.count().catch(() => 0)) {
    // Clicking through the calendar can land on the wrong day under load (a
    // month-navigation re-render racing the next click) and silently select
    // the same day twice - verify the two dates actually differ afterward,
    // and retry from a freshly-reopened picker if they don't.
    for (let attempt = 0; attempt < 3; attempt++) {
      await travelDateField.click();
      await page.waitForTimeout(300);
      const opened = await page.locator('.daterangepicker:visible').first().count().catch(() => 0);
      if (!opened) break;

      const depOk = await selectRangePickerDate(page, depDate);
      await page.waitForTimeout(400);
      const retOk = await selectRangePickerDate(page, retDate);
      await page.waitForTimeout(400);

      const value = await travelDateField.inputValue().catch(() => '');
      const [depText, retText] = value.split(' - ').map((s) => s.trim());
      if (depOk && retOk && depText && retText && depText !== retText) {
        return true;
      }

      // Wrong/duplicate selection - close the picker and try the whole
      // depart+return selection again from scratch.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  const hasHiddenFields = await page.locator('input[name="dep_date"]').count().catch(() => 0);
  if (hasHiddenFields) {
    await page.evaluate(
      ({ depIso, retIso, depDisplay, retDisplay }) => {
        const dep = document.querySelector('input[name="dep_date"]');
        const ret = document.querySelector('input[name="return_date"]');
        const visible = document.querySelector('input[name="travelDate"]');
        if (dep) {
          dep.value = depIso;
          dep.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (ret) {
          ret.value = retIso;
          ret.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (visible) {
          visible.value = `${depDisplay} - ${retDisplay}`;
          visible.dispatchEvent(new Event('input', { bubbles: true }));
          visible.dispatchEvent(new Event('change', { bubbles: true }));
        }
      },
      { depIso: isoDate(depDate), retIso: isoDate(retDate), depDisplay: formatDate(depDate), retDisplay: formatDate(retDate) }
    );
    return true;
  }

  const generic = page.locator('input[name*="date" i], input[placeholder*="date" i]').first();
  if (await generic.count().catch(() => 0)) {
    await generic.fill(formatDate(depDate));
    return true;
  }

  return false;
}

async function fillAges(page, ages) {
  let filledAny = false;
  for (let i = 0; i < ages.length; i++) {
    const input = page.locator(`input[name="age[age_${i}]"]`).first();
    if (await input.count().catch(() => 0)) {
      await input.fill(String(ages[i]));
      filledAny = true;
    } else if (i === 0) {
      const generic = page.locator('input[name*="age" i]').first();
      if (await generic.count().catch(() => 0)) {
        await generic.fill(String(ages[i]));
        filledAny = true;
      }
    }
  }
  return filledAny;
}

async function setResident(page, resident) {
  const value = resident ? '1' : '0';
  const radio = page.locator(`input[name="resident"][value="${value}"]`).first();
  if (await radio.count().catch(() => 0)) {
    await radio.check({ force: true });
  }
}

async function submitGetQuote(page) {
  const known = page.locator('#edit-submit:visible, button:has-text("Get a Quote"):visible, button:has-text("Get Quote"):visible').first();
  if (await known.count().catch(() => 0)) {
    await known.click({ timeout: 5000 }).catch(() => {});
    return true;
  }
  const generic = page.locator('button:visible:has-text("Continue"), button:visible:has-text("Next"), input[type="submit"]:visible').first();
  if (await generic.count().catch(() => 0)) {
    await generic.click({ timeout: 5000 }).catch(() => {});
    return true;
  }
  return false;
}

async function acceptConsentDialog(page) {
  const agreeBtn = page
    .locator('button:visible:has-text("I Agree"), button:visible:has-text("I accept"), button:visible:has-text("Accept")')
    .first();
  if (await agreeBtn.count().catch(() => 0)) {
    await agreeBtn.click({ timeout: 5000 }).catch(() => {});
    return true;
  }
  return false;
}

async function advanceGetQuote(page, testProfile, runId, side) {
  try {
    const destOk = await fillDestination(page, testProfile.destination);
    if (!destOk) return { ok: false, error: 'Could not find a destination field' };

    const dateOk = await fillDates(page, testProfile.departDaysFromNow, testProfile.tripLengthDays);
    if (!dateOk) return { ok: false, error: 'Could not find a travel date field' };

    const agesOk = await fillAges(page, testProfile.travellerAges);
    if (!agesOk) return { ok: false, error: 'Could not find a traveller age field' };

    await setResident(page, testProfile.resident).catch(() => {});

    // Screenshot after filling but before submitting, so the saved image
    // shows what was actually entered rather than the blank starting form.
    const screenshot = await captureScreenshot(page, runId, 'Get Quote', side);

    const submitted = await submitGetQuote(page);
    if (!submitted) return { ok: false, error: 'Could not find a submit/"Get a Quote" button', screenshot };

    // Some partners show a terms-acknowledgement dialog ("I Agree - Get Quote")
    // after the initial submit, before the plan results render. Others render
    // plan results in-place via AJAX without ever changing the URL, so a
    // "did navigation happen" check is unreliable here - the next step
    // (finding a Select/Choose/Buy button) is what actually proves success.
    await page.waitForTimeout(1000);
    await acceptConsentDialog(page).catch(() => {});
    await waitForSettle(page);

    return { ok: true, screenshot };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function extractPlanList(page) {
  return page
    .evaluate(() => {
      const cards = document.querySelectorAll('[class*="plan" i], [class*="product" i], [class*="tier" i]');
      const names = new Set();
      cards.forEach((el) => {
        const heading = el.querySelector('h2, h3, h4');
        if (heading && heading.textContent.trim()) names.add(heading.textContent.trim());
      });
      return [...names].slice(0, 20);
    })
    .catch(() => []);
}

async function advancePlanOptions(page, runId, side) {
  try {
    // Covers both real buttons/links (text content) and <input type="submit">
    // controls (label lives in the "value" attribute, which :has-text() can't see).
    const btn = page
      .locator(
        [
          'a:visible:has-text("Select")',
          'button:visible:has-text("Select")',
          'a:visible:has-text("Choose")',
          'button:visible:has-text("Choose")',
          'a:visible:has-text("Buy")',
          'button:visible:has-text("Buy")',
          'input[type="submit"]:visible[value*="Select" i]',
          'input[type="submit"]:visible[value*="Choose" i]',
          'input[type="submit"]:visible[value*="Buy" i]',
        ].join(', ')
      )
      .first();
    if (!(await btn.count().catch(() => 0))) return { ok: false, error: 'Could not find a plan "Select/Choose/Buy" button' };
    await btn.click({ timeout: 5000 });
    await waitForSettle(page);
    // Some partners reveal extra "options to vary cover" add-ons on this same
    // page once a plan is selected, without navigating anywhere - screenshot
    // after selecting so that content is actually captured.
    const screenshot = await captureScreenshot(page, runId, 'Plan Options', side);
    return { ok: true, screenshot };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fillByPatterns(page, selectors, value) {
  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if (await input.count().catch(() => 0)) {
      await input.fill(String(value), { timeout: 3000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

// Masked/formatted inputs (date-of-birth with a DD/MM/YYYY mask, etc.)
// reformat the value as you type - a raw .fill() pastes the whole string at
// once and can produce garbage (e.g. "1990-01-01" mangled into
// "19/90/0101"). Real keystrokes let the mask's own formatting keep up.
async function fillByPatternsTyped(page, selectors, value) {
  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if (await input.count().catch(() => 0)) {
      await input.click({ timeout: 3000 }).catch(() => {});
      await input.fill('').catch(() => {});
      await input.pressSequentially(String(value), { delay: 40 }).catch(() => {});
      return true;
    }
  }
  return false;
}

function isoToDDMMYYYY(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Text-matched "Continue/Next/Proceed" controls must be tried before the
// bare input[type="submit"] fallback - DOM order (not list order) decides
// which Playwright's .first() picks, and a stray "Select"/"Choose" submit
// input left over from an earlier step (e.g. a plan-switch button still
// visible on an add-ons page) can sit earlier in the DOM and get clicked
// instead of the real continue control.
const CONTINUE_TEXT_SELECTOR = 'button:visible:has-text("Continue"), button:visible:has-text("Next"), button:visible:has-text("Proceed")';
const CONTINUE_FALLBACK_SELECTOR = 'input[type="submit"]:visible:not([value*="Select" i]):not([value*="Choose" i]):not([value*="Buy" i])';

async function clickGenericContinue(page) {
  const specific = page.locator(CONTINUE_TEXT_SELECTOR).first();
  if (await specific.count().catch(() => 0)) {
    await specific.click({ timeout: 5000 }).catch(() => {});
    await waitForSettle(page);
    return true;
  }
  const fallback = page.locator(CONTINUE_FALLBACK_SELECTOR).first();
  if (await fallback.count().catch(() => 0)) {
    await fallback.click({ timeout: 5000 }).catch(() => {});
    await waitForSettle(page);
    return true;
  }
  return false;
}

// Address fields are often an autocomplete widget by default - a visible
// "Enter manually" control switches it to a plain free-text input first.
// A generic "contains address" selector can also wrongly match an email
// field named e.g. "emailAddress", so email-like fields are excluded here.
async function fillAddressField(page, address) {
  const manualLink = page.locator('a:visible:has-text("Enter manually"), button:visible:has-text("Enter manually")').first();
  if (await manualLink.count().catch(() => 0)) {
    await manualLink.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  return fillByPatterns(
    page,
    [
      'input[name*="address" i]:not([type="email"]):not([name*="email" i])',
      'input[id*="address" i]:not([type="email"]):not([id*="email" i])',
      'input[placeholder*="address" i]:not([type="email"])',
      'textarea[name*="address" i]',
    ],
    address
  );
}

async function fillTravellerFields(page, traveller) {
  const firstOk = await fillByPatterns(page, ['input[name*="first" i][name*="name" i]', 'input[id*="first" i][id*="name" i]'], traveller.firstName);
  const lastOk = await fillByPatterns(
    page,
    [
      'input[name*="last" i][name*="name" i]',
      'input[id*="last" i][id*="name" i]',
      'input[name*="surname" i]',
      'input[id*="surname" i]',
    ],
    traveller.lastName
  );
  const emailOk = await fillByPatterns(page, ['input[type="email"]', 'input[name*="email" i]'], traveller.email);
  const phoneOk = await fillByPatterns(page, ['input[name*="phone" i]', 'input[name*="mobile" i]'], traveller.phone);
  const dobOk =
    (await fillByPatternsTyped(page, ['input[name*="dob" i]', 'input[name*="birth" i]'], isoToDDMMYYYY(traveller.dob))) ||
    (await fillByPatterns(page, ['input[type="date"]'], traveller.dob));
  const addressOk = await fillAddressField(page, traveller.address);
  return firstOk || lastOk || emailOk || phoneOk || dobOk || addressOk;
}

// Add-on pages (optional extras shown between picking a plan and the real
// traveller form) often have a *required* dropdown (e.g. cancellation cover
// amount) that must have a real value selected before Continue is enabled.
// Picking the first non-placeholder option satisfies validation generically,
// without needing to know what the "right" choice is for any given partner.
async function fillRequiredSelects(page) {
  const selects = await page.locator('select[required]').all().catch(() => []);
  for (const select of selects) {
    const current = await select.inputValue().catch(() => '');
    if (current) continue;
    const firstRealOption = select.locator('option[value]:not([value=""])').first();
    const optValue = await firstRealOption.getAttribute('value').catch(() => null);
    if (optValue != null) await select.selectOption(optValue).catch(() => {});
  }
}

// Matches radios by their associated <label> text rather than a value
// attribute, since value conventions (0/1, true/false, Y/N...) differ
// across partners but the visible "Yes"/"No" wording is consistent.
async function selectRadiosByLabel(page, labelText) {
  const radioIds = await page
    .evaluate(
      (text) =>
        [...document.querySelectorAll('label')]
          .filter((label) => label.textContent.trim() === text)
          .map((label) => label.getAttribute('for'))
          .filter(Boolean),
      labelText
    )
    .catch(() => []);

  for (const id of radioIds) {
    const radio = page.locator(`#${id}`);
    if (await radio.count().catch(() => 0)) {
      await radio.check({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

// The Plan Options/add-ons page asks several yes/no questions (going on a
// cruise, riding a motorbike, etc.) - select "Yes" on all of them so every
// optional add-on gets opted into and compared, not just whichever ones are
// strictly required to proceed.
async function selectAllYesRadios(page) {
  await selectRadiosByLabel(page, 'Yes');
}

// The Travellers page asks yes/no questions too (e.g. "Does this traveller
// have existing medical conditions to declare?") - answering "No" keeps the
// flow on its simplest path instead of opening a lengthy medical
// questionnaire.
async function selectAllNoRadios(page) {
  await selectRadiosByLabel(page, 'No');
}

// Some partners show a "riding a motorbike or moped?" add-on: answering
// "Yes" (already handled by selectAllYesRadios) reveals a level-select
// dropdown that still needs an explicit choice - fill it when present.
async function fillMotorcycleAddon(page) {
  const levelSelect = page.locator('select:has(option:text-is("Motorcycle/Moped Riding"))').first();
  if (await levelSelect.count().catch(() => 0)) {
    await levelSelect.selectOption({ label: 'Motorcycle/Moped Riding' }).catch(() => {});
  }
}

// Add-on pages can also have required yes/no radio groups (e.g. "Going on a
// cruise?") marked via data-msg-required rather than the plain HTML
// "required" attribute. Any unanswered required group blocks Continue;
// picking whichever option is first satisfies validation generically.
async function fillRequiredRadioGroups(page) {
  const requiredRadios = await page.locator('input[type="radio"][data-msg-required], input[type="radio"][required]').all().catch(() => []);
  const handledNames = new Set();
  for (const radio of requiredRadios) {
    const name = await radio.getAttribute('name').catch(() => null);
    if (!name || handledNames.has(name)) continue;
    handledNames.add(name);
    const alreadyChecked = await page.locator(`input[type="radio"][name="${name}"]:checked`).count().catch(() => 0);
    if (alreadyChecked) continue;
    await radio.check({ force: true }).catch(() => {});
  }
}

async function advanceTravellers(page, testProfile, runId, side) {
  try {
    const t = testProfile.traveller;
    let filledAny = await fillTravellerFields(page, t);

    // Some partners show an intermediate "add-ons" / optional-extras page
    // between picking a plan and the real traveller-details form. If no
    // recognizable traveller fields are found yet, satisfy any required
    // add-on selections and try clicking through a couple of generic
    // Continue/Next controls before giving up.
    for (let hop = 0; !filledAny && hop < 2; hop++) {
      await selectAllYesRadios(page).catch(() => {});
      await fillRequiredSelects(page).catch(() => {});
      await fillMotorcycleAddon(page).catch(() => {});
      await fillRequiredRadioGroups(page).catch(() => {});
      const advanced = await clickGenericContinue(page);
      if (!advanced) break;
      filledAny = await fillTravellerFields(page, t);
    }

    if (!filledAny) {
      return { ok: false, error: 'Could not find any recognizable traveller detail fields' };
    }

    // The real Travellers form itself can have its own yes/no questions
    // (e.g. existing medical conditions) - answer "No" to keep the simplest
    // path through, same as a real tester would for a clean test profile.
    await selectAllNoRadios(page).catch(() => {});

    // Screenshot the filled-in real traveller form before continuing - this
    // is the page the add-on hop loop above was trying to reach, as opposed
    // to the add-ons page some partners show at the same URL beforehand.
    const screenshot = await captureScreenshot(page, runId, 'Travellers', side);

    const advanced = await clickGenericContinue(page);
    if (!advanced) return { ok: false, error: 'Could not find a Continue/Next button on the Travellers step', screenshot };
    return { ok: true, screenshot };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function detectPaymentFields(page) {
  const count = await page
    .locator('input[name*="card" i], input[placeholder*="card number" i], input[name*="cvv" i], input[name*="cvc" i], input[name*="expiry" i]')
    .count()
    .catch(() => 0);
  return count > 0;
}

async function runSideSteps(page, baseUrl, testProfile, runId, side) {
  const result = {
    snapshots: {},
    urls: {},
    screenshots: {},
    planList: null,
    paymentFieldsPresent: null,
    reachedSteps: [],
    blockedAt: null,
    blockReason: null,
  };

  const nav = await gotoSafe(page, baseUrl);
  if (!nav.ok) {
    result.blockedAt = 'Get Quote';
    result.blockReason = nav.error;
    return result;
  }
  result.urls['Get Quote'] = page.url();
  result.snapshots['Get Quote'] = await readPageSnapshot(page);
  result.reachedSteps.push('Get Quote');

  const quoteAdvance = await advanceGetQuote(page, testProfile, runId, side);
  result.screenshots['Get Quote'] = quoteAdvance.screenshot || null;
  if (!quoteAdvance.ok) {
    result.blockedAt = 'Plan Options';
    result.blockReason = quoteAdvance.error;
    return result;
  }
  result.urls['Plan Options'] = page.url();
  result.snapshots['Plan Options'] = await readPageSnapshot(page);
  result.planList = await extractPlanList(page);
  result.reachedSteps.push('Plan Options');

  const planAdvance = await advancePlanOptions(page, runId, side);
  result.screenshots['Plan Options'] = planAdvance.screenshot || null;
  if (!planAdvance.ok) {
    result.blockedAt = 'Travellers';
    result.blockReason = planAdvance.error;
    return result;
  }
  result.urls['Travellers'] = page.url();
  result.snapshots['Travellers'] = await readPageSnapshot(page);
  result.reachedSteps.push('Travellers');

  const travellerAdvance = await advanceTravellers(page, testProfile, runId, side);
  result.screenshots['Travellers'] = travellerAdvance.screenshot || null;
  if (!travellerAdvance.ok) {
    result.blockedAt = 'Payment';
    result.blockReason = travellerAdvance.error;
    return result;
  }
  result.urls['Payment'] = page.url();
  result.snapshots['Payment'] = await readPageSnapshot(page);
  result.screenshots['Payment'] = await captureScreenshot(page, runId, 'Payment', side);
  result.paymentFieldsPresent = await detectPaymentFields(page);
  result.reachedSteps.push('Payment');

  return result;
}

async function runQuoteFlowComparison({ devBaseUrl, prodBaseUrl, devUsername, devPassword, testProfile, headed }) {
  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  const profile = {
    ...DEFAULT_TEST_PROFILE,
    ...(testProfile || {}),
    traveller: { ...DEFAULT_TEST_PROFILE.traveller, ...((testProfile && testProfile.traveller) || {}) },
  };
  // If the caller changed travellerAges without also giving an explicit DOB,
  // recompute it so the declared age and date of birth stay consistent.
  if (!(testProfile && testProfile.traveller && testProfile.traveller.dob) && Array.isArray(profile.travellerAges) && profile.travellerAges[0]) {
    profile.traveller.dob = dobForAge(profile.travellerAges[0]);
  }
  const rows = [];

  const browser = await launchBrowser({ headed });
  try {
    const devContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      ...(devUsername && devPassword ? { httpCredentials: { username: devUsername, password: devPassword } } : {}),
    });
    const prodContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const devPage = await devContext.newPage();
    const prodPage = await prodContext.newPage();

    let devResult;
    let prodResult;
    try {
      [devResult, prodResult] = await Promise.all([
        runSideSteps(devPage, devBaseUrl, profile, runId, 'dev'),
        runSideSteps(prodPage, prodBaseUrl, profile, runId, 'prod'),
      ]);

      for (const step of STEP_NAMES) {
        const devReached = devResult.reachedSteps.includes(step);
        const prodReached = prodResult.reachedSteps.includes(step);

        if (devReached && prodReached) {
          comparePathSnapshots(step, devResult.snapshots[step], prodResult.snapshots[step], rows);
          await checkLinksForPath(devPage, devResult.urls[step], 'Dev', step, devResult.snapshots[step].allLinks, rows);
          await checkLinksForPath(prodPage, prodResult.urls[step], 'Prod', step, prodResult.snapshots[step].allLinks, rows);

          if (step === 'Plan Options' && devResult.planList && prodResult.planList) {
            const devPlans = devResult.planList.join('\n');
            const prodPlans = prodResult.planList.join('\n');
            if (devPlans !== prodPlans) {
              rows.push(
                diffRow({
                  category: 'Plan options',
                  issueType: 'plan_list_mismatch',
                  pagePath: step,
                  severity: 'high',
                  description: 'The plan names/tiers shown differ between Dev and Prod.',
                  devValue: devPlans,
                  prodValue: prodPlans,
                  recommendation: 'Confirm the correct set of plans and align whichever environment is missing/extra plans.',
                })
              );
            }
          }

          if (step === 'Payment' && devResult.paymentFieldsPresent !== prodResult.paymentFieldsPresent) {
            rows.push(
              diffRow({
                category: 'Payment',
                issueType: 'payment_fields_mismatch',
                pagePath: step,
                severity: 'critical',
                description: 'Payment form fields (card number/expiry/CVV) appear present on one environment but not the other.',
                devValue: devResult.paymentFieldsPresent,
                prodValue: prodResult.paymentFieldsPresent,
                recommendation: 'Verify the payment form renders correctly on both environments. Payment was not submitted by this tool.',
              })
            );
          }
        } else if (devReached !== prodReached) {
          rows.push(
            diffRow({
              category: 'Page availability',
              issueType: 'step_unreachable',
              pagePath: step,
              severity: 'critical',
              description: `${devReached ? 'Prod' : 'Dev'} could not reach the "${step}" step: ${
                devReached ? prodResult.blockReason : devResult.blockReason
              }`,
              devValue: devReached ? 'reached' : null,
              prodValue: prodReached ? 'reached' : null,
              recommendation: 'Investigate why this environment could not progress to this step; the form fields may differ from the generic patterns this tool recognizes.',
            })
          );
        } else if (!devReached && !prodReached && devResult.blockedAt === step && prodResult.blockedAt === step) {
          rows.push(
            diffRow({
              category: 'Page availability',
              issueType: 'step_blocked',
              pagePath: step,
              severity: 'high',
              description: `Neither Dev nor Prod could be progressed to the "${step}" step automatically.`,
              devValue: devResult.blockReason,
              prodValue: prodResult.blockReason,
              recommendation: 'This partner\'s form may not match the generic field patterns this tool recognizes; verify this step manually.',
            })
          );
        }
      }

      rows.push(
        diffRow({
          category: 'Run info',
          issueType: 'confirmation_not_tested',
          pagePath: 'Confirmation',
          severity: 'low',
          description: 'Confirmation was not tested — reaching it requires submitting real payment, which this tool intentionally never does.',
          devValue: null,
          prodValue: null,
          recommendation: 'Manually verify the Confirmation step if needed, using a safe test-card flow.',
        })
      );
    } finally {
      await devContext.close();
      await prodContext.close();
    }

    const screenshots = {};
    STEP_NAMES.forEach((step) => {
      if (devResult.screenshots[step] || prodResult.screenshots[step]) {
        screenshots[step] = { dev: devResult.screenshots[step] || null, prod: prodResult.screenshots[step] || null };
      }
    });

    const finishedAt = new Date().toISOString();
    return {
      runId,
      startedAt,
      finishedAt,
      status: 'completed',
      devBaseUrl,
      prodBaseUrl,
      paths: STEP_NAMES,
      stepsReachedDev: devResult.reachedSteps,
      stepsReachedProd: prodResult.reachedSteps,
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
        description: `Quote flow comparison failed unexpectedly: ${err.message}`,
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
      paths: STEP_NAMES,
      stepsReachedDev: [],
      stepsReachedProd: [],
      diffs: rows,
      diffCount: rows.length,
      screenshots: {},
    };
  } finally {
    await browser.close();
  }
}

module.exports = { runQuoteFlowComparison, DEFAULT_TEST_PROFILE, STEP_NAMES };
