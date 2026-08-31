import api from '../../../shared/api/api';
import type {DB} from '../../../shared/types/db';
import {WindowDB} from '../db/window';
import {getCloudSyncConfig} from '../cloud/config';
import puppeteer from 'puppeteer';
import {getWindowManager} from './window-addon';
import {createRng} from './rng';
import {getKeyStroke, getShiftKeyCode} from './keyboard';

export interface HumanClickOptions {
  windowId: number;
  selector?: string;
  x?: number;
  y?: number;
}

export interface HumanTypeOptions {
  windowId: number;
  selector?: string;
  text: string;
}

export interface HumanScrollOptions {
  windowId: number;
  deltaY?: number;
  x?: number;
  y?: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

export const humanClick = async (options: HumanClickOptions) => {
  const runtime = await getRuntime(options.windowId);
  const point = options.selector
    ? await resolveSelectorPoint(runtime.windowData, options.selector)
    : {x: options.x, y: options.y};

  if (!isFinitePoint(point)) {
    return {success: false, message: 'selector or coordinates did not resolve to a point'};
  }

  await moveMouse(runtime.windowData, point, runtime.rng);
  await sleep(runtime.rng.int(40, 140));
  runtime.manager.sendMouseEvent(
    runtime.windowData.pid,
    Math.round(point.x),
    Math.round(point.y),
    'mousedown',
  );
  await sleep(runtime.rng.int(55, 180));
  runtime.manager.sendMouseEvent(
    runtime.windowData.pid,
    Math.round(point.x),
    Math.round(point.y),
    'mouseup',
  );

  return {success: true};
};

export const humanType = async (options: HumanTypeOptions) => {
  const runtime = await getRuntime(options.windowId);

  if (options.selector) {
    await humanClick({windowId: options.windowId, selector: options.selector});
    await sleep(runtime.rng.int(120, 360));
  }

  if (!canNativeType(options.text)) {
    await typeWithPuppeteer(runtime.windowData, options.text, runtime.rng);
    return {success: true, mode: 'puppeteer-fallback'};
  }

  for (const char of options.text) {
    const stroke = getKeyStroke(char);
    if (!stroke) {
      await typeWithPuppeteer(runtime.windowData, char, runtime.rng);
      continue;
    }

    if (stroke.shift) {
      runtime.manager.sendKeyboardEvent(runtime.windowData.pid, getShiftKeyCode(), 'keydown');
      await sleep(runtime.rng.int(12, 35));
    }

    runtime.manager.sendKeyboardEvent(runtime.windowData.pid, stroke.code, 'keydown');
    await sleep(runtime.rng.int(18, 58));
    runtime.manager.sendKeyboardEvent(runtime.windowData.pid, stroke.code, 'keyup');

    if (stroke.shift) {
      await sleep(runtime.rng.int(8, 24));
      runtime.manager.sendKeyboardEvent(runtime.windowData.pid, getShiftKeyCode(), 'keyup');
    }

    await sleep(runtime.rng.int(55, 220));
  }

  return {success: true, mode: 'native'};
};

export const humanScroll = async (options: HumanScrollOptions) => {
  const runtime = await getRuntime(options.windowId);
  const bounds = runtime.manager.getWindowBounds(runtime.windowData.pid);
  if (!bounds?.success) {
    return {success: false, message: 'target window bounds unavailable'};
  }

  const x = options.x ?? Math.round(bounds.x + bounds.width * runtime.rng.between(0.42, 0.62));
  const y = options.y ?? Math.round(bounds.y + bounds.height * runtime.rng.between(0.45, 0.68));
  const targetDelta = options.deltaY ?? runtime.rng.int(420, 1100);
  const steps = runtime.rng.int(5, 12);
  let remaining = targetDelta;

  for (let index = 0; index < steps; index++) {
    const part =
      index === steps - 1
        ? remaining
        : Math.round((targetDelta / steps) * runtime.rng.between(0.65, 1.35));
    remaining -= part;
    runtime.manager.sendWheelEvent(
      runtime.windowData.pid,
      0,
      part,
      x + runtime.rng.int(-8, 8),
      y + runtime.rng.int(-8, 8),
    );
    await sleep(runtime.rng.int(45, 160));
  }

  return {success: true};
};

const getRuntime = async (windowId: number) => {
  const cloudConfig = await getCloudSyncConfig();
  const windowData = await WindowDB.getByIdInScope(
    windowId,
    cloudConfig.enabled ? cloudConfig.workspaceId : undefined,
  );
  const manager = getWindowManager();

  if (!windowData?.pid || !windowData?.port) {
    throw new Error('window is not running');
  }
  if (!manager) {
    throw new Error('native window addon is unavailable');
  }

  return {
    windowData,
    manager,
    rng: createRng(`${windowData.profile_id || windowId}:${Date.now()}`),
  };
};

const resolveSelectorPoint = async (
  windowData: DB.Window,
  selector: string,
): Promise<ScreenPoint | null> => {
  const browser = await connectBrowser(windowData);
  try {
    const pages = await browser.pages();
    const page = pages.find(item => !item.url().startsWith('chrome://')) || pages[0];
    if (!page) {
      return null;
    }

    const handle = await page.$(selector);
    const box = await handle?.boundingBox();
    if (!box) {
      return null;
    }

    const metrics = await page.evaluate(() => ({
      screenX: window.screenX,
      screenY: window.screenY,
      outerHeight: window.outerHeight,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      innerWidth: window.innerWidth,
    }));

    const chromeTop = Math.max(0, metrics.outerHeight - metrics.innerHeight);
    const chromeLeft = Math.max(0, Math.round((metrics.outerWidth - metrics.innerWidth) / 2));

    return {
      x: metrics.screenX + chromeLeft + box.x + box.width / 2,
      y: metrics.screenY + chromeTop + box.y + box.height / 2,
    };
  } finally {
    await browser.disconnect();
  }
};

const moveMouse = async (
  windowData: DB.Window,
  target: ScreenPoint,
  rng: ReturnType<typeof createRng>,
) => {
  const manager = getWindowManager();
  if (!manager || !windowData.pid) {
    return;
  }

  const bounds = manager.getWindowBounds(windowData.pid);
  const start = {
    x: bounds?.success
      ? bounds.x + bounds.width * rng.between(0.2, 0.8)
      : target.x + rng.int(-180, 180),
    y: bounds?.success
      ? bounds.y + bounds.height * rng.between(0.2, 0.8)
      : target.y + rng.int(-120, 120),
  };
  const cp1 = {
    x: start.x + (target.x - start.x) * rng.between(0.25, 0.45) + rng.int(-80, 80),
    y: start.y + (target.y - start.y) * rng.between(0.1, 0.35) + rng.int(-60, 60),
  };
  const cp2 = {
    x: start.x + (target.x - start.x) * rng.between(0.55, 0.8) + rng.int(-80, 80),
    y: start.y + (target.y - start.y) * rng.between(0.65, 0.95) + rng.int(-60, 60),
  };
  const steps = rng.int(18, 42);

  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    const point = cubicBezier(start, cp1, cp2, target, t);
    manager.sendMouseEvent(windowData.pid, Math.round(point.x), Math.round(point.y), 'mousemove');
    await sleep(rng.int(5, 18));
  }
};

const typeWithPuppeteer = async (
  windowData: DB.Window,
  text: string,
  rng: ReturnType<typeof createRng>,
) => {
  const browser = await connectBrowser(windowData);
  try {
    const pages = await browser.pages();
    const page = pages.find(item => !item.url().startsWith('chrome://')) || pages[0];
    await page?.keyboard.type(text, {delay: rng.int(70, 190)});
  } finally {
    await browser.disconnect();
  }
};

const connectBrowser = async (windowData: DB.Window) => {
  const {data} = await api.get(`http://127.0.0.1:${windowData.port}/json/version`);
  return await puppeteer.connect({
    browserWSEndpoint: data.webSocketDebuggerUrl,
    defaultViewport: null,
  });
};

const cubicBezier = (
  p0: ScreenPoint,
  p1: ScreenPoint,
  p2: ScreenPoint,
  p3: ScreenPoint,
  t: number,
) => {
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y,
  };
};

const canNativeType = (text: string) => {
  return text.split('').every(char => Boolean(getKeyStroke(char)));
};

const isFinitePoint = (point: Partial<ScreenPoint> | null): point is ScreenPoint => {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
