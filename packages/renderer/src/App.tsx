import {Route, Routes, useLocation, useNavigate} from 'react-router-dom';
import Navigation from './components/navigation';

import dayjs from 'dayjs';

import './index.css';
import './styles/antd.css';
import {Layout, message} from 'antd';
import {useRoutes, useRoutesMap} from './routes';
import Header from './components/header';
import {useEffect, useState} from 'react';
import {CommonBridge} from '#preload';
import {MESSAGE_CONFIG} from './constants';
import type {BridgeMessage} from '../../shared/types/common';
import {getSavedSettings} from './utils/cloud-auth';
import {nextRouteForCloudSession} from './utils/auth-routing';
import AppUpdate from './components/app-update';

const {Content, Sider} = Layout;

dayjs.locale('zh-cn');

const App = () => {
  const routes = useRoutes();
  const routesMap = useRoutesMap();
  const [isVisible, setIsVisible] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [messageApi, contextHolder] = message.useMessage(MESSAGE_CONFIG);
  const navigate = useNavigate();

  useEffect(() => {
    setTimeout(() => setIsVisible(true), 100); // 延迟显示组件
  }, []);

  const location = useLocation();
  const isAuthRoute = location.pathname.startsWith('/auth/');
  const isTeamSelectRoute = location.pathname === '/auth/team-select';
  const isChromeStartRoute = location.pathname === '/start';

  useEffect(() => {
    const handleMessaged = (_: Electron.IpcRendererEvent, msg: BridgeMessage) => {
      messageApi.open({
        type: msg.type,
        content: msg.text,
      });
    };

    CommonBridge?.offMessaged(handleMessaged);

    CommonBridge?.onMessaged(handleMessaged);

    return () => {
      CommonBridge?.offMessaged(handleMessaged);
    };
  }, []);

  useEffect(() => {
    if (isChromeStartRoute) {
      setAuthReady(true);
      return;
    }

    getSavedSettings()
      .then(settings => {
        const hasToken = Boolean(settings.cloudSync?.accessToken);
        const nextRoute = nextRouteForCloudSession({hasToken, isAuthRoute, isTeamSelectRoute});
        if (nextRoute) navigate(nextRoute, {replace: true});
      })
      .finally(() => setAuthReady(true));
  }, [location.pathname]);

  const showAppShell = !isChromeStartRoute && !isAuthRoute;

  if (!authReady) {
    return null;
  }

  return (
    <Layout className={`app-shell h-full fade-in ${isVisible ? 'visible' : ''}`}>
      {contextHolder}
      <AppUpdate />
      {/* <Spin
        spinning={loading}
        rootClassName={loading ? 'fullscreen-spin-wrapper visible' : ''}
      /> */}
      {showAppShell && (
        <Sider
          width={232}
          className="sider"
        >
          <Navigation></Navigation>
        </Sider>
      )}

      <Layout className={showAppShell ? 'workspace-layout' : 'h-full'}>
        {showAppShell && <Header title={routesMap[location.pathname]?.name} />}
        <Content className={showAppShell ? 'content' : 'h-full'}>
          <Routes>
            {routes.map(route => {
              return (
                <Route
                  key={route.path}
                  path={route.path}
                  Component={route.component}
                />
              );
            })}
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
};
export default App;
