export const databaseClusterKeys = {
  list: () => ['database-clusters'] as const,
  cluster: (identifier: string | undefined) =>
    ['database-clusters', identifier] as const,
  metrics: () =>
    ['database-clusters', 'metrics'] as const,
}
