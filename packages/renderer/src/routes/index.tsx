import Windows from '../pages/windows';
// import About from '../pages/about';
import Settings from '../pages/settings';
import Proxy from '../pages/proxy';
import WindowDetail from '../pages/windows/detail';
import ProxyImport from '../pages/proxy/import';
import {Icon} from '@iconify/react';
import Sync from '../pages/sync';
import {useMemo, type ReactElement} from 'react';
import {useTranslation} from 'react-i18next';
import Logs from '../pages/logs';
import Start from '../pages/start';
import Api from '../pages/api';
import Extensions from '../pages/extensions';
import Login from '../pages/auth/login';
import Register from '../pages/auth/register';
import TeamSelect from '../pages/auth/team-select';
import TeamMembers from '../pages/team-members';
interface RouteOption {
  path: string;
  name?: string;
  icon?: ReactElement;
  component: () => JSX.Element;
  invisible?: boolean;
}

export const useRoutes = () => {
  const {t, i18n} = useTranslation();

  return useMemo(() => {
    return [
      {
        path: '/',
        name: t('menu_windows'),
        icon: <Icon icon="bx:windows" />,
        component: Windows,
      },
      {
        path: '/window/create',
        name: t('new_window'),
        component: WindowDetail,
        invisible: true,
      },
      {
        path: '/window/edit',
        name: t('edit_window'),
        component: WindowDetail,
        invisible: true,
      },
      {
        path: '/proxy',
        name: t('menu_proxy'),
        icon: <Icon icon="solar:global-outline" />,
        component: Proxy,
      },
      {
        path: '/proxy/import',
        name: t('new_proxy'),
        component: ProxyImport,
        invisible: true,
      },
      {
        path: '/extensions',
        name: t('menu_extensions'),
        icon: <Icon icon="mdi:puzzle-outline" />,
        component: Extensions,
      },
      {
        path: '/sync',
        name: t('menu_sync'),
        icon: <Icon icon="ic:outline-sync" />,
        component: Sync,
      },
      {
        path: '/logs',
        name: t('menu_logs'),
        icon: <Icon icon="carbon:flow-logs-vpc" />,
        component: Logs,
      },
      {
        path: '/settings',
        name: t('menu_settings'),
        icon: <Icon icon="material-symbols:settings-outline" />,
        component: Settings,
      },
      {
        path: '/team/members',
        name: '团队成员',
        icon: <Icon icon="mdi:account-group-outline" />,
        component: TeamMembers,
      },
      {
        path: '/api',
        name: t('menu_api'),
        icon: <Icon icon="ant-design:api-outlined" />,
        component: Api,
      },
      {
        path: '/auth/login',
        component: Login,
        invisible: true,
      },
      {
        path: '/auth/register',
        component: Register,
        invisible: true,
      },
      {
        path: '/auth/team-select',
        component: TeamSelect,
        invisible: true,
      },
      {
        path: '/start',
        component: () => <Start />,
        invisible: true,
      },
    ];
  }, [i18n.language]);
};

export const useRoutesMap = () => {
  const routes = useRoutes();

  const routesMap: Record<string, RouteOption> = {};

  routes.forEach(route => {
    routesMap[route.path] = route;
  });

  return routesMap;
};
