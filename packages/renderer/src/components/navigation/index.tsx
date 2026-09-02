import {Button, Menu, type MenuProps} from 'antd';
import type {MenuInfo} from 'rc-menu/lib/interface';
import {useRoutes} from '/@/routes';
import {useLocation, useNavigate} from 'react-router-dom';
import {CrownOutlined, PlusCircleOutlined} from '@ant-design/icons';
import {useEffect} from 'react';
import {CommonBridge} from '#preload';
import './index.css';
import React from 'react';
import {t} from 'i18next';
import logo from '../../../assets/logo.png';
import {filterNavigationRoutes} from './visibility';
import {hasSavedMembership} from '/@/utils/membership';
import {CLOUD_MODE_UPDATED_EVENT} from '/@/pages/settings/mode-switch';

export default function Navigation() {
  const routes = useRoutes();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuItems, setMenuItems] = React.useState<MenuProps['items']>([]);
  const [hasMembership, setHasMembership] = React.useState(false);

  useEffect(() => {
    let active = true;
    const refreshWorkspaceChrome = () => {
      void CommonBridge.getSettings()
        .then(settings => {
          if (active) setHasMembership(hasSavedMembership(settings));
        })
        .catch(() => {
          if (active) setHasMembership(false);
        });
    };
    refreshWorkspaceChrome();
    window.addEventListener(CLOUD_MODE_UPDATED_EVENT, refreshWorkspaceChrome);
    return () => {
      active = false;
      window.removeEventListener(CLOUD_MODE_UPDATED_EVENT, refreshWorkspaceChrome);
    };
  }, [location.pathname]);

  useEffect(() => {
    const navigationOrder = ['/team/members', '/logs', '/api', '/settings'];
    const visibleRoutes = filterNavigationRoutes(routes, false);
    const navigationPriority = new Map(navigationOrder.map((path, index) => [path, index]));
    const otherRoutes = visibleRoutes.filter(route => !navigationPriority.has(route.path));
    const orderedRoutes = [
      ...otherRoutes,
      ...navigationOrder
        .map(path => visibleRoutes.find(route => route.path === path))
        .filter((route): route is (typeof visibleRoutes)[number] => route !== undefined),
    ];
    const menuItemsTemp: MenuProps['items'] = orderedRoutes.map(route => ({
      key: route.path,
      icon: route.icon,
      label: route.name,
    }));
    menuItemsTemp.splice(otherRoutes.length, 0, {type: 'divider'});
    setMenuItems(menuItemsTemp);
  }, [routes]);

  const onItemClicked = (info: MenuInfo) => {
    navigate(info.key);
  };

  return (
    <>
      <div className="nav-brand">
        <div className="nav-brand-mark">
          <img
            src={logo}
            alt="ISLES Browser"
          />
        </div>
        <div>
          <div className="nav-brand-title">ISLES Browser</div>
          <div className="nav-brand-subtitle">Browser Ops</div>
        </div>
      </div>
      <div className="nav-create">
        <Button
          type="primary"
          block
          onClick={() => {
            navigate('/window/create');
          }}
          icon={<PlusCircleOutlined />}
        >
          {t('new_window')}
        </Button>
      </div>
      <div className="nav-section-label">Main navigation</div>
      <Menu
        mode="inline"
        defaultSelectedKeys={['/']}
        selectedKeys={[location.pathname]}
        style={{borderRight: 0}}
        onClick={onItemClicked}
        rootClassName="navigation"
        items={menuItems}
      />
      {!hasMembership && (
        <div className="nav-membership">
          <div className="nav-membership-copy">
            <div className="nav-membership-title">
              <CrownOutlined aria-hidden="true" /> 会员服务
            </div>
            <div className="nav-membership-description">云同步、团队协作与官方脚本更新</div>
          </div>
          <Button
            type="primary"
            size="small"
            onClick={() => navigate('/settings')}
          >
            了解会员
          </Button>
        </div>
      )}
    </>
  );
}
