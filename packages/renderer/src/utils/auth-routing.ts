export const nextRouteForCloudSession = ({
  hasToken,
  isAuthRoute,
  isTeamSelectRoute = false,
}: {
  hasToken: boolean;
  isAuthRoute: boolean;
  isTeamSelectRoute?: boolean;
}) => {
  if (!hasToken && !isAuthRoute) return '/auth/login';
  if (hasToken && isAuthRoute && !isTeamSelectRoute) return '/';
  return undefined;
};
