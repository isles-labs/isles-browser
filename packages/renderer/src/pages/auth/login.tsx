import {Button, Form, Input, Space, message} from 'antd';
import {Link, useNavigate} from 'react-router-dom';
import {useEffect, useState} from 'react';
import type {SettingOptions} from '../../../../shared/types/common';
import {
  fetchCloudJson,
  getSavedSettings,
  normalizeApiBaseUrl,
  saveCloudSession,
} from '/@/utils/cloud-auth';
import './index.css';

type LoginForm = {
  apiBaseUrl: string;
  email: string;
  password: string;
};

export default function Login() {
  const [form] = Form.useForm<LoginForm>();
  const [settings, setSettings] = useState<SettingOptions>();
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const navigate = useNavigate();

  useEffect(() => {
    getSavedSettings().then(savedSettings => {
      setSettings(savedSettings);
      form.setFieldsValue({
        apiBaseUrl: savedSettings.cloudSync?.apiBaseUrl || '',
      });
    });
  }, []);

  const onFinish = async (values: LoginForm) => {
    const apiBaseUrl = normalizeApiBaseUrl(values.apiBaseUrl);
    setLoading(true);
    try {
      const result = await fetchCloudJson<{
        success: boolean;
        access_token: string;
        user: {id: string};
      }>(apiBaseUrl, '/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: values.email,
          password: values.password,
        }),
      });

      await saveCloudSession(settings || (await getSavedSettings()), {
        apiBaseUrl,
        accessToken: result.access_token,
        userId: result.user?.id || '',
        workspaceId: '',
      });

      navigate('/', {replace: true});
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      {contextHolder}
      <div className="auth-brand">
        <div>
          <h1 className="auth-brand-title">ISLES Browser</h1>
          <p className="auth-brand-copy">
            登录用于账号隔离；本地窗口、代理和脚本工作流无需团队即可使用。
          </p>
        </div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <h1>登录</h1>
          <p className="auth-subtitle">登录后进入本地工作区；需要同步时再选择团队。</p>
          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
          >
            <Form.Item
              name="apiBaseUrl"
              label="服务地址"
              rules={[{required: true}]}
            >
              <Input placeholder="https://sync.example.com" />
            </Form.Item>
            <Form.Item
              name="email"
              label="邮箱"
              rules={[{required: true, type: 'email'}]}
            >
              <Input autoComplete="email" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{required: true}]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={loading}
            >
              登录
            </Button>
          </Form>
          <Space style={{marginTop: 18}}>
            <span>还没有账号？</span>
            <Link to="/auth/register">注册团队账号</Link>
          </Space>
        </div>
      </div>
    </div>
  );
}
