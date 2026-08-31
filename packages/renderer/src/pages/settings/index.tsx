import {Button, Form, Input, Modal, Radio, Space, Typography, message} from 'antd';
import {CheckCircleOutlined, ReloadOutlined, SwapOutlined, WechatOutlined} from '@ant-design/icons';
import {CommonBridge, SyncBridge, UpdateBridge} from '#preload';
import type {AppUpdateStatus} from '../../../../shared/types/update';
import {useEffect, useState} from 'react';
import type {SettingOptions} from '../../../../shared/types/common';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router-dom';
import {
  clearCloudSession,
  fetchCloudJson,
  fetchTeamCreationGrant,
  fetchTeams,
  type CloudTeam,
} from '/@/utils/cloud-auth';
import {
  DEFAULT_UI_SETTINGS,
  normalizeUiSettings,
  THEME_UPDATED_EVENT,
  type ColorMode,
  type ThemePreset,
} from '/@/theme';
import './index.css';
import previewALight from '../../../assets/theme-previews/a-light.png';
import previewADark from '../../../assets/theme-previews/a-dark.png';
import previewBLight from '../../../assets/theme-previews/b-light.png';
import previewBDark from '../../../assets/theme-previews/b-dark.png';
import previewCLight from '../../../assets/theme-previews/c-light.png';
import previewCDark from '../../../assets/theme-previews/c-dark.png';
import membershipWechatQr from '../../../assets/wechat-membership-qr.png';
import {
  buildCloudModeSettings,
  buildLocalModeSettings,
  CLOUD_MODE_UPDATED_EVENT,
  shouldBroadcastModeUpdate,
  shouldShowCloudSyncSettings,
  shouldShowCloudModeSwitch,
  shouldShowLocalModeSwitch,
  shouldShowModeSwitch,
} from './mode-switch';

type FieldType = {
  profileCachePath: string;
  useLocalChrome: boolean;
  localChromePath: string;
  chromiumBinPath: string;
  automationConnect: boolean;
  runtimeDownload?: SettingOptions['runtimeDownload'];
  cloudSync?: SettingOptions['cloudSync'];
  ui?: SettingOptions['ui'];
};

type SettingsFormValues = SettingOptions;

const {Text, Title} = Typography;

const entitlementStatusText = (status?: CloudTeam['entitlement_status']) =>
  (
    ({
      active: '已开通',
      expired: '已到期',
      suspended: '已暂停',
    }) as Record<string, string>
  )[status || ''] || '未配置';

const entitlementDateText = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {dateStyle: 'medium', timeStyle: 'short'}).format(
        new Date(value),
      )
    : '长期有效';

