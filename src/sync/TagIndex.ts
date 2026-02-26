import { App, type CachedMetadata, TFile } from "obsidian";
import { normalizeTag, normalizeTags } from "../settings";
import { isConflictCopyPath, normalizeLocalPath } from "./pathUtils";

function globToRegex(glob: string): RegExp {
  const normalized = normalizeLocalPath(glob.trim()).replace(/^\/+/, "");
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___DOUBLE_STAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLE_STAR___/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function extractFrontmatterTags(frontmatter: Record<string, unknown> | null | undefined): string[] {
  if (!frontmatter) {
    return [];
  }

  const source = frontmatter.tags ?? frontmatter.tag;
  if (!source) {
    return [];
  }

  if (Array.isArray(source)) {
    return source.map((item) => normalizeTag(String(item)));
  }

  if (typeof source === "string") {
    return source
      .split(/[,\s]+/)
      .map((value) => normalizeTag(value))
      .filter(Boolean);
  }

  return [];
}

function extractCacheTags(cache: CachedMetadata | null): string[] {
  if (!cache) {
    return [];
  }

  const inlineTags = (cache.tags ?? []).map((tag) => normalizeTag(tag.tag));
  const frontmatterTags = extractFrontmatterTags(
    cache.frontmatter as Record<string, unknown> | undefined,
  );

  return [...inlineTags, ...frontmatterTags].filter(Boolean);
}

export class TagIndex {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  buildTaggedFileSet(tagsToSync: string[], ignoreGlobs: string[]): Set<string> {
    const normalizedTags = new Set(normalizeTags(tagsToSync));
    if (normalizedTags.size === 0) {
      return new Set();
    }

    const ignoreMatchers = ignoreGlobs.filter(Boolean).map(globToRegex);
    const result = new Set<string>();

    for (const file of this.app.vault.getMarkdownFiles()) {
      const localPath = normalizeLocalPath(file.path);
      if (ignoreMatchers.some((matcher) => matcher.test(localPath))) {
        continue;
      }
      if (isConflictCopyPath(localPath)) {
        continue;
      }

      if (this.fileHasAnyTag(file, normalizedTags)) {
        result.add(localPath);
      }
    }

    return result;
  }

  fileHasAnyTag(file: TFile, normalizedTags: Set<string>): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    const fileTags = extractCacheTags(cache);
    if (fileTags.length === 0) {
      return false;
    }

    return fileTags.some((tag) => normalizedTags.has(tag));
  }
}
