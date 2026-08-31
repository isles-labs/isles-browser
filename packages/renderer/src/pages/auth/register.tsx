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

type RegisterForm = {
  apiBaseUrl: string;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
};

export default function Register() {
  const [form] = Form.useForm<RegisterForm>();
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

  const onFinish = async (values: RegisterForm) => {
    if (values.password !== values.confirmPassword) {
      messageApi.warning('两次输入的密码不一致');
      return;
    }

    const apiBaseUrl = normalizeApiBaseUrl(values.apiBaseUrl);
    setLoading(true);
    try {
      const result = await fetchCloudJson<{
        success: boolean;
        access_token: string;
        user: {id: string};
        team?: {id: string};
      }>(apiBaseUrl, '/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: values.email,
          password: values.password,
          name: values.name,
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
          <h1 className="auth-brand-title">创建账号</h1>
          <p className="auth-brand-copy">
            创建账号后即可使用本地工作区；创建或加入团队仅在启用云端同步时需要。
          </p>
        </div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <h1>注册</h1>
          <p className="auth-subtitle">
            先创建个人账号；需要云端同步时再创建团队或使用邀请码加入。
          </p>
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
              name="name"
              label="姓名"
              rules={[{required: true}]}
            >
              <Input />
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
              rules={[{required: true, min: 8}]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="confirmPassword"
              label="确认密码"
              rules={[{required: true}]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={loading}
            >
              创建账号
            </Button>
          </Form>
          <Space style={{marginTop: 18}}>
            <span>已有账号？</span>
            <Link to="/auth/login">登录</Link>
          </Space>
        </div>
      </div>
    </div>
  );
}
