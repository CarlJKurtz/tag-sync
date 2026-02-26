import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TagSyncPlugin from "./main";
import { DEFAULT_SETTINGS, type TagSyncSettings } from "./types";
import { normalizeRemoteBasePath } from "./sync/pathUtils";

export function normalizeTag(rawTag: string): string {
  return rawTag.trim().replace(/^#+/, "").toLowerCase();
}

export function normalizeTags(rawTags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of rawTags) {
    const normalized = normalizeTag(tag);
    if (normalized) {
      seen.add(normalized);
    }
  }

  return Array.from(seen);
}

function parseDelimitedList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function sanitizeSettings(input: TagSyncSettings): TagSyncSettings {
  const pollSeconds = Number.isFinite(input.pollIntervalSeconds)
    ? Math.max(5, Math.round(input.pollIntervalSeconds))
    : DEFAULT_SETTINGS.pollIntervalSeconds;
  const maxUploadSizeMB = Number.isFinite(input.maxUploadSizeMB)
    ? Math.max(1, input.maxUploadSizeMB)
    : DEFAULT_SETTINGS.maxUploadSizeMB;

  return {
    tagsToSync: normalizeTags(input.tagsToSync ?? []),
    dropboxAccessToken: (input.dropboxAccessToken ?? "").trim(),
    remoteBasePath: normalizeRemoteBasePath(input.remoteBasePath ?? "/"),
    pollIntervalSeconds: pollSeconds,
    vaultId: input.vaultId ?? "",
    maxUploadSizeMB,
  };
}

export function getSettingsWarnings(settings: TagSyncSettings): string[] {
  const warnings: string[] = [];
  if (settings.tagsToSync.length === 0) {
    warnings.push("Add at least one tag to enable syncing.");
  }
  if (!settings.dropboxAccessToken.trim()) {
    warnings.push("Dropbox access token is required.");
  }
  if (!settings.remoteBasePath.trim()) {
    warnings.push("Remote base path is required.");
  }
  if (settings.pollIntervalSeconds < 5) {
    warnings.push("Poll interval must be at least 5 seconds.");
  }
  if (settings.maxUploadSizeMB < 1) {
    warnings.push("Max upload size must be at least 1 MB.");
  }

  return warnings;
}

function parseNumberInput(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

export class TagSyncSettingTab extends PluginSettingTab {
  plugin: TagSyncPlugin;

  constructor(app: App, plugin: TagSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "TagSync Settings" });
    containerEl.createEl("h3", { text: "Plugin description" });
    containerEl.createEl("p", {
      text: "Syncs tagged Markdown files between vaults through Dropbox.",
    });
    containerEl.createEl("p", {
      text: "Security warning: Dropbox access token is stored unencrypted in this vault.",
    });
    containerEl.createEl("p", {
      text: "Plugin commands:",
    });
    const commandsListEl = containerEl.createEl("ul");
    commandsListEl.createEl("li", {
      text: "Sync now - Runs an immediate local+remote sync pass.",
    });
    commandsListEl.createEl("li", {
      text: "Rebuild index - Rebuilds tag index and syncs with current metadata.",
    });
    commandsListEl.createEl("li", {
      text: "Resync all tagged files - Force re-uploads all tagged files.",
    });
    commandsListEl.createEl("li", {
      text: "Pause/Resume sync - Temporarily pauses or resumes syncing.",
    });

    const warningsEl = containerEl.createDiv();
    const renderWarnings = () => {
      warningsEl.empty();
      for (const warning of getSettingsWarnings(this.plugin.settings)) {
        warningsEl.createEl("p", { text: `Warning: ${warning}` });
      }
    };

    new Setting(containerEl)
      .setName("Tags to sync")
      .setDesc("Comma or newline separated tags, with or without #.")
      .addTextArea((textArea) =>
        textArea
          .setPlaceholder("#sync/project-x")
          .setValue(this.plugin.settings.tagsToSync.join(", "))
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              tagsToSync: parseDelimitedList(value),
            });
            renderWarnings();
          }),
      );

    new Setting(containerEl)
      .setName("Dropbox access token")
      .setDesc("Token used for Dropbox API requests.")
      .addText((text) => {
        text.inputEl.type = "password";
        return text
          .setPlaceholder("sl ...")
          .setValue(this.plugin.settings.dropboxAccessToken)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ dropboxAccessToken: value.trim() });
            renderWarnings();
          });
      });

    new Setting(containerEl)
      .setName("Poll interval (seconds)")
      .setDesc("How often to poll Dropbox for remote changes.")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.pollIntervalSeconds))
          .onChange(async (value) => {
            const parsed = parseNumberInput(value, this.plugin.settings.pollIntervalSeconds);
            if (!Number.isFinite(parsed)) {
              new Notice("Invalid poll interval.");
              return;
            }

            await this.plugin.updateSettings({ pollIntervalSeconds: parsed });
            renderWarnings();
          }),
      );

    new Setting(containerEl)
      .setName("Max upload size (MB)")
      .setDesc("Files above this size are skipped.")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.maxUploadSizeMB))
          .onChange(async (value) => {
            const parsed = parseNumberInput(value, this.plugin.settings.maxUploadSizeMB);
            if (!Number.isFinite(parsed)) {
              new Notice("Invalid max upload size.");
              return;
            }

            await this.plugin.updateSettings({ maxUploadSizeMB: parsed });
            renderWarnings();
          }),
      );

    containerEl.createEl("h3", { text: "Experimental features" });
    containerEl.createEl("p", {
      text:
        "Remote base path should be the same across all synced vaults. If you change it, previously synced files might stop syncing until you run a full tagged resync.",
    });

    new Setting(containerEl)
      .setName("Remote base path (experimental)")
      .setDesc("Default is '/'. Use only if you need a dedicated Dropbox subfolder.")
      .addText((text) =>
        text
          .setPlaceholder("/")
          .setValue(this.plugin.settings.remoteBasePath)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ remoteBasePath: value.trim() || "/" });
            renderWarnings();
          }),
      );

    renderWarnings();
  }
}
