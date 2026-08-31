import type {MenuProps} from 'antd';
import {
  Badge,
  Button,
  Card,
  Descriptions,
  Drawer,
  Dropdown,
  Input,
  List,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Row,
  Col,
  Typography,
  Progress,
  message,
  Tooltip,
} from 'antd';
import type {ColumnsType} from 'antd/es/table';
import type {MenuInfo} from 'rc-menu/lib/interface';
import {useEffect, useMemo, useState} from 'react';
import _ from 'lodash';
import * as ExcelJS from 'exceljs';

import {
  CloseOutlined,
  // SendOutlined,
  ChromeOutlined,
  MoreOutlined,
  SearchOutlined,
  EditOutlined,
  GlobalOutlined,
  DeleteOutlined,
  SyncOutlined,
  ClearOutlined,
  // ExportOutlined,
  ExclamationCircleFilled,
  ExportOutlined,
} from '@ant-design/icons';
import type {DB} from '../../../../shared/types/db';
import {
  CommonBridge,
  GroupBridge,
  ProxyBridge,
  SyncBridge,
  TagBridge,
  WindowBridge,
} from '#preload';
import type {CloudSyncV2Conflict, CloudSyncV2OutboxItem} from '#preload';
import {containsKeyword} from '/@/utils/str';
import {useNavigate} from 'react-router-dom';
import {MESSAGE_CONFIG, WINDOW_STATUS} from '/@/constants';
import {useTranslation} from 'react-i18next';
import {
  getCloudSyncProgressPercent,
  getCloudSyncQueueLabel,
  shouldShowCloudSyncProgress,
  type CloudSyncProgress,
} from './cloud-sync-status';

const {Text} = Typography;

const isSameCloudSyncProgress = (
  current: {enabled: boolean; pendingOutbox: number; progressPercent: number; syncing: boolean},
  next: {enabled: boolean; pendingOutbox: number; progressPercent: number; syncing: boolean},
) =>
  current.enabled === next.enabled &&
  current.pendingOutbox === next.pendingOutbox &&
  current.progressPercent === next.progressPercent &&
  current.syncing === next.syncing;

const haveSameCloudLocks = (
  current: Map<string, CloudLockState>,
  next: Map<string, CloudLockState>,
) =>
  current.size === next.size &&
  Array.from(current.entries()).every(([profileId, currentLock]) => {
    const nextLock = next.get(profileId);
    return (
      nextLock &&
      currentLock.user_id === nextLock.user_id &&
      currentLock.user_name === nextLock.user_name &&
      currentLock.device_id === nextLock.device_id &&
      currentLock.device_name === nextLock.device_name
    );
  });

interface CloudLockState {
  lock_id?: string;
  workspace_id?: string;
  profile_cloud_id: string;
  user_id?: string;
  user_name?: string;
  device_id?: string;
  device_name?: string;
  locked_at?: string;
  heartbeat_at?: string;
}

interface CloudProfileSyncDiagnostic {
  window_id: number;
  cloud_id?: string;
  cloud_revision?: string;
  uploaded_bytes?: number;
  downloaded_bytes?: number;
  last_file_count?: number;
  last_cookie_count?: number;
  offline_dirty?: boolean | number;
  conflict_status?: string;
  last_error?: string;
  updated_at?: string;
  window_name?: string;
  window_status?: number;
}
const CLOUD_LOCK_STALE_MS = 60 * 1000;
const OPEN_STAGE_LABELS: Record<string, string> = {
  locking: '等待云锁',
  extensions: '检查扩展',
  'profile-download': '下载登录状态',
  runtime: '准备浏览器运行时',
  'proxy-check': '验证代理网络',
  'browser-start': '启动浏览器',
  offline: '离线运行',
  'offline-running': '离线运行',
  running: '运行中',
  failed: '启动失败',
};

const CONFLICT_FIELD_LABELS: Record<string, string> = {
  profile_id: 'Profile ID',
  name: '窗口名称',
  group_cloud_id: '分组',
  proxy_cloud_id: '代理',
  tag_cloud_ids: '标签',
  remark: '备注',
  ua: 'User-Agent',
  browser_engine: '浏览器内核',
  browser_core_family: '浏览器核心',
  browser_channel: '浏览器通道',
  browser_min_core_version: '最低核心版本',
  browser_version: '浏览器版本',
};

const CONFLICT_REASON_LABELS: Record<string, string> = {
  tombstone_conflict: '云端版本已删除，本地仍有修改',
  conflict: '本地与云端都修改了同一条记录',
  reference_conflict: '关联的云端数据已变化，当前修改无法安全合并',
  entity_missing: '该对象属于旧团队，当前团队的云端不存在该记录',
};

const getConflictReason = (status: string) =>
  CONFLICT_REASON_LABELS[status] || `同步冲突：${status}`;

const OUTBOX_STATE_LABELS: Record<CloudSyncV2OutboxItem['state'], {label: string; color: string}> =
  {
    pending: {label: '等待发送', color: 'blue'},
    sending: {label: '发送中', color: 'processing'},
    retry_wait: {label: '重试等待', color: 'orange'},
    conflict: {label: '同步冲突', color: 'red'},
  };

const OUTBOX_ENTITY_LABELS: Record<CloudSyncV2OutboxItem['entity_type'], string> = {
  window: '窗口',
  proxy: '代理',
  group: '分组',
  tag: '标签',
};

const OUTBOX_OPERATION_LABELS: Record<CloudSyncV2OutboxItem['operation'], string> = {
  create: '创建',
  patch: '更新',
  delete: '删除',
};

const formatUtcTimestamp = (value?: string | null) => {
  if (!value) return '-';
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {hour12: false});
};

const parseCloudLockTime = (lock: CloudLockState) => {
  const source = lock.heartbeat_at || lock.locked_at;
  if (!source) return null;
  const timestamp = new Date(source).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
};

const isCloudLockFresh = (lock: CloudLockState) => {
  const lockTime = parseCloudLockTime(lock);
  if (!lockTime) return false;
  return Date.now() - lockTime <= CLOUD_LOCK_STALE_MS;
};

