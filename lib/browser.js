const { chromium } = require('playwright');

const BASE_URL = 'https://www.saucedemo.com/';

async function launchBrowser({ headed = false } = {}) {
  return chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });
}

async function login(page, username, password) {
  await page.goto(BASE_URL);
  await page.fill('#user-name', username);
  await page.fill('#password', password);
  await page.click('#login-button');

  const errorLocator = page.locator('[data-test="error"]');
  if (await errorLocator.isVisible().catch(() => false)) {
    return { loggedIn: false, error: (await errorLocator.innerText()).trim() };
  }
  return { loggedIn: true, error: null };
}

module.exports = { BASE_URL, launchBrowser, login };
