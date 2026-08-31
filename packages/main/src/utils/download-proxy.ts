import {HttpProxyAgent} from 'http-proxy-agent';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import {session} from 'electron';
import type {Agent as HttpAgent} from 'http';
import {getSettings} from './get-settings';

export const getDownloadProxyUrl = async (url: string) => {
  const parsedUrl = new URL(url);
  if (shouldBypassProxy(parsedUrl.hostname)) {
    return '';
  }

  const configuredProxy = getSettings().runtimeDownload?.proxyUrl?.trim();
  if (configuredProxy) {
    return normalizeProxyUrl(configuredProxy);
  }

  const systemProxy = await getSystemProxyUrl(url);
  if (systemProxy) {
    return systemProxy;
  }

  const env = process.env;
  if (parsedUrl.protocol === 'https:') {
    return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || '';
  }

  return env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '';
};

export const getDownloadAgent = async (url: string): Promise<HttpAgent | undefined> => {
  const proxyUrl = await getDownloadProxyUrl(url);
  if (!proxyUrl) {
    return undefined;
  }

  if (/^socks[45]?:\/\//i.test(proxyUrl)) {
    return new SocksProxyAgent(proxyUrl);
  }

  return new URL(url).protocol === 'http:'
    ? new HttpProxyAgent(proxyUrl)
    : new HttpsProxyAgent(proxyUrl);
};

export async function getSystemProxyUrl(url: string) {
  try {
    const resolvedProxy = await session.defaultSession?.resolveProxy(url);
    return parseSystemProxyRules(resolvedProxy);
  } catch {
    return '';
  }
}

function parseSystemProxyRules(rules: string | undefined) {
  if (!rules) {
    return '';
  }

  for (const rule of rules.split(';')) {
    const [kind, endpoint] = rule.trim().split(/\s+/, 2);
    if (!kind || !endpoint || kind.toUpperCase() === 'DIRECT') {
      continue;
    }

    const normalizedKind = kind.toUpperCase();
    const protocol =
      normalizedKind === 'SOCKS4' ? 'socks4' : normalizedKind === 'SOCKS5' ? 'socks5' : 'http';
    try {
      return normalizeProxyUrl(`${protocol}://${endpoint}`);
    } catch {
      continue;
    }
  }

  return '';
}

function normalizeProxyUrl(proxyUrl: string) {
  let parsedProxy: URL;
  try {
    parsedProxy = new URL(proxyUrl);
  } catch {
    throw new Error('Runtime download proxy must be a valid HTTP(S) or SOCKS URL');
  }

  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(parsedProxy.protocol)) {
    throw new Error('Runtime download proxy must use HTTP(S) or SOCKS');
  }

  return parsedProxy.toString();
}

function shouldBypassProxy(hostname: string) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (!noProxy) {
    return false;
  }

  return noProxy
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
    .some(pattern => {
      if (pattern === '*') return true;
      if (pattern.startsWith('.')) return hostname.toLowerCase().endsWith(pattern);
      return hostname.toLowerCase() === pattern || hostname.toLowerCase().endsWith(`.${pattern}`);
    });
}
