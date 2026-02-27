export interface TagSyncSettings {
  tagsToSync: string[];
  dropboxAccessToken: string;
  dropboxAppKey: string;
  dropboxRefreshToken: string;
  dropboxAccessTokenExpiresAt: string;
  dropboxOauthCodeVerifier: string;
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
  dropboxAppKey: "",
  dropboxRefreshToken: "",
  dropboxAccessTokenExpiresAt: "",
  dropboxOauthCodeVerifier: "",
  remoteBasePath: "/",
  pollIntervalSeconds: 30,
  vaultId: "",
  maxUploadSizeMB: 20,
};

export const DEFAULT_SYNC_STATE: SyncStateData = {
  cursor: undefined,
  files: {},
};
