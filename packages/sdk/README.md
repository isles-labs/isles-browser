# @liwenguan/cloak-power-humanize-sdk

用于把 Puppeteer / Playwright 自动化项目连接到 `cloak-power-browser` 的客户端 SDK，并在脚本侧提供 wrapper-style Humanize 行为层。

## 安装

```bash
npm install @liwenguan/cloak-power-humanize-sdk@0.1.0
```

## Puppeteer

```js
import puppeteer from 'puppeteer';
import {openCloakProfile} from '@liwenguan/cloak-power-humanize-sdk';

const {browser, page, close} = await openCloakProfile({
  windowId: 1,
  puppeteer,
  // 在 Cloak Power Browser 的 API 页面复制本机 token
  token: process.env.CLOAK_API_TOKEN,
  humanize: true,
});

await page.goto('https://example.com');
await page.click('button');
await page.type('input[name="q"]', 'hello');

await browser.disconnect();
await close();
```

## Playwright

```js
import {chromium} from 'playwright';
import {openCloakProfile} from '@liwenguan/cloak-power-humanize-sdk';

const {browser, page, close} = await openCloakProfile({
  windowId: 1,
  driver: 'playwright',
  playwright: {chromium},
  token: process.env.CLOAK_API_TOKEN,
  humanize: true,
});

await page.goto('https://example.com');
await page.click('button');
await page.type('input[name="q"]', 'hello');

await browser.close();
await close();
```

## Humanize 选项

```js
await openCloakProfile({
  windowId: 1,
  puppeteer,
  humanize: true,
  humanizeOptions: {
    clickDelay: [60, 180],
    keyDelay: [55, 190],
    actionDelay: [220, 900],
    moveSteps: [14, 32],
    scrollSteps: [5, 12],
  },
});
```

注意：这个 SDK 不会抢占系统鼠标，它是通过 Puppeteer / Playwright 页面 API 进行行为包装。