const Settings = () => {
  const [formValue, setFormValue] = useState<SettingOptions>({
    profileCachePath: '',
    useLocalChrome: true,
    localChromePath: '',
    chromiumBinPath: '',
    automationConnect: false,
    runtimeDownload: {proxyUrl: ''},
    ui: DEFAULT_UI_SETTINGS,
  });
  const [form] = Form.useForm();
  const [joinTeamForm] = Form.useForm<{inviteCode: string; message?: string}>();
  const [messageApi, contextHolder] = message.useMessage();
  const [auditingCloudRepair, setAuditingCloudRepair] = useState(false);
  const [authorityRepairId, setAuthorityRepairId] = useState('');
  const [acceptingAuthorityRepair, setAcceptingAuthorityRepair] = useState(false);
  const [repullingCloudSync, setRepullingCloudSync] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>();
  const [appVersion, setAppVersion] = useState('');
  const [currentTeamName, setCurrentTeamName] = useState('');
  const [currentTeam, setCurrentTeam] = useState<CloudTeam>();
  const [checkingMembership, setCheckingMembership] = useState(false);
  const [joinTeamOpen, setJoinTeamOpen] = useState(false);
  const [requestingTeamJoin, setRequestingTeamJoin] = useState(false);
  const {t} = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    fetchSettings();
    void UpdateBridge.getCurrentVersion()
      .then(setAppVersion)
      .catch(() => undefined);
    void UpdateBridge.getStatus()
      .then(setUpdateStatus)
      .catch(() => undefined);
    const handleUpdateStatus = (_: Electron.IpcRendererEvent, status: AppUpdateStatus) => {
      setUpdateStatus(status);
    };
    UpdateBridge.onStatus(handleUpdateStatus);
    return () => {
      UpdateBridge.offStatus(handleUpdateStatus);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const {apiBaseUrl, accessToken, workspaceId} = formValue.cloudSync || {};
    if (!apiBaseUrl || !accessToken || !workspaceId) {
      setCurrentTeamName('');
      setCurrentTeam(undefined);
      return undefined;
    }

    setCurrentTeamName('');
    setCurrentTeam(undefined);
    void fetchTeams(apiBaseUrl, accessToken)
      .then(teams => {
        if (!cancelled) {
          const team = teams.find(item => item.id === workspaceId);
          setCurrentTeamName(team?.name || '');
          setCurrentTeam(team);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentTeamName('');
          setCurrentTeam(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    formValue.cloudSync?.accessToken,
    formValue.cloudSync?.apiBaseUrl,
    formValue.cloudSync?.workspaceId,
  ]);

  const fetchSettings = async () => {
    const settings = await CommonBridge.getSettings();
    const settingsWithDefaults = {
      ...settings,
      ui: normalizeUiSettings(settings),
    };
    setFormValue(settingsWithDefaults);
    form.setFieldsValue(settingsWithDefaults);
  };

  const handleSave = async (values: SettingsFormValues) => {
    const currentCloudSync = formValue.cloudSync || {};
    const nextCloudSync = values.cloudSync || {};
    const shouldNotifyModeUpdate = shouldBroadcastModeUpdate(formValue, values);
    const currentCloudMode = Boolean(
      currentCloudSync.enabled &&
        currentCloudSync.apiBaseUrl &&
        currentCloudSync.accessToken &&
        currentCloudSync.workspaceId,
    );
    const nextCloudMode = Boolean(
      nextCloudSync.enabled &&
        nextCloudSync.apiBaseUrl &&
        nextCloudSync.accessToken &&
        nextCloudSync.workspaceId,
    );
    const workspaceChanged = currentCloudSync.workspaceId !== nextCloudSync.workspaceId;
    if (currentCloudMode !== nextCloudMode || (currentCloudMode && workspaceChanged)) {
      const preflight = await SyncBridge.preflightCloudModeSwitch();
      if (!preflight?.success) throw new Error(preflight?.message || '请先结束当前运行再切换模式');
    }
    await CommonBridge.saveSettings(values);
    window.dispatchEvent(
      new CustomEvent(THEME_UPDATED_EVENT, {
        detail: normalizeUiSettings(values),
      }),
    );
    await SyncBridge?.refreshCloudSyncConfig?.();
    if (shouldNotifyModeUpdate) {
      window.dispatchEvent(new Event(CLOUD_MODE_UPDATED_EVENT));
    }
  };

  const handleChoosePath = async (
    field: 'profileCachePath' | 'localChromePath' | 'chromiumBinPath',
    type: 'openFile' | 'openDirectory',
  ) => {
    const path = await CommonBridge.choosePath(type);
    if (!formValue[field] || (path && formValue[field] !== path)) {
      handleFormValueChange({
        ...formValue,
        [field]: path,
      });
    }
  };

  const handleFormValueChange = (changed: Partial<SettingsFormValues>) => {
    const newFormValue = {
      ...formValue,
      ...changed,
      ui: {
        ...normalizeUiSettings(formValue),
        ...(changed.ui || {}),
      },
    };
    setFormValue(newFormValue);
    void handleSave(newFormValue).catch(error => {
      messageApi.error((error as Error)?.message || '保存设置失败');
    });
  };

  const handleSwitchToLocalMode = async () => {
    const nextSettings = buildLocalModeSettings(formValue);
    try {
      await handleSave(nextSettings);
      setFormValue(nextSettings);
      form.setFieldsValue(nextSettings);
      messageApi.success('已切换到本地模式');
    } catch (error) {
      messageApi.error((error as Error)?.message || '切换到本地模式失败');
    }
  };

  const handleSwitchToCloudMode = async () => {
    if (!hasCloudWorkspace) {
      navigate('/auth/login');
      return;
    }

    const nextSettings = buildCloudModeSettings(formValue);
    try {
      await handleSave(nextSettings);
      setFormValue(nextSettings);
      form.setFieldsValue(nextSettings);
      messageApi.success('已切换到云端模式');
    } catch (error) {
      messageApi.error((error as Error)?.message || '切换到云端模式失败');
    }
  };

  const themePreset = normalizeUiSettings(formValue).themePreset;
  const colorMode = normalizeUiSettings(formValue).colorMode;

  const themePreviews: Record<ThemePreset, Record<ColorMode, string>> = {
    a: {light: previewALight, dark: previewADark},
    b: {light: previewBLight, dark: previewBDark},
    c: {light: previewCLight, dark: previewCDark},
  };

  const themeOptions: Array<{key: ThemePreset; title: string; description: string}> = [
    {
      key: 'a',
      title: '方案 A：安全蓝 SaaS 控制台',
      description: '更有产品感，适合隐私、代理、团队同步这类安全工具。',
    },
    {
      key: 'b',
      title: '方案 B：温润专业工作台',
      description: '更柔和，适合长时间配置和运营，不那么冷硬。',
    },
    {
      key: 'c',
      title: '方案 C：高密度极简后台',
      description: '信息密度最高，装饰最少，更像专业桌面管理工具。',
    },
  ];

  const updateUiSettings = (nextUi: SettingOptions['ui']) => {
    const ui = {
      ...normalizeUiSettings(formValue),
      ...nextUi,
    };
    form.setFieldsValue({ui});
    handleFormValueChange({ui});
  };

  const handleAuthorityRepairDryRun = async () => {
    if (auditingCloudRepair) return;
    setAuditingCloudRepair(true);
    try {
      const snapshot = await SyncBridge.exportCloudSyncAuthoritySnapshot();
      const saveResult = await CommonBridge.saveDialog({
        title: '保存 Windows 权威同步快照',
        defaultPath: `cloak-cloud-authority-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        filters: [{name: 'JSON', extensions: ['json']}],
      });
      if (saveResult?.canceled || !saveResult?.filePath) {
        return;
      }
      await CommonBridge.saveFile(
        saveResult.filePath,
        new TextEncoder().encode(JSON.stringify(snapshot, null, 2)),
      );
      const report = await SyncBridge.submitCloudSyncRepairDryRun(snapshot);
      if (!report?.success) throw new Error(report?.message || '服务端 dry-run 未成功');
      Modal.info({
        title: '权威快照审计完成',
        content: `仅生成报告，没有写入任何云端数据。计划 upsert ${report.summary?.would_upsert || 0} 个实体，计划写入 ${report.summary?.would_tombstone || 0} 个墓碑，未绑定记录 ${report.summary?.unbound_authority_rows || 0}，悬挂引用 ${report.summary?.dangling_references || 0}。`,
      });
    } catch (error) {
      messageApi.error((error as Error)?.message || '权威快照审计失败');
    } finally {
      setAuditingCloudRepair(false);
    }
  };

  const handleRepullCloudSync = async () => {
    if (repullingCloudSync) return;
    setRepullingCloudSync(true);
    try {
      const result = await SyncBridge.repullCurrentCloudWorkspace();
      if (!result?.success) {
        messageApi.error(result?.message || '重新拉取团队数据失败');
        return;
      }
      messageApi.success('团队数据已重新拉取，请返回窗口页面查看分组。');
    } catch (error) {
      messageApi.error((error as Error)?.message || '重新拉取团队数据失败');
    } finally {
      setRepullingCloudSync(false);
    }
  };

  const handleAcceptAuthorityRepair = () => {
    const repairId = authorityRepairId.trim();
    if (!repairId) {
      messageApi.error('请输入服务器 apply 输出的 repair ID');
      return;
    }
    Modal.confirm({
      title: '接受 Windows 权威修复',
      content:
        '此设备将先保存本地 SQLite 备份，然后删除待发送 outbox、重置 cursor，并以 Windows 权威状态重新拉取。仅在非权威设备执行。',
      okText: '重置并重新拉取',
      okButtonProps: {danger: true},
      cancelText: '取消',
      onOk: async () => {
        setAcceptingAuthorityRepair(true);
        try {
          const result = await SyncBridge.acceptCloudAuthorityRepair(repairId);
          if (!result?.success) throw new Error(result?.message || '未能接受权威修复');
          messageApi.success(
            `本机已切换到 Windows 权威状态，拉取 ${result.pulled || 0} 个同步事件。`,
          );
        } catch (error) {
          messageApi.error((error as Error)?.message || '接受权威修复失败');
          throw error;
        } finally {
          setAcceptingAuthorityRepair(false);
        }
      },
    });
  };

  const hasCloudWorkspace = Boolean(
    formValue.cloudSync?.apiBaseUrl &&
      formValue.cloudSync?.accessToken &&
      formValue.cloudSync?.workspaceId,
  );
  const cloudSyncEnabled = Boolean(formValue.cloudSync?.enabled && hasCloudWorkspace);

  const refreshMembershipPermission = async () => {
    const {apiBaseUrl, accessToken} = formValue.cloudSync || {};
    if (!apiBaseUrl || !accessToken) {
      messageApi.info('请先登录云端账号后再刷新会员权限。');
      return;
    }
    setCheckingMembership(true);
    try {
      const [teams, grant] = await Promise.all([
        fetchTeams(apiBaseUrl, accessToken),
        fetchTeamCreationGrant(apiBaseUrl, accessToken),
      ]);
      if (teams.length || grant.can_create_team) {
        navigate('/auth/team-select');
        return;
      }
      Modal.info({
        title: '当前还没有会员权限',
        content: '请添加微信咨询会员开通，或使用团队邀请码申请加入已有团队。',
      });
    } catch (error) {
      messageApi.error((error as Error)?.message || '刷新云端权限失败');
    } finally {
      setCheckingMembership(false);
    }
  };

  const requestJoinTeam = async (values: {inviteCode: string; message?: string}) => {
    const {apiBaseUrl, accessToken} = formValue.cloudSync || {};
    if (!apiBaseUrl || !accessToken) {
      messageApi.info('请先登录云端账号后再绑定团队邀请码。');
      return;
    }
    setRequestingTeamJoin(true);
    try {
      await fetchCloudJson(apiBaseUrl, '/teams/join-requests', {
        method: 'POST',
        headers: {Authorization: `Bearer ${accessToken}`},
        body: JSON.stringify({invite_code: values.inviteCode, message: values.message}),
      });
      setJoinTeamOpen(false);
      joinTeamForm.resetFields();
      messageApi.success('已提交加入团队申请，等待团队管理员批准。');
    } catch (error) {
      messageApi.error((error as Error)?.message || '绑定团队邀请码失败');
    } finally {
      setRequestingTeamJoin(false);
    }
  };

  const handleCheckUpdate = async () => {
    try {
      await UpdateBridge.check();
      messageApi.info('正在检查更新');
    } catch {
      messageApi.error('检查更新失败，请稍后重试');
    }
  };

  // type FieldType = SettingOptions;

  return (
    <>
      {contextHolder}
      <div className="settings-page">
        <div className="settings-shell">
          <aside className="settings-summary">
            <div className="settings-summary-block">
              <Text className="settings-eyebrow">Preferences</Text>
              <Title
                level={3}
                className="settings-summary-title"
              >
                工作区设置
              </Title>
              <Text className="settings-summary-copy">
                {cloudSyncEnabled
                  ? '管理界面主题、语言、缓存路径和团队云同步。'
                  : '管理界面主题、语言和当前设备的本地工作区。'}
              </Text>
            </div>
            <div className="settings-status-list">
              <div className="settings-status-item">
                <span>运行模式</span>
                <strong>
                  {cloudSyncEnabled ? '团队模式（云同步已启用）' : '本地模式（云同步已关闭）'}
                </strong>
              </div>
              {cloudSyncEnabled && (
                <div className="settings-status-item">
                  <span>当前团队</span>
                  <strong>{currentTeamName || '-'}</strong>
                </div>
              )}
            </div>
            {shouldShowModeSwitch(hasCloudWorkspace) &&
              shouldShowLocalModeSwitch(formValue.cloudSync) && (
                <Button
                  icon={<SwapOutlined />}
                  onClick={handleSwitchToLocalMode}
                >
                  切换到本地模式
                </Button>
              )}
            {shouldShowModeSwitch(hasCloudWorkspace) &&
              shouldShowCloudModeSwitch(formValue.cloudSync) && (
                <Button
                  icon={<SwapOutlined />}
                  onClick={handleSwitchToCloudMode}
                >
                  切换到云端模式
                </Button>
              )}
          </aside>

          <Form
            name="settingsForm"
            className="settings-form"
            layout="vertical"
            size="middle"
            form={form}
            initialValues={formValue}
            onValuesChange={(_, allValues) => handleFormValueChange(allValues)}
          >
            <section className="settings-section">
              <div className="settings-section-header">
                <div>
                  <Text className="settings-eyebrow">Appearance</Text>
                  <Title
                    level={4}
                    className="settings-section-title"
                  >
                    界面主题
                  </Title>
                </div>
              </div>
              <Form.Item
                label="明暗模式"
                name={['ui', 'colorMode']}
              >
                <Radio.Group
                  buttonStyle="solid"
                  onChange={event => updateUiSettings({colorMode: event.target.value})}
                >
                  <Radio.Button value="light">浅色</Radio.Button>
                  <Radio.Button value="dark">深色</Radio.Button>
                </Radio.Group>
              </Form.Item>
              <Form.Item
                label="设计方案"
                name={['ui', 'themePreset']}
              >
                <div className="theme-preset-grid">
                  {themeOptions.map(option => {
                    const selected = option.key === themePreset;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        className={`theme-preset-card ${selected ? 'selected' : ''}`}
                        onClick={() => updateUiSettings({themePreset: option.key})}
                      >
                        <img
                          src={themePreviews[option.key][colorMode]}
                          alt={option.title}
                          className="theme-preset-preview"
                        />
                        <div className="theme-preset-body">
                          <div>
                            <div className="theme-preset-title">{option.title}</div>
                            <div className="theme-preset-copy">{option.description}</div>
                          </div>
                          <Radio checked={selected} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Form.Item>
            </section>

            {!hasCloudWorkspace && (
              <section
                className="settings-section settings-membership-section"
                aria-labelledby="membership-title"
              >
                <div className="settings-membership-content">
                  <div className="settings-membership-copy">
                    <Text className="settings-eyebrow">Membership</Text>
                    <Title
                      level={4}
                      id="membership-title"
                      className="settings-section-title"
                    >
                      开启会员服务
                    </Title>
                    <Text className="settings-membership-intro">
                      扫码添加微信，咨询适合团队的会员方案与开通流程。
                    </Text>
                    <ul className="settings-membership-features">
                      <li>
                        <CheckCircleOutlined aria-hidden="true" />{' '}
                        一个账号仅加入一个团队，团队成员数量按授权上限控制
                      </li>
                      <li>
                        <CheckCircleOutlined aria-hidden="true" />{' '}
                        团队设备和指纹窗口总数按授权上限控制，创建与导入均校验
                      </li>
                      <li>
                        <CheckCircleOutlined aria-hidden="true" />{' '}
                        团队工作区云端同步、成员协作与到期后只读保护
                      </li>
                      <li>
                        <CheckCircleOutlined aria-hidden="true" /> 云端 Script
                        Center：脚本版本审核、发布与团队内受控使用
                      </li>
                      <li>
                        <CheckCircleOutlined aria-hidden="true" />{' '}
                        会员咨询与使用支持由微信人工服务提供
                      </li>
                    </ul>
                    <div className="settings-membership-actions">
                      <div className="settings-membership-wechat">
                        <WechatOutlined aria-hidden="true" /> 微信扫码咨询会员
                      </div>
                      <Space wrap>
                        <Button
                          icon={<ReloadOutlined />}
                          onClick={refreshMembershipPermission}
                          loading={checkingMembership}
                        >
                          刷新云端权限
                        </Button>
                        <Button onClick={() => setJoinTeamOpen(true)}>绑定团队邀请码</Button>
                      </Space>
                    </div>
                  </div>
                  <figure className="settings-membership-qr">
                    <img
                      src={membershipWechatQr}
                      alt="微信扫码咨询 Cloak 会员服务"
                      width={150}
                      height={152}
                    />
                  </figure>
                </div>
              </section>
            )}

            <Modal
              title="绑定团队邀请码"
              open={joinTeamOpen}
              onCancel={() => setJoinTeamOpen(false)}
              onOk={() => joinTeamForm.submit()}
              okText="提交申请"
              cancelText="取消"
              confirmLoading={requestingTeamJoin}
            >
              <Form
                form={joinTeamForm}
                layout="vertical"
                onFinish={requestJoinTeam}
              >
                <Form.Item
                  name="inviteCode"
                  label="团队邀请码"
                  rules={[{required: true, message: '请输入团队邀请码'}]}
                >
                  <Input placeholder="输入团队管理员提供的邀请码" />
                </Form.Item>
                <Form.Item
                  name="message"
                  label="申请说明（可选）"
                >
                  <Input.TextArea placeholder="例如：已开通会员，请加入团队" />
                </Form.Item>
              </Form>
            </Modal>

            <section className="settings-section">
              <div className="settings-section-header">
                <div>
                  <Text className="settings-eyebrow">Application</Text>
                  <Title
                    level={4}
                    className="settings-section-title"
                  >
                    应用更新
                  </Title>
                </div>
                <Button
                  onClick={handleCheckUpdate}
                  loading={updateStatus?.phase === 'checking'}
                  disabled={updateStatus?.phase === 'unsupported'}
                >
                  检查更新
                </Button>
              </div>
              <div
                className="settings-status-list"
                style={{marginTop: 12}}
              >
                <div className="settings-status-item">
                  <span>当前版本</span>
                  <strong>v{appVersion || updateStatus?.currentVersion || '-'}</strong>
                </div>
              </div>
              {updateStatus?.phase === 'unsupported' && (
                <Text
                  type="secondary"
                  style={{display: 'block', marginTop: 8}}
                >
                  当前平台暂不支持应用内更新，请安装发布页提供的正式安装包。
                </Text>
              )}
            </section>

            <section className="settings-section">
              <div className="settings-section-header">
                <div>
                  <Text className="settings-eyebrow">Storage</Text>
                  <Title
                    level={4}
                    className="settings-section-title"
                  >
                    浏览器路径
                  </Title>
                </div>
              </div>
              <div className="settings-fields-grid">
                <Form.Item<FieldType>
                  className="settings-field-full"
                  label={t('settings_cache_path')}
                  name="profileCachePath"
                >
                  <Space.Compact style={{width: '100%'}}>
                    <Input
                      readOnly
                      disabled
                      value={formValue.profileCachePath}
                    />
                    <Button
                      type="default"
                      onClick={() => handleChoosePath('profileCachePath', 'openDirectory')}
                    >
                      {t('settings_choose_cache_path')}
                    </Button>
                  </Space.Compact>
                </Form.Item>
                {/* <Form.Item<FieldType>
                  label={t('settings_use_local_chrome')}
                  name="useLocalChrome"
                >
                  <Switch value={formValue.useLocalChrome} />
                </Form.Item> */}
                {formValue.useLocalChrome ? (
                  <Form.Item<FieldType>
                    className="settings-field-full"
                    label={t('settings_chrome_path')}
                    name="localChromePath"
                  >
                    <Space.Compact style={{width: '100%'}}>
                      <Input
                        readOnly
                        disabled
                        value={formValue.localChromePath}
                      />
                      <Button
                        type="default"
                        onClick={() => handleChoosePath('localChromePath', 'openFile')}
                      >
                        {t('settings_choose_cache_path')}
                      </Button>
                    </Space.Compact>
                  </Form.Item>
                ) : (
                  <Form.Item<FieldType>
                    className="settings-field-full"
                    label={t('setting_chromium_path')}
                    name="chromiumBinPath"
                  >
                    <Space.Compact style={{width: '100%'}}>
                      <Input
                        readOnly
                        disabled
                        value={formValue.chromiumBinPath}
                      />
                      <Button
                        type="default"
                        onClick={() => handleChoosePath('chromiumBinPath', 'openFile')}
                      >
                        {t('settings_choose_cache_path')}
                      </Button>
                    </Space.Compact>
                  </Form.Item>
                )}
              </div>
            </section>
            <section className="settings-section">
              <div className="settings-section-header">
                <div>
                  <Text className="settings-eyebrow">Runtime Download</Text>
                  <Title
                    level={4}
                    className="settings-section-title"
                  >
                    内核下载
                  </Title>
                </div>
              </div>
              <Form.Item
                label="下载代理"
                name={['runtimeDownload', 'proxyUrl']}
                extra="用于下载浏览器内核和 Chrome 扩展。支持 http://、https://、socks4:// 和 socks5://；留空时自动检测系统代理，再使用 HTTPS_PROXY / ALL_PROXY 或直连。"
              >
                <Input
                  placeholder="socks5://127.0.0.1:7890"
                  autoComplete="off"
                />
              </Form.Item>
            </section>
            {/* <Form.Item<FieldType>
              label={t('settings_automation_connect')}
              name="automationConnect"
              >
                <Switch value={formValue.automationConnect} />
            </Form.Item> */}
            {shouldShowCloudSyncSettings(formValue.cloudSync) && (
              <section className="settings-section">
                <div className="settings-section-header">
                  <div>
                    <Text className="settings-eyebrow">Cloud Sync</Text>
                    <Title
                      level={4}
                      className="settings-section-title"
                    >
                      云同步
                    </Title>
                  </div>
                  <Space
                    wrap
                    className="settings-section-actions"
                  >
                    <Button onClick={() => navigate('/team/members')}>管理团队成员</Button>
                    <Button
                      type="primary"
                      onClick={() => navigate('/auth/team-select')}
                    >
                      切换团队
                    </Button>
                    <Button
                      danger
                      onClick={() => {
                        clearCloudSession().then(() => navigate('/auth/login', {replace: true}));
                      }}
                    >
                      退出登录
                    </Button>
                  </Space>
                </div>
                <div
                  className="settings-membership-entitlement"
                  aria-label="当前会员权益"
                >
                  <div className="settings-membership-entitlement-head">
                    <div>
                      <Text className="settings-eyebrow">Current Membership</Text>
                      <Title
                        level={5}
                        className="settings-section-title"
                      >
                        当前会员权益
                      </Title>
                    </div>
                    <Text
                      className={`settings-membership-status ${currentTeam?.entitlement_status || 'unknown'}`}
                      role="status"
                    >
                      {entitlementStatusText(currentTeam?.entitlement_status)}
                    </Text>
                  </div>
                  <div className="settings-membership-quota-grid">
                    <div>
                      <span>团队成员</span>
                      <strong>
                        {currentTeam
                          ? `${currentTeam.member_count || 0} / ${currentTeam.max_members || 1}`
                          : '-'}
                      </strong>
                    </div>
                    <div>
                      <span>已绑定设备</span>
                      <strong>
                        {currentTeam
                          ? `${currentTeam.active_device_count || 0} / ${currentTeam.max_devices || 1}`
                          : '-'}
                      </strong>
                    </div>
                    <div>
                      <span>指纹窗口</span>
                      <strong>
                        {currentTeam
                          ? `${currentTeam.active_window_count || 0} / ${currentTeam.max_windows || 1}`
                          : '-'}
                      </strong>
                    </div>
                    <div>
                      <span>会员有效期</span>
                      <strong>
                        {currentTeam ? entitlementDateText(currentTeam.cloud_enabled_until) : '-'}
                      </strong>
                    </div>
                  </div>
                </div>
                <div className="settings-fields-grid">
                  <Form.Item
                    label="API URL"
                    name={['cloudSync', 'apiBaseUrl']}
                  >
                    <Input placeholder="http://your-server:8787" />
                  </Form.Item>
                  <Form.Item
                    className="settings-field-full"
                    label="Repair audit"
                    extra="只能在被选定为权威源的 Windows 设备上执行。该操作会保存快照并生成只读 dry-run 报告，不会修复、删除、重置或上传任何数据。"
                  >
                    <Space wrap>
                      <Button
                        onClick={handleAuthorityRepairDryRun}
                        loading={auditingCloudRepair}
                      >
                        导出 Windows 权威快照并审计
                      </Button>
                      <Button
                        onClick={handleRepullCloudSync}
                        loading={repullingCloudSync}
                      >
                        重新拉取团队数据
                      </Button>
                    </Space>
                  </Form.Item>
                  <Form.Item
                    className="settings-field-full"
                    label="接受权威修复"
                    extra="仅在 macOS 等非权威设备执行。输入服务器 apply 输出的 repair ID 后，本机会先备份再重置同步状态。"
                  >
                    <Space.Compact block>
                      <Input
                        value={authorityRepairId}
                        onChange={event => setAuthorityRepairId(event.target.value)}
                        placeholder="repair ID"
                      />
                      <Button
                        danger
                        loading={acceptingAuthorityRepair}
                        onClick={handleAcceptAuthorityRepair}
                      >
                        重置本机并拉取
                      </Button>
                    </Space.Compact>
                  </Form.Item>
                  <Form.Item
                    label="Device Name"
                    name={['cloudSync', 'deviceName']}
                  >
                    <Input placeholder="mac-a / win-b" />
                  </Form.Item>
                  <Form.Item
                    className="settings-access-token-field"
                    label="Access Token"
                    name={['cloudSync', 'accessToken']}
                  >
                    <Input.Password />
                  </Form.Item>
                </div>
              </section>
            )}
          </Form>
        </div>
      </div>
      {/* <div className="content-footer pl-24">
        <Button
          type="primary"
          className="w-20"
          onClick={() => handleSave(formValue)}
        >
          {t('footer_ok')}
        </Button>
      </div> */}
    </>
  );
};
export default Settings;
