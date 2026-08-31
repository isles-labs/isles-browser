export const canManageScriptSources = (mode: 'local' | 'cloud', cloudRole?: string) => {
  if (mode === 'local') return true;
  const normalizedRole = String(cloudRole || '')
    .trim()
    .toLowerCase();
  return normalizedRole === 'owner' || normalizedRole === 'admin';
};
