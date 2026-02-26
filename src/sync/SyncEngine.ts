import { App, Notice, TFile } from "obsidian";
import type { TagSyncSettings } from "../types";
import {
  DropboxClient,
  DropboxReachabilityError,
  type DropboxDeletedMetadata,
  type DropboxFileMetadata,
} from "./DropboxClient";
import {
  isConflictCopyPath,
  isMarkdownPath,
  normalizeLocalPath,
  toLocalPath,
  toRemotePath,
} from "./pathUtils";
import { StateStore } from "./StateStore";
import { TagIndex } from "./TagIndex";

type SyncTrigger =
  | "manual"
  | "local-event"
  | "poll"
  | "settings-change"
  | "rebuild-index"
  | "resync-all-tagged";

export type LocalVaultEvent =
  | { type: "create"; path: string }
  | { type: "modify"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; path: string; oldPath: string };

interface SyncEngineOptions {
  app: App;
  getSettings: () => TagSyncSettings;
  stateStore: StateStore;
  onStatusChange?: (status: string) => void;
}

const INTERNAL_IGNORE_GLOBS = [".obsidian/**"];

export class SyncEngine {
  private readonly app: App;
  private readonly getSettings: () => TagSyncSettings;
  private readonly stateStore: StateStore;
  private readonly tagIndex: TagIndex;
  private readonly onStatusChange?: (status: string) => void;
  private isPaused = false;
  private isRunning = false;
  private rerunRequested = false;
  private runPromise: Promise<void> | null = null;
  private debounceTimer: number | null = null;
  private pollTimer: number | null = null;
  private ignoredPaths = new Map<string, number>();
  private forceUploadAllTagged = false;

  constructor(options: SyncEngineOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.stateStore = options.stateStore;
    this.tagIndex = new TagIndex(this.app);
    this.onStatusChange = options.onStatusChange;
  }

  async initialize(): Promise<void> {
    await this.stateStore.initialize();
    this.restartPolling();
    this.updateStatus("Idle");
    this.enqueueSync("settings-change", true);
  }

