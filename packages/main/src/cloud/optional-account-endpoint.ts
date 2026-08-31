export const isMissingOptionalAccountEndpoint = (path: string, status: unknown) =>
  path.startsWith('/account/') && status === 404;
