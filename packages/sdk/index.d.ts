export type DriverModule = Record<string, unknown>;
export type BrowserLike = Record<string, unknown>;
export type PageLike = Record<string, unknown>;
export type LocatorLike = Record<string, unknown>;

export interface OpenCloakProfileOptions {
  server?: string;
  token?: string;
  windowId: number | string;
  driver?: 'puppeteer' | 'playwright';
  puppeteer?: DriverModule;
  playwright?: DriverModule;
  humanize?: boolean;
  humanizeOptions?: HumanizeOptions;
}

export interface HumanizeOptions {
  enabled?: boolean;
  mouse?: boolean;
  keyboard?: boolean;
  scroll?: boolean;
  clickDelay?: [number, number];
  keyDelay?: [number, number];
  actionDelay?: [number, number];
  moveSteps?: [number, number];
  scrollSteps?: [number, number];
  timeout?: number;
}

export interface OpenCloakProfileResult {
  browser: BrowserLike;
  context?: BrowserLike;
  page: PageLike;
  payload: unknown;
  close: () => Promise<unknown>;
}

export function openCloakProfile(options: OpenCloakProfileOptions): Promise<OpenCloakProfileResult>;
export function closeCloakProfile(options: {server?: string; token?: string; windowId: number | string}): Promise<unknown>;
export function patchPuppeteerPage<T extends PageLike>(page: T, options?: HumanizeOptions): T;
export function patchPlaywrightPage<T extends PageLike>(page: T, options?: HumanizeOptions): T;
export function patchPlaywrightLocator<T extends LocatorLike>(locator: T, page: PageLike, options?: HumanizeOptions): T;
export function humanClick(page: PageLike, selector: string, options?: HumanizeOptions): Promise<void>;
export function humanType(page: PageLike, selector: string, text: string, options?: HumanizeOptions): Promise<void>;
export function humanClear(page: PageLike, selector: string): Promise<void>;
export function humanKeyboardType(page: PageLike, text: string, options?: HumanizeOptions): Promise<void>;
export function humanWheel(
  page: PageLike,
  wheelOptions?: {deltaX?: number; deltaY?: number},
  options?: HumanizeOptions,
): Promise<void>;
export function moveMouseHuman(page: PageLike, x: number, y: number, options?: HumanizeOptions): Promise<void>;