  async dispose(): Promise<void> {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.runPromise) {
      await this.runPromise;
    }
  }

  onSettingsChanged(): void {
    this.restartPolling();
    this.enqueueSync("settings-change", true);
  }

  handleVaultEvent(event: LocalVaultEvent): void {
    if (event.type === "rename") {
      const newPath = normalizeLocalPath(event.path);
      const oldPath = normalizeLocalPath(event.oldPath);
      const hasMarkdownPath = isMarkdownPath(newPath) || isMarkdownPath(oldPath);
      if (!hasMarkdownPath) {
        return;
      }
      if (this.isPathIgnored(newPath) || this.isPathIgnored(oldPath)) {
        return;
      }
      this.enqueueSync("local-event", false);
      return;
    }

    const path = normalizeLocalPath(event.path);
    if (!isMarkdownPath(path)) {
      return;
    }
    if (this.isPathIgnored(path)) {
      return;
    }

    this.enqueueSync("local-event", false);
  }

  async syncNow(): Promise<void> {
    this.enqueueSync("manual", true);
    if (this.runPromise) {
      await this.runPromise;
    }
  }

  async rebuildIndex(): Promise<void> {
    this.enqueueSync("rebuild-index", true);
    if (this.runPromise) {
      await this.runPromise;
    }
  }

  async resyncAllTaggedFiles(): Promise<void> {
    this.forceUploadAllTagged = true;
    this.stateStore.setCursor(undefined);
    this.enqueueSync("resync-all-tagged", true);
    if (this.runPromise) {
      await this.runPromise;
    }
  }

  togglePause(): boolean {
    this.isPaused = !this.isPaused;
    if (this.isPaused) {
      this.updateStatus("Paused");
    } else {
      this.updateStatus("Idle");
      this.enqueueSync("manual", true);
    }
    return this.isPaused;
  }

  private enqueueSync(trigger: SyncTrigger, immediate: boolean): void {
    if (immediate) {
      void this.startRun(trigger);
      return;
    }

    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.startRun(trigger);
    }, 750);
  }

  private startRun(trigger: SyncTrigger): Promise<void> {
    if (this.runPromise) {
      this.rerunRequested = true;
      return this.runPromise;
    }

    this.runPromise = this.runLoop(trigger).finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  private async runLoop(initialTrigger: SyncTrigger): Promise<void> {
    if (this.isRunning) {
      this.rerunRequested = true;
      return;
    }

    this.isRunning = true;
    this.updateStatus("Syncing ...");

    try {
      let trigger: SyncTrigger | null = initialTrigger;
      do {
        this.rerunRequested = false;
        await this.syncOnce(trigger);
        trigger = this.rerunRequested ? "local-event" : null;
      } while (trigger);

      if (this.isPaused) {
        this.updateStatus("Paused");
      } else {
        this.updateStatus("Up to date");
      }
    } catch (error) {
      if (error instanceof DropboxReachabilityError) {
        this.updateStatus("Can’t reach Dropbox");
        new Notice("Can’t reach Dropbox");
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus("Error");
      new Notice(`TagSync error: ${message}`);
    } finally {
      this.isRunning = false;
    }
  }

  private async syncOnce(trigger: SyncTrigger | null): Promise<void> {
    if (this.isPaused) {
      return;
    }

    const settings = this.getSettings();
    if (!this.isConfigured(settings)) {
      return;
    }

    const client = new DropboxClient(settings.dropboxAccessToken);
    const shouldForceUpload = this.forceUploadAllTagged || trigger === "resync-all-tagged";

    try {
      await this.pullRemoteChanges(client, settings);
      const taggedFiles = this.tagIndex.buildTaggedFileSet(settings.tagsToSync, INTERNAL_IGNORE_GLOBS);
      await this.pushLocalChanges(client, settings, taggedFiles, shouldForceUpload);
      this.forceUploadAllTagged = false;
    } finally {
      await this.stateStore.save();
    }
  }

  private async pullRemoteChanges(client: DropboxClient, settings: TagSyncSettings): Promise<void> {
    const { entries, cursor } = await client.listDelta(settings.remoteBasePath, this.stateStore.getCursor());

    for (const entry of entries) {
      if (entry[".tag"] === "deleted") {
        await this.applyRemoteDelete(entry, client, settings);
      } else {
        await this.applyRemoteFile(entry, client, settings);
      }
    }

    this.stateStore.setCursor(cursor);
  }

  private async applyRemoteDelete(
    entry: DropboxDeletedMetadata,
    client: DropboxClient,
    settings: TagSyncSettings,
  ): Promise<void> {
    const remotePath = entry.path_display ?? entry.path_lower;
    const localPath = toLocalPath(settings.remoteBasePath, remotePath);
    if (!localPath || !isMarkdownPath(localPath)) {
      return;
    }
    if (isConflictCopyPath(localPath)) {
      this.stateStore.deleteFile(localPath);
      return;
    }

    const localFile = this.getLocalFile(localPath);
    if (!localFile) {
      this.stateStore.deleteFile(localPath);
      return;
    }

    const existingState = this.stateStore.getFile(localPath);
    const localChanged = !existingState || localFile.stat.mtime !== existingState.lastLocalMtime;
    if (!localChanged) {
      await this.deleteLocalFile(localFile);
      this.stateStore.deleteFile(localPath);
      return;
    }

    // Keep the original local path stable on delete conflicts to avoid breaking links.
    const localContent = await this.app.vault.read(localFile);
    await this.createConflictCopy(localPath, localContent, settings.vaultId, settings.tagsToSync);

    const uploaded = await client.upload(toRemotePath(settings.remoteBasePath, localPath), localContent);
    this.stateStore.setFile(localPath, {
      dropboxRev: uploaded.rev,
      lastLocalMtime: localFile.stat.mtime,
      lastRemoteModified: this.parseRemoteTime(uploaded.server_modified),
    });
  }

  private async applyRemoteFile(
    entry: DropboxFileMetadata,
    client: DropboxClient,
    settings: TagSyncSettings,
  ): Promise<void> {
    const remotePath = entry.path_display;
    const localPath = toLocalPath(settings.remoteBasePath, remotePath);
    if (!localPath || !isMarkdownPath(localPath)) {
      return;
    }
    if (isConflictCopyPath(localPath)) {
      this.stateStore.deleteFile(localPath);
      return;
    }

    const existingState = this.stateStore.getFile(localPath);
    const remoteChanged = !existingState || existingState.dropboxRev !== entry.rev;
    if (!remoteChanged) {
      return;
    }

    const localFile = this.getLocalFile(localPath);
    if (!localFile) {
      const downloaded = await client.download(remotePath);
      const created = await this.createOrModifyLocalFile(localPath, downloaded.content);
      this.stateStore.setFile(localPath, {
        dropboxRev: downloaded.metadata.rev,
        lastLocalMtime: created.stat.mtime,
        lastRemoteModified: this.parseRemoteTime(downloaded.metadata.server_modified),
      });
      return;
    }

    const localChanged = !existingState || localFile.stat.mtime !== existingState.lastLocalMtime;
    if (!localChanged) {
      const downloaded = await client.download(remotePath);
      const updated = await this.createOrModifyLocalFile(localPath, downloaded.content);
      this.stateStore.setFile(localPath, {
        dropboxRev: downloaded.metadata.rev,
        lastLocalMtime: updated.stat.mtime,
        lastRemoteModified: this.parseRemoteTime(downloaded.metadata.server_modified),
      });
      return;
    }

    const localContent = await this.app.vault.read(localFile);
    const downloaded = await client.download(remotePath);

    // Same-content edits across devices can shift mtime/rev and look like conflicts.
    // If content is equal, advance state without creating conflict copies.
    if (downloaded.content === localContent) {
      this.stateStore.setFile(localPath, {
        dropboxRev: downloaded.metadata.rev,
        lastLocalMtime: localFile.stat.mtime,
        lastRemoteModified: this.parseRemoteTime(downloaded.metadata.server_modified),
      });
      return;
    }

    await this.createConflictCopy(localPath, localContent, settings.vaultId, settings.tagsToSync);

    const remoteModifiedMs = this.parseRemoteTime(downloaded.metadata.server_modified);
    if (remoteModifiedMs >= localFile.stat.mtime) {
      const updated = await this.createOrModifyLocalFile(localPath, downloaded.content);
      this.stateStore.setFile(localPath, {
        dropboxRev: downloaded.metadata.rev,
        lastLocalMtime: updated.stat.mtime,
        lastRemoteModified: this.parseRemoteTime(downloaded.metadata.server_modified),
      });
      return;
    }

    const uploaded = await client.upload(toRemotePath(settings.remoteBasePath, localPath), localContent);
    this.stateStore.setFile(localPath, {
      dropboxRev: uploaded.rev,
      lastLocalMtime: localFile.stat.mtime,
      lastRemoteModified: this.parseRemoteTime(uploaded.server_modified),
    });
  }

  private async pushLocalChanges(
    client: DropboxClient,
    settings: TagSyncSettings,
    taggedFiles: Set<string>,
    forceUploadAllTagged: boolean,
  ): Promise<void> {
    for (const [trackedPath, trackedState] of this.stateStore.allFiles()) {
      const localFile = this.getLocalFile(trackedPath);
      if (!localFile) {
        await this.deleteRemotePath(client, settings, trackedPath);
        this.stateStore.deleteFile(trackedPath);
        continue;
      }

      if (isConflictCopyPath(trackedPath)) {
        await this.deleteRemotePath(client, settings, trackedPath);
        this.stateStore.deleteFile(trackedPath);
        continue;
      }

      if (!taggedFiles.has(trackedPath)) {
        const localChanged = trackedState.lastLocalMtime !== localFile.stat.mtime;
        if (localChanged) {
          await this.deleteRemotePath(client, settings, trackedPath);
          this.stateStore.deleteFile(trackedPath);
        }
      }
    }

    const maxUploadBytes = settings.maxUploadSizeMB * 1024 * 1024;

    for (const localPath of taggedFiles) {
      const localFile = this.getLocalFile(localPath);
      if (!localFile) {
        continue;
      }

      const existingState = this.stateStore.getFile(localPath);
      if (!forceUploadAllTagged && existingState && existingState.lastLocalMtime === localFile.stat.mtime) {
        continue;
      }

      if (localFile.stat.size > maxUploadBytes) {
        new Notice(
          `TagSync skipped ${localPath}: file is larger than ${settings.maxUploadSizeMB} MB limit`,
        );
        this.stateStore.setFile(localPath, {
          dropboxRev: existingState?.dropboxRev,
          lastLocalMtime: localFile.stat.mtime,
          lastRemoteModified: existingState?.lastRemoteModified,
        });
        continue;
      }

      const content = await this.app.vault.read(localFile);
      const uploaded = await client.upload(toRemotePath(settings.remoteBasePath, localPath), content);
      this.stateStore.setFile(localPath, {
        dropboxRev: uploaded.rev,
        lastLocalMtime: localFile.stat.mtime,
        lastRemoteModified: this.parseRemoteTime(uploaded.server_modified),
      });
    }
  }

  private async deleteRemotePath(
    client: DropboxClient,
    settings: TagSyncSettings,
    localPath: string,
  ): Promise<void> {
    await client.delete(toRemotePath(settings.remoteBasePath, localPath));
  }

  private getLocalFile(path: string): TFile | null {
    const normalized = normalizeLocalPath(path);
    const abstractFile = this.app.vault.getAbstractFileByPath(normalized);
    return abstractFile instanceof TFile ? abstractFile : null;
  }

  private async createOrModifyLocalFile(path: string, content: string): Promise<TFile> {
    const normalizedPath = normalizeLocalPath(path);
    const existing = this.getLocalFile(normalizedPath);

    this.markPathIgnored(normalizedPath);
    if (existing) {
      await this.app.vault.modify(existing, content);
      const updated = this.getLocalFile(normalizedPath);
      if (updated) {
        return updated;
      }
      return existing;
    }

    await this.ensureParentFolders(normalizedPath);
    const created = await this.app.vault.create(normalizedPath, content);
    return created;
  }

  private async deleteLocalFile(file: TFile): Promise<void> {
    this.markPathIgnored(file.path);
    await this.app.vault.delete(file);
  }

  private async ensureParentFolders(filePath: string): Promise<void> {
    const segments = normalizeLocalPath(filePath).split("/");
    segments.pop();

    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const current = this.app.vault.getAbstractFileByPath(currentPath);
      if (!current) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch (error) {
          if (!this.app.vault.getAbstractFileByPath(currentPath)) {
            throw error;
          }
        }
      }
    }
  }

  private async createConflictCopy(
    localPath: string,
    content: string,
    vaultId: string,
    tagsToSync: string[],
  ): Promise<void> {
    const conflictPath = this.buildConflictPath(localPath, vaultId);
    await this.ensureParentFolders(conflictPath);
    let finalPath = conflictPath;
    let suffix = 1;
    while (this.app.vault.getAbstractFileByPath(finalPath) !== null) {
      finalPath = conflictPath.replace(/\.md$/i, `-${suffix}.md`);
      suffix += 1;
    }

    this.markPathIgnored(finalPath);
    const sanitizedContent = this.stripSyncTagsFromContent(content, tagsToSync);
    await this.app.vault.create(finalPath, sanitizedContent);
  }

  private buildConflictPath(localPath: string, vaultId: string): string {
    const normalizedPath = normalizeLocalPath(localPath);
    const slashIndex = normalizedPath.lastIndexOf("/");
    const directory = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) : "";
    const filename = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
    const baseName = filename.replace(/\.md$/i, "");
    const safeVaultId = (vaultId || "vault").replace(/[^a-zA-Z0-9_-]/g, "-");

    const now = new Date();
    const timestamp = [
      now.getFullYear(),
      this.pad(now.getMonth() + 1),
      this.pad(now.getDate()),
    ].join("-") +
      "_" +
      `${this.pad(now.getHours())}-${this.pad(now.getMinutes())}`;

    const conflictName = `${baseName} (conflict ${safeVaultId} ${timestamp}).md`;
    return directory ? `${directory}/${conflictName}` : conflictName;
  }

  private stripSyncTagsFromContent(content: string, tagsToSync: string[]): string {
    const syncTagSet = this.buildSyncTagSet(tagsToSync);
    if (syncTagSet.size === 0) {
      return content;
    }

    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/);
    if (!frontmatterMatch) {
      return this.stripInlineSyncTags(content, syncTagSet);
    }

    const newline = frontmatterMatch[0].includes("\r\n") ? "\r\n" : "\n";
    const frontmatterBody = frontmatterMatch[1];
    const remainingBody = content.slice(frontmatterMatch[0].length);
    const strippedFrontmatter = this.stripSyncTagsFromFrontmatter(frontmatterBody, syncTagSet, newline);
    const strippedBody = this.stripInlineSyncTags(remainingBody, syncTagSet);

    return `---${newline}${strippedFrontmatter}${newline}---${newline}${strippedBody}`;
  }

  private stripSyncTagsFromFrontmatter(
    frontmatterBody: string,
    syncTagSet: Set<string>,
    newline: string,
  ): string {
    const lines = frontmatterBody.split(/\r?\n/);
    const output: string[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const match = line.match(/^(\s*)(tags?)\s*:\s*(.*)$/i);
      if (!match) {
        output.push(line);
        continue;
      }

      const indent = match[1];
      const key = match[2];
      const rawValue = match[3].trim();
      if (!rawValue) {
        const keptItems: string[] = [];
        i += 1;
        while (i < lines.length) {
          const current = lines[i];
          if (!(current.startsWith(`${indent}  `) || current.startsWith(`${indent}\t`))) {
            i -= 1;
            break;
          }

          const itemMatch = current.match(/^\s*-\s*(.+?)\s*$/);
          if (!itemMatch) {
            keptItems.push(current);
            i += 1;
            continue;
          }

          const normalizedItem = this.normalizeTagForMatch(itemMatch[1]);
          if (!syncTagSet.has(normalizedItem)) {
            keptItems.push(current);
          }
          i += 1;
        }

        if (keptItems.length > 0) {
          output.push(`${indent}${key}:`);
          output.push(...keptItems);
        }
        continue;
      }

      const strippedValue = this.stripSyncTagsFromFrontmatterValue(rawValue, syncTagSet);
      if (strippedValue !== null) {
        output.push(`${indent}${key}: ${strippedValue}`);
      }
    }

    return output.join(newline);
  }

  private stripSyncTagsFromFrontmatterValue(
    rawValue: string,
    syncTagSet: Set<string>,
  ): string | null {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const listItems = trimmed
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const kept = listItems.filter((item) => !syncTagSet.has(this.normalizeTagForMatch(item)));
      if (kept.length === 0) {
        return null;
      }
      return `[${kept.join(", ")}]`;
    }

    if (trimmed.includes(",")) {
      const listItems = trimmed
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const kept = listItems.filter((item) => !syncTagSet.has(this.normalizeTagForMatch(item)));
      if (kept.length === 0) {
        return null;
      }
      return kept.join(", ");
    }

    return syncTagSet.has(this.normalizeTagForMatch(trimmed)) ? null : trimmed;
  }

  private stripInlineSyncTags(body: string, syncTagSet: Set<string>): string {
    const stripped = body.replace(
      /(^|[\s([{>"'`])#([A-Za-z0-9_/-]+)/gm,
      (fullMatch, prefix: string, tagValue: string) => {
        const normalizedTag = this.normalizeTagForMatch(tagValue);
        if (syncTagSet.has(normalizedTag)) {
          return prefix;
        }
        return fullMatch;
      },
    );

    return stripped.replace(/[ \t]+\n/g, "\n");
  }

  private buildSyncTagSet(tagsToSync: string[]): Set<string> {
    const set = new Set<string>();
    for (const rawTag of tagsToSync) {
      const normalized = this.normalizeTagForMatch(rawTag);
      if (normalized) {
        set.add(normalized);
      }
    }
    return set;
  }

  private normalizeTagForMatch(rawTag: string): string {
    return rawTag
      .trim()
      .replace(/^#+/, "")
      .replace(/^['"]+|['"]+$/g, "")
      .toLowerCase();
  }

  private parseRemoteTime(raw: string): number {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    return Date.now();
  }

  private markPathIgnored(path: string): void {
    this.ignoredPaths.set(normalizeLocalPath(path), Date.now() + 5000);
  }

  private isPathIgnored(path: string): boolean {
    const now = Date.now();
    for (const [trackedPath, expiresAt] of this.ignoredPaths.entries()) {
      if (expiresAt < now) {
        this.ignoredPaths.delete(trackedPath);
      }
    }

    const normalized = normalizeLocalPath(path);
    const expiresAt = this.ignoredPaths.get(normalized);
    return typeof expiresAt === "number" && expiresAt >= now;
  }

  private restartPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const settings = this.getSettings();
    const intervalMs = Math.max(5, settings.pollIntervalSeconds) * 1000;
    this.pollTimer = window.setInterval(() => {
      this.enqueueSync("poll", true);
    }, intervalMs);
  }

  private isConfigured(settings: TagSyncSettings): boolean {
    return Boolean(
      settings.tagsToSync.length > 0 &&
        settings.dropboxAccessToken.trim() &&
        settings.remoteBasePath.trim(),
    );
  }

  private updateStatus(status: string): void {
    this.onStatusChange?.(status);
  }

  private pad(value: number): string {
    return String(value).padStart(2, "0");
  }
}
