// name: row.name,
// group: row.group,
// proxy_id: row.proxy,
// ua: row.ua,
// remark: row.remark,
// cookie: row.cookie,
// };
// const proxy = {
// proxy_type: row.proxytype,
// proxy: row.proxy,
// ip: row.ip,
// ip_checker: row.ipchecker,
// };
// const group = {
// name: row.group,
export interface IWindowTemplate {
  id?: string;
  name?: string;
  group?: string;
  proxy?: string;
  proxy_ip?: string;
  proxyid?: string;
  proxy_id?: string;
  ua?: string;
  remark?: string;
  cookie?: string;
  browser_engine?: string;
  browser_version?: string;
  browser_runtime_platform?: string;
  [key: string]: unknown;
}
