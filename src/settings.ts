import { App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type TagSyncPlugin from "./main";
import { DEFAULT_SETTINGS, type TagSyncSettings } from "./types";
import { normalizeRemoteBasePath } from "./sync/pathUtils";
import { DropboxClient } from "./sync/DropboxClient";

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

function normalizeIsoTimestamp(rawValue: string): string {
  const value = rawValue.trim();
  if (!value) {
    return "";
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }

  return new Date(parsed).toISOString();
}

function parseDelimitedList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generatePkceCodeVerifier(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Browser crypto API unavailable.");
  }

  const random = new Uint8Array(32);
  globalThis.crypto.getRandomValues(random);
  return toBase64Url(random);
}

async function generatePkceCodeChallenge(codeVerifier: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Browser crypto subtle API unavailable.");
  }

  const data = new TextEncoder().encode(codeVerifier);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest));
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
    dropboxAppKey: (input.dropboxAppKey ?? "").trim(),
    dropboxRefreshToken: (input.dropboxRefreshToken ?? "").trim(),
    dropboxAccessTokenExpiresAt: normalizeIsoTimestamp(input.dropboxAccessTokenExpiresAt ?? ""),
    dropboxOauthCodeVerifier: (input.dropboxOauthCodeVerifier ?? "").trim(),
    remoteBasePath: normalizeRemoteBasePath(input.remoteBasePath ?? "/"),
    pollIntervalSeconds: pollSeconds,
    vaultId: input.vaultId ?? "",
    maxUploadSizeMB,
  };
}

export function getSettingsWarnings(settings: TagSyncSettings): string[] {
  const warnings: string[] = [];
  const hasAppKey = Boolean(settings.dropboxAppKey.trim());
  const hasRefreshToken = Boolean(settings.dropboxRefreshToken.trim());
  const hasOauthInProgress = Boolean(hasAppKey && settings.dropboxOauthCodeVerifier.trim());

  if (settings.tagsToSync.length === 0) {
    warnings.push("Add at least one tag to enable syncing.");
  }
  if (!hasAppKey) {
    warnings.push("Dropbox app key is required.");
  }
  if (!hasRefreshToken) {
    if (hasOauthInProgress) {
      warnings.push("Complete OAuth code exchange to finish Dropbox connection.");
    } else {
      warnings.push("Connect Dropbox with OAuth to store a refresh token.");
    }
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
      .setName("Dropbox app key")
      .setDesc("Required for OAuth helper and refresh-token mode.")
      .addText((text) =>
        text
          .setPlaceholder("App key from Dropbox app console")
          .setValue(this.plugin.settings.dropboxAppKey)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ dropboxAppKey: value.trim() });
            renderWarnings();
          }),
      );

    containerEl.createEl("p", {
      text:
        "OAuth helper: Generate a Dropbox link from your app key, approve access, paste the authorization code, then exchange it for refresh/access tokens.",
    });

    let authorizationCodeInput: TextComponent | null = null;
    let refreshTokenInput: TextComponent | null = null;
    let expiresAtInput: TextComponent | null = null;
    let authorizationCode = "";

    new Setting(containerEl)
      .setName("Generate OAuth link")
      .setDesc("Creates a Dropbox OAuth URL with offline access and opens it in your browser.")
      .addButton((button) =>
        button
          .setButtonText("Generate + open")
          .onClick(async () => {
            try {
              const appKey = this.plugin.settings.dropboxAppKey.trim();
              if (!appKey) {
                new Notice("Enter Dropbox app key first.");
                return;
              }

              const codeVerifier = generatePkceCodeVerifier();
              const codeChallenge = await generatePkceCodeChallenge(codeVerifier);
              const authorizeUrl = DropboxClient.buildAuthorizeUrl({
                clientId: appKey,
                codeChallenge,
              });

              window.open(authorizeUrl, "_blank", "noopener,noreferrer");
              await this.plugin.updateSettings({
                dropboxOauthCodeVerifier: codeVerifier,
              });

              new Notice("Dropbox OAuth link opened. Approve access, then paste the authorization code.");
              renderWarnings();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`Failed to generate OAuth link: ${message}`);
            }
          }),
      );

    new Setting(containerEl)
      .setName("Authorization code")
      .setDesc("Paste the code returned by Dropbox after approving access.")
      .addText((text) => {
        authorizationCodeInput = text;
        return text
          .setPlaceholder("Paste Dropbox authorization code")
          .setValue(authorizationCode)
          .onChange((value) => {
            authorizationCode = value.trim();
          });
      });

    new Setting(containerEl)
      .setName("Exchange authorization code")
      .setDesc("Saves refresh/access tokens to this vault.")
      .addButton((button) =>
        button
          .setButtonText("Exchange code")
          .setCta()
          .onClick(async () => {
            try {
              const appKey = this.plugin.settings.dropboxAppKey.trim();
              if (!appKey) {
                new Notice("Enter Dropbox app key first.");
                return;
              }

              if (!authorizationCode) {
                new Notice("Paste authorization code first.");
                return;
              }

              const codeVerifier = this.plugin.settings.dropboxOauthCodeVerifier.trim();
              if (!codeVerifier) {
                new Notice("Generate a new OAuth link before exchanging code.");
                return;
              }

              const exchanged = await DropboxClient.exchangeAuthorizationCode({
                clientId: appKey,
                authorizationCode,
                codeVerifier,
              });
              if (!exchanged.refreshToken) {
                new Notice(
                  "Dropbox did not return a refresh token. Ensure offline access is enabled and retry.",
                );
                return;
              }

              const expiresAt = new Date(Date.now() + exchanged.expiresInSeconds * 1000).toISOString();
              await this.plugin.updateSettings({
                dropboxAccessToken: exchanged.accessToken,
                dropboxRefreshToken: exchanged.refreshToken,
                dropboxAccessTokenExpiresAt: expiresAt,
                dropboxOauthCodeVerifier: "",
              });

              authorizationCode = "";
              authorizationCodeInput?.setValue("");
              refreshTokenInput?.setValue(exchanged.refreshToken);
              expiresAtInput?.setValue(expiresAt);
              renderWarnings();
              new Notice("Dropbox OAuth setup complete.");
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`Failed to exchange authorization code: ${message}`);
            }
          }),
      );

    new Setting(containerEl)
      .setName("Dropbox refresh token")
      .setDesc("Long-lived token used to auto-refresh access tokens. Note: filled automatically after OAuth code exchange.")
      .addText((text) => {
        refreshTokenInput = text;
        text.inputEl.type = "password";
        return text
          .setPlaceholder("Refresh token")
          .setValue(this.plugin.settings.dropboxRefreshToken)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ dropboxRefreshToken: value.trim() });
            renderWarnings();
          });
      });

    const expiresAtDisplay = this.plugin.settings.dropboxAccessTokenExpiresAt
      ? this.plugin.settings.dropboxAccessTokenExpiresAt
      : "Not set";
    new Setting(containerEl)
      .setName("Access token expires at (UTC)")
      .setDesc("Auto-managed in refresh-token mode. Note: filled automatically after OAuth code exchange.")
      .addText((text) => {
        expiresAtInput = text;
        return text
          .setValue(expiresAtDisplay)
          .setDisabled(true);
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

    new Setting(containerEl).setName("Advanced").setHeading();
    containerEl.createEl("p", {
      text:
        "Remote base path should be the same across all synced vaults. If you change it, previously synced files might stop syncing until you run a full tagged resync.",
    });

    new Setting(containerEl)
      .setName("Remote base path")
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
