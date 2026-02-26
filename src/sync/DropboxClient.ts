import { normalizeRemoteBasePath } from "./pathUtils";

const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

export interface DropboxFileMetadata {
  ".tag": "file";
  name: string;
  path_display: string;
  path_lower: string;
  rev: string;
  server_modified: string;
  size: number;
}

export interface DropboxDeletedMetadata {
  ".tag": "deleted";
  name?: string;
  path_display?: string;
  path_lower: string;
}

export type DropboxEntry = DropboxFileMetadata | DropboxDeletedMetadata;

interface ListFolderResponse {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const DROPBOX_UNREACHABLE_MESSAGE = "Can’t reach Dropbox";

export class DropboxReachabilityError extends Error {
  constructor(message = DROPBOX_UNREACHABLE_MESSAGE) {
    super(message);
    this.name = "DropboxReachabilityError";
  }
}

function toHeaderSafeJson(value: unknown): string {
  const json = JSON.stringify(value);
  // Dropbox-API-Arg must be HTTP header safe:
  // escape non-ASCII and 0x7F as \uXXXX sequences.
  return json.replace(/[\u007f-\uffff]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export class DropboxClient {
  private readonly token: string;

  constructor(accessToken: string) {
    this.token = accessToken;
  }

  async upload(remotePath: string, content: string): Promise<DropboxFileMetadata> {
    const path = normalizeRemoteBasePath(remotePath);
    const arg = {
      path,
      mode: "overwrite",
      mute: true,
    };

    const response = await this.fetchWithRetry(
      `${CONTENT_BASE}/files/upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Dropbox-API-Arg": toHeaderSafeJson(arg),
          "Content-Type": "application/octet-stream",
        },
        body: new TextEncoder().encode(content),
      },
      `upload ${path}`,
    );

    const body = (await response.json()) as DropboxFileMetadata;
    return body;
  }

  async download(remotePath: string): Promise<{ metadata: DropboxFileMetadata; content: string }> {
    const path = normalizeRemoteBasePath(remotePath);
    const response = await this.fetchWithRetry(
      `${CONTENT_BASE}/files/download`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Dropbox-API-Arg": toHeaderSafeJson({ path }),
        },
      },
      `download ${path}`,
    );

    const metadataHeader = response.headers.get("Dropbox-API-Result");
    if (!metadataHeader) {
      throw new Error(`Dropbox download missing metadata header for ${path}`);
    }

    const metadata = JSON.parse(metadataHeader) as DropboxFileMetadata;
    const buffer = await response.arrayBuffer();
    const content = new TextDecoder().decode(buffer);
    return { metadata, content };
  }

  async listDelta(
    remoteBasePath: string,
    cursor?: string,
  ): Promise<{ entries: DropboxEntry[]; cursor: string }> {
    const entries: DropboxEntry[] = [];
    let nextCursor = cursor;

    let response = cursor
      ? await this.postJson<ListFolderResponse>("/files/list_folder/continue", { cursor })
      : await this.postJson<ListFolderResponse>("/files/list_folder", {
          path: this.toListFolderPath(remoteBasePath),
          recursive: true,
          include_deleted: true,
        });

    entries.push(...response.entries);
    nextCursor = response.cursor;

    while (response.has_more) {
      response = await this.postJson<ListFolderResponse>("/files/list_folder/continue", {
        cursor: nextCursor,
      });
      entries.push(...response.entries);
      nextCursor = response.cursor;
    }

    return { entries, cursor: nextCursor };
  }

  async delete(remotePath: string): Promise<boolean> {
    const path = normalizeRemoteBasePath(remotePath);
    const response = await this.fetchWithRetry(
      `${API_BASE}/files/delete_v2`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path }),
      },
      `delete ${path}`,
      { allowNotFound: true },
    );

    if (response.status === 409) {
      return false;
    }

    return true;
  }

  private async postJson<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchWithRetry(
      `${API_BASE}${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      endpoint,
    );

    return (await response.json()) as T;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    label: string,
    options?: { allowNotFound?: boolean },
  ): Promise<Response> {
    const maxAttempts = 6;
    let attempt = 1;
    let lastNetworkError: Error | undefined;

    while (attempt <= maxAttempts) {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        lastNetworkError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxAttempts) {
          throw new DropboxReachabilityError();
        }

        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 30000);
        await delay(delayMs);
        attempt += 1;
        continue;
      }

      if (response.ok) {
        return response;
      }

      if (options?.allowNotFound && response.status === 409) {
        const errorText = await response.text();
        if (errorText.includes("not_found")) {
          return response;
        }
      }

      const responseText = await response.text();
      if (!isTransientStatus(response.status)) {
        throw new Error(`Dropbox ${label} failed (${response.status}): ${responseText}`);
      }

      if (attempt === maxAttempts) {
        if (response.status >= 500) {
          throw new DropboxReachabilityError();
        }
        throw new Error(`Dropbox ${label} failed (${response.status}): ${responseText}`);
      }

      const retryAfter = Number(response.headers.get("Retry-After"));
      const delayMs = Number.isFinite(retryAfter)
        ? Math.max(1000, retryAfter * 1000)
        : Math.min(1000 * 2 ** (attempt - 1), 30000);
      await delay(delayMs);
      attempt += 1;
    }

    if (lastNetworkError) {
      throw new DropboxReachabilityError();
    }

    throw new Error(`Dropbox ${label} failed for unknown reason`);
  }

  private toListFolderPath(remoteBasePath: string): string {
    const normalized = normalizeRemoteBasePath(remoteBasePath);
    return normalized === "/" ? "" : normalized;
  }
}
