import type {AxiosProxyConfig} from 'axios';

export interface ParsedProxy {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const stripProxyScheme = (proxy: string) => proxy.trim().replace(/^(https?|socks5?|socks):\/\//i, '');

export const parseProxy = (proxy: string): ParsedProxy => {
  const normalizedProxy = stripProxyScheme(proxy);

  if (!normalizedProxy) {
    throw new Error('Proxy is empty');
  }

  const authSeparatorIndex = normalizedProxy.lastIndexOf('@');
  if (authSeparatorIndex > -1) {
    const authPart = normalizedProxy.slice(0, authSeparatorIndex);
    const hostPart = normalizedProxy.slice(authSeparatorIndex + 1);
    const [host, portText] = splitHostPort(hostPart);
    const passwordSeparatorIndex = authPart.indexOf(':');
    const username = passwordSeparatorIndex > -1 ? authPart.slice(0, passwordSeparatorIndex) : authPart;
    const password = passwordSeparatorIndex > -1 ? authPart.slice(passwordSeparatorIndex + 1) : '';

    return {
      host,
      port: parsePort(portText),
      username: decodeProxyComponent(username),
      password: decodeProxyComponent(password),
    };
  }

  const [host, portText, username, ...passwordParts] = normalizedProxy.split(':');
  return {
    host,
    port: parsePort(portText),
    username: username ? decodeProxyComponent(username) : undefined,
    password: passwordParts.length ? decodeProxyComponent(passwordParts.join(':')) : undefined,
  };
};

export const buildProxyUrl = (protocol: string, proxy: string) => {
  const {host, port, username, password} = parseProxy(proxy);
  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@`
    : '';
  return `${protocol.toLowerCase()}://${auth}${host}:${port}`;
};

export const getRequestProxy = (
  proxy: string,
  proxy_type: string,
): AxiosProxyConfig | undefined => {
  if (!proxy) return;
  const {host, port, username, password} = parseProxy(proxy);
  return {
    protocol: proxy_type.toLocaleLowerCase(),
    host,
    port,
    auth: username
      ? {
          username,
          password: password || '',
        }
      : undefined,
  };
};

const splitHostPort = (value: string) => {
  const portSeparatorIndex = value.lastIndexOf(':');
  if (portSeparatorIndex < 1) {
    throw new Error(`Invalid proxy host:port: ${value}`);
  }
  return [value.slice(0, portSeparatorIndex), value.slice(portSeparatorIndex + 1)];
};

const parsePort = (portText?: string) => {
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid proxy port: ${portText || ''}`);
  }
  return port;
};

const decodeProxyComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