const getWindowNameNumber = (name?: string) => {
  const match = name?.match(/\d+/);

  return match ? Number(match[0]) : null;
};

const compareWindowNameByNumber = (left: DB.Window, right: DB.Window) => {
  const leftNumber = getWindowNameNumber(left.name);
  const rightNumber = getWindowNameNumber(right.name);

  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  if (leftNumber !== null && rightNumber === null) {
    return -1;
  }

  if (leftNumber === null && rightNumber !== null) {
    return 1;
  }

  return (left.name ?? '').localeCompare(right.name ?? '');
};

const getWindowExportFileName = () => {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  return `windows-${timestamp}.xlsx`;
};

const Windows = () => {
  const OFFSET = 304;
  const [group, setGroup] = useState(-1);
  const [searchValue, setSearchValue] = useState(''); // Note: Set SOME_OFFSET based on your design
  const [tableScrollY, setTableScrollY] = useState(window.innerHeight - OFFSET); // Note: Set SOME_OFFSET based on your design
  const {t, i18n} = useTranslation();
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [windowNameSortOrder, setWindowNameSortOrder] = useState<'ascend' | 'descend' | null>(null);
  const [selectedRow, setSelectedRow] = useState<DB.Window>();
  const [rawWindowData, setRawWindowData] = useState<DB.Window[]>([]);
  const [groupOptions, setGroupOptions] = useState<DB.Group[]>([{id: -1, name: 'All'}]);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [clearCacheModalVisible, setClearCacheModalVisible] = useState(false);
  const [conflictDrawerOpen, setConflictDrawerOpen] = useState(false);
  const [outboxDrawerOpen, setOutboxDrawerOpen] = useState(false);
  const [cloudSyncOutbox, setCloudSyncOutbox] = useState<CloudSyncV2OutboxItem[]>([]);
  const [loadingCloudSyncOutbox, setLoadingCloudSyncOutbox] = useState(false);
  const [retryingCloudSyncOutboxId, setRetryingCloudSyncOutboxId] = useState<number>();
  const [resolvingCloudConflictId, setResolvingCloudConflictId] = useState<number>();
  const [tagMap, setTagMap] = useState(new Map<number, DB.Tag>());
  const [messageApi, contextHolder] = message.useMessage(MESSAGE_CONFIG);
  const [proxySettingVisible, setProxySettingVisible] = useState(false);
  const [proxies, setProxies] = useState<DB.Proxy[]>([]);
  const [selectedProxy, setSelectedProxy] = useState<number>();
  const [cloudSyncDeviceId, setCloudSyncDeviceId] = useState('');
  const [cloudLocks, setCloudLocks] = useState(new Map<string, CloudLockState>());
  const [releasingCloudLocks, setReleasingCloudLocks] = useState(false);
  const [cloudSyncProgress, setCloudSyncProgress] = useState<CloudSyncProgress>({
    enabled: false,
    pendingOutbox: 0,
    progressPercent: 100,
    syncing: false,
  });
  const [openStages, setOpenStages] = useState(new Map<number, string>());
  const [cloudDiagnostics, setCloudDiagnostics] = useState<{
    profiles: CloudProfileSyncDiagnostic[];
    failedOutbox: number;
    v2Conflicts: CloudSyncV2Conflict[];
  }>({profiles: [], failedOutbox: 0, v2Conflicts: []});
  const navigate = useNavigate();

  const moreActionDropdownItems: MenuProps['items'] = [
    // {
    //   key: 'group',
    //   label: 'Switching Group',
    //   icon: <SendOutlined />,
    // },
    {
      key: 'clear-cache',
      label: t('window_clear_cache'),
      icon: <ClearOutlined />,
    },
    {
      key: 'export',
      label: t('window_export'),
      icon: <ExportOutlined />,
    },
    {
      type: 'divider',
    },
    {
      key: 'delete',
      danger: true,
      label: t('window_delete'),
      icon: <DeleteOutlined />,
    },
  ];
  const recorderDropdownItems: MenuProps['items'] = [
    {
      key: 'edit',
      label: t('window_edit'),
      icon: <EditOutlined />,
    },
    {
      key: 'proxy',
      label: t('window_proxy_setting'),
      icon: <GlobalOutlined />,
    },
    {
      key: 'clear-cache',
      label: t('window_clear_cache'),
      icon: <ClearOutlined />,
    },
    // {
    //   key: 'set-cookie',
    //   label: t('window_set_cookie'),
    //   icon: <UsergroupAddOutlined />,
    // },
    {
      type: 'divider',
    },
    {
      key: 'delete',
      danger: true,
      label: t('window_delete'),
      icon: <DeleteOutlined />,
    },
  ];
  const columns: ColumnsType<DB.Window> = useMemo(() => {
    const getCloudLock = (recorder: DB.Window) =>
      recorder.cloud_id ? cloudLocks.get(recorder.cloud_id) : undefined;
    const getLockLabel = (lock?: CloudLockState) => {
      if (!lock) return '';
      return `${lock.user_name || lock.user_id || 'Unknown'} / ${
        lock.device_name || lock.device_id || 'Unknown'
      }`;
    };
    const formatCloudLockTime = (lock?: CloudLockState) => {
      const time = lock?.heartbeat_at || lock?.locked_at;
      if (!time) return '';
      return new Date(time).toLocaleString();
    };
    const isLockedByOther = (recorder: DB.Window) => {
      const lock = getCloudLock(recorder);
      return Boolean(lock?.device_id && lock.device_id !== cloudSyncDeviceId);
    };

    return [
      {
        title: 'ID',
        width: 60,
        dataIndex: 'id',
        key: 'id',
        fixed: 'left',
      },
      {
        title: t('window_column_name'),
        width: 100,
        dataIndex: 'name',
        key: 'name',
        sorter: compareWindowNameByNumber,
        sortDirections: ['ascend', 'descend'],
        sortOrder: windowNameSortOrder,
        fixed: 'left',
      },
      {
        title: t('window_column_group'),
        width: 100,
        dataIndex: 'group_name',
        key: 'group_name',
        fixed: 'left',
      },
      {
        title: '云状态',
        width: 110,
        key: 'cloud_lock',
        render: (_, recorder) => {
          const lock = getCloudLock(recorder);
          if (lock?.device_id && lock.device_id !== cloudSyncDeviceId) {
            return (
              <Tooltip title={`Opened by ${getLockLabel(lock)}`}>
                <Tag color="orange">使用中</Tag>
              </Tooltip>
            );
          }
          if (lock) {
            return <Tag color="green">本机</Tag>;
          }
          if (!recorder.cloud_id) {
            return <Tag color="default">未同步</Tag>;
          }
          return <Tag color="blue">可用</Tag>;
        },
      },
      {
        title: t('window_column_remark'),
        dataIndex: 'remark',
        key: 'remark',
        width: 150,
      },
      {
        title: t('window_column_proxy'),
        dataIndex: 'proxy',
        key: 'proxy',
        width: 350,
      },
      {
        title: t('window_column_tags'),
        dataIndex: 'tags',
        key: 'tags',
        width: 150,
        render: (_, recorder) => (
          <>
            {recorder.tags &&
              recorder.tags
                .toString()
                .split(',')
                .map(tagId => {
                  const tag = tagMap.get(Number(tagId));
                  return (
                    <Tag
                      key={tagId}
                      color={tag?.color}
                    >
                      {tag?.name}
                    </Tag>
                  );
                })}
          </>
        ),
      },
      {
        title: t('window_column_last_open'),
        dataIndex: 'opened_at',
        key: 'opened_at',
        width: 180,
        render: (value, recorder) => {
          const lock = getCloudLock(recorder);
          if (isLockedByOther(recorder)) {
            return (
              <Tooltip title={`Opened by ${getLockLabel(lock)}`}>
                <Space
                  direction="vertical"
                  size={0}
                >
                  <Tag color="orange">远端打开中</Tag>
                  {formatCloudLockTime(lock) && (
                    <Text type="secondary">{formatCloudLockTime(lock)}</Text>
                  )}
                </Space>
              </Tooltip>
            );
          }

          if (!value) return '';
          const utcDate = new Date(value + 'Z');

          const localDateStr = utcDate.toLocaleString();
          return localDateStr;
        },
      },
      {
        title: t('window_column_profile_id'),
        width: 100,
        dataIndex: 'profile_id',
        key: 'profile_id',
      },
      {
        title: t('window_column_created_at'),
        dataIndex: 'created_at',
        key: 'created_at',
        width: 150,
        render: value => {
          const utcDate = new Date(value + 'Z');

          const localDateStr = utcDate.toLocaleString();
          return localDateStr;
        },
      },
      {
        title: t('window_column_action'),
        key: 'operation',
        fixed: 'right',
        width: 120,
        align: 'center',
        render: (_, recorder) => (
          <Tooltip
            title={
              isLockedByOther(recorder)
                ? `Opened by ${getLockLabel(getCloudLock(recorder))}`
                : undefined
            }
          >
            <Button
              icon={<ChromeOutlined />}
              disabled={
                recorder.status === WINDOW_STATUS.RUNNING ||
                recorder.status === WINDOW_STATUS.PREPARING ||
                isLockedByOther(recorder)
              }
              type="primary"
              onClick={() => openWindows(recorder.id)}
            >
              {isLockedByOther(recorder)
                ? '使用中'
                : recorder.status === 1
                  ? t('window_open')
                  : recorder.status === 2
                    ? t('window_running')
                    : OPEN_STAGE_LABELS[openStages.get(recorder.id!) || ''] ||
                      t('window_preparing')}
            </Button>
          </Tooltip>
        ),
      },
      {
        title: '',
        key: 'operation',
        fixed: 'right',
        align: 'center',
        width: 40,
        render: (_, recorder) => (
          <Dropdown
            className="cursor-pointer"
            menu={{
              items: recorderDropdownItems,
              onClick: menuInfo => recorderAction(menuInfo, recorder),
            }}
          >
            <MoreOutlined />
          </Dropdown>
        ),
      },
    ];
  }, [tagMap, i18n.language, cloudLocks, cloudSyncDeviceId, openStages, windowNameSortOrder]);

  const [pageSize, setPageSize] = useState(20);

  const onSelectChange = (newSelectedRowKeys: React.Key[]) => {
    setSelectedRowKeys(newSelectedRowKeys as number[]);
  };
  const rowSelection = {
    selectedRowKeys,
    onChange: onSelectChange,
  };

  const windowData = useMemo(() => {
    let filteredData = [...rawWindowData];

    // 按组过滤
    if (group > -1) {
      filteredData = filteredData.filter(item => item.group_id === group);
    }

    // 按搜索关键词过滤
    if (searchValue) {
      const keyword = searchValue.toLowerCase();
      filteredData = filteredData.filter(
        f =>
          containsKeyword(f.group_name, keyword) ||
          containsKeyword(f.name, keyword) ||
          containsKeyword(f.id, keyword) ||
          containsKeyword(f.ip, keyword) ||
          containsKeyword(f.profile_id, keyword) ||
          containsKeyword(f.proxy, keyword) ||
          (f.tags &&
            ((f.tags instanceof Array &&
              f.tags.some(tag => containsKeyword(tagMap.get(Number(tag))?.name, keyword))) ||
              f.tags
                .toString()
                .split(',')
                .some(tag => containsKeyword(tagMap.get(Number(tag))?.name, keyword)))),
      );
    }

    return filteredData;
  }, [rawWindowData, group, searchValue, tagMap]);

  const refreshWindowData = async () => {
    const data = await WindowBridge?.getAll();
    setRawWindowData(Array.isArray(data) ? data : []);
  };

  const syncWindowDataInBackground = () => {
    void (async () => {
      try {
        const result = await SyncBridge?.pullCloudSync?.();
        if (!result?.success || result.skipped) return;
        await refreshWindowData();
      } catch {
        // The local list is already visible. Cloud sync state is shown separately.
      }
    })();
  };

  const fetchWindowData = async () => {
    setLoading(true);
    try {
      await refreshWindowData();
    } catch (error) {
      messageApi.error('Failed to fetch window data');
    } finally {
      setLoading(false);
      setSelectedRowKeys([]);
      setSelectedRow(undefined);
    }

    syncWindowDataInBackground();
  };

  const fetchTagData = async () => {
    const data = await TagBridge?.getAll();
    const newTagMap = new Map<number, DB.Tag>();
    data?.forEach((tag: DB.Tag) => {
      newTagMap.set(tag.id!, tag);
    });
    setTagMap(newTagMap);
  };

  const fetchGroupData = async () => {
    const data = await GroupBridge?.getAll();
    data.splice(0, 0, {id: -1, name: 'All'});
    setGroupOptions(data);
  };

  const fetchProxies = async () => {
    const proxies = await ProxyBridge?.getAll();
    setProxies(
      proxies.map((proxy: DB.Proxy) => {
        return {
          host: proxy.proxy?.split(':')[0] ?? proxy.id,
          ...proxy,
        };
      }),
    );
  };

  const fetchCloudLocks = async () => {
    try {
      const status = await SyncBridge.getCloudSyncStatus();
      setCloudSyncDeviceId(status?.deviceId || '');
      if (!status?.enabled) {
        setCloudLocks(current => (current.size ? new Map() : current));
        return;
      }

      const result = await SyncBridge.getCloudSyncLocks();
      const nextLocks = new Map<string, CloudLockState>();
      result?.data?.forEach((lock: CloudLockState) => {
        if (lock.profile_cloud_id && isCloudLockFresh(lock)) {
          nextLocks.set(lock.profile_cloud_id, lock);
        }
      });
      setCloudLocks(current => (haveSameCloudLocks(current, nextLocks) ? current : nextLocks));
    } catch {
      setCloudLocks(current => (current.size ? new Map() : current));
    }
  };

  const fetchCloudSyncProgress = async () => {
    try {
      const progress = await SyncBridge.getCloudSyncProgress();
      const nextProgress = {
        enabled: Boolean(progress?.enabled),
        pendingOutbox: Number(progress?.pendingOutbox || 0),
        progressPercent: Number(progress?.progressPercent || 100),
        syncing: Boolean(progress?.syncing),
      };
      setCloudSyncProgress(current =>
        isSameCloudSyncProgress(current, nextProgress) ? current : nextProgress,
      );
    } catch {
      setCloudSyncProgress(current => (current.syncing ? {...current, syncing: false} : current));
    }
  };

  const fetchCloudSyncOutbox = async () => {
    setLoadingCloudSyncOutbox(true);
    try {
      setCloudSyncOutbox(await SyncBridge.getCloudSyncV2Outbox());
    } catch (error) {
      messageApi.error(`读取同步队列失败：${(error as Error).message}`);
    } finally {
      setLoadingCloudSyncOutbox(false);
    }
  };

  const openCloudSyncOutbox = () => {
    setOutboxDrawerOpen(true);
    void fetchCloudSyncOutbox();
  };

  const retryCloudSyncOutboxNow = async (item: CloudSyncV2OutboxItem) => {
    setRetryingCloudSyncOutboxId(item.id);
    try {
      const result = await SyncBridge.retryCloudSyncV2OutboxNow(item.id);
      if (!result?.success) throw new Error(result?.message || '立即同步失败');
      messageApi.success(result.count ? `已立即同步 ${result.count} 个队列项` : '已发起立即同步');
      await fetchCloudSyncOutbox();
      await fetchCloudSyncProgress();
    } catch (error) {
      messageApi.error(`立即同步失败：${(error as Error).message}`);
      await fetchCloudSyncOutbox();
    } finally {
      setRetryingCloudSyncOutboxId(undefined);
    }
  };

  const fetchCloudDiagnostics = async () => {
    try {
      setCloudDiagnostics(await SyncBridge.getCloudSyncDiagnostics());
    } catch {
      // The normal window workflow should remain usable if diagnostics fails.
    }
  };

  const releaseCloudLocks = async () => {
    setReleasingCloudLocks(true);
    try {
      await SyncBridge.releaseCloudSyncLocks();
      await fetchCloudLocks();
      await fetchWindowData();
      messageApi.success('Cloud locks cleared');
    } catch (error) {
      messageApi.error(`Failed to clear cloud locks: ${(error as Error).message}`);
    } finally {
      setReleasingCloudLocks(false);
    }
  };

  const resolveCloudConflict = async (
    conflictId: number,
    resolution: 'keep_cloud' | 'keep_local',
  ) => {
    setResolvingCloudConflictId(conflictId);
    try {
      const result = await SyncBridge.resolveCloudSyncV2Conflict(conflictId, resolution);
      if (!result?.success) throw new Error(result?.message || 'Conflict resolution failed');
      await Promise.all([fetchCloudDiagnostics(), fetchCloudSyncProgress(), fetchWindowData()]);
      messageApi.success(
        result.recreated
          ? '已在当前团队创建本地版本'
          : resolution === 'keep_cloud'
            ? '已应用云端版本'
            : '已重新提交本地版本',
      );
    } catch (error) {
      messageApi.error(`同步冲突处理失败：${(error as Error).message}`);
    } finally {
      setResolvingCloudConflictId(undefined);
    }
  };

  const isWindowLockedByOtherDevice = (windowItem: DB.Window) => {
    const lock = windowItem.cloud_id ? cloudLocks.get(windowItem.cloud_id) : undefined;
    return Boolean(lock?.device_id && cloudSyncDeviceId && lock.device_id !== cloudSyncDeviceId);
  };

  const moreAction = (info: MenuInfo) => {
    switch (info.key) {
      case 'delete':
        setSelectedRow(undefined);
        deleteWindows();
        break;
      case 'clear-cache':
        setSelectedRow(undefined);
        clearWindowsCache();
        break;
      case 'export':
        exportWindows();
        break;
      default:
        break;
    }
  };

  const exportWindows = async () => {
    try {
      // 导出窗口数据
      const orderedWindowData = windowNameSortOrder
        ? [...windowData].sort((left, right) => {
            const result = compareWindowNameByNumber(left, right);
            return windowNameSortOrder === 'descend' ? -result : result;
          })
        : windowData;
      const data = orderedWindowData.map(item => {
        return {
          ...item,
          proxy: proxies.find(proxy => proxy.id === item.proxy_id)?.proxy,
        };
      });

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Windows');

      // 添加表头
      worksheet.addRow([
        'ID',
        'Profile ID',
        'Group',
        'Name',
        'Remark',
        'Tags',
        'Proxy',
        'Last Open',
        'Created At',
      ]);

      // 添加数据
      data.forEach(item => {
        worksheet.addRow([
          item.id,
          item.profile_id,
          item.group_name,
          item.name,
          item.remark,
          item.tags
            ? item.tags
                .toString()
                .split(',')
                .map(tag => tagMap.get(Number(tag))?.name)
                .join(',')
            : '',
          item.proxy,
          item.opened_at ? new Date(item.opened_at + 'Z').toLocaleString() : '',
          item.created_at ? new Date(item.created_at + 'Z').toLocaleString() : '',
        ]);
      });

      // 调整列宽
      worksheet.columns.forEach(column => {
        column.width = 20;
      });

      // 生成 buffer
      const buffer = await workbook.xlsx.writeBuffer();

      // 调用主进程的保存对话框
      const result = await CommonBridge?.saveDialog({
        title: 'Save Windows Data',
        defaultPath: getWindowExportFileName(),
        filters: [{name: 'Excel Files', extensions: ['xlsx']}],
      });

      if (result.filePath) {
        // 将 buffer 写入文件
        await CommonBridge?.saveFile(result.filePath, buffer);
        messageApi.success('Export successfully');
      }
    } catch (error) {
      console.log('export windows error', error);
      const saveError = error as NodeJS.ErrnoException;
      if (saveError.code === 'EBUSY') {
        messageApi.error('该 Excel 文件正在被占用。请关闭它，或选择新的文件名后重试。');
      } else {
        messageApi.error('Failed to export: ' + saveError.message);
      }
    }
  };

  useEffect(() => {
    fetchTagData();
    fetchProxies();
    fetchGroupData();
    fetchWindowData();
    fetchCloudLocks();
    fetchCloudSyncProgress();
    fetchCloudDiagnostics();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(fetchCloudLocks, 10000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(fetchCloudSyncProgress, 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(fetchCloudDiagnostics, 10000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleWindowClosed = (_: Electron.IpcRendererEvent, id: number) => {
      setRawWindowData(windowData =>
        windowData.map(window => (window.id === id ? {...window, status: 1} : window)),
      );
      fetchCloudLocks();
    };

    const handleWindowOpened = (_: Electron.IpcRendererEvent, id: number) => {
      if (id) {
        setRawWindowData(windowData =>
          windowData.map(window => (window.id === id ? {...window, status: 2} : window)),
        );
        setOpenStages(stages => {
          const next = new Map(stages);
          next.set(id, 'running');
          return next;
        });
        fetchCloudLocks();
      } else {
        messageApi.error('Failed to open window');
      }
    };
    const handleWindowOpenStage = (
      _: Electron.IpcRendererEvent,
      update: {id: number; stage: string},
    ) => {
      setOpenStages(stages => new Map(stages).set(update.id, update.stage));
    };
    WindowBridge?.offWindowClosed(handleWindowClosed);
    WindowBridge?.offWindowOpened(handleWindowOpened);
    WindowBridge?.offWindowOpenStage(handleWindowOpenStage);

    WindowBridge?.onWindowClosed(handleWindowClosed);
    WindowBridge?.onWindowOpened(handleWindowOpened);
    WindowBridge?.onWindowOpenStage(handleWindowOpenStage);

    return () => {
      WindowBridge?.offWindowClosed(handleWindowClosed);
      WindowBridge?.offWindowOpened(handleWindowOpened);
      WindowBridge?.offWindowOpenStage(handleWindowOpenStage);
    };
  }, []);

  const closeWindows = async (id?: number) => {
    setLoading(true);
    if (id) {
      await WindowBridge?.close(id);
      setLoading(false);
    } else {
      for (let index = 0; index < selectedRowKeys.length; index++) {
        const rowKey = selectedRowKeys[index];
        await WindowBridge?.close(rowKey);
      }
      fetchWindowData();
    }
  };

  const openWindows = async (id?: number) => {
    const openOne = async (windowId: number, offline = false) => {
      const result = offline
        ? await WindowBridge?.openOffline(windowId)
        : await WindowBridge?.open(windowId);
      if ((result as {offlineAvailable?: boolean} | undefined)?.offlineAvailable) {
        setRawWindowData(windowData =>
          windowData.map(window =>
            window.id === windowId ? {...window, status: WINDOW_STATUS.NORMAL} : window,
          ),
        );
        Modal.confirm({
          title: '云锁不可用',
          content:
            '无法确认其他设备是否正在使用该 profile。离线打开会在网络恢复后要求处理同步冲突。',
          okText: '确认离线打开',
          cancelText: '取消',
          onOk: () => openOne(windowId, true),
        });
        return;
      }
      if (!result || (result as {success?: boolean}).success === false) {
        const message =
          (result as {message?: string} | undefined)?.message || 'Failed to open window';
        throw new Error(message);
      }
    };
    if (id) {
      const targetWindow = rawWindowData.find(windowItem => windowItem.id === id);
      if (targetWindow && isWindowLockedByOtherDevice(targetWindow)) {
        messageApi.warning('Window is already open on another device');
        return;
      }
      setRawWindowData(windowData =>
        windowData.map(window =>
          window.id === id ? {...window, status: WINDOW_STATUS.PREPARING} : window,
        ),
      );
      void openOne(id).catch((error: unknown) => {
        messageApi.error((error as Error)?.message || 'Failed to open window');
        setRawWindowData(windowData =>
          windowData.map(window =>
            window.id === id ? {...window, status: WINDOW_STATUS.NORMAL} : window,
          ),
        );
      });
    } else {
      const openTargets = selectedRowKeys.filter(rowKey => {
        const targetWindow = rawWindowData.find(windowItem => windowItem.id === rowKey);
        return !(targetWindow && isWindowLockedByOtherDevice(targetWindow));
      });

      if (!openTargets.length) {
        return;
      }

      setRawWindowData(windowData =>
        windowData.map(window =>
          openTargets.includes(window.id!) ? {...window, status: WINDOW_STATUS.PREPARING} : window,
        ),
      );

      for (let index = 0; index < selectedRowKeys.length; index++) {
        const rowKey = selectedRowKeys[index];
        const targetWindow = rawWindowData.find(windowItem => windowItem.id === rowKey);
        if (targetWindow && isWindowLockedByOtherDevice(targetWindow)) {
          continue;
        }
        void openOne(rowKey).catch((error: unknown) => {
          messageApi.error((error as Error)?.message || `Failed to open window #${rowKey}`);
          setRawWindowData(windowData =>
            windowData.map(window =>
              window.id === rowKey ? {...window, status: WINDOW_STATUS.NORMAL} : window,
            ),
          );
        });
      }
    }
    await fetchCloudLocks();
  };

  const deleteWindows = () => {
    setDeleteModalVisible(true);
  };

  const clearWindowsCache = (window?: DB.Window) => {
    const ids = window ? [window.id!] : selectedRow ? [selectedRow.id!] : selectedRowKeys;

    if (ids.length === 0) {
      messageApi.warning(t('window_select_first'));
      return;
    }

    setClearCacheModalVisible(true);
  };

  const onDeleteModalOk = async () => {
    const ids = selectedRow ? [selectedRow.id!] : selectedRowKeys;
    try {
      setLoading(true);
      await WindowBridge?.batchDelete(ids);
      setDeleteModalVisible(false);
      await fetchWindowData();
      messageApi.success('Deleted successfully');
      setLoading(false);
    } catch (error) {
      messageApi.error('Failed to delete');
    }
  };

  const onDeleteModalCancel = () => {
    setDeleteModalVisible(false);
  };

  const onClearCacheModalOk = async () => {
    const ids = selectedRow ? [selectedRow.id!] : selectedRowKeys;

    try {
      setLoading(true);
      const result = await WindowBridge?.clearCache(ids);
      const skippedCount = result?.data?.skipped?.length ?? 0;
      const failedCount = result?.data?.failed?.length ?? 0;

      if (skippedCount > 0 || failedCount > 0) {
        messageApi.warning(
          t('window_clear_cache_partial', {
            cleared: result?.data?.cleared?.length ?? 0,
            skipped: skippedCount + failedCount,
          }),
        );
      } else if (result?.success === false) {
        messageApi.error(result.message || t('window_clear_cache_failed'));
      } else {
        messageApi.success(t('window_clear_cache_success'));
      }

      setClearCacheModalVisible(false);
      setSelectedRowKeys([]);
      setSelectedRow(undefined);
    } catch (error) {
      messageApi.error((error as Error)?.message || t('window_clear_cache_failed'));
    } finally {
      setLoading(false);
    }
  };

  const onClearCacheModalCancel = () => {
    setClearCacheModalVisible(false);
  };

  const setCookie = async (window: DB.Window) => {
    const result = await WindowBridge.toogleSetCookie(window.id!);
    messageApi.open({
      type: result.success ? 'success' : 'error',
      content: result.message,
    });
  };

  const recorderAction = async (info: MenuInfo, recorder: DB.Window) => {
    switch (info.key) {
      case 'delete':
        setSelectedRow(recorder);
        deleteWindows();
        break;
      case 'edit':
        navigate(`/window/edit?id=${recorder.id}`);
        break;
      case 'proxy':
        setSelectedRow(recorder);
        setSelectedProxy(recorder.proxy_id ?? undefined);
        setProxySettingVisible(true);
        break;
      case 'clear-cache':
        setSelectedRow(recorder);
        clearWindowsCache(recorder);
        break;
      case 'set-cookie':
        setSelectedRow(recorder);
        await setCookie(recorder);
        break;

      default:
        break;
    }
  };


  const handleProxySettingSave = async () => {
    if (selectedRow) {
      await WindowBridge?.update(selectedRow.id!, {
        ...selectedRow,
        proxy_id: selectedProxy ? selectedProxy : null,
      });
      setProxySettingVisible(false);
      messageApi.success('Update proxy successfully');
      fetchWindowData();
    }
  };

  useEffect(() => {
    const handleResize = _.debounce(() => {
      setTableScrollY(window.innerHeight - OFFSET); // Note: Adjust SOME_OFFSET based on your design
    }, 200);

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const handleGroupChange = (value: number) => {
    setGroup(value);
  };

  const handleSearchValueChange = (value: string) => {
    setSearchValue(value.trim());
  };

  const filterProxyOption = (input: string, option?: DB.Proxy) => {
    return (
      (option?.ip ?? '').toLowerCase().includes(input.toLowerCase()) ||
      (option?.proxy ?? '').toLowerCase().includes(input.toLowerCase()) ||
      (option?.remark ?? '').toLowerCase().includes(input.toLowerCase())
    );
  };

  return (
    <>
      <div className="content-toolbar">
        {contextHolder}
        <Space size={16}>
          <Select
            value={group}
            defaultValue={-1}
            defaultActiveFirstOption={true}
            style={{width: 120}}
            fieldNames={{value: 'id', label: 'name'}}
            onChange={handleGroupChange}
            options={groupOptions}
          />
          <Input
            value={searchValue}
            className="content-toolbar-search"
            placeholder="Search"
            onChange={e => handleSearchValueChange(e.target.value)}
            prefix={<SearchOutlined />}
          />
          <Button
            type="default"
            onClick={async () => {
              await fetchWindowData();
              messageApi.success('Refreshed successfully');
            }}
            icon={<SyncOutlined />}
          >
            {t('refresh')}
          </Button>
          {cloudSyncProgress.enabled && (
            <Button
              type="default"
              loading={releasingCloudLocks}
              onClick={releaseCloudLocks}
            >
              清理云锁
            </Button>
          )}
          {shouldShowCloudSyncProgress(cloudSyncProgress) && (
            <Progress
              percent={getCloudSyncProgressPercent(cloudSyncProgress)}
              status={cloudSyncProgress.syncing ? 'active' : 'normal'}
              size="small"
              style={{width: 200, marginLeft: 8}}
              format={() =>
                cloudSyncProgress.pendingOutbox > 0
                  ? `待同步 ${cloudSyncProgress.pendingOutbox}`
                  : '同步中'
              }
            />
          )}
        </Space>
        <Space
          size={8}
          className="content-toolbar-btns"
        >
          <Button
            icon={<ChromeOutlined />}
            onClick={() => openWindows()}
            type="primary"
          >
            {t('window_open')}
          </Button>
          <Button
            type="default"
            onClick={() => closeWindows()}
            icon={<CloseOutlined />}
          >
            {t('window_close')}
          </Button>
          <Dropdown
            menu={{
              items: moreActionDropdownItems,
              onClick: menuInfo => moreAction(menuInfo),
            }}
          >
            <Button
              type="default"
              className="rotate-90 font-black"
              icon={<MoreOutlined />}
            ></Button>
          </Dropdown>
        </Space>
      </div>
      {cloudSyncProgress.enabled && (
        <div className="cloud-diagnostics-bar">
          <Space
            size={16}
            wrap
          >
            <Text strong>云同步状态</Text>
            <Badge
              status={cloudSyncProgress.pendingOutbox > 0 ? 'processing' : 'default'}
              text={getCloudSyncQueueLabel(cloudSyncProgress)}
            />
            <Button onClick={openCloudSyncOutbox}>查看同步</Button>
            <Badge
              status={cloudDiagnostics.failedOutbox > 0 ? 'error' : 'default'}
              text={`失败队列 ${cloudDiagnostics.failedOutbox}`}
            />
            <Badge
              status="warning"
              text={`离线/待处理 ${cloudDiagnostics.profiles.filter(item => item.offline_dirty || item.conflict_status).length}`}
            />
            {cloudDiagnostics.v2Conflicts.length > 0 && (
              <Button
                danger
                type="text"
                onClick={() => setConflictDrawerOpen(true)}
              >
                查看 {cloudDiagnostics.v2Conflicts.length} 条冲突
              </Button>
            )}
          </Space>
        </div>
      )}
      <Card
        className="content-card"
        bordered={false}
      >
        <Table
          className="content-table content-table-paginated"
          columns={columns}
          rowKey={'id'}
          loading={loading}
          rowSelection={rowSelection}
          dataSource={windowData}
          onChange={(_pagination, _filters, sorter) => {
            const activeSorter = Array.isArray(sorter) ? sorter[0] : sorter;
            setWindowNameSortOrder(
              activeSorter.columnKey === 'name' ? (activeSorter.order ?? null) : null,
            );
          }}
          scroll={{x: 1500, y: tableScrollY}}
          pagination={{
            pageSize: pageSize,
            pageSizeOptions: [20, 50, 100],
            showSizeChanger: true,
            onChange: (page, pageSize) => {
              setPageSize(pageSize);
            },
          }}
        />
      </Card>
      <Drawer
        title={`同步队列（${cloudSyncOutbox.length}）`}
        open={outboxDrawerOpen}
        onClose={() => setOutboxDrawerOpen(false)}
        width={860}
        extra={
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={loadingCloudSyncOutbox}
            onClick={() => void fetchCloudSyncOutbox()}
          >
            刷新
          </Button>
        }
        destroyOnClose
      >
        <Table<CloudSyncV2OutboxItem>
          size="small"
          rowKey="id"
          loading={loadingCloudSyncOutbox}
          dataSource={cloudSyncOutbox}
          virtual
          pagination={false}
          scroll={{x: 760, y: 480}}
          columns={[
            {
              title: '对象',
              key: 'entity',
              width: 210,
              render: (_, item) => (
                <>
                  <Text strong>
                    {OUTBOX_ENTITY_LABELS[item.entity_type]}
                    {item.entity_name ? `：${item.entity_name}` : ''}
                  </Text>
                  <br />
                  <Text type="secondary">#{item.id}</Text>
                </>
              ),
            },
            {
              title: '操作',
              dataIndex: 'operation',
              width: 90,
              render: value => OUTBOX_OPERATION_LABELS[value as CloudSyncV2OutboxItem['operation']],
            },
            {
              title: '状态',
              dataIndex: 'state',
              width: 110,
              render: value => {
                const state = OUTBOX_STATE_LABELS[value as CloudSyncV2OutboxItem['state']];
                return <Tag color={state.color}>{state.label}</Tag>;
              },
            },
            {title: '重试', dataIndex: 'attempt_count', width: 70, render: value => `${value} 次`},
            {
              title: '下次重试',
              dataIndex: 'retry_at',
              width: 170,
              render: value => formatUtcTimestamp(value),
            },
            {
              title: '最近错误',
              dataIndex: 'last_error',
              width: 270,
              ellipsis: true,
              render: value =>
                value ? (
                  <Tooltip title={value}>
                    <Text type="danger">{value}</Text>
                  </Tooltip>
                ) : (
                  '-'
                ),
            },
            {
              title: '操作',
              key: 'actions',
              width: 108,
              fixed: 'right',
              render: (_, item) =>
                item.state === 'retry_wait' ? (
                  <Button
                    type="link"
                    size="small"
                    loading={retryingCloudSyncOutboxId === item.id}
                    onClick={() => void retryCloudSyncOutboxNow(item)}
                  >
                    立即重试
                  </Button>
                ) : (
                  '-'
                ),
            },
          ]}
        />
      </Drawer>
      <Drawer
        title={`同步冲突（${cloudDiagnostics.v2Conflicts.length}）`}
        open={conflictDrawerOpen}
        onClose={() => setConflictDrawerOpen(false)}
        width={760}
        destroyOnClose
      >
        <Text type="secondary">
          每条冲突均显示当前本地值与云端值。对于旧团队对象不存在的情况，“在当前团队创建”会生成新的云端身份，不会修改旧团队数据。
        </Text>
        <List
          className="cloud-conflict-list"
          dataSource={cloudDiagnostics.v2Conflicts}
          split
          renderItem={conflict => (
            <List.Item>
              <div className="cloud-conflict-item">
                <Space
                  size={[8, 8]}
                  wrap
                >
                  <Text strong>
                    {conflict.entity_type === 'window' ? '窗口' : conflict.entity_type}：
                    {conflict.entity_name ||
                      `未命名（本地记录 ${conflict.local_id ?? '已不存在'}）`}
                  </Text>
                  <Tag color="orange">{getConflictReason(conflict.status)}</Tag>
                  <Text type="secondary">云端 ID：{conflict.cloud_id.slice(0, 8)}</Text>
                </Space>
                <Descriptions
                  size="small"
                  bordered
                  column={1}
                  style={{marginTop: 10}}
                >
                  {conflict.field_values.map(value => (
                    <Descriptions.Item
                      key={value.field}
                      label={CONFLICT_FIELD_LABELS[value.field] || value.field}
                    >
                      <div>本地：{value.local_value}</div>
                      <div>云端：{value.cloud_value}</div>
                    </Descriptions.Item>
                  ))}
                  {conflict.field_values.length === 0 && (
                    <Descriptions.Item label="冲突内容">
                      云端未返回具体字段，请根据上方原因选择保留版本。
                    </Descriptions.Item>
                  )}
                </Descriptions>
                <Space style={{marginTop: 12}}>
                  <Button
                    size="small"
                    loading={resolvingCloudConflictId === conflict.id}
                    disabled={resolvingCloudConflictId !== undefined}
                    onClick={() => resolveCloudConflict(conflict.id, 'keep_cloud')}
                  >
                    {conflict.status === 'tombstone_conflict' ? '确认远端删除' : '保留云端'}
                  </Button>
                  {conflict.status !== 'tombstone_conflict' && (
                    <Button
                      size="small"
                      type="primary"
                      loading={resolvingCloudConflictId === conflict.id}
                      disabled={resolvingCloudConflictId !== undefined}
                      onClick={() => resolveCloudConflict(conflict.id, 'keep_local')}
                    >
                      {conflict.can_recreate_current_workspace ? '在当前团队创建' : '保留本地'}
                    </Button>
                  )}
                </Space>
              </div>
            </List.Item>
          )}
        />
      </Drawer>
      <Modal
        title={
          <>
            <ExclamationCircleFilled
              style={{color: '#faad14', fontSize: '22px', marginRight: '12px'}}
            ></ExclamationCircleFilled>
            <span>Delete Windows</span>
          </>
        }
        open={deleteModalVisible}
        centered
        onOk={onDeleteModalOk}
        onCancel={onDeleteModalCancel}
        closable={false}
        okText="Confirm"
        cancelText="Cancel"
      >
        <div className="pl-[36px]">
          <div>
            The current operation will keep the local cache, if you want to delete the local cache,
            please go to the cache directory to delete manually.
          </div>
        </div>
      </Modal>
      <Modal
        title={
          <>
            <ExclamationCircleFilled
              style={{color: '#faad14', fontSize: '22px', marginRight: '12px'}}
            ></ExclamationCircleFilled>
            <span>{t('window_clear_cache_title')}</span>
          </>
        }
        open={clearCacheModalVisible}
        centered
        onOk={onClearCacheModalOk}
        onCancel={onClearCacheModalCancel}
        closable={false}
        confirmLoading={loading}
        okText={t('footer_ok')}
        cancelText={t('footer_cancel')}
      >
        <div className="pl-[36px]">
          <div>{t('window_clear_cache_confirm')}</div>
        </div>
      </Modal>
      <Modal
        open={proxySettingVisible}
        centered
        title="Proxy Setting"
        onOk={handleProxySettingSave}
        onCancel={setProxySettingVisible.bind(null, false)}
        footer={[
          <Button
            key="back"
            onClick={setProxySettingVisible.bind(null, false)}
          >
            Cancel
          </Button>,
          <Button
            key="submit"
            type="primary"
            loading={loading}
            onClick={handleProxySettingSave}
          >
            Save
          </Button>,
        ]}
      >
        <Select
          placeholder="Proxy"
          options={proxies}
          size="large"
          className="w-full"
          value={selectedProxy}
          showSearch
          allowClear
          onChange={(value: number) => {
            setSelectedProxy(value);
          }}
          filterOption={filterProxyOption}
          fieldNames={{label: 'proxy', value: 'id'}}
          optionRender={option => {
            return (
              <Row justify="space-between">
                <Col span={2}>
                  <Text code>#{option.data.id}</Text>
                </Col>

                <Col span={16}>
                  <Space direction="vertical">
                    <Text
                      style={{width: 300}}
                      ellipsis={{tooltip: `${option.data.proxy}  ${option.data.remark}`}}
                    >
                      {option.data.proxy}
                    </Text>
                    {option.data.remark && (
                      <Text
                        mark
                        style={{width: 300}}
                        ellipsis={{tooltip: `${option.data.proxy}  ${option.data.remark}`}}
                      >
                        {option.data.remark}
                      </Text>
                    )}
                  </Space>
                </Col>
                <Col span={1}>
                  <span
                    role="img"
                    aria-label={option.data.proxy}
                  >
                    {option.data.usageCount}
                  </span>
                </Col>
              </Row>
            );
          }}
        ></Select>
      </Modal>
    </>
  );
};
export default Windows;
