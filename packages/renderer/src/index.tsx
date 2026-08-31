import React, {useEffect, useMemo, useState} from 'react';
import 'virtual:windi.css';
import './index.css';
import {createRoot} from 'react-dom/client';
import App from './App';
import {ConfigProvider, message} from 'antd';
import {HashRouter as Router} from 'react-router-dom';
import 'dayjs/locale/zh-cn';
// import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import './i18n';
import {CommonBridge} from '#preload';
import {
  applyThemeClass,
  buildThemeConfig,
  DEFAULT_UI_SETTINGS,
  normalizeUiSettings,
  THEME_UPDATED_EVENT,
  type UiSettings,
} from './theme';
import type {SettingOptions} from '../../shared/types/common';

const rootContainer = document.getElementById('app');

message.config({
  top: 1000,
  duration: 2,
});

const Root = () => {
  const [ui, setUi] = useState(DEFAULT_UI_SETTINGS);
  const customTheme = useMemo(() => buildThemeConfig(ui), [ui]);
  const isChromeStartRoute = window.location.hash.startsWith('#/start');

  useEffect(() => {
    applyThemeClass(ui);
  }, [ui]);

  useEffect(() => {
    if (isChromeStartRoute) {
      setUi(DEFAULT_UI_SETTINGS);
      return;
    }

    CommonBridge?.getSettings?.()
      .then((settings: SettingOptions) => setUi(normalizeUiSettings(settings)))
      .catch(() => setUi(DEFAULT_UI_SETTINGS));

    const handleThemeUpdated = (event: Event) => {
      const nextUi = (event as CustomEvent<UiSettings>).detail;
      setUi(normalizeUiSettings({ui: nextUi} as SettingOptions));
    };

    window.addEventListener(THEME_UPDATED_EVENT, handleThemeUpdated);

    return () => {
      window.removeEventListener(THEME_UPDATED_EVENT, handleThemeUpdated);
    };
  }, [isChromeStartRoute]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={customTheme}
    >
      <Router>
        <App />
      </Router>
    </ConfigProvider>
  );
};

const root = createRoot(rootContainer!);
root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
