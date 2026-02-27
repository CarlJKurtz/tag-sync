import { Notice, Plugin, TFile } from "obsidian";
import { sanitizeSettings, TagSyncSettingTab } from "./settings";
import { StateStore } from "./sync/StateStore";
import { SyncEngine } from "./sync/SyncEngine";
import {
  DEFAULT_SETTINGS,
  type PluginStoredData,
  type SyncStateData,
  type TagSyncSettings,
} from "./types";

function createVaultId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  const randomPart = Math.random().toString(36).slice(2, 10);
  const timePart = Date.now().toString(36);
  return `${timePart}-${randomPart}`;
}

export default class TagSyncPlugin extends Plugin {
  settings: TagSyncSettings = { ...DEFAULT_SETTINGS };
  private storedData: PluginStoredData = {};
  private syncEngine: SyncEngine | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();
    await this.loadSettings();

    const stateStore = new StateStore(
      async () => this.storedData.syncState,
      async (state) => {
        await this.saveSyncState(state);
      },
    );

    this.syncEngine = new SyncEngine({
      app: this.app,
      getSettings: () => this.settings,
      stateStore,
      onStatusChange: (status) => this.updateStatus(status),
      onAuthTokensUpdated: async (tokens) => {
        await this.persistAuthTokens(tokens);
      },
    });
    await this.syncEngine.initialize();

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatus(this.getSetupIssue() ? "Setup required" : "Idle");

    this.addSettingTab(new TagSyncSettingTab(this.app, this));
    this.registerCommands();
    this.registerVaultEvents();

    this.addRibbonIcon("sync", "TagSync: Sync now", async () => {
      if (!this.syncEngine) {
        return;
      }
      if (!this.ensureSetupForSync()) {
        return;
      }
      await this.syncEngine.syncNow();
      new Notice("TagSync completed");
    });
  }

  async onunload(): Promise<void> {
    if (this.syncEngine) {
      await this.syncEngine.dispose();
      this.syncEngine = null;
    }
  }

  async updateSettings(patch: Partial<TagSyncSettings>): Promise<void> {
    const previousRemoteBasePath = this.settings.remoteBasePath;
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    if (!this.settings.vaultId) {
      this.settings.vaultId = createVaultId();
    }
    await this.saveSettings();
    this.syncEngine?.onSettingsChanged();

    if (previousRemoteBasePath !== this.settings.remoteBasePath) {
      new Notice(
        "TagSync remote base path changed. Run 'TagSync: Resync all tagged files' in each synced vault.",
      );
    }
  }

  private registerCommands(): void {
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: async () => {
        if (!this.syncEngine) {
          return;
        }
        if (!this.ensureSetupForSync()) {
          return;
        }
        await this.syncEngine.syncNow();
        new Notice("TagSync completed");
      },
    });

    this.addCommand({
      id: "rebuild-index",
      name: "Rebuild index",
      callback: async () => {
        if (!this.syncEngine) {
          return;
        }
        if (!this.ensureSetupForSync()) {
          return;
        }
        await this.syncEngine.rebuildIndex();
        new Notice("TagSync rebuild complete");
      },
    });

    this.addCommand({
      id: "resync-all-tagged-files",
      name: "Resync all tagged files",
      callback: async () => {
        if (!this.syncEngine) {
          return;
        }
        if (!this.ensureSetupForSync()) {
          return;
        }
        await this.syncEngine.resyncAllTaggedFiles();
        new Notice("TagSync tagged resync completed");
      },
    });

    this.addCommand({
      id: "toggle-pause-sync",
      name: "Pause/Resume sync",
      callback: () => {
        if (!this.syncEngine) {
          return;
        }
        const paused = this.syncEngine.togglePause();
        new Notice(paused ? "TagSync paused" : "TagSync resumed");
      },
    });
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) {
          return;
        }
        this.syncEngine?.handleVaultEvent({ type: "create", path: file.path });
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) {
          return;
        }
        this.syncEngine?.handleVaultEvent({ type: "modify", path: file.path });
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) {
          return;
        }
        this.syncEngine?.handleVaultEvent({ type: "delete", path: file.path });
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) {
          return;
        }
        this.syncEngine?.handleVaultEvent({
          type: "rename",
          path: file.path,
          oldPath,
        });
      }),
    );
  }

  private async loadSettings(): Promise<void> {
    this.settings = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      ...(this.storedData.settings ?? {}),
    });

    if (!this.settings.vaultId) {
      this.settings.vaultId = createVaultId();
      await this.saveSettings();
    }
  }

  private async saveSettings(): Promise<void> {
    this.storedData.settings = this.settings;
    await this.savePluginData();
  }

  private async persistAuthTokens(tokens: {
    dropboxAccessToken: string;
    dropboxAccessTokenExpiresAt: string;
  }): Promise<void> {
    this.settings = sanitizeSettings({
      ...this.settings,
      ...tokens,
    });
    await this.saveSettings();
  }

  private async saveSyncState(syncState: SyncStateData): Promise<void> {
    this.storedData.syncState = syncState;
    await this.savePluginData();
  }

  private async loadPluginData(): Promise<void> {
    const loaded = (await this.loadData()) as PluginStoredData | null;
    this.storedData = loaded ?? {};
  }

  private async savePluginData(): Promise<void> {
    await this.saveData(this.storedData);
  }

  private updateStatus(status: string): void {
    this.statusBarEl?.setText(`TagSync: ${status}`);
  }

  private ensureSetupForSync(): boolean {
    const issue = this.getSetupIssue();
    if (!issue) {
      return true;
    }

    this.updateStatus("Setup required");
    new Notice(`TagSync setup required: ${issue}`);
    return false;
  }

  private getSetupIssue(): string | null {
    if (this.settings.tagsToSync.length === 0) {
      return "Add at least one tag in 'Tags to sync'.";
    }
    if (!this.settings.dropboxAppKey.trim()) {
      return "Enter Dropbox app key in TagSync settings.";
    }
    if (!this.settings.dropboxRefreshToken.trim()) {
      return "Use the OAuth helper to connect Dropbox and store a refresh token.";
    }
    if (!this.settings.remoteBasePath.trim()) {
      return "Set a Dropbox remote base path.";
    }
    return null;
  }
}
