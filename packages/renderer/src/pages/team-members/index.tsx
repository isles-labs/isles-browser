import {DeleteOutlined, ReloadOutlined, TeamOutlined} from '@ant-design/icons';
import {Alert, Avatar, Button, Empty, Popconfirm, Space, Spin, Tag, Typography, message} from 'antd';
import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {
  fetchCloudJson,
  fetchTeamMembers,
  fetchTeams,
  getSavedSettings,
  type CloudTeam,
  type CloudTeamMember,
} from '/@/utils/cloud-auth';
import './index.css';

const {Text, Title} = Typography;

const roleLabel: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
};

const initials = (value: string) => value.trim().slice(0, 1).toUpperCase() || '?';

export default function TeamMembers() {
  const [team, setTeam] = useState<CloudTeam>();
  const [members, setMembers] = useState<CloudTeamMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [removingUserId, setRemovingUserId] = useState('');
  const [messageApi, contextHolder] = message.useMessage();
  const navigate = useNavigate();

  const loadMembers = async () => {
    setLoading(true);
    try {
      const settings = await getSavedSettings();
      const apiBaseUrl = settings.cloudSync?.apiBaseUrl || '';
      const accessToken = settings.cloudSync?.accessToken || '';
      const workspaceId = settings.cloudSync?.workspaceId || '';
      if (!apiBaseUrl || !accessToken || !workspaceId) {
        navigate('/auth/login', {replace: true});
        return;
      }

      setCurrentUserId(settings.cloudSync?.userId || '');
      const teams = await fetchTeams(apiBaseUrl, accessToken);
      const currentTeam = teams.find(item => item.id === workspaceId);
      if (!currentTeam) {
        messageApi.error('无法读取当前团队信息');
        return;
      }
      setTeam(currentTeam);
      setMembers(await fetchTeamMembers(apiBaseUrl, accessToken, workspaceId));
    } catch (error) {
      messageApi.error((error as Error).message || '成员列表加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMembers();
  }, []);

  const removeMember = async (member: CloudTeamMember) => {
    if (!team) return;
    setRemovingUserId(member.user_id);
    try {
      const settings = await getSavedSettings();
      await fetchCloudJson(
        settings.cloudSync?.apiBaseUrl || '',
        `/teams/${team.id}/members/${member.user_id}`,
        {
          method: 'DELETE',
          headers: {Authorization: `Bearer ${settings.cloudSync?.accessToken || ''}`},
        },
      );
      messageApi.success('成员已移出团队');
      await loadMembers();
    } catch (error) {
      messageApi.error((error as Error).message || '移除成员失败');
    } finally {
      setRemovingUserId('');
    }
  };

  const canManage = team?.role === 'owner' || team?.role === 'admin';

  return (
    <div className="team-members-page">
      {contextHolder}
      <div className="team-members-heading">
        <div>
          <Text className="team-members-eyebrow">Team workspace</Text>
          <Title level={2}>团队成员</Title>
          <Text type="secondary">查看当前团队成员；管理员可移除不再需要访问权限的成员。</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadMembers} loading={loading}>刷新</Button>
          <Button onClick={() => navigate('/settings')}>返回设置</Button>
        </Space>
      </div>

      {!loading && team && !canManage && (
        <Alert
          className="team-members-notice"
          type="info"
          showIcon
          message="你拥有只读权限"
          description="只有团队所有者或管理员可以移除成员。"
        />
      )}

      <section className="team-members-card" aria-label="团队成员列表">
        <div className="team-members-card-header">
          <div className="team-members-title"><TeamOutlined /> <span>{team?.name || '当前团队'}</span></div>
          <Text type="secondary">{members.length} 名成员</Text>
        </div>
        {loading ? (
          <div className="team-members-loading"><Spin /></div>
        ) : members.length === 0 ? (
          <Empty description="暂时没有成员数据" />
        ) : (
          <div className="team-member-list">
            {members.map(member => {
              const name = member.user?.name || member.user?.email || member.user_id;
              const isSelf = member.user_id === currentUserId;
              const canRemove = canManage && !isSelf && member.role !== 'owner';
              return (
                <div className="team-member-row" key={member.user_id}>
                  <Avatar className="team-member-avatar">{initials(name)}</Avatar>
                  <div className="team-member-identity">
                    <div className="team-member-name">
                      {name} {isSelf && <Text type="secondary">（我）</Text>}
                    </div>
                    {member.user?.email && member.user.name && <Text type="secondary">{member.user.email}</Text>}
                  </div>
                  <Space className="team-member-actions" size={10}>
                    <Tag color={member.role === 'owner' ? 'gold' : member.role === 'admin' ? 'blue' : 'default'}>
                      {roleLabel[member.role] || member.role}
                    </Tag>
                    {canRemove && (
                      <Popconfirm
                        title="移出该成员？"
                        description="该成员将立即失去此团队的访问权限。"
                        okText="移出成员"
                        cancelText="取消"
                        okButtonProps={{danger: true, loading: removingUserId === member.user_id}}
                        onConfirm={() => removeMember(member)}
                      >
                        <Button danger type="text" icon={<DeleteOutlined />} loading={removingUserId === member.user_id}>
                          移出
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
