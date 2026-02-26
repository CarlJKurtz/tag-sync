export function normalizeLocalPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function normalizeRemoteBasePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

export function toRemotePath(remoteBasePath: string, localPath: string): string {
  const base = normalizeRemoteBasePath(remoteBasePath);
  const local = normalizeLocalPath(localPath);
  if (base === "/") {
    return `/${local}`;
  }

  return `${base}/${local}`.replace(/\/{2,}/g, "/");
}

export function toLocalPath(remoteBasePath: string, remotePath: string): string | null {
  const base = normalizeRemoteBasePath(remoteBasePath);
  const normalizedRemote = normalizeRemoteBasePath(remotePath);

  if (base === "/") {
    return normalizedRemote.replace(/^\/+/, "");
  }

  if (normalizedRemote === base) {
    return null;
  }

  if (!normalizedRemote.startsWith(`${base}/`)) {
    return null;
  }

  return normalizedRemote.slice(base.length + 1);
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

export function isConflictCopyPath(path: string): boolean {
  return /\s\(conflict [^)]+\)(-\d+)?\.md$/i.test(normalizeLocalPath(path));
}
