# TagSync
**TagSync syncs notes with specific tags between Obsidian vaults via Dropbox.** Use the same tags in multiple vaults to create a shared sync channel for selected notes only.

TagSync is a sync plugin for [Obsidian.md](https://obsidian.md/).

### Use case
I developed this plugin to **sync notes** about people **between my personal and work vaults**. This keeps personal and work-related notes separated, while all notes tagged with `#person` are synced between both vaults. This can be easily extended to handle any other tag or type of Markdown note.

## Features
- Syncs only notes with configured sync tags.
- Uses Obsidian metadata cache for inline and frontmatter tags.
- Two-way sync: local -> Dropbox and Dropbox -> local.
- Conflict-safe behavior: creates conflict copies instead of silently dropping content.
- Conflict copies are stripped of sync tags to avoid conflict loops.
- Works on desktop and mobile.

### Commands

| Command                   | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `Sync now`                | Run an immediate sync pass.                             |
| `Rebuild index`           | Rebuild tag scope and sync from current metadata.       |
| `Resync all tagged files` | Force re-upload all tagged notes, even unchanged files. |
| `Pause/Resume sync`       | Temporarily pause or resume syncing.                    |

### Ribbon action
- Sync icon triggers **Sync now**.


## Installation

### Requirements
- Obsidian `1.5.0+`
- Dropbox account
- Dropbox API app + app key
  
### Installation
1. Download the [latest release](https://github.com/CarlJKurtz/tag-sync/releases).
2. Extract the zip. It should produce a single ready-to-install `tag-sync` plugin folder (not loose files).
3. In Obsidian, open `Settings -> Community plugins`
4. Click the folder icon to open the third-party plugins directory.
5. Drag and drop or move the extracted `tag-sync` folder into that plugins directory.
6. Back in Obsidian Community plugins, reload plugins and enable **TagSync**.

### Dropbox Setup
1. Create a [Dropbox App](https://www.dropbox.com/developers/apps).
2. Use `Scoped access`.
3. Enable required file scopes:
   - `files.metadata.read`
   - `files.content.read`
   - `files.content.write`
4. Copy the app key.
5. In TagSync settings:
   - Enter `Dropbox app key`
   - Click `Generate + open`
   - Approve Dropbox access
   - Paste the returned authorization code
   - Click `Exchange code`
6. TagSync stores `Dropbox refresh token`, `Dropbox access token`, and expiry automatically.

## Settings
| Setting                         | Type         | Required | Default | Description                                                                   |
| ------------------------------- | ------------ | -------- | ------- | ----------------------------------------------------------------------------- |
| `Tags to sync`                  | string list  | Yes      | `[]`    | Comma/newline list of tags, with or without `#`.                              |
| `Dropbox app key`               | string       | Yes      | `""`    | Dropbox app key used for OAuth setup and token refresh.                       |
| `Dropbox refresh token`         | string       | Yes*     | `""`    | Long-lived token used to auto-refresh access tokens (set via OAuth helper).   |
| `Access token expires at (UTC)` | ISO datetime | No       | `""`    | Auto-managed expiration timestamp for current access token.                   |
| `Poll interval (seconds)`       | number       | Yes      | `30`    | Remote refresh interval. Minimum `5`.                                         |
| `Max upload size (MB)`          | number       | Yes      | `20`    | Tagged files larger than this are skipped. Minimum `1`.                       |
| `Remote base path`              | string       | No       | `/`     | Dropbox base folder for synced notes. Keep identical across synced vaults.\** |


\*`Dropbox refresh token` is automatically set by the in-plugin OAuth code exchange flow.

\** Keep `Remote base path` identical across all vaults in the same sync channel. If you change it, run **Resync all tagged files** in each synced vault.

## Conflict Behavior
If local and remote diverge before sync, the plugin creates a local conflict copy `NoteName (conflict <vaultId> YYYY-MM-DD_HH-MM).md`. It keeps the original file path stable and resolves the main file by latest timestamp policy.

### Additional safeguards
Conflict copies have sync tags removed (inline + frontmatter), so they do not re-enter normal sync scope. If local and remote content are identical, no conflict copy is created.

### iCloud / Same-Vault Multi-Device Notes
If the same iCloud-backed vault is open on multiple devices simultaneously, timing and mtime drift can still create extra churn.

Possible fixes:
- Edit primarily on one device at a time.
- Use `Pause/Resume sync` on secondary devices.
- Keep poll interval reasonable for your workflow.

## Troubleshooting for Repeated Conflict Copies
- Ensure all vaults use identical tag + remote path settings.
- Verify latest plugin build is installed on all devices.
- Avoid editing same file simultaneously across devices.

## Troubleshooting for "Folder already exists"
- On case-sensitive path handling, cases like `people` and `People` are treated as different paths and can collide during sync/move operations.
- If sync reports that a folder already exists, normalize folder naming to a single case in your vault and Dropbox (for example, rename `people` -> `People`).
- After renaming, run `Resync all tagged files` once to reconcile paths.

## Security
Your Dropbox auth values (access token and optional refresh token) are stored unencrypted in the Obsidian plugin data on your machine.


## Contributing, Support & License

### Contributing

Contributions are greatly appreciated! You can create an [issue](https://github.com/CarlJKurtz/tag-sync/issues) to report a bug, suggest an improvement for this plugin, ask a question, etc. You can make a [pull request](https://github.com/CarlJKurtz/tag-sync/pulls) to contribute to this plugin development.

### Acknowledgements
This plugin was created with the help of AI, specifically GPT-5.3-Codex.

### Testing
The plugin was tested only in a macOS and iOS environment. TagSync should be OS-agnostic, but it was not tested in other environments.

### Support
TagSync is entirely free of charge for both commercial and private use. If you **enjoy using TagSync** and it **solved a problem** for you, please consider sharing this project with a fellow human, or even support the project by sponsoring it here on GitHub.

Happy syncing!

### License
TagSync is licensed under the MIT License. See `LICENSE.md` for more information.
