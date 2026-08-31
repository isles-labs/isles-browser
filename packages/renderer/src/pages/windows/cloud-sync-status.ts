export interface CloudSyncProgress {
  enabled: boolean;
  pendingOutbox: number;
  progressPercent: number;
  syncing: boolean;
}

export const shouldShowCloudSyncProgress = (progress: CloudSyncProgress) =>
  progress.enabled && (progress.syncing || progress.pendingOutbox > 0);

export const getCloudSyncProgressPercent = (progress: CloudSyncProgress) => {
  if (progress.pendingOutbox === 0 && progress.syncing) {
    return Math.min(progress.progressPercent || 99, 99);
  }
  return progress.progressPercent;
};

export const getCloudSyncQueueLabel = (progress: Pick<CloudSyncProgress, 'pendingOutbox'>) =>
  `同步队列 ${progress.pendingOutbox}`;
