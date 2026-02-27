import { normalizeRemoteBasePath } from "./pathUtils";

const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";
const OAUTH_BASE = "https://api.dropbox.com";
const OAUTH_AUTHORIZE_BASE = "https://www.dropbox.com/oauth2/authorize";

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

export interface DropboxTokenRefreshResult {
  accessToken: string;
  expiresInSeconds: number;
}

export interface DropboxAuthorizationCodeExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
}

interface DropboxClientOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken?: () => Promise<string>;
}

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

function getRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter)) {
    return Math.max(1000, retryAfter * 1000);
  }
  return Math.min(1000 * 2 ** (attempt - 1), 30000);
}

const DROPBOX_UNREACHABLE_MESSAGE = "Can’t reach Dropbox";

export class DropboxReachabilityError extends Error {
  constructor(message = DROPBOX_UNREACHABLE_MESSAGE) {
    super(message);
    this.name = "DropboxReachabilityError";
  }
}

class DropboxCursorResetError extends Error {
  constructor() {
    super("Dropbox cursor reset requested");
    this.name = "DropboxCursorResetError";
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
  private readonly getAccessToken: () => Promise<string>;
  private readonly refreshAccessToken?: () => Promise<string>;

  constructor(options: DropboxClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.refreshAccessToken = options.refreshAccessToken;
  }

  static async refreshAccessToken(params: {
    clientId: string;
    refreshToken: string;
  }): Promise<DropboxTokenRefreshResult> {
    const clientId = params.clientId.trim();
    const refreshToken = params.refreshToken.trim();
    if (!clientId || !refreshToken) {
      throw new Error("Dropbox app key and refresh token are required to refresh access tokens.");
    }

    const tokenResult = await this.requestOAuthToken(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }));

