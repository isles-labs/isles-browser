# ISLES Power

ISLES Power is an open-source desktop manager for independent Chromium profiles, proxies, extensions, and local browser automation connections.

This repository contains the open-source edition. It launches a locally installed Chrome or Chromium executable without shipping a custom browser runtime.

## Features

- Independent Chromium profile directories
- HTTP and SOCKS5 proxy assignment
- Group, tag, and extension management
- Local API for Puppeteer, Playwright, and Selenium connections
- Optional cloud profile synchronization

## Development

Requires Node.js 18 and npm.

```bash
npm install
npm run watch:mac
```

Use `npm run build` for a production build, `npm run typecheck` for TypeScript validation, and `npm run package` to package the app locally.

Set the Chrome or Chromium executable path in Settings before opening a profile.

## License

This project is licensed under the AGPL-3.0 license. See [LICENSE](./LICENSE).
