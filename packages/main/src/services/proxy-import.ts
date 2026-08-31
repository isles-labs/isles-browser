import type {DB} from '../../../shared/types/db';

export const normalizeProxyForImport = (proxy: DB.Proxy): DB.Proxy => ({
  ...proxy,
  proxy_type: proxy.proxy_type?.trim().toLowerCase(),
  proxy: proxy.proxy?.trim(),
});

export const getProxyImportKey = (proxy: DB.Proxy) => {
  if (!proxy.proxy_type || !proxy.proxy) return null;
  return `${proxy.proxy_type}\u0000${proxy.proxy}`;
};

export const deduplicateProxyImport = (proxies: DB.Proxy[]) => {
  const uniqueProxies: DB.Proxy[] = [];
  const seenKeys = new Set<string>();
  let duplicateCount = 0;

  for (const proxy of proxies.map(normalizeProxyForImport)) {
    const key = getProxyImportKey(proxy);
    if (key && seenKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }
    if (key) seenKeys.add(key);
    uniqueProxies.push(proxy);
  }

  return {uniqueProxies, duplicateCount};
};
