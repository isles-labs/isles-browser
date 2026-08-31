import type {MenuProps} from 'antd';
import {Avatar, Button, Dropdown, Layout, Space, message} from 'antd';
import './index.css';
import Title from 'antd/es/typography/Title';
import {
  CloseOutlined,
  MinusOutlined,
  BorderOutlined,
  BlockOutlined,
  CrownOutlined,
} from '@ant-design/icons';
import {useEffect, useState} from 'react';
import {CommonBridge, customizeToolbarControl} from '#preload';
import type {MenuInfo} from 'rc-menu/lib/interface';
import {theme} from 'antd';
const {useToken} = theme;
import {Icon} from '@iconify/react';
import {useLocation, useNavigate} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import {clearCloudSession} from '/@/utils/cloud-auth';
import type {SettingOptions} from '../../../../shared/types/common';
import {hasSavedMembership} from '/@/utils/membership';
import {CLOUD_MODE_UPDATED_EVENT} from '/@/pages/settings/mode-switch';

const {Header: AntdHeader} = Layout;
const AVATAR_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];

interface HeaderProps {
  title?: string;
}

const isAvatarImage = (filePath: string) => {
  const lowerPath = filePath.toLowerCase();
  return AVATAR_IMAGE_EXTENSIONS.some(extension => lowerPath.endsWith(extension));
};

export default function Header({title}: HeaderProps) {
  const {t} = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);
  const [settings, setSettings] = useState<SettingOptions>();
  const [hasMembership, setHasMembership] = useState(false);
  const [avatarSrc, setAvatarSrc] = useState<string>();
  const [messageApi, contextHolder] = message.useMessage();
  const navigate = useNavigate();
  const location = useLocation();
  const checkIfMaximized = async () => {
    try {
      const maximized = await customizeToolbarControl.isMaximized();
      setIsMaximized(maximized);
    } catch (error) {
      console.error('Failed to check if window is maximized:', error);
    }
  };

  const {token} = useToken();

  useEffect(() => {
    let active = true;
    const refreshHeaderSettings = () => {
      CommonBridge.getSettings()
        .then((nextSettings: SettingOptions) => {
          if (!active) return;
          setSettings(nextSettings);
          setHasMembership(hasSavedMembership(nextSettings));
          loadAvatarPreview(nextSettings.avatarPath);
        })
        .catch(error => console.error('Failed to load settings:', error));
    };
    refreshHeaderSettings();
    window.addEventListener(CLOUD_MODE_UPDATED_EVENT, refreshHeaderSettings);
    return () => {
      active = false;
      window.removeEventListener(CLOUD_MODE_UPDATED_EVENT, refreshHeaderSettings);
    };
  }, [location.pathname]);

  const loadAvatarPreview = async (avatarPath?: string) => {
    if (!avatarPath) {
      setAvatarSrc(undefined);
      return;
    }

    try {
      const dataUrl = await CommonBridge.readFileAsDataUrl(avatarPath);
      setAvatarSrc(dataUrl || undefined);
    } catch (error) {
      console.error('Failed to load avatar image:', error);
      setAvatarSrc(undefined);
    }
  };

  const saveAvatarPath = async (avatarPath?: string) => {
    const currentSettings = settings || ((await CommonBridge.getSettings()) as SettingOptions);
    const nextSettings = {
      ...currentSettings,
      avatarPath,
    };
    await CommonBridge.saveSettings(nextSettings);
    setSettings(nextSettings);
    await loadAvatarPreview(avatarPath);
  };

  const chooseAvatar = async () => {
    const avatarPath = await CommonBridge.choosePath('openFile');
    if (!avatarPath) return;
    if (!isAvatarImage(avatarPath)) {
      messageApi.warning('请选择 jpg、png、gif、webp、bmp 或 svg 图片');
      return;
    }

    await saveAvatarPath(avatarPath);
    messageApi.success('头像已更新');
  };

  const clearAvatar = async () => {
    await saveAvatarPath(undefined);
    messageApi.success('头像已清除');
  };

  const items: MenuProps['items'] = [
    {
      label: '修改头像',
      key: 'avatar-change',
    },
    ...(settings?.avatarPath
      ? [
          {
            label: '清除头像',
            key: 'avatar-clear',
          },
        ]
      : []),
    {
      type: 'divider',
    },
    {
      label: t('header_settings'),
      key: 'settings',
    },
    ...(hasMembership
      ? [
          {
            label: '切换团队',
            key: 'team-select',
          },
        ]
      : [
          {
            label: '开启会员服务',
            key: 'membership',
            icon: <CrownOutlined />,
          },
        ]),
    {
      type: 'divider',
    },
    {
      label: t('header_sign_out'),
      key: 'signout',
    },
  ];

  const appControl = (action: 'close' | 'minimize' | 'maximize') => {
    customizeToolbarControl[action]();
    checkIfMaximized();
  };

  const dropdownAction = (info: MenuInfo) => {
    switch (info.key) {
      case 'avatar-change':
        chooseAvatar();
        break;
      case 'avatar-clear':
        clearAvatar();
        break;
      case 'signout':
        clearCloudSession().then(() => navigate('/auth/login', {replace: true}));
        break;
      case 'team-select':
        navigate('/auth/team-select');
        break;
      case 'membership':
        navigate('/settings');
        break;
      case 'settings':
        navigate('/settings');
        break;

      default:
        break;
    }
  };
  return (
    <>
      {contextHolder}
      <AntdHeader className="header">
        <div className="header-left">
          <Title
            className="page-title"
            level={2}
          >
            {title || 'ISLES Power'}
          </Title>
          <div className="page-kicker">Workspace control center</div>
        </div>
        <div className="draggable draggable-bar"></div>
        <div className="header-right">
          <div className="avater-wrapper">
            <Dropdown
              menu={{items, onClick: menuInfo => dropdownAction(menuInfo)}}
              trigger={['click']}
            >
              <Avatar
                style={{backgroundColor: token.colorPrimary}}
                className="avatar"
                size={32}
                src={avatarSrc}
                icon={avatarSrc ? undefined : <Icon icon="mdi:account" />}
              />
            </Dropdown>
          </div>

          <div className="control-btn">
            <Space direction="horizontal">
              <Button
                icon={<MinusOutlined />}
                onClick={() => appControl('minimize')}
              />
              <Button
                onClick={() => appControl('maximize')}
                icon={isMaximized ? <BlockOutlined /> : <BorderOutlined />}
              />
              <Button
                onClick={() => appControl('close')}
                icon={<CloseOutlined />}
              />
            </Space>
          </div>
        </div>
      </AntdHeader>
    </>
  );
}
