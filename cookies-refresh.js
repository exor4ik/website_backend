'use strict';

const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');

const COOKIES_FILE  = path.join(os.tmpdir(), 'yt_cookies.txt');
const REFRESH_EVERY = 3 * 24 * 60 * 60 * 1000;

let refreshTimer  = null;
let isRefreshing  = false;
let lastRefreshAt = null;
let lastRefreshOk = false;

function toNetscapeFormat(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Auto-generated', ''];
  for (const c of cookies) {
    const domain  = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const secure  = c.secure ? 'TRUE' : 'FALSE';
    const expires = c.expires > 0 ? Math.floor(c.expires) : Math.floor(Date.now() / 1000) + 86400 * 30;
    lines.push([domain, 'TRUE', c.path || '/', secure, expires, c.name, c.value].join('\t'));
  }
  return lines.join('\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function refreshCookies() {
  if (isRefreshing) return false;

  const email    = process.env.GOOGLE_EMAIL;
  const password = process.env.GOOGLE_PASSWORD;

  if (!email || !password) {
    console.warn('[cookies] GOOGLE_EMAIL / GOOGLE_PASSWORD не заданы');
    return false;
  }

  isRefreshing = true;
  console.log('[cookies] Начинаем обновление...');

  let browser = null;

  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
      defaultViewport: { width: 1280, height: 800 },
      executablePath:  await chromium.executablePath(),
      headless:        chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ── Шаг 1: Email ──────────────────────────
    console.log('[cookies] Шаг 1: вводим email...');
    await page.goto('https://accounts.google.com/signin/v2/identifier?hl=en', {
      waitUntil: 'networkidle2',
      timeout:   30_000,
    });

    await page.waitForSelector('input[type="email"]', { visible: true, timeout: 15_000 });
    await sleep(800);
    await page.click('input[type="email"]');
    await sleep(300);
    await page.keyboard.type(email, { delay: 120 });
    await sleep(500);
    await page.keyboard.press('Enter');

    // ── Шаг 2: Ждём поле пароля ───────────────
    console.log('[cookies] Шаг 2: ждём поле пароля...');
    let passwordSelector = null;

    for (let i = 0; i < 10; i++) {
      await sleep(2_000);
      const url = page.url();
      console.log(`[cookies] Попытка ${i + 1}/10, URL: ${url}`);

      // Проверяем все возможные селекторы поля пароля
      for (const sel of ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]']) {
        const el = await page.$(sel);
        if (el) {
          passwordSelector = sel;
          console.log(`[cookies] Поле пароля найдено: ${sel}`);
          break;
        }
      }
      if (passwordSelector) break;
    }

    if (!passwordSelector) {
      const screenshotPath = path.join(os.tmpdir(), 'debug.png');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      throw new Error(`Поле пароля не появилось за 20 сек. Последний URL: ${page.url()}`);
    }

    // ── Шаг 3: Пароль ─────────────────────────
    console.log('[cookies] Шаг 3: вводим пароль...');
    await sleep(500);
    await page.click(passwordSelector);
    await sleep(300);
    await page.keyboard.type(password, { delay: 120 });
    await sleep(500);
    await page.keyboard.press('Enter');

    // ── Шаг 4: Ждём завершения входа ──────────
    console.log('[cookies] Шаг 4: ждём завершения входа...');
    await sleep(5_000);
    const finalUrl = page.url();
    console.log(`[cookies] URL после входа: ${finalUrl}`);

    if (finalUrl.includes('challenge') || finalUrl.includes('signin/rejected') || finalUrl.includes('accounts.google.com/signin')) {
      throw new Error(`Вход не завершён или требуется 2FA. URL: ${finalUrl}`);
    }

    // ── Шаг 5: YouTube ────────────────────────
    console.log('[cookies] Шаг 5: переходим на YouTube...');
    await page.goto('https://www.youtube.com', { waitUntil: 'networkidle2', timeout: 30_000 });
    await sleep(2_000);

    // ── Шаг 6: Cookies ────────────────────────
    const cookies = await page.cookies();
    console.log(`[cookies] Получено ${cookies.length} cookies`);

    if (cookies.length < 5) {
      throw new Error(`Слишком мало cookies (${cookies.length})`);
    }

    fs.writeFileSync(COOKIES_FILE, toNetscapeFormat(cookies), 'utf8');
    lastRefreshAt = new Date();
    lastRefreshOk = true;
    console.log('[cookies] ✅ Успешно обновлено');
    return true;

  } catch (err) {
    lastRefreshOk = false;
    console.error('[cookies] ❌ Ошибка:', err.message);
    if (fs.existsSync(COOKIES_FILE)) console.warn('[cookies] Работаем со старыми cookies');
    return false;

  } finally {
    if (browser) await browser.close().catch(() => {});
    isRefreshing = false;
  }
}

async function startCookieRefresh() {
  if (process.env.YT_COOKIES) {
    fs.writeFileSync(COOKIES_FILE, process.env.YT_COOKIES, 'utf8');
    lastRefreshOk = true;
    lastRefreshAt = new Date();
    console.log('[cookies] Начальные cookies загружены из YT_COOKIES env');
  } else {
    await refreshCookies();
  }

  refreshTimer = setInterval(async () => {
    console.log('[cookies] Плановое обновление...');
    await refreshCookies();
  }, REFRESH_EVERY);

  refreshTimer.unref();
}

function stopCookieRefresh()  { if (refreshTimer) clearInterval(refreshTimer); }
function getCookiesFile()     { return fs.existsSync(COOKIES_FILE) ? COOKIES_FILE : null; }
function getRefreshStatus()   {
  return {
    lastRefreshAt: lastRefreshAt?.toISOString() ?? null,
    lastRefreshOk,
    isRefreshing,
    cookiesExist:  fs.existsSync(COOKIES_FILE),
    nextRefreshIn: refreshTimer ? '~72h' : 'не запланировано',
  };
}

module.exports = { startCookieRefresh, stopCookieRefresh, getCookiesFile, getRefreshStatus, refreshCookies };
