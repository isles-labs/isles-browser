type MembershipSettings = {
  cloudSync?: {
    apiBaseUrl?: string;
    accessToken?: string;
    workspaceId?: string;
  };
};

// Membership is an account/workspace relationship, not the current run mode.
export const hasSavedMembership = (settings?: MembershipSettings) => {
  const cloudSync = settings?.cloudSync;
  return Boolean(cloudSync?.apiBaseUrl && cloudSync.accessToken && cloudSync.workspaceId);
};
