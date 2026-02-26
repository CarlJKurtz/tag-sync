import { DEFAULT_SYNC_STATE, type FileSyncState, type SyncStateData } from "../types";
import { normalizeLocalPath } from "./pathUtils";

type LoadSyncState = () => Promise<SyncStateData | undefined>;
type SaveSyncState = (state: SyncStateData) => Promise<void>;

function cloneState(state: SyncStateData): SyncStateData {
  return {
    cursor: state.cursor,
    files: { ...state.files },
  };
}

function normalizeLoadedState(state: SyncStateData | undefined): SyncStateData {
  if (!state) {
    return cloneState(DEFAULT_SYNC_STATE);
  }

  return {
    cursor: state.cursor,
    files: state.files ?? {},
  };
}

export class StateStore {
  private readonly loadState: LoadSyncState;
  private readonly saveStateFn: SaveSyncState;
  private loaded = false;
  private state: SyncStateData = cloneState(DEFAULT_SYNC_STATE);

  constructor(loadState: LoadSyncState, saveStateFn: SaveSyncState) {
    this.loadState = loadState;
    this.saveStateFn = saveStateFn;
  }

  async initialize(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.state = normalizeLoadedState(await this.loadState());
    this.loaded = true;
  }

  getCursor(): string | undefined {
    return this.state.cursor;
  }

  setCursor(cursor: string | undefined): void {
    this.state.cursor = cursor;
  }

  getFile(path: string): FileSyncState | undefined {
    return this.state.files[normalizeLocalPath(path)];
  }

  setFile(path: string, value: FileSyncState): void {
    this.state.files[normalizeLocalPath(path)] = value;
  }

  deleteFile(path: string): void {
    delete this.state.files[normalizeLocalPath(path)];
  }

  allFiles(): Array<[string, FileSyncState]> {
    return Object.entries(this.state.files);
  }

  hasFile(path: string): boolean {
    return normalizeLocalPath(path) in this.state.files;
  }

  async save(): Promise<void> {
    await this.saveStateFn(cloneState(this.state));
  }
}

