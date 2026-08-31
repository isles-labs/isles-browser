import type {TabsProps} from 'antd';
import {Card, Tabs} from 'antd';
import './index.css';
import WindowEditForm from '../components/edit-form';
import WindowImportForm from '../components/import-form';
import {useCallback, useEffect, useState} from 'react';
import type {DB} from '../../../../../shared/types/db';
import {useSearchParams} from 'react-router-dom';
import {WindowBridge} from '#preload';
import WindowDetailFooter from '../components/edit-footer';
import {useTranslation} from 'react-i18next';

const WindowDetailTabs = ({
  formValue,
  onChange,
  formValueChangeCallback,
}: {
  formValue: DB.Window;
  onChange: (key: string) => void;
  formValueChangeCallback: (changed: DB.Window, data: DB.Window) => void;
}) => {
  const {t} = useTranslation();
  const DEFAULT_ACTIVE_KEY = '0';
  const items: TabsProps['items'] = [
    {
      key: 'windowForm',
      label: t('window_detail_create'),
      forceRender: true,
      children: (
        <div className="flex w-full">
          <WindowEditForm
            loading={false}
            formValue={formValue}
            formChangeCallback={formValueChangeCallback}
          />
        </div>
      ),
    },
    {
      key: 'import',
      label: t('window_detail_import'),
      children: <WindowImportForm />,
    },
  ];

  return (
    <Tabs
      size="small"
      defaultActiveKey={DEFAULT_ACTIVE_KEY}
      items={items}
      onChange={onChange}
    />
  );
};

const WindowDetail = () => {
  const [formValue, setFormValue] = useState<DB.Window>({});
  const [currentTab, setCurrentTab] = useState('windowForm');
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    initFormValue();
  }, [searchParams]);

  const initFormValue = async () => {
    const id = searchParams.get('id');
    setLoading(true);
    if (id) {
      const window = await WindowBridge?.getById(Number(id));
      if (window.tags) {
        if (typeof window.tags === 'string') {
          window.tags = window.tags.split(',').map((item: string) => Number(item));
        } else if (typeof window.tags === 'number') {
          window.tags = [window.tags];
        }
      } else {
        window.tags = [];
      }
      setFormValue(window || new Object());
    } else {
      setFormValue(new Object());
    }
    setLoading(false);
  };

  const onTabChange = useCallback((tab: string) => {
    setCurrentTab(tab);
  }, []);

  const formValueChangeCallback = (changed: DB.Window, _: DB.Window) => {
    setFormValue(prev => ({
      ...prev,
      ...changed,
    }));
  };

  return (
    <>
      <Card className="window-detail-card">
        {searchParams.get('id') ? (
          <div className="flex w-full mt-4">
            <WindowEditForm
              loading={loading}
              formValue={formValue}
              formChangeCallback={formValueChangeCallback}
            ></WindowEditForm>
          </div>
        ) : (
          <WindowDetailTabs
            formValue={formValue}
            onChange={onTabChange}
            formValueChangeCallback={formValueChangeCallback}
          />
        )}
      </Card>
      <WindowDetailFooter
        loading={loading}
        currentTab={currentTab}
        formValue={formValue}
      />
    </>
  );
};

export default WindowDetail;
