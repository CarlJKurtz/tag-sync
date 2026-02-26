export interface TagSyncSettings {
  tagsToSync: string[];
  dropboxAccessToken: string;
  remoteBasePath: string;
  pollIntervalSeconds: number;
  vaultId: string;
  maxUploadSizeMB: number;
}

export interface FileSyncState {
  dropboxRev?: string;
  lastLocalMtime?: number;
  lastRemoteModified?: number;
}

export interface SyncStateData {
  cursor?: string;
  files: Record<string, FileSyncState>;
}

export interface PluginStoredData {
  settings?: Partial<TagSyncSettings>;
  syncState?: SyncStateData;
}

export const DEFAULT_SETTINGS: TagSyncSettings = {
  tagsToSync: [],
  dropboxAccessToken: "",
  remoteBasePath: "/",
  pollIntervalSeconds: 30,
  vaultId: "",
  maxUploadSizeMB: 20,
};

export const DEFAULT_SYNC_STATE: SyncStateData = {
  cursor: undefined,
  files: {},
};
