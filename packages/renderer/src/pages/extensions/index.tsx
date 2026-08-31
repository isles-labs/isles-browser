import type {MenuProps} from 'antd';
import {
  Avatar,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type {ColumnsType} from 'antd/es/table';
import {
  AppstoreAddOutlined,
  CheckOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  MoreOutlined,
  SearchOutlined,
  SettingOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import _ from 'lodash';
import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import VirtualList from 'rc-virtual-list';
import {CommonBridge, ExtensionBridge, GroupBridge, WindowBridge} from '#preload';
import type {DB} from '../../../../shared/types/db';

const {Paragraph, Text} = Typography;

type InstallFormValues = {
  source_type: 'chrome_web_store' | 'custom';
  source_url?: string;
  directory_path?: string;
};

const PAGE_OFFSET = 266;
const WINDOW_LIST_ITEM_HEIGHT = 78;
const SELECTED_WINDOW_ROW_HEIGHT = 42;
const SELECTED_WINDOW_COLUMNS = 3;

const normalizeExtension = (extension: DB.Extension) => ({
  ...extension,
  distribution_mode: extension.distribution_mode === 'manual' ? 'manual' : 'global',
  auto_update:
    typeof extension.auto_update === 'boolean'
      ? extension.auto_update
      : extension.auto_update !== 0,
});

const matchWindowKeyword = (windowItem: DB.Window, keyword: string) => {
  if (!keyword) {
    return true;
  }

  const normalizedKeyword = keyword.toLowerCase();
  return [windowItem.id, windowItem.name, windowItem.group_name, windowItem.profile_id]
    .filter(Boolean)
    .some(value => value!.toString().toLowerCase().includes(normalizedKeyword));
};

const Extensions = () => {
  const {i18n, t} = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const labels = useMemo(
    () => ({
      upload: isZh ? '上传扩展' : 'Upload Extension',
      refresh: isZh ? '刷新' : 'Refresh',
      extensionColumn: isZh ? '扩展' : 'Extension',
      sourceColumn: isZh ? '来源' : 'Source',
      distributionColumn: isZh ? '分配方式' : 'Distribution',
      actionColumn: isZh ? '操作' : 'Action',
      chromeWebStore: isZh ? '谷歌应用商店' : 'Chrome Web Store',
      customExtension: isZh ? '自建扩展' : 'Custom Extension',
      extensionUrl: isZh ? '扩展 URL' : 'Extension URL',
      extensionDirectory: isZh ? '扩展目录' : 'Extension Directory',
      extensionUrlPlaceholder: isZh
        ? '请输入 Chrome 应用商店中的扩展详情 URL'
        : 'Enter the Chrome Web Store extension URL',
      extensionDirectoryPlaceholder: isZh
        ? '请选择已解压的扩展目录'
        : 'Choose an unpacked extension directory',
      chooseDirectory: isZh ? '选择目录' : 'Choose Directory',
      sourceRequired: isZh ? '请输入扩展地址' : 'Please enter the extension URL',
      directoryRequired: isZh ? '请选择扩展目录' : 'Please choose the extension directory',
      installSuccess: isZh ? '扩展添加成功' : 'Extension added successfully',
      installFailed: isZh ? '扩展添加失败' : 'Failed to add extension',
      distributionGlobal: isZh ? '全局使用' : 'Global',
      distributionManual: isZh ? '手动分配' : 'Manual',
      globalHint: isZh ? '默认加载到所有浏览器窗口' : 'Loads in all browser windows',
      manualHint: isZh ? '仅加载到已分配的浏览器窗口' : 'Loads only in assigned windows',
      configure: isZh ? '配置' : 'Configure',
      autoUpdate: isZh ? '自动更新' : 'Auto Update',
      enabled: isZh ? '已开启' : 'Enabled',
      disabled: isZh ? '已关闭' : 'Disabled',
      version: isZh ? '版本' : 'Version',
      closeGlobal: isZh ? '关闭全局使用' : 'Disable Global',
      openGlobal: isZh ? '开启全局使用' : 'Enable Global',
      closeAutoUpdate: isZh ? '关闭自动更新' : 'Disable Auto Update',
      openAutoUpdate: isZh ? '开启自动更新' : 'Enable Auto Update',
      manualUpdate: isZh ? '更新扩展' : 'Update Extension',
      remove: isZh ? '删除' : 'Delete',
      deleteTitle: isZh ? '删除扩展' : 'Delete Extension',
      deleteContent: isZh
        ? '删除后将移除扩展文件以及所有窗口分配关系，是否继续？'
        : 'Deleting will remove the extension files and all window assignments. Continue?',
      deleteSuccess: isZh ? '扩展已删除' : 'Extension deleted',
      deleteFailed: isZh ? '扩展删除失败' : 'Failed to delete extension',
      updateSuccess: isZh ? '设置已更新' : 'Settings updated',
      updateFailed: isZh ? '设置更新失败' : 'Failed to update settings',
      assignTitle: isZh ? '分配环境' : 'Assign Windows',
      assignSubtitle: isZh
        ? '请选择需要添加该扩展的浏览器窗口'
        : 'Choose windows for this extension',
      allGroups: isZh ? '全部分组' : 'All Groups',
      searchWindow: isZh ? '搜索浏览器窗口' : 'Search windows',
      searchSelectedWindow: isZh ? '搜索已选窗口' : 'Search selected windows',
      selectAllCurrent: isZh ? '全选当前筛选结果' : 'Select filtered',
      selectedWindows: isZh ? '已选环境' : 'Selected',
      clearSelected: isZh ? '清空已选' : 'Clear',
      assignSuccess: isZh ? '分配已保存' : 'Assignments saved',
      assignFailed: isZh ? '分配保存失败' : 'Failed to save assignments',
      manualUpdateSuccess: isZh
        ? '扩展已更新，重新打开环境后生效'
        : 'Extension updated. Reopen windows to apply it.',
      manualUpdateFailed: isZh ? '扩展更新失败' : 'Failed to update extension',
      empty: isZh ? '暂无扩展' : 'No extensions',
      noMatchedWindows: isZh ? '没有匹配的浏览器窗口' : 'No matching windows',
      noSelectedWindows: isZh ? '当前没有已分配窗口' : 'No selected windows',
      unnamedWindow: isZh ? '未命名窗口' : 'Untitled Window',
    }),
    [isZh],
  );

  const [messageApi, contextHolder] = message.useMessage({
    duration: 2,
    top: 120,
    getContainer: () => document.body,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [extensions, setExtensions] = useState<DB.Extension[]>([]);
  const [windows, setWindows] = useState<DB.Window[]>([]);
  const [groupOptions, setGroupOptions] = useState<DB.Group[]>([]);
  const [tableScrollY, setTableScrollY] = useState(window.innerHeight - PAGE_OFFSET);
  const [pageSize, setPageSize] = useState(10);
  const [uploadVisible, setUploadVisible] = useState(false);
  const [assignVisible, setAssignVisible] = useState(false);
  const [selectedExtension, setSelectedExtension] = useState<DB.Extension>();
  const [selectedWindowIds, setSelectedWindowIds] = useState<number[]>([]);
  const [groupFilter, setGroupFilter] = useState(-1);
  const [windowSearch, setWindowSearch] = useState('');
  const [selectedSearch, setSelectedSearch] = useState('');
  const [installForm] = Form.useForm<InstallFormValues>();

  const installSourceType = Form.useWatch('source_type', installForm) ?? 'chrome_web_store';

  const fetchExtensions = async () => {
    setLoading(true);
    try {
      const data = await ExtensionBridge.getAll();
      setExtensions((data ?? []).map((item: DB.Extension) => normalizeExtension(item)));
    } catch {
      messageApi.error(labels.installFailed);
    } finally {
      setLoading(false);
    }
  };

  const fetchWindows = async () => {
    const data = await WindowBridge.getAll();
    const sortedWindows = [...(data ?? [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    setWindows(sortedWindows);
  };

  const fetchGroups = async () => {
    const data = await GroupBridge.getAll();
    setGroupOptions([{id: -1, name: labels.allGroups}, ...(data ?? [])]);
  };

  useEffect(() => {
    void fetchExtensions();
    void fetchWindows();
    void fetchGroups();
  }, [labels.allGroups]);

  useEffect(() => {
    const handleResize = _.debounce(() => {
      setTableScrollY(window.innerHeight - PAGE_OFFSET);
    }, 200);

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const filteredWindows = useMemo(() => {
    return windows.filter(windowItem => {
      const matchesGroup = groupFilter < 0 || windowItem.group_id === groupFilter;
      return matchesGroup && matchWindowKeyword(windowItem, windowSearch);
    });
  }, [windows, groupFilter, windowSearch]);

  const selectedWindowIdSet = useMemo(() => new Set(selectedWindowIds), [selectedWindowIds]);

  const selectedWindows = useMemo(() => {
    return windows.filter(windowItem => windowItem.id && selectedWindowIdSet.has(windowItem.id));
  }, [windows, selectedWindowIdSet]);

  const filteredSelectedWindows = useMemo(() => {
    return selectedWindows.filter(windowItem => matchWindowKeyword(windowItem, selectedSearch));
  }, [selectedWindows, selectedSearch]);

  const filteredSelectedWindowRows = useMemo(() => {
    const rows: DB.Window[][] = [];
    for (let index = 0; index < filteredSelectedWindows.length; index += SELECTED_WINDOW_COLUMNS) {
      rows.push(filteredSelectedWindows.slice(index, index + SELECTED_WINDOW_COLUMNS));
    }
    return rows;
  }, [filteredSelectedWindows]);

  const allFilteredSelected =
    filteredWindows.length > 0 &&
    filteredWindows.every(windowItem => selectedWindowIdSet.has(windowItem.id!));
  const indeterminate =
    filteredWindows.some(windowItem => selectedWindowIdSet.has(windowItem.id!)) &&
    !allFilteredSelected;

  const openInstallModal = () => {
    installForm.resetFields();
    installForm.setFieldsValue({
      source_type: 'chrome_web_store',
      source_url: '',
      directory_path: '',
    });
    setUploadVisible(true);
  };

  const handleChooseDirectory = async () => {
    const directoryPath = await CommonBridge.choosePath('openDirectory');
    if (directoryPath) {
      installForm.setFieldValue('directory_path', directoryPath);
    }
  };

  const handleInstall = async () => {
    try {
      const values = await installForm.validateFields();
      setSaving(true);
      const result =
        values.source_type === 'custom'
          ? await ExtensionBridge.installFromDirectory(values.directory_path!)
          : await ExtensionBridge.installFromWebStore(values.source_url!);

      if (!result?.success) {
        messageApi.error(result?.error || labels.installFailed);
        return;
      }

      messageApi.success(labels.installSuccess);
      setUploadVisible(false);
      await fetchExtensions();
    } catch (error) {
      if (error instanceof Error && error.message) {
        messageApi.error(error.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const openAssignModal = async (extension: DB.Extension) => {
    try {
      const result = await ExtensionBridge.getExtensionWindows(extension.id!);
      setSelectedExtension(extension);
      setSelectedWindowIds(
        (result ?? [])
          .filter((item: DB.WindowExtension) => item.enabled !== false && item.enabled !== 0)
          .map((item: DB.WindowExtension) => item.window_id)
          .filter(Boolean) as number[],
      );
      setGroupFilter(-1);
      setWindowSearch('');
      setSelectedSearch('');
      setAssignVisible(true);
    } catch {
      messageApi.error(labels.assignFailed);
    }
  };

  const handleSaveAssignments = async () => {
    if (!selectedExtension?.id) {
      return;
    }

    try {
      setSaving(true);
      const result = await ExtensionBridge.syncWindowExtensions(
        selectedExtension.id,
        selectedWindowIds,
      );
      if (!result?.success) {
        messageApi.error(result?.message || labels.assignFailed);
        return;
      }

      messageApi.success(labels.assignSuccess);
      setAssignVisible(false);
    } catch {
      messageApi.error(labels.assignFailed);
    } finally {
      setSaving(false);
    }
  };

  const toggleWindowSelection = (windowId: number) => {
    setSelectedWindowIds(currentIds => {
      const currentIdSet = new Set(currentIds);
      if (currentIdSet.has(windowId)) {
        currentIdSet.delete(windowId);
      } else {
        currentIdSet.add(windowId);
      }

      return Array.from(currentIdSet);
    });
  };

  const toggleFilteredWindows = (checked: boolean) => {
    const filteredIds = filteredWindows.map(windowItem => windowItem.id!).filter(Boolean);
    setSelectedWindowIds(currentIds => {
      const currentIdSet = new Set(currentIds);
      if (checked) {
        filteredIds.forEach(id => currentIdSet.add(id));
        return Array.from(currentIdSet);
      }

      filteredIds.forEach(id => currentIdSet.delete(id));
      return Array.from(currentIdSet);
    });
  };

  const handleUpdateExtension = async (extensionId: number, payload: Partial<DB.Extension>) => {
    try {
      setSaving(true);
      await ExtensionBridge.updateExtension(extensionId, payload);
      messageApi.success(labels.updateSuccess);
      await fetchExtensions();
    } catch {
      messageApi.error(labels.updateFailed);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteExtension = async (extension: DB.Extension) => {
    Modal.confirm({
      title: labels.deleteTitle,
      content: labels.deleteContent,
      okText: t('footer_ok'),
      cancelText: t('footer_cancel'),
      okButtonProps: {danger: true},
      onOk: async () => {
        try {
          const result = await ExtensionBridge.deleteExtension(extension.id!);
          if (!result?.success) {
            messageApi.error(result?.message || labels.deleteFailed);
            return;
          }

          messageApi.success(labels.deleteSuccess);
          await fetchExtensions();
        } catch {
          messageApi.error(labels.deleteFailed);
        }
      },
    });
  };

  const handleManualUpdateExtension = async (extension: DB.Extension) => {
    try {
      setSaving(true);
      const result = await ExtensionBridge.manualUpdate(extension.id!);
      if (!result?.success) {
        messageApi.error(result?.error || labels.manualUpdateFailed);
        return;
      }

      messageApi.success(labels.manualUpdateSuccess);
      await fetchExtensions();
    } catch (error) {
      messageApi.error(
        error instanceof Error && error.message ? error.message : labels.manualUpdateFailed,
      );
    } finally {
      setSaving(false);
    }
  };

  const buildMoreActionItems = (extension: DB.Extension): MenuProps['items'] => {
    const isGlobal = extension.distribution_mode !== 'manual';
    const autoUpdateEnabled =
      typeof extension.auto_update === 'boolean'
        ? extension.auto_update
        : extension.auto_update !== 0;

    return [
      {
        key: 'toggle-global',
        icon: <GlobalOutlined />,
        label: isGlobal ? labels.closeGlobal : labels.openGlobal,
      },
      {
        key: 'toggle-auto-update',
        icon: <SyncOutlined />,
        label: autoUpdateEnabled ? labels.closeAutoUpdate : labels.openAutoUpdate,
      },
      {
        key: 'manual-update',
        icon: <SyncOutlined />,
        label: labels.manualUpdate,
      },
      {
        type: 'divider',
      },
      {
        key: 'delete',
        danger: true,
        icon: <DeleteOutlined />,
        label: labels.remove,
      },
    ];
  };

  const handleMoreAction = async (key: string, extension: DB.Extension) => {
    switch (key) {
      case 'toggle-global':
        await handleUpdateExtension(extension.id!, {
          distribution_mode: extension.distribution_mode === 'manual' ? 'global' : 'manual',
        });
        break;
      case 'toggle-auto-update':
        await handleUpdateExtension(extension.id!, {
          auto_update:
            typeof extension.auto_update === 'boolean'
              ? !extension.auto_update
              : extension.auto_update === 0,
        });
        break;
      case 'manual-update':
        await handleManualUpdateExtension(extension);
        break;
      case 'delete':
        await handleDeleteExtension(extension);
        break;
      default:
        break;
    }
  };

  const columns: ColumnsType<DB.Extension> = [
    {
      title: labels.extensionColumn,
      dataIndex: 'name',
      key: 'name',
      render: (_, extension) => (
        <Space
          size={12}
          align="center"
        >
          <Avatar
            src={extension.icon}
            shape="square"
            size={46}
            icon={<AppstoreAddOutlined />}
            className="shrink-0"
          />
          <div className="min-w-0">
            <Text
              strong
              className="block"
            >
              {extension.name}
            </Text>
            <Paragraph
              className="mb-0 mt-1"
              type="secondary"
              ellipsis={{
                rows: 2,
                tooltip: extension.description || extension.source_url || extension.path,
              }}
            >
              {extension.description || extension.source_url || extension.path}
            </Paragraph>
          </div>
        </Space>
      ),
    },
    {
      title: labels.sourceColumn,
      key: 'source',
      width: 220,
      render: (_, extension) => {
        const autoUpdateEnabled =
          typeof extension.auto_update === 'boolean'
            ? extension.auto_update
            : extension.auto_update !== 0;

        return (
          <Space
            direction="vertical"
            size={4}
          >
            <Tag color={extension.source_type === 'chrome_web_store' ? 'blue' : 'gold'}>
              {extension.source_type === 'chrome_web_store'
                ? labels.chromeWebStore
                : labels.customExtension}
            </Tag>
            <Text type="secondary">
              {labels.autoUpdate}: {autoUpdateEnabled ? labels.enabled : labels.disabled}
            </Text>
            <Text type="secondary">
              {labels.version}: {extension.version || '-'}
            </Text>
          </Space>
        );
      },
    },
    {
      title: labels.distributionColumn,
      key: 'distribution',
      width: 220,
      render: (_, extension) => {
        const isGlobal = extension.distribution_mode !== 'manual';
        return (
          <Space
            direction="vertical"
            size={4}
          >
            <Text strong>{isGlobal ? labels.distributionGlobal : labels.distributionManual}</Text>
            <Text type="secondary">{isGlobal ? labels.globalHint : labels.manualHint}</Text>
          </Space>
        );
      },
    },
    {
      title: labels.actionColumn,
      key: 'action',
      width: 160,
      align: 'center',
      render: (_, extension) => {
        const isGlobal = extension.distribution_mode !== 'manual';

        return (
          <Space size={8}>
            {!isGlobal && (
              <Button
                size="small"
                type="default"
                onClick={() => openAssignModal(extension)}
                icon={<SettingOutlined />}
              >
                {labels.configure}
              </Button>
            )}
            <Dropdown
              trigger={['click']}
              menu={{
                items: buildMoreActionItems(extension),
                onClick: ({key}) => handleMoreAction(key, extension),
              }}
            >
              <Button
                type="text"
                icon={<MoreOutlined />}
              />
            </Dropdown>
          </Space>
        );
      },
    },
  ];

  const renderWindowItem = (windowItem: DB.Window, selected: boolean) => {
    return (
      <button
        type="button"
        className={`extensions-window-option w-full rounded-lg border px-3 py-3 text-left transition-colors ${
          selected ? 'selected' : ''
        }`}
        onClick={() => toggleWindowSelection(windowItem.id!)}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Text
              strong
              className="block"
            >
              {windowItem.name || labels.unnamedWindow}
            </Text>
            <Text type="secondary">
              #{windowItem.id}
              {windowItem.group_name ? ` · ${windowItem.group_name}` : ''}
            </Text>
          </div>
          {selected && <CheckOutlined className="text-blue-500" />}
        </div>
      </button>
    );
  };

  return (
    <>
      {contextHolder}
      <div className="content-toolbar">
        <Space size={12}>
          <Button
            type="primary"
            icon={<AppstoreAddOutlined />}
            onClick={openInstallModal}
          >
            {labels.upload}
          </Button>
          <Button
            icon={<SyncOutlined />}
            onClick={() => void fetchExtensions()}
          >
            {labels.refresh}
          </Button>
        </Space>
      </div>

      <Card
        className="content-card mt-4"
        bordered={false}
      >
        <Table
          className="content-table content-table-paginated extensions-table"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={extensions}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={labels.empty}
              />
            ),
          }}
          virtual
          scroll={{x: 960, y: tableScrollY}}
          pagination={{
            rootClassName: 'pagination-wrapper',
            pageSize,
            pageSizeOptions: [10, 20, 50],
            showSizeChanger: true,
            onChange: (_, size) => {
              setPageSize(size);
            },
          }}
        />
      </Card>

      <Modal
        title={labels.upload}
        open={uploadVisible}
        onCancel={() => setUploadVisible(false)}
        onOk={() => void handleInstall()}
        okText={t('footer_ok')}
        cancelText={t('footer_cancel')}
        confirmLoading={saving}
        width={620}
        destroyOnClose
      >
        <Form
          form={installForm}
          layout="vertical"
          initialValues={{source_type: 'chrome_web_store'}}
        >
          <Form.Item
            label={isZh ? '扩展来源' : 'Source'}
            name="source_type"
          >
            <Radio.Group>
              <Radio value="chrome_web_store">{labels.chromeWebStore}</Radio>
              <Radio value="custom">{labels.customExtension}</Radio>
            </Radio.Group>
          </Form.Item>

          {installSourceType === 'custom' ? (
            <Form.Item
              label={labels.extensionDirectory}
              name="directory_path"
              rules={[{required: true, message: labels.directoryRequired}]}
            >
              <Input
                readOnly
                placeholder={labels.extensionDirectoryPlaceholder}
                addonAfter={
                  <Button
                    type="link"
                    icon={<FolderOpenOutlined />}
                    onClick={() => void handleChooseDirectory()}
                  >
                    {labels.chooseDirectory}
                  </Button>
                }
              />
            </Form.Item>
          ) : (
            <Form.Item
              label={labels.extensionUrl}
              name="source_url"
              rules={[{required: true, message: labels.sourceRequired}]}
            >
              <Input placeholder={labels.extensionUrlPlaceholder} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title={
          <div>
            <div className="text-xl font-semibold">{labels.assignTitle}</div>
            <div className="mt-1 text-sm font-normal text-slate-500">{labels.assignSubtitle}</div>
          </div>
        }
        open={assignVisible}
        onCancel={() => setAssignVisible(false)}
        onOk={() => void handleSaveAssignments()}
        okText={t('footer_ok')}
        cancelText={t('footer_cancel')}
        confirmLoading={saving}
        width={920}
        destroyOnClose
        className="extensions-assign-modal"
        styles={{
          body: {
            height: 'min(560px, calc(100vh - 310px))',
            minHeight: 360,
            overflow: 'hidden',
          },
        }}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="mb-5 shrink-0">
            <Text type="secondary">
              {isZh ? '扩展名称' : 'Extension'}: {selectedExtension?.name}
            </Text>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-2 gap-5">
            <div className="extensions-assign-panel flex min-h-0 flex-col rounded-xl border border-slate-200 p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <Checkbox
                  indeterminate={indeterminate}
                  checked={allFilteredSelected}
                  onChange={event => toggleFilteredWindows(event.target.checked)}
                >
                  {labels.selectAllCurrent}
                </Checkbox>
                <Select
                  value={groupFilter}
                  className="w-[140px]"
                  options={groupOptions}
                  fieldNames={{label: 'name', value: 'id'}}
                  onChange={value => setGroupFilter(value)}
                />
              </div>

              <Input
                value={windowSearch}
                placeholder={labels.searchWindow}
                prefix={<SearchOutlined />}
                onChange={event => setWindowSearch(event.target.value.trim())}
              />

              <div className="mt-4 min-h-0 flex-1">
                {filteredWindows.length ? (
                  <VirtualList
                    data={filteredWindows}
                    height={360}
                    itemHeight={WINDOW_LIST_ITEM_HEIGHT}
                    itemKey="id"
                    className="h-full pr-1"
                  >
                    {windowItem => (
                      <div className="pb-2">
                        {renderWindowItem(windowItem, selectedWindowIdSet.has(windowItem.id!))}
                      </div>
                    )}
                  </VirtualList>
                ) : (
                  <Empty
                    className="pt-12"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={labels.noMatchedWindows}
                  />
                )}
              </div>
            </div>

            <div className="extensions-assign-panel flex min-h-0 flex-col rounded-xl border border-slate-200 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Text strong>
                  {labels.selectedWindows} ({selectedWindowIds.length})
                </Text>
                <Button
                  type="link"
                  onClick={() => setSelectedWindowIds([])}
                  disabled={!selectedWindowIds.length}
                >
                  {labels.clearSelected}
                </Button>
              </div>

              <Input
                value={selectedSearch}
                placeholder={labels.searchSelectedWindow}
                prefix={<SearchOutlined />}
                onChange={event => setSelectedSearch(event.target.value.trim())}
              />

              <div className="mt-4 min-h-0 flex-1">
                {filteredSelectedWindowRows.length ? (
                  <VirtualList
                    data={filteredSelectedWindowRows}
                    height={360}
                    itemHeight={SELECTED_WINDOW_ROW_HEIGHT}
                    itemKey={windowRow => windowRow[0]?.id ?? ''}
                    className="h-full pr-1"
                  >
                    {windowRow => (
                      <div className="grid grid-cols-3 gap-2 pb-2">
                        {windowRow.map(windowItem => (
                          <button
                            key={windowItem.id}
                            type="button"
                            title={`${windowItem.name || labels.unnamedWindow} #${windowItem.id}`}
                            className="extensions-selected-window flex min-w-0 items-center gap-1 rounded-md border px-2 py-1 text-left text-sm transition-colors"
                            onClick={() => toggleWindowSelection(windowItem.id!)}
                          >
                            <span className="truncate">
                              {windowItem.name || labels.unnamedWindow} #{windowItem.id}
                            </span>
                            <span
                              className="ml-auto text-base leading-none"
                              aria-hidden="true"
                            >
                              ×
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </VirtualList>
                ) : (
                  <Empty
                    className="pt-12"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={labels.noSelectedWindows}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default Extensions;
