import type {UploadProps} from 'antd';
import {Alert, Button, Descriptions, Form, List, Modal, Space, Spin, Tag, Upload, message} from 'antd';
import {UploadOutlined} from '@ant-design/icons';
import {CommonBridge, WindowBridge} from '#preload';
import {useNavigate} from 'react-router-dom';
import {MESSAGE_CONFIG} from '/@/constants';
import {useState} from 'react';
import type {OperationResult} from '../../../../../../shared/types/common';
import {useTranslation} from 'react-i18next';

type ImportConflict = {
  row: number;
  windowName: string;
  importedId?: string;
  reason: string;
  content: Record<string, string>;
};

type WindowImportResult = OperationResult & {
  createdWindowIds?: number[];
  updatedWindowIds?: number[];
  skippedRows?: number[];
  conflicts?: ImportConflict[];
};

const WindowImportForm = () => {
  const key = 'updatable';

  const [messageApi, contextHolder] = message.useMessage(MESSAGE_CONFIG);
  const [loading, setLoading] = useState(false);
  const [conflicts, setConflicts] = useState<ImportConflict[]>([]);

  const navigate = useNavigate();
  const {t} = useTranslation();

  const props: UploadProps = {
    name: 'import',
    customRequest: async ({file}) => {
      try {
        setLoading(true);
        messageApi.open({type: 'loading', content: 'Importing...', key: key});
        const result: WindowImportResult = await WindowBridge?.import((file as unknown as File).path);
        console.log(result);
        const importedIds = Array.isArray(result.data) ? result.data : [];
        const importConflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
        setConflicts(importConflicts);
        messageApi
          .open({
            type: importedIds.length > 0 ? 'success' : 'error',
            content: `${
              result.message +
              (importConflicts.length > 0 ? `，${importConflicts.length} 条需要查看冲突明细` : '') +
              (importedIds.length > 0 && importConflicts.length === 0
                ? `, will be automatically jumped after ${MESSAGE_CONFIG.duration}s`
                : '')
            }`,
            key: key,
          })
          .then(() => {
            setLoading(false);
            if (importedIds.length > 0 && importConflicts.length === 0) {
              navigate('/');
            }
          });
      } catch (error) {
        console.error(error);
        setLoading(false);
        messageApi.error('导入失败，请检查文件格式后重试。');
      }
    },
    showUploadList: false,
  };

  const downLoadTempalte = async () => {
    try {
      const filePath = 'renderer/assets/template.xlsx';
      const rs = await CommonBridge.download(filePath);
      if (rs) {
        messageApi.success('Template downloaded successfully');
      }
    } catch (error) {
      console.error(error);
      messageApi.error('Failed to download template');
    }
  };

  return (
    <>
      {contextHolder}
      <Spin spinning={loading}>
        <Form
          layout="horizontal"
          size="large"
          labelCol={{span: 5}}
        >
          <Form.Item label={t('window_import_from_template')} extra="导出的窗口 Excel 保留 ID 时会更新原窗口；没有 ID 的模板行会新建窗口。">
            <Space>
              <Upload {...props}>
                <Button icon={<UploadOutlined />}>{t('window_import_from_template_tip')}</Button>
              </Upload>
              <Button
                type="link"
                onClick={() => downLoadTempalte()}
              >
                {t('window_import_from_template_download')}
              </Button>
            </Space>
          </Form.Item>
          <Form.Item label={t('window_import_from_ads')}>
            <Upload {...props}>
              <Button icon={<UploadOutlined />}>{t('window_import_from_ads_tip')}</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Spin>
      <Modal
        title={`导入冲突明细（${conflicts.length}）`}
        open={conflicts.length > 0}
        footer={<Button onClick={() => setConflicts([])}>关闭</Button>}
        onCancel={() => setConflicts([])}
        width={760}
      >
        <Alert
          showIcon
          type="warning"
          message="这些行未被导入或更新"
          description="系统不会为带有其他设备 ID 的窗口自动新建 profile，以避免误覆盖已有窗口数据。"
          style={{marginBottom: 16}}
        />
        <List
          dataSource={conflicts}
          itemLayout="vertical"
          renderItem={conflict => (
            <List.Item>
              <Space size={[8, 8]} wrap>
                <Tag color="orange">Excel 第 {conflict.row} 行</Tag>
                <strong>{conflict.windowName}</strong>
                {conflict.importedId && <Tag>导入 ID: {conflict.importedId}</Tag>}
              </Space>
              <div style={{marginTop: 8}}>{conflict.reason}</div>
              <Descriptions
                size="small"
                column={2}
                bordered
                style={{marginTop: 12}}
              >
                {Object.entries(conflict.content).map(([label, value]) => (
                  <Descriptions.Item key={label} label={label}>
                    {value}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </List.Item>
          )}
        />
      </Modal>
    </>
  );
};

export default WindowImportForm;
