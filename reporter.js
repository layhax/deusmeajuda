const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

puppeteer.use(StealthPlugin());

const PROFILE_DIR = process.env.PUPPETEER_USER_DATA_DIR || path.join(__dirname, 'chrome-profile');
const COOKIES_PATH = path.join(PROFILE_DIR, 'cookies.json');

async function loadCookies(page) {
  try {
    let cookies = [];
    if (fs.existsSync(COOKIES_PATH)) {
      try {
        cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8')) || [];
      } catch (e) {
        console.warn('[Puppeteer] cookies.json inválido, ignorando arquivo:', e.message);
        cookies = [];
      }
    }

    // If CF_CLEARANCE is provided via env, ensure it's present in the cookie list
    const envCf = process.env.CF_CLEARANCE;
    const hasCfInFile = cookies.find((c) => c && c.name === 'cf_clearance');
    if (envCf && !hasCfInFile) {
      cookies.push({
        name: 'cf_clearance',
        value: envCf,
        domain: 'forum.mush.com.br',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      });
      console.log('[Puppeteer] cf_clearance injetado a partir de CF_CLEARANCE env');
    }

    if (!cookies.length) return false;
    await page.setCookie(...cookies);
    return true;
  } catch (error) {
    console.warn('[Puppeteer] falha ao carregar cookies:', error.message);
    return false;
  }
}

async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log('[Puppeteer] cookies salvos em', COOKIES_PATH);
  } catch (error) {
    console.warn('[Puppeteer] falha ao salvar cookies:', error.message);
  }
}

function getExecutablePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }

  return undefined;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function debugScreenshot(page, name) {
  try {
    const dir = path.join(__dirname, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${Date.now()}-${name}.png`), fullPage: true });
  } catch (_) {}
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 5000 });
      await page.click(selector);
      return selector;
    } catch (_) {}
  }
  throw new Error(`Nenhum seletor encontrado para clique: ${selectors.join(', ')}`);
}

async function typeFirst(page, selectors, text) {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 5000 });
      await page.click(selector, { clickCount: 3 });
      await page.type(selector, text, { delay: 15 });
      return selector;
    } catch (_) {}
  }
  throw new Error(`Nenhum seletor encontrado para digitar: ${selectors.join(', ')}`);
}

async function waitCloudflare(page, timeout = 180000) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeout) {
    attempt += 1;
    const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const title = await page.title().catch(() => '');
    const combined = `${title}\n${text}`;

    // If page doesn't show Cloudflare challenge text, consider it passed
    if (!/just a moment|checking your browser|verifica|seguran|cloudflare/i.test(combined)) {
      // also double-check presence of cf_clearance cookie
      try {
        const cookies = await page.cookies();
        const cf = cookies.find((c) => c.name === 'cf_clearance' && c.domain && c.value);
        if (cf) {
          console.log('[Puppeteer] cf_clearance encontrado, seguindo.');
          return;
        }
      } catch (_) {}
      // no cf_clearance but no obvious challenge text: assume OK
      return;
    }

    // Log progress every few attempts
    if (attempt % 3 === 0) console.log(`[Puppeteer] aguardando Cloudflare (tentativa ${attempt})`);
    await debugScreenshot(page, `cloudflare-wait-${attempt}`);
    await sleep(3000 + Math.floor(Math.random() * 2000));
  }

  await debugScreenshot(page, 'cloudflare-timeout');
  throw new Error('Cloudflare/verificação de segurança não terminou em tempo útil. Tente executar com PUPPETEER_HEADLESS=false para resolver manualmente ou adicione `cf_clearance` em chrome-profile/cookies.json.');
}

async function postReport({ categoryUrl, title, content, tags = [], attachments = [] }) {
  const executablePath = getExecutablePath();
  console.log('[Puppeteer] Chrome usado:', executablePath || 'padrão do Puppeteer');
  console.log('[Puppeteer] DBUS_SESSION_BUS_ADDRESS:', process.env.DBUS_SESSION_BUS_ADDRESS || 'não definido');

  const hasAuthEnv = Boolean(process.env.FORUM_USERNAME && process.env.FORUM_PASSWORD);

  const browser = await puppeteer.launch({
    headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
    executablePath,
    protocolTimeout: 120000,
    timeout: 120000,
    dumpio: false,
    ignoreHTTPSErrors: true,
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=TranslateUI,MediaRouter,OptimizationHints,AutofillServerCommunication',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
      '--proxy-server=direct://',
      '--proxy-bypass-list=*',
      '--password-store=basic',
      '--use-mock-keychain',
    ],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(120000);

    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['pt-BR', 'pt', 'en-US', 'en'],
      });
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Linux x86_64',
      });
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    const loadedCookies = await loadCookies(page);
    if (loadedCookies) {
      console.log('[Puppeteer] cookies carregados');
    }

    if (!loadedCookies && !hasAuthEnv) {
      throw new Error('Nenhum cookie carregado e FORUM_USERNAME/FORUM_PASSWORD não definidos.');
    }

    await page.goto('https://forum.mush.com.br', { waitUntil: 'networkidle2', timeout: 120000 });
    await waitCloudflare(page);

    const isLoggedIn = !page.url().includes('/login') && !/entrar|login/i.test(await page.title());

    if (!isLoggedIn) {
      if (!hasAuthEnv) {
        throw new Error('Sessão não autenticada e credenciais não disponíveis.');
      }
      console.log('[Puppeteer] realizando login com credenciais');
      await page.goto('https://forum.mush.com.br/login', { waitUntil: 'networkidle2', timeout: 120000 });
      await waitCloudflare(page);

      await typeFirst(page, [
        'input[name="username"]',
        'input[name="email"]',
        'input[type="text"]',
        'input[placeholder*="usuário" i]',
        'input[placeholder*="email" i]',
      ], process.env.FORUM_USERNAME);

      await typeFirst(page, [
        'input[name="password"]',
        'input[type="password"]',
        'input[placeholder*="senha" i]',
      ], process.env.FORUM_PASSWORD);

      await Promise.all([
        clickFirst(page, [
          'button[type="submit"]',
          'button.btn-primary',
          'button[component="login/login"]',
        ]).catch(async () => page.keyboard.press('Enter')),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => null),
      ]);

      await sleep(5000);
      await waitCloudflare(page);
      await saveCookies(page);
    } else {
      console.log('[Puppeteer] sessão autenticada, seguindo para a categoria');
    }

    await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 120000 });
    await waitCloudflare(page);

    await clickFirst(page, [
      'button[component="header/newtopic"]',
      'a[href*="composer"]',
      'button[title*="Tópico" i]',
      'button[aria-label*="Tópico" i]',
      'a[component="category/post"]',
    ]);

    await sleep(3000);

    await typeFirst(page, [
      'input[name="title"]',
      'input[placeholder*="título" i]',
      'input[component="composer/title"]',
      '.composer input[type="text"]',
    ], title);

    await typeFirst(page, [
      'textarea[name="content"]',
      'textarea[component="composer/textarea"]',
      '.composer textarea',
      'textarea',
    ], content);

    for (const filePath of attachments) {
      if (!fs.existsSync(filePath)) continue;
      const uploadButton = await page.$('button[data-action="upload"], button[component="composer/upload"]');
      if (!uploadButton) continue;
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 30000 }),
        uploadButton.click(),
      ]);
      await fileChooser.accept([filePath]);
      await sleep(6000);
    }

    await Promise.all([
      clickFirst(page, [
        'button[class*="publish"]',
        'button[component="composer/submit"]',
        'button[type="submit"]',
      ]),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => null),
    ]);

    await sleep(5000);

    const url = page.url();
    if (url.includes('/login')) {
      await debugScreenshot(page, 'login-falhou');
      throw new Error('Login no fórum não foi concluído. Verifique suas credenciais ou cookies.');
    }

    return url;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { postReport };
