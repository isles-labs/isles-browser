import express from 'express';
import {IP2Location} from 'ip2location-nodejs';
import geoip from 'geoip-lite';
import {find} from 'geo-tz';
import path from 'path';
import type {DB} from '../../../../shared/types/db';
import {WindowDB} from '/@/db/window';
import {ProxyDB} from '/@/db/proxy';
import {testProxy} from '../../network/prepare';
import {createLogger} from '../../../../shared/utils/logger';
import {PROXY_LOGGER_LABEL} from '/@/constants';
import {getCloudSyncConfig} from '../../cloud/config';

const router = express.Router();

const logger = createLogger(PROXY_LOGGER_LABEL);

const getIPInfo = async (ip: string, gateway: 'ip2location' | 'geoip') => {
  try {
    if (ip.includes(':')) {
      return {
        ip,
      };
    }
    if (gateway === 'ip2location') {
      const ip2location = new IP2Location();
      const filePath = path.join(
        import.meta.env.MODE === 'development' ? 'assets' : `${process.resourcesPath}/app/assets`,
        'IP2LOCATION-LITE-DB11.BIN',
      );
      ip2location.open(filePath);
      const ipInfo = ip2location.getAll(ip);
      const {latitude, longitude, countryShort} = ipInfo;
      const timeZone = latitude && longitude ? find(Number(latitude), Number(longitude)) : [];
      return {
        country: countryShort,
        ip,
        ll: [latitude, longitude],
        timeZone: timeZone[0],
      };
    } else if (gateway === 'geoip') {
      const ipInfo = geoip.lookup(ip);
      const {ll, country, timezone} = ipInfo;
      return {
        country,
        ip,
        ll,
        timeZone: timezone,
      };
    }
  } catch (error) {
    logger.error('| Proxy | getIPInfo | error:', error);
    return {};
  }
};

router.get('/geoip', async (req, res) => {
  const ip = req.query?.ip as string;
  if (ip) {
    const ipInfo = await getIPInfo(ip, 'geoip');
    res.send(ipInfo);
  } else {
    res.send({});
  }
});

router.get('/ip2location', async (req, res) => {
  const ip = req.query?.ip as string;
  if (ip) {
    const ipInfo = await getIPInfo(ip, 'ip2location');
    res.send(ipInfo);
  } else {
    res.send({});
  }
});

router.get('/ping', async (req, res) => {
  const {windowId} = req.query;
  let windowData: DB.Window = {};
  let pings: {
    connectivity: {name: string; elapsedTime: number; status: string; reason?: string}[];
  } = {connectivity: []};

  try {
    const config = await getCloudSyncConfig();
    windowData = await WindowDB.getByIdInScope(
      Number(windowId),
      config.enabled ? config.workspaceId : undefined,
    );
    let proxyData: DB.Proxy = {};
    if (windowData.proxy_id) {
      proxyData = await ProxyDB.getByIdInScope(
        windowData.proxy_id,
        windowData.workspace_id || undefined,
      );
      pings = await testProxy(proxyData);
    } else {
      pings = await testProxy(proxyData);
    }
  } catch (error) {
    console.error(error);
  }
  res.send({
    pings: pings.connectivity,
  });
});

export default router;
