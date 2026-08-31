export interface ProxyProbeInfo {
  country?: string;
  ip?: string;
  ll?: number[];
  timeZone?: string;
}

export const selectBestProxyProbeInfo = (results: ProxyProbeInfo[]) => {
  return (
    results.find(result => result.ip && (result.country || result.timeZone)) ||
    results.find(result => result.ip) ||
    results[0]
  );
};
