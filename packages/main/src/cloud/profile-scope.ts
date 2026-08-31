import type {DB} from '../../../shared/types/db';

export const getProfileScopeDirectory = (windowData: Pick<DB.Window, 'workspace_id'>) =>
  windowData.workspace_id ? `cloud-${encodeURIComponent(windowData.workspace_id)}` : 'local';

export const shouldCopyLegacyProfileData = (windowData: Pick<DB.Window, 'workspace_id'>) =>
  !windowData.workspace_id;
