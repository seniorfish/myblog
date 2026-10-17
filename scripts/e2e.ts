import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createStaticServer } from './serve.ts';

const root = process.cwd();
const distDir = path.join(root, 'dist');

if (!existsSync(path.join(distDir, 'manifest.json'))) {
  console.error('dist/manifest.json is missing. Run `npm run build:all` first.');
  process.exit(1);
}

const chromePath =
  process.env.CHROME_PATH ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!existsSync(chromePath)) {
  console.error(`Chrome not found at ${chromePath}. Set CHROME_PATH.`);
  process.exit(1);
}

const server = await createStaticServer(distDir, 0);
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
});

const errors: string[] = [];
const context = await browser.newContext();
const page = await context.newPage();

page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

try {
  console.log(`Serving ${server.url}`);
  await page.goto(server.url, { waitUntil: 'networkidle' });

  const initialTheme = await page.evaluate(
    () => document.documentElement.dataset.themeId ?? '',
  );
  console.log(`initial theme: ${initialTheme || '(none)'}`);
  if (initialTheme !== 'default') throw new Error('initial theme is not default');

  await page.waitForFunction(
    () => Boolean(navigator.serviceWorker?.controller),
    null,
    { timeout: 20_000 },
  );

  await page.waitForFunction(
    () => {
      const dock = document.querySelector('sys-theme-dock');
      const shadow = dock?.shadowRoot;
      if (!shadow) return false;
      return [...shadow.querySelectorAll('.theme')].some(
        (button) => !(button as HTMLButtonElement).disabled,
      );
    },
    null,
    { timeout: 20_000 },
  );
  console.log('service worker is controlling the page; dock is ready');

  const dockButtons = await page.evaluate(() => {
    const dock = document.querySelector('sys-theme-dock');
    const shadow = dock?.shadowRoot;
    return shadow
      ? [...shadow.querySelectorAll('button')].map(
          (button) => button.textContent?.trim() ?? '',
        )
      : [];
  });
  console.log(`dock buttons: ${dockButtons.join(' | ')}`);
  if (!dockButtons.some((label) => label.includes('检查'))) {
    throw new Error('theme dock is missing the update check button');
  }

  const initialUrl = page.url();
  await page.evaluate(() => {
    const dock = document.querySelector('sys-theme-dock');
    const shadow = dock?.shadowRoot;
    if (!shadow) throw new Error('theme dock shadow root is missing');

    const target = [...shadow.querySelectorAll('.theme')].find((button) =>
      button.textContent?.includes('Terminal'),
    ) as HTMLButtonElement | undefined;

    if (!target) throw new Error('Terminal theme button is missing');
    target.click();
  });

  await page.waitForFunction(
    () => document.documentElement.dataset.themeId === 'terminal',
    null,
    { timeout: 20_000 },
  );

  console.log(`switched theme: ${await page.evaluate(
    () => document.documentElement.dataset.themeId,
  )}`);

  if (page.url() !== initialUrl) {
    throw new Error(`URL changed during theme switch: ${page.url()}`);
  }

  await context.setOffline(true);
  await page.goto(`${server.url}/n/hello`, {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });

  const offlineTheme = await page.evaluate(
    () => document.documentElement.dataset.themeId ?? '',
  );
  const offlineTitle = await page.title();
  console.log(`offline theme: ${offlineTheme}; title: ${offlineTitle}`);

  if (offlineTheme !== 'terminal') {
    throw new Error('offline navigation lost the active theme');
  }
  if (!offlineTitle.includes('构建面向 AI Agent')) {
    throw new Error('offline content is missing');
  }

  await context.setOffline(false);
  console.log('E2E passed');
} finally {
  await context.close();
  await browser.close();
  await server.close();
}

if (errors.length > 0) {
  console.error('Browser errors:');
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
