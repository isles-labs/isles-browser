type NavigationRoute = {path: string; invisible?: boolean};

export const filterNavigationRoutes = <T extends NavigationRoute>(
  routes: T[],
  hasCloudWorkspace: boolean,
) =>
  routes.filter(route => !route.invisible && (route.path !== '/team/members' || hasCloudWorkspace));
