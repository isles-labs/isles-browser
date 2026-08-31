// A selected cloud workspace must never inherit local rows. Calls without a
// workspace are local-mode reads and therefore only see unassigned legacy
// rows; cloud-mode callers must always pass the selected workspace id.
type WorkspaceScopeQuery = {
  where: (column: string, workspaceId: string) => unknown;
  whereNull: (column: string) => unknown;
};

export const applyWorkspaceScope = <T extends WorkspaceScopeQuery>(
  query: T,
  column: string,
  workspaceId?: string,
) => {
  if (workspaceId) {
    query.where(column, workspaceId);
  } else {
    query.whereNull(column);
  }
  return query;
};
