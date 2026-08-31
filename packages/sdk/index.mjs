const PATCHED = Symbol.for('cloakPower.humanize.patched');

const defaultHumanize = {
  enabled: true,
  mouse: true,
  keyboard: true,
  scroll: true,
  clickDelay: [60, 180],
  keyDelay: [55, 190],
  actionDelay: [220, 900],
  moveSteps: [14, 32],
  scrollSteps: [5, 12],
};

export async function openCloakProfile(options) {
  const {
    server = 'http://127.0.0.1:49156',
    windowId,
    driver = 'puppeteer',
    puppeteer,
    playwright,
    humanize = true,
    humanizeOptions = {},
    token,
  } = options || {};

  if (!windowId) {
    throw new Error('openCloakProfile requires windowId');
  }

  const response = await request(server, '/profiles/open', token, {windowId});
  if (!response.ok) {
    throw new Error(await apiError(`打开窗口 ${windowId} 失败`, response));
  }

  const payload = await response.json();
  const wsEndpoint = payload?.browser?.webSocketDebuggerUrl;
  if (!wsEndpoint) {
    throw new Error(`cloak-power-browser did not return webSocketDebuggerUrl for windowId=${windowId}`);
  }

  if (driver === 'playwright') {
    if (!playwright?.chromium && !playwright?.connectOverCDP) {
      throw new Error('Playwright driver requires the playwright module or chromium object');
    }
    const chromium = playwright.chromium || playwright;
    const browser = await chromium.connectOverCDP(wsEndpoint);
    const context = browser.contexts()[0] || (await browser.newContext?.());
    const page = context.pages()[0] || (await context.newPage());
    if (humanize) {
      patchPlaywrightPage(page, humanizeOptions);
    }
    return {browser, context, page, payload, close: () => closeCloakProfile({server, windowId, token})};
  }

  if (!puppeteer?.connect) {
    throw new Error('Puppeteer driver requires the puppeteer module');
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  if (humanize) {
    patchPuppeteerPage(page, humanizeOptions);
  }
  return {browser, page, payload, close: () => closeCloakProfile({server, windowId, token})};
}

export async function closeCloakProfile({server = 'http://127.0.0.1:49156', windowId, token}) {
  if (!windowId) {
    throw new Error('closeCloakProfile requires windowId');
  }

  const response = await request(server, '/profiles/close', token, {windowId});
  if (!response.ok) {
    throw new Error(await apiError(`关闭窗口 ${windowId} 失败`, response));
  }
  return response.json();
}

async function request(server, path, token, body) {
  const headers = {'content-type': 'application/json'};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${trimSlash(server)}${path}`, {method: 'POST', headers, body: JSON.stringify(body)});
}

async function apiError(prefix, response) {
  let detail = '';
  try { detail = (await response.json())?.error || ''; } catch { detail = ''; }
  return `${prefix}：${detail || `HTTP ${response.status}`}`;
}

export function patchPuppeteerPage(page, options = {}) {
  const config = resolveHumanizeConfig(options);
  if (!config.enabled || page?.[PATCHED]) {
    return page;
  }

  const original = {
    click: page.click?.bind(page),
    type: page.type?.bind(page),
    mouseWheel: page.mouse?.wheel?.bind(page.mouse),
  };

  if (config.mouse && original.click) {
    page.click = async (selector, clickOptions = {}) => {
      return humanClick(page, selector, {...config, ...clickOptions});
    };
  }

  if (config.keyboard && original.type) {
    page.type = async (selector, text, typeOptions = {}) => {
      return humanType(page, selector, text, {...config, ...typeOptions});
    };
  }

  if (config.scroll && original.mouseWheel) {
    page.mouse.wheel = async wheelOptions => {
      return humanWheel(page, wheelOptions, {
        ...config,
        wheel: original.mouseWheel,
        wheelMode: 'object',
      });
    };
  }

  Object.defineProperty(page, PATCHED, {
    value: {type: 'puppeteer', original, config},
    configurable: true,
  });

  return page;
}

export function patchPlaywrightPage(page, options = {}) {
  const config = resolveHumanizeConfig(options);
  if (!config.enabled || page?.[PATCHED]) {
    return page;
  }

  const original = {
    click: page.click?.bind(page),
    type: page.type?.bind(page),
    fill: page.fill?.bind(page),
    locator: page.locator?.bind(page),
    mouseWheel: page.mouse?.wheel?.bind(page.mouse),
  };

  if (config.mouse && original.click) {
    page.click = async (selector, clickOptions = {}) => {
      return humanClick(page, selector, {...config, ...clickOptions});
    };
  }

  if (config.keyboard && original.type) {
    page.type = async (selector, text, typeOptions = {}) => {
      return humanType(page, selector, text, {...config, ...typeOptions});
    };
  }

  if (config.keyboard && original.fill) {
    page.fill = async (selector, text, fillOptions = {}) => {
      await humanClear(page, selector);
      return humanType(page, selector, text, {...config, ...fillOptions});
    };
  }

  if (config.scroll && original.mouseWheel) {
    page.mouse.wheel = async (deltaX, deltaY) => {
      if (typeof deltaX === 'object') {
        return humanWheel(page, deltaX, {
          ...config,
          wheel: original.mouseWheel,
          wheelMode: 'numbers',
        });
      }
      return humanWheel(page, {deltaX, deltaY}, {
        ...config,
        wheel: original.mouseWheel,
        wheelMode: 'numbers',
      });
    };
  }

  if (original.locator) {
    page.locator = (...args) => patchPlaywrightLocator(original.locator(...args), page, config);
  }

  Object.defineProperty(page, PATCHED, {
    value: {type: 'playwright', original, config},
    configurable: true,
  });

  return page;
}

export function patchPlaywrightLocator(locator, page, options = {}) {
  const config = resolveHumanizeConfig(options);
  if (!config.enabled || locator?.[PATCHED]) {
    return locator;
  }

  const original = {
    click: locator.click?.bind(locator),
    type: locator.type?.bind(locator),
    fill: locator.fill?.bind(locator),
  };

  if (config.mouse && original.click) {
    locator.click = async clickOptions => {
      await humanClickLocator(page, locator, {...config, ...clickOptions});
    };
  }

  if (config.keyboard && original.type) {
    locator.type = async (text, typeOptions = {}) => {
      await humanClickLocator(page, locator, config);
      await humanKeyboardType(page, text, {...config, ...typeOptions});
    };
  }

  if (config.keyboard && original.fill) {
    locator.fill = async (text, fillOptions = {}) => {
      await humanClickLocator(page, locator, config);
      await selectAll(page);
      await humanKeyboardType(page, text, {...config, ...fillOptions});
    };
  }

  Object.defineProperty(locator, PATCHED, {
    value: {type: 'playwright-locator', original, config},
    configurable: true,
  });

  return locator;
}

export async function humanClick(page, selector, options = {}) {
  const config = resolveHumanizeConfig(options);
  const element = await page.waitForSelector(selector, {visible: true, timeout: options.timeout});
  const box = await element.boundingBox();
  if (!box) {
    throw new Error(`Element is not clickable: ${selector}`);
  }

  const point = choosePointInBox(box, config);
  await moveMouseHuman(page, point.x, point.y, config);
  await delayRange(config.clickDelay);
  await page.mouse.down();
  await delayRange(config.clickDelay);
  await page.mouse.up();
  await delayRange(config.actionDelay);
}

export async function humanType(page, selector, text, options = {}) {
  const config = resolveHumanizeConfig(options);
  await humanClick(page, selector, config);
  await humanKeyboardType(page, text, config);
}

export async function humanClear(page, selector) {
  await page.click(selector);
  await selectAll(page);
}

export async function humanKeyboardType(page, text, options = {}) {
  const config = resolveHumanizeConfig(options);
  for (const char of String(text)) {
    await page.keyboard.type(char);
    await delayRange(config.keyDelay);
  }
  await delayRange(config.actionDelay);
}

export async function humanWheel(page, wheelOptions = {}, options = {}) {
  const config = resolveHumanizeConfig(options);
  const wheel = options.wheel || page.mouse.wheel.bind(page.mouse);
  const wheelMode = options.wheelMode || 'object';
  const deltaX = Number(wheelOptions.deltaX || 0);
  const deltaY = Number(wheelOptions.deltaY || 0);
  const steps = randomInt(config.scrollSteps[0], config.scrollSteps[1]);

  for (let index = 0; index < steps; index++) {
    const progress = easeInOut((index + 1) / steps);
    const prev = easeInOut(index / steps);
    const slice = Math.max(0.04, progress - prev);
    const nextDeltaX = deltaX * slice + jitter(deltaX * 0.035);
    const nextDeltaY = deltaY * slice + jitter(deltaY * 0.035);
    if (wheelMode === 'numbers') {
      await wheel(nextDeltaX, nextDeltaY);
    } else {
      await wheel({deltaX: nextDeltaX, deltaY: nextDeltaY});
    }
    await delay(randomInt(90, 360));
  }
  await delayRange(config.actionDelay);
}

export async function moveMouseHuman(page, x, y, options = {}) {
  const config = resolveHumanizeConfig(options);
  const start = options.from || {
    x: x - randomInt(80, 220),
    y: y - randomInt(35, 160),
  };
  const steps = randomInt(config.moveSteps[0], config.moveSteps[1]);
  const c1 = {
    x: start.x + (x - start.x) * 0.35 + jitter(100),
    y: start.y + (y - start.y) * 0.2 + jitter(80),
  };
  const c2 = {
    x: start.x + (x - start.x) * 0.75 + jitter(70),
    y: start.y + (y - start.y) * 0.85 + jitter(60),
  };

  for (let index = 1; index <= steps; index++) {
    const t = easeInOut(index / steps);
    const point = cubicBezier(start, c1, c2, {x, y}, t);
    await page.mouse.move(point.x, point.y);
    await delay(randomInt(8, 26));
  }
}

async function humanClickLocator(page, locator, options) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Locator is not clickable');
  }
  const point = choosePointInBox(box, options);
  await moveMouseHuman(page, point.x, point.y, options);
  await delayRange(options.clickDelay);
  await page.mouse.down();
  await delayRange(options.clickDelay);
  await page.mouse.up();
  await delayRange(options.actionDelay);
}

async function selectAll(page) {
  const isMac = typeof process !== 'undefined' && process.platform === 'darwin';
  await page.keyboard.down(isMac ? 'Meta' : 'Control');
  await page.keyboard.press('A');
  await page.keyboard.up(isMac ? 'Meta' : 'Control');
  await delay(randomInt(80, 180));
}

function choosePointInBox(box) {
  const insetX = Math.min(box.width * 0.25, 12);
  const insetY = Math.min(box.height * 0.25, 10);
  return {
    x: box.x + insetX + Math.random() * Math.max(1, box.width - insetX * 2),
    y: box.y + insetY + Math.random() * Math.max(1, box.height - insetY * 2),
  };
}

function resolveHumanizeConfig(options = {}) {
  return {
    ...defaultHumanize,
    ...options,
    clickDelay: normalizeRange(options.clickDelay, defaultHumanize.clickDelay),
    keyDelay: normalizeRange(options.keyDelay, defaultHumanize.keyDelay),
    actionDelay: normalizeRange(options.actionDelay, defaultHumanize.actionDelay),
    moveSteps: normalizeRange(options.moveSteps, defaultHumanize.moveSteps),
    scrollSteps: normalizeRange(options.scrollSteps, defaultHumanize.scrollSteps),
  };
}

function normalizeRange(value, fallback) {
  if (!Array.isArray(value) || value.length !== 2) {
    return fallback;
  }
  return [Number(value[0]), Number(value[1])];
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function delayRange(range) {
  return delay(randomInt(range[0], range[1]));
}

function randomInt(min, max) {
  return Math.floor(Number(min) + Math.random() * (Number(max) - Number(min) + 1));
}

function jitter(amount) {
  return (Math.random() - 0.5) * Number(amount || 0);
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}
