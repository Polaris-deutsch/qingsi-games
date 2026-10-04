/*
 * Run with a local server and Playwright CLI:
 * playwright-cli open http://127.0.0.1:3000
 * playwright-cli run-code --filename scripts/smoke-qingsi-ui.js
 * Screenshots are written outside the repository.
 */
async (page) => {
  const origin = new URL(page.url()).origin;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__qingsiSmokeSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__qingsiSmokeSockets.push(this);
      }
    };
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/');
  await page.getByRole('heading', { name: 'QingSi Games', level: 1 }).waitFor();
  const count = await page.locator('.browse-card').count();
  if (count !== 32) throw new Error(`Expected 32 catalog cards, got ${count}`);
  await page.locator('#gameSearch').fill('井字棋');
  if (await page.locator('.browse-card').count() !== 1) throw new Error('Catalog search did not filter');
  await page.locator('.browse-card[data-game="tictactoe"]').click();
  await page.locator('#quickCreate').click();
  await page.waitForURL('**/game.html');
  await page.getByRole('heading', { name: '井字棋', level: 2 }).waitFor();
  const code = await page.locator('#primaryRoomCode').textContent();
  if (!/^[A-Z0-9]{3,4}$/.test(code)) throw new Error(`Invalid room code ${code}`);
  await page.waitForFunction(() => document.querySelector('#qrImage').naturalWidth > 0);
  await page.waitForFunction(() => document.querySelector('#connectionIndicator').dataset.state === 'connected', null, { timeout: 8000 });
  if (await page.locator('#connectionText').textContent() !== '已连接') throw new Error('Room connection status missing');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/qingsi-smoke-room-1440.png' });

  const guest = await page.context().newPage();
  guest.on('pageerror', error => errors.push(error.message));
  try {
    await guest.goto(origin + '/?room=' + code);
    await guest.waitForURL('**/game.html');
    await guest.getByRole('heading', { name: '井字棋', level: 2 }).waitFor();
    if (await guest.locator('#startGameBtn').isVisible()) throw new Error('Guest can see host Start button');
    await guest.locator('#readyBtn').click();
    await page.waitForFunction(() => document.querySelector('#waitingSlots').textContent.includes('已准备'));
    await page.locator('#readyBtn').click();
    await page.waitForFunction(() => !document.querySelector('#startGameBtn').disabled);
    await page.locator('#startGameBtn').click();
    await page.locator('#boardArea button').first().waitFor();
    await page.locator('#gameActions button').last().click();
    await page.locator('#waitingRoom').waitFor({ state: 'visible' });

    await page.evaluate(() => window.__qingsiSmokeSockets.at(-1).close());
    await page.waitForFunction(() => document.querySelector('#connectionIndicator').dataset.state === 'restoring');
    await page.waitForFunction(() => document.querySelector('#connectionIndicator').dataset.state === 'connected', null, { timeout: 8000 });
    await page.screenshot({ path: '/tmp/qingsi-smoke-reconnected.png' });
    await page.waitForTimeout(2700);

    const roomSizes = [];
    for (const [width, height] of [[375, 812], [390, 844], [430, 932], [820, 1180]]) {
      await page.setViewportSize({ width, height });
      const metrics = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
        qr: document.querySelector('#qrImage').getBoundingClientRect().width,
        ready: document.querySelector('#readyBtn').getBoundingClientRect().height,
      }));
      if (metrics.width > width) throw new Error(`Room overflows at ${width}px`);
      if (metrics.qr < 160 || metrics.ready < 44) throw new Error(`Room touch/QR size fails at ${width}px`);
      roomSizes.push({ width, qr: Math.round(metrics.qr), ready: Math.round(metrics.ready) });
      if (width === 390) await page.screenshot({ path: '/tmp/qingsi-smoke-room-390.png' });
    }

    await page.locator('.back-btn').click();
    await page.waitForURL(origin + '/');
    await page.waitForTimeout(500);
    const homeSizes = [];
    for (const [width, height] of [[375, 812], [390, 844], [430, 932], [820, 1180], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      const metrics = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        lab: getComputedStyle(document.querySelector('.site-nav .lab-link')).display !== 'none',
        create: document.querySelector('#quickCreate').getBoundingClientRect().height,
      }));
      if (metrics.width > width || !metrics.lab || metrics.create < 44) throw new Error(`Home layout fails at ${width}px`);
      homeSizes.push(width);
      if (width === 390) await page.screenshot({ path: '/tmp/qingsi-smoke-home-390.png' });
    }
    if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    return { catalogCards: count, roomCode: code, create: true, join: true, waiting: true, ready: true, start: true, returnToRoom: true, reconnect: true, roomSizes, homeSizes };
  } finally {
    await guest.close();
  }
}
