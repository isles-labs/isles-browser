import {Button, Modal, Progress, Typography} from 'antd';
import {useEffect, useState} from 'react';
import {UpdateBridge} from '#preload';
import type {AppUpdateStatus} from '../../../../shared/types/update';

const {Paragraph, Text} = Typography;

const INITIAL_STATUS: AppUpdateStatus = {
  phase: 'idle',
  currentVersion: '',
};

const formatBytes = (bytes?: number) => {
  if (!bytes) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const formatReleaseNotes = (releaseNotes?: string) => {
  if (!releaseNotes) return '';

  const document = new DOMParser().parseFromString(releaseNotes, 'text/html');
  return (document.body.innerText || document.body.textContent || '').trim();
};

export default function AppUpdate() {
  const [status, setStatus] = useState<AppUpdateStatus>(INITIAL_STATUS);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handleStatus = (_: Electron.IpcRendererEvent, nextStatus: AppUpdateStatus) => {
      setStatus(nextStatus);
      if (nextStatus.phase === 'available') setDismissed(false);
    };

    void UpdateBridge.getStatus()
      .then(setStatus)
      .catch(() => undefined);
    UpdateBridge.onStatus(handleStatus);
    return () => {
      UpdateBridge.offStatus(handleStatus);
    };
  }, []);

  const visible = !dismissed && ['available', 'downloading', 'downloaded'].includes(status.phase);
  const downloading = status.phase === 'downloading';
  const downloaded = status.phase === 'downloaded';
  const releaseNotes = formatReleaseNotes(status.releaseNotes);

  return (
    <Modal
      title={downloaded ? '更新已准备就绪' : `发现新版本 ${status.version || ''}`}
      open={visible}
      closable={!downloading}
      maskClosable={!downloading}
      cancelText={downloaded ? '稍后重启' : '稍后提醒'}
      okText={downloaded ? '重启并更新' : downloading ? '正在下载' : '下载更新'}
      okButtonProps={{loading: downloading}}
      cancelButtonProps={{disabled: downloading}}
      onCancel={() => setDismissed(true)}
      onOk={() => {
        if (downloaded) {
          void UpdateBridge.install();
          return;
        }
        void UpdateBridge.download();
      }}
    >
      {status.releaseDate && (
        <Text type="secondary">发布日期：{new Date(status.releaseDate).toLocaleDateString()}</Text>
      )}
      {releaseNotes ? (
        <Paragraph style={{whiteSpace: 'pre-wrap', marginTop: 12}}>{releaseNotes}</Paragraph>
      ) : (
        <Paragraph style={{marginTop: 12}}>此版本包含功能改进和问题修复。</Paragraph>
      )}
      {downloading && (
        <div style={{marginTop: 18}}>
          <Progress percent={Math.round(status.percent || 0)} />
          <Text type="secondary">
            {formatBytes(status.transferred)}
            {status.total ? ` / ${formatBytes(status.total)}` : ''}
          </Text>
        </div>
      )}
      {downloaded && (
        <Paragraph style={{marginTop: 16, marginBottom: 0}}>
          重启后会完成安装，请先保存正在进行的工作。
        </Paragraph>
      )}
    </Modal>
  );
}
