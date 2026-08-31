import {Button, Form, Input, List, Modal, Space, Tag, Typography, message} from 'antd';
import {ReloadOutlined} from '@ant-design/icons';
import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {
  fetchCloudJson,
  fetchTeamCreationGrant,
  fetchTeams,
  getSavedSettings,
  isCloudTeamAvailable,
  saveCloudSession,
  type CloudTeam,
  type JoinRequest,
} from '/@/utils/cloud-auth';
import {SyncBridge} from '#preload';
import type {SettingOptions} from '../../../../shared/types/common';
import './index.css';

const {Text} = Typography;

// Bounds how long "进入团队" waits for the cloud sync engine refresh before
// navigating anyway. The engine keeps running in the background after the
// timeout, so entering the team is never blocked on a slow or stalled sync.
const ENTER_TEAM_SYNC_TIMEOUT_MS = 25_000;

class SyncTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncTimeoutError';
  }
}

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SyncTimeoutError(`同步等待超时（${Math.round(ms / 1000)} 秒）`));
    }, ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
};

export default function TeamSelect() {
  const [settings, setSettings] = useState<SettingOptions>();
  const [teams, setTeams] = useState<CloudTeam[]>([]);
  const [canCreateTeam, setCanCreateTeam] = useState(false);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [adminRequests, setAdminRequests] = useState<Record<string, JoinRequest[]>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectingTeamId, setSelectingTeamId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [createForm] = Form.useForm<{name: string}>();
  const [joinForm] = Form.useForm<{inviteCode: string; message?: string}>();
  const [messageApi, contextHolder] = message.useMessage();
  const navigate = useNavigate();
  const currentWorkspaceId = settings?.cloudSync?.workspaceId;

  const getAuthContext = async () => {
    const savedSettings = settings || (await getSavedSettings());
    const apiBaseUrl = savedSettings.cloudSync?.apiBaseUrl || '';
    const accessToken = savedSettings.cloudSync?.accessToken || '';
    if (!apiBaseUrl || !accessToken) {
      navigate('/auth/login', {replace: true});
      return undefined;
    }
    return {savedSettings, apiBaseUrl, accessToken};
  };

  const loadTeams = async () => {
    setLoading(true);
    try {
      const context = await getAuthContext();
      if (!context) return;
      setSettings(context.savedSettings);
      const [nextTeams, grant] = await Promise.all([
        fetchTeams(context.apiBaseUrl, context.accessToken),
        fetchTeamCreationGrant(context.apiBaseUrl, context.accessToken),
      ]);
      setTeams(nextTeams);
      setCanCreateTeam(grant.can_create_team);
      await loadJoinRequests(context.apiBaseUrl, context.accessToken, nextTeams);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTeams();
  }, []);

  const selectTeam = async (team: CloudTeam) => {
    const context = await getAuthContext();
    if (!context?.savedSettings.cloudSync) {
      messageApi.error('无法读取登录信息，请重新登录后再选择团队。');
      return;
    }
    const savedSettings = settings || context.savedSettings;
    const cloudSync = savedSettings.cloudSync;
    if (!cloudSync) {
      messageApi.error('无法读取登录信息，请重新登录后再选择团队。');
      return;
    }
    setSelectingTeamId(team.id);
    let currentTeam = team;
    try {
      const latestTeams = await fetchTeams(context.apiBaseUrl, context.accessToken);
      setTeams(latestTeams);
      currentTeam = latestTeams.find(item => item.id === team.id) || team;
    } catch (error) {
      messageApi.error((error as Error).message || '刷新团队权益失败，请稍后重试。');
      setSelectingTeamId(undefined);
      return;
    }
    if (!isCloudTeamAvailable(currentTeam)) {
      messageApi.error('该团队没有有效的云端权益，已保持本地模式。');
      setSelectingTeamId(undefined);
      return;
    }

    try {
      // A workspace may have been selected before the user was approved to join it.
      // Its cursor can then point past events that were not visible at the time.
      // Start a fresh pull when switching workspaces so existing team data, including
      // groups, is present before the windows page mounts.
      if (currentTeam.id !== cloudSync.workspaceId) {
        await SyncBridge.resetCloudSyncCursor(currentTeam.id);
      }
      try {
        await withTimeout(
          saveCloudSession(savedSettings, {
            ...cloudSync,
            workspaceId: currentTeam.id,
          }),
          ENTER_TEAM_SYNC_TIMEOUT_MS,
        );
      } catch (error) {
        // A timeout only means the cloud sync refresh is still running in the
        // background. Settings were saved before the refresh was attempted, so
        // entering the team is safe. Genuine failures still abort navigation.
        if (error instanceof SyncTimeoutError) {
          messageApi.info('团队已切换，云端数据同步中，可稍后点击刷新查看最新数据。');
        } else {
          throw error;
        }
      }
      navigate('/', {replace: true});
    } catch (error) {
      messageApi.error((error as Error).message || '进入团队失败，请稍后重试。');
    } finally {
      setSelectingTeamId(undefined);
    }
  };

  const handleBack = () => {
    navigate(currentWorkspaceId ? '/' : '/auth/login', {replace: true});
  };

  const loadJoinRequests = async (
    apiBaseUrl: string,
    accessToken: string,
    currentTeams: CloudTeam[],
  ) => {
    const ownRequests = await fetchCloudJson<{success: boolean; data: JoinRequest[]}>(
      apiBaseUrl,
      '/join-requests',
      {headers: {Authorization: `Bearer ${accessToken}`}},
    );
    setJoinRequests(ownRequests.data || []);

    const adminTeams = currentTeams.filter(team => team.role === 'owner' || team.role === 'admin');
    const entries = await Promise.all(
      adminTeams.map(async team => {
        const result = await fetchCloudJson<{success: boolean; data: JoinRequest[]}>(
          apiBaseUrl,
          `/teams/${team.id}/join-requests`,
          {headers: {Authorization: `Bearer ${accessToken}`}},
        );
        return [team.id, result.data || []] as const;
      }),
    );
    setAdminRequests(Object.fromEntries(entries));
  };

  const createTeam = async (values: {name: string}) => {
    const context = await getAuthContext();
    if (!context) return;
    setSubmitting(true);
    try {
      await fetchCloudJson<{success: boolean; data: CloudTeam}>(context.apiBaseUrl, '/teams', {
        method: 'POST',
        headers: {Authorization: `Bearer ${context.accessToken}`},
        body: JSON.stringify({name: values.name}),
      });
      setCreateOpen(false);
      createForm.resetFields();
      await loadTeams();
      messageApi.success(
        '团队已创建。请在 ISLES Power 为该团队开通会员权益后，刷新团队列表并进入团队。',
      );
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const requestJoin = async (values: {inviteCode: string; message?: string}) => {
    const context = await getAuthContext();
    if (!context) return;
    setSubmitting(true);
    try {
      await fetchCloudJson(context.apiBaseUrl, '/teams/join-requests', {
        method: 'POST',
        headers: {Authorization: `Bearer ${context.accessToken}`},
        body: JSON.stringify({invite_code: values.inviteCode, message: values.message}),
      });
      messageApi.success('申请已提交，等待管理员审批');
      setJoinOpen(false);
      joinForm.resetFields();
      await loadTeams();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const reviewRequest = async (teamId: string, requestId: string, action: 'approve' | 'reject') => {
    const context = await getAuthContext();
    if (!context) return;
    setSubmitting(true);
    try {
      await fetchCloudJson(
        context.apiBaseUrl,
        `/teams/${teamId}/join-requests/${requestId}/${action}`,
        {
          method: 'POST',
          headers: {Authorization: `Bearer ${context.accessToken}`},
        },
      );
      messageApi.success(action === 'approve' ? '已批准加入' : '已拒绝申请');
      await loadTeams();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const copyInviteCode = async (inviteCode: string) => {
    try {
      await navigator.clipboard.writeText(inviteCode);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = inviteCode;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    messageApi.success('邀请码已复制');
  };

  const regenerateInviteCode = async (teamId: string) => {
    const context = await getAuthContext();
    if (!context) return;
    setSubmitting(true);
    try {
      await fetchCloudJson(context.apiBaseUrl, `/teams/${teamId}/invite-code/regenerate`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${context.accessToken}`},
      });
      messageApi.success('邀请码已生成');
      await loadTeams();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      {contextHolder}
      <div className="auth-brand">
        <div>
          <h1 className="auth-brand-title">选择团队</h1>
          <p className="auth-brand-copy">
            选择后，窗口、代理和 profile 同步都会限定在该团队内；扩展及其分配仅保留在本机。
          </p>
        </div>
      </div>
      <div className="auth-panel team-select-panel">
        <div className="auth-card">
          <div className="team-select-header">
            <div>
              <h1>团队</h1>
              <p className="auth-subtitle">选择本次工作的团队空间。</p>
            </div>
            <Space>
              <Button
                icon={<ReloadOutlined />}
                onClick={loadTeams}
                loading={loading}
              >
                刷新
              </Button>
              <Button onClick={() => setJoinOpen(true)}>加入团队</Button>
              {canCreateTeam && (
                <Button
                  type="primary"
                  onClick={() => setCreateOpen(true)}
                >
                  创建团队
                </Button>
              )}
            </Space>
          </div>
          <List
            className="team-list"
            loading={loading}
            dataSource={teams}
            locale={{emptyText: '当前账号还没有团队'}}
            renderItem={team => {
              const isCurrent = team.id === currentWorkspaceId;
              return (
                <List.Item
                  className={`team-list-item ${isCurrent ? 'current' : ''}`}
                  actions={[
                    isCurrent ? (
                      <Tag
                        key="current"
                        color="processing"
                      >
                        当前选择
                      </Tag>
                    ) : (
                      <Button
                        key="select"
                        type="primary"
                        loading={selectingTeamId === team.id}
                        disabled={Boolean(selectingTeamId)}
                        onClick={() => selectTeam(team)}
                      >
                        进入
                      </Button>
                    ),
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space wrap>
                        <span className="team-name">{team.name}</span>
                        {team.role && <Tag>{team.role}</Tag>}
                      </Space>
                    }
                    description={
                      <Space
                        direction="vertical"
                        size={6}
                        className="team-meta"
                      >
                        <Text type="secondary">{team.id}</Text>
                        {(team.role === 'owner' || team.role === 'admin') && team.invite_code && (
                          <Space wrap>
                            <Text code>{team.invite_code}</Text>
                            <Button
                              size="small"
                              onClick={() => copyInviteCode(team.invite_code!)}
                            >
                              复制邀请码
                            </Button>
                          </Space>
                        )}
                        {(team.role === 'owner' || team.role === 'admin') && !team.invite_code && (
                          <Button
                            size="small"
                            loading={submitting}
                            onClick={() => regenerateInviteCode(team.id)}
                          >
                            生成邀请码
                          </Button>
                        )}
                      </Space>
                    }
                  />
                </List.Item>
              );
            }}
          />
          {joinRequests.length > 0 && (
            <div className="team-section">
              <Text strong>我的加入申请</Text>
              <List
                className="team-request-list"
                dataSource={joinRequests}
                renderItem={request => (
                  <List.Item>
                    <List.Item.Meta
                      title={
                        <Space>
                          {request.team?.name || request.team_id}
                          <Tag>{request.status}</Tag>
                        </Space>
                      }
                      description={request.message || request.created_at}
                    />
                  </List.Item>
                )}
              />
            </div>
          )}
          {Object.entries(adminRequests).some(([, requests]) => requests.length > 0) && (
            <div className="team-section">
              <Text strong>待审批申请</Text>
              {Object.entries(adminRequests).map(([teamId, requests]) =>
                requests.length ? (
                  <List
                    key={teamId}
                    className="team-request-list"
                    dataSource={requests}
                    renderItem={request => (
                      <List.Item
                        actions={[
                          <Button
                            key="approve"
                            type="primary"
                            loading={submitting}
                            onClick={() => reviewRequest(teamId, request.id, 'approve')}
                          >
                            批准
                          </Button>,
                          <Button
                            key="reject"
                            loading={submitting}
                            onClick={() => reviewRequest(teamId, request.id, 'reject')}
                          >
                            拒绝
                          </Button>,
                        ]}
                      >
                        <List.Item.Meta
                          title={request.user?.name || request.user?.email || request.user_id}
                          description={request.message || request.created_at}
                        />
                      </List.Item>
                    )}
                  />
                ) : null,
              )}
            </div>
          )}
          <Button
            className="team-back-btn"
            onClick={handleBack}
          >
            返回
          </Button>
        </div>
      </div>
      <Modal
        title="创建团队"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        okText="创建"
        cancelText="取消"
        confirmLoading={submitting}
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={createTeam}
        >
          <Form.Item
            name="name"
            label="团队名称"
            rules={[{required: true, message: '请输入团队名称'}]}
          >
            <Input placeholder="例如：Marketing Ops" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="用邀请码申请加入"
        open={joinOpen}
        onCancel={() => setJoinOpen(false)}
        onOk={() => joinForm.submit()}
        okText="提交申请"
        cancelText="取消"
        confirmLoading={submitting}
      >
        <Form
          form={joinForm}
          layout="vertical"
          onFinish={requestJoin}
        >
          <Form.Item
            name="inviteCode"
            label="邀请码"
            rules={[{required: true, message: '请输入邀请码'}]}
          >
            <Input placeholder="输入管理员提供的邀请码" />
          </Form.Item>
          <Form.Item
            name="message"
            label="申请说明"
          >
            <Input.TextArea
              rows={3}
              placeholder="可选，告诉管理员你是谁或加入用途"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
