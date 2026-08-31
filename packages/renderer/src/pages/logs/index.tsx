import {Card, Tabs} from 'antd';
import {CommonBridge} from '#preload';
import {useCallback, useEffect, useMemo, useState} from 'react';
import './index.css';

interface logsDataOptions {
  name: string;
  content: Array<{
    level: string;
    message: string;
  }>;
}

type LogModule = 'Main' | 'Windows' | 'Proxy' | 'Services' | 'Api';
const MAX_RENDERED_LOG_LINES = 4000;

const Logs = () => {
  const items = [
    {
      key: 'Main',
      label: 'Main',
    },
    {
      key: 'Windows',
      label: 'Windows',
    },
    {
      key: 'Proxy',
      label: 'Proxy',
    },
    {
      key: 'Services',
      label: 'Service',
    },
    // {
    //   key: 'Api',
    //   label: 'Api',
    // },
  ];
  const [logsData, setLogsData] = useState<logsDataOptions[]>([]);
  const [activeModule, setActiveModule] = useState<LogModule>('Main');
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(async (logModule: LogModule) => {
    setActiveModule(logModule);
    setLoading(true);
    try {
      const logs = await CommonBridge.getLogs(logModule);
      setLogsData([...logs].reverse());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs('Main');
  }, [fetchLogs]);

  const logText = useMemo(() => {
    const lines = logsData.flatMap(logs => [...logs.content].reverse().map(log => log.message));
    return lines.slice(0, MAX_RENDERED_LOG_LINES).join('\n');
  }, [logsData]);
  // type FieldType = SettingOptions;

  return (
    <>
      <Card
        className="content-card p-6 "
        bordered={false}
      >
        <Tabs
          activeKey={activeModule}
          onChange={(key: string) => fetchLogs(key as LogModule)}
          size="small"
          items={items}
        />
        <aside className="log-aside log-container">
          <div className="log-window-bar">
            <div className="log-window-dots">
              <span className="log-dot error" />
              <span className="log-dot warn" />
              <span className="log-dot info" />
            </div>
            <span>{loading ? '加载中...' : `最近 ${Math.min(logText ? logText.split('\n').length : 0, MAX_RENDERED_LOG_LINES)} 行`}</span>
          </div>
          <pre className="log-output">{logText || (loading ? '' : '暂无日志')}</pre>
        </aside>
      </Card>
    </>
  );
};
export default Logs;
