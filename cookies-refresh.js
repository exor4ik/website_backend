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

// ─────────────────────────────────────────────
// Netscape формат для yt-dlp
// ─────────────────────────────────────────────

function toNetscapeFormat(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Auto-generated', ''];
  for (const c of cookies) {
    const domain  = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const secure  = c.secure   ? 'TRUE' : 'FALSE';
    const expires = c.expires > 0 ? Math.floor(c.expires) : Math.floor(Date.now() / 1000) + 86400 * 30;
    lines.push([domain, 'TRUE', c.path || '/', secure, expires, c.name, c.value].join('\t'));
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Ждём один из нескольких селекторов — возвращает какой появился
async function waitForAny(page, selectors, timeout = 15_000) {
  return Promise.race(
    selectors.map(sel =>
      page.waitForSelector(sel, { visible: true, timeout })
        .then(() => sel)
        .catch(() => null)
    )
  );
}

// ─────────────────────────────────────────────
// Основная функция
// ─────────────────────────────────────────────

async function refreshCookies() {
  if (isRefreshing) {
    console.log('[cookies] Обновление уже идёт, пропускаем');
    return false;
  }

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
        '--window-size=1280,800',
      ],
      defaultViewport: { width: 1280, height: 800 },
      executablePath:  await chromium.executablePath(),
      headless:        chromium.headless,
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ── Шаг 1: Email ──────────────────────────
    console.log('[cookies] Шаг 1: открываем форму входа...');
    await page.goto('https://accounts.google.com/signin/v2/identifier?hl=en', {
      waitUntil: 'networkidle2',
      timeout:   30_000,
    });

    await page.waitForSelector('input[type="email"]', { visible: true, timeout: 15_000 });
    await sleep(500);
    await page.type('input[type="email"]', email, { delay: 100 });
    await sleep(300);

    // Кликаем "Next" (надёжнее чем Enter)
    const nextBtn1 = await page.$('#identifierNext button, [jsname="LgbsSe"]');
    if (nextBtn1) {
      await nextBtn1.click();
    } else {
      await page.keyboard.press('Enter');
    }

    console.log('[cookies] Шаг 2: ждём поле пароля...');

    // Google может показать промежуточные экраны — ждём терпеливо
    let passwordFound = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(2_000);

      const found = await waitForAny(page, [
        'input[type="password"]',
        'input[name="password"]',
        '#password input',
      ], 3_000);

      if (found) {
        passwordFound = true;
        console.log(`[cookies] Поле пароля найдено (${found})`);
        break;
      }

      // Логируем текущий URL для отладки
      const url = page.url();
      console.log(`[cookies] Попытка ${attempt + 1}/8, URL: ${url}`);

      // Иногда Google показывает "Use another account" или похожие экраны
      const skipBtn = await page.$('[data-primary-action-label] button, [jsname="tJiF1b"]');
      if (skipBtn) {
        console.log('[cookies] Нашли промежуточную кнопку — кликаем...');
        await skipBtn.click();
      }
    }

    if (!passwordFound) {
      // Делаем скриншот для диагностики
      const screenshotPath = path.join(os.tmpdir(), 'google_login_debug.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[cookies] Скриншот сохранён: ${screenshotPath}`);
      throw new Error(`Поле пароля не появилось. URL: ${page.url()}`);
    }

    // ── Шаг 3: Password ───────────────────────
    await sleep(400);
    await page.focus('input[type="password"], input[name="password"], #password input');
    await page.keyboard.type(password, { delay: 100 });
    await sleep(300);

    const nextBtn2 = await page.$('#passwordNext button, [jsname="LgbsSe"]');
    if (nextBtn2) {
      await nextBtn2.click();
    } else {
      await page.keyboard.press('Enter');
    }

    console.log('[cookies] Шаг 3: ожидаем результат входа...');
    await sleep(4_000);

    const afterLoginUrl = page.url();
    console.log(`[cookies] После входа URL: ${afterLoginUrl}`);

    if (afterLoginUrl.includes('challenge') || afterLoginUrl.includes('signin/rejected')) {
      throw new Error(`Требуется дополнительная проверка (2FA/капча): ${afterLoginUrl}`);
    }

    // ── Шаг 4: YouTube ────────────────────────
    console.log('[cookies] Шаг 4: переходим на YouTube...');
    await page.goto('https://www.youtube.com', {
      waitUntil: 'networkidle2',
      timeout:   30_000,
    });
    await sleep(2_000);

    // ── Шаг 5: Собираем cookies ───────────────
    const cookies = await page.cookies();
    console.log(`[cookies] Получено ${cookies.length} cookies`);

    if (cookies.length < 5) {
      throw new Error(`Слишком мало cookies (${cookies.length}) — возможно вход не выполнен`);
    }

    const netscape = toNetscapeFormat(cookies);
    fs.writeFileSync(COOKIES_FILE, netscape, 'utf8');

    lastRefreshAt = new Date();
    lastRefreshOk = true;
    console.log(`[cookies] ✅ Успешно обновлено → ${COOKIES_FILE}`);
    return true;

  } catch (err) {
    lastRefreshOk = false;
    console.error('[cookies] ❌ Ошибка:', err.message);
    if (fs.existsSync(COOKIES_FILE)) {
      console.warn('[cookies] Продолжаем работать со старыми cookies');
    }
    return false;

  } finally {
    if (browser) await browser.close().catch(() => {});
    isRefreshing = false;
  }
}

// ─────────────────────────────────────────────
// Запуск и планировщик
// ─────────────────────────────────────────────

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

function stopCookieRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
}

function getCookiesFile() {
  return fs.existsSync(COOKIES_FILE) ? COOKIES_FILE : null;
}

function getRefreshStatus() {
  return {
    lastRefreshAt: lastRefreshAt?.toISOString() ?? null,
    lastRefreshOk,
    isRefreshing,
    cookiesExist:  fs.existsSync(COOKIES_FILE),
    nextRefreshIn: refreshTimer ? `~72h` : 'не запланировано',
  };
}

module.exports = { startCookieRefresh, stopCookieRefresh, getCookiesFile, getRefreshStatus, refreshCookies };