    return {
      accessToken: tokenResult.accessToken,
      expiresInSeconds: tokenResult.expiresInSeconds,
    };
  }

  static buildAuthorizeUrl(params: { clientId: string; codeChallenge: string }): string {
    const clientId = params.clientId.trim();
    const codeChallenge = params.codeChallenge.trim();
    if (!clientId) {
      throw new Error("Dropbox app key is required to generate an OAuth authorization URL.");
    }
    if (!codeChallenge) {
      throw new Error("OAuth PKCE code challenge is required.");
    }

    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      token_access_type: "offline",
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
    });
    return `${OAUTH_AUTHORIZE_BASE}?${query.toString()}`;
  }

  static async exchangeAuthorizationCode(params: {
    clientId: string;
    authorizationCode: string;
    codeVerifier: string;
  }): Promise<DropboxAuthorizationCodeExchangeResult> {
    const clientId = params.clientId.trim();
    const authorizationCode = params.authorizationCode.trim();
    const codeVerifier = params.codeVerifier.trim();
    if (!clientId) {
      throw new Error("Dropbox app key is required.");
    }
    if (!authorizationCode) {
      throw new Error("Authorization code is required.");
    }
    if (!codeVerifier) {
      throw new Error("OAuth code verifier is required. Generate a new OAuth link and retry.");
    }

    return this.requestOAuthToken(new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: clientId,
      code_verifier: codeVerifier,
    }));
  }

  private static async requestOAuthToken(
    bodyParams: URLSearchParams,
  ): Promise<DropboxAuthorizationCodeExchangeResult> {
    const body = bodyParams.toString();
    const maxAttempts = 6;
    let attempt = 1;
    let lastNetworkError: Error | undefined;

    while (attempt <= maxAttempts) {
      let response: Response;
      try {
        response = await fetch(`${OAUTH_BASE}/oauth2/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });
      } catch (error) {
        lastNetworkError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxAttempts) {
          throw new DropboxReachabilityError();
        }
        await delay(Math.min(1000 * 2 ** (attempt - 1), 30000));
        attempt += 1;
        continue;
      }

      if (response.ok) {
        const payload = (await response.json()) as {
          access_token?: unknown;
          refresh_token?: unknown;
          expires_in?: unknown;
        };
        const accessToken =
          typeof payload.access_token === "string" ? payload.access_token.trim() : "";
        const expiresInSeconds =
          typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
        const refreshToken =
          typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : undefined;

        if (!accessToken || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
          throw new Error("Dropbox OAuth token endpoint returned an invalid response.");
        }

        return {
          accessToken,
          refreshToken,
          expiresInSeconds,
        };
      }

      const responseText = await response.text();
      if (!isTransientStatus(response.status) || attempt === maxAttempts) {
        throw new Error(`Dropbox OAuth token request failed (${response.status}): ${responseText}`);
      }

      await delay(getRetryDelayMs(response, attempt));
      attempt += 1;
    }

    if (lastNetworkError) {
      throw new DropboxReachabilityError();
    }
    throw new Error("Dropbox OAuth token request failed for unknown reason");
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
    try {
      return await this.listDeltaInternal(remoteBasePath, cursor);
    } catch (error) {
      if (!(error instanceof DropboxCursorResetError)) {
        throw error;
      }

      // Dropbox can invalidate stored cursors at any time.
      // Recover by doing a fresh full listing and continuing from the new cursor.
      return this.listDeltaInternal(remoteBasePath, undefined);
    }
  }

  private async listDeltaInternal(
    remoteBasePath: string,
    cursor?: string,
  ): Promise<{ entries: DropboxEntry[]; cursor: string }> {
    const entries: DropboxEntry[] = [];
    let nextCursor = cursor;

    let response = cursor
      ? await this.postListFolderContinue(cursor)
      : await this.postListFolder(remoteBasePath);

    entries.push(...response.entries);
    nextCursor = response.cursor;

    while (response.has_more) {
      response = await this.postListFolderContinue(nextCursor);
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
    return this.postJsonWithOptions(endpoint, body);
  }

  private async postListFolder(remoteBasePath: string): Promise<ListFolderResponse> {
    return this.postJson("/files/list_folder", {
      path: this.toListFolderPath(remoteBasePath),
      recursive: true,
      include_deleted: true,
    });
  }

  private async postListFolderContinue(cursor: string): Promise<ListFolderResponse> {
    return this.postJsonWithOptions(
      "/files/list_folder/continue",
      { cursor },
      { allowCursorReset: true },
    );
  }

  private async postJsonWithOptions<T>(
    endpoint: string,
    body: Record<string, unknown>,
    options?: { allowCursorReset?: boolean },
  ): Promise<T> {
    const response = await this.fetchWithRetry(
      `${API_BASE}${endpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      endpoint,
      options,
    );

    return (await response.json()) as T;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    label: string,
    options?: { allowNotFound?: boolean; allowCursorReset?: boolean },
  ): Promise<Response> {
    const maxAttempts = 6;
    let attempt = 1;
    let lastNetworkError: Error | undefined;
    let refreshedAfter401 = false;
    let accessToken = await this.resolveAccessToken();

    while (attempt <= maxAttempts) {
      let response: Response;
      try {
        const headers = new Headers(init.headers ?? {});
        headers.set("Authorization", `Bearer ${accessToken}`);
        response = await fetch(url, {
          ...init,
          headers,
        });
      } catch (error) {
        lastNetworkError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxAttempts) {
          throw new DropboxReachabilityError();
        }

        await delay(Math.min(1000 * 2 ** (attempt - 1), 30000));
        attempt += 1;
        continue;
      }

      if (response.ok) {
        return response;
      }

      if (response.status === 401 && this.refreshAccessToken && !refreshedAfter401) {
        accessToken = await this.refreshAccessToken();
        refreshedAfter401 = true;
        continue;
      }

      let responseText: string | undefined;
      if (response.status === 409 && (options?.allowNotFound || options?.allowCursorReset)) {
        responseText = await response.text();

        if (options?.allowNotFound && responseText.includes("not_found")) {
          return response;
        }

        if (options?.allowCursorReset && this.isCursorResetResponse(responseText)) {
          throw new DropboxCursorResetError();
        }
      }

      if (typeof responseText !== "string") {
        responseText = await response.text();
      }

      if (!isTransientStatus(response.status)) {
        throw new Error(`Dropbox ${label} failed (${response.status}): ${responseText}`);
      }

      if (attempt === maxAttempts) {
        if (response.status >= 500) {
          throw new DropboxReachabilityError();
        }
        throw new Error(`Dropbox ${label} failed (${response.status}): ${responseText}`);
      }

      await delay(getRetryDelayMs(response, attempt));
      attempt += 1;
    }

    if (lastNetworkError) {
      throw new DropboxReachabilityError();
    }

    throw new Error(`Dropbox ${label} failed for unknown reason`);
  }

  private async resolveAccessToken(): Promise<string> {
    const token = (await this.getAccessToken()).trim();
    if (!token) {
      throw new Error("Dropbox access token is missing.");
    }
    return token;
  }

  private toListFolderPath(remoteBasePath: string): string {
    const normalized = normalizeRemoteBasePath(remoteBasePath);
    return normalized === "/" ? "" : normalized;
  }

  private isCursorResetResponse(responseText: string): boolean {
    const lowered = responseText.toLowerCase();
    return lowered.includes("reset/") || lowered.includes("\"reset\"") || lowered.includes(".tag: reset");
  }
}
