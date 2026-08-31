type CloudErrorResponse = {
  response?: {
    data?: {
      reason?: unknown;
      message?: unknown;
      active_windows?: unknown;
      max_windows?: unknown;
      active_devices?: unknown;
      max_devices?: unknown;
      member_count?: unknown;
      max_members?: unknown;
    };
  };
};

const numberText = (value: unknown) =>
  Number.isFinite(Number(value)) ? String(Number(value)) : '?';

export const cloudEntitlementErrorMessage = (error: unknown) => {
  const data = (error as CloudErrorResponse)?.response?.data;
  const reason = String(data?.reason || '');
  if (reason === 'cloud_window_quota_exceeded') {
    return `指纹窗口数量已达到团队上限（${numberText(data?.active_windows)} / ${numberText(data?.max_windows)}）。请删除不需要的窗口，或联系管理员调整会员权益。`;
  }
  if (reason === 'cloud_device_quota_exceeded') {
    return `已绑定设备数量达到团队上限（${numberText(data?.active_devices)} / ${numberText(data?.max_devices)}）。请联系团队管理员释放设备或调整会员权益。`;
  }
  if (reason === 'team_member_quota_exceeded') {
    return `团队成员数量已达到上限（${numberText(data?.member_count)} / ${numberText(data?.max_members)}）。请联系团队管理员调整会员权益。`;
  }
  if (reason === 'cloud_entitlement_expired')
    return '会员权益已到期，云端工作区当前为只读。请联系管理员续费后重试。';
  if (reason === 'cloud_entitlement_suspended')
    return '会员权益已暂停，暂时不能使用云端服务。请联系管理员咨询。';
  if (reason === 'cloud_entitlement_required')
    return '当前团队没有有效的会员权益，暂时不能使用云端服务。';
  if (reason === 'cloud_device_not_registered')
    return '当前设备尚未获得团队云端授权，请刷新云端权限后重试。';
  if (reason === 'team_creation_not_authorized')
    return '当前账号没有创建团队的会员权限，请添加微信咨询开通。';
  if (reason === 'one_team_per_user') return '一个账号只能加入一个团队，无法加入或创建其他团队。';
  return typeof data?.message === 'string' && data.message.trim()
    ? data.message
    : '云端请求失败，请检查会员权益和网络后重试。';
};
