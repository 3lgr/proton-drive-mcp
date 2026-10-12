# proton-drive-mcp (hardened fork)

[![CI](https://github.com/3lgr/proton-drive-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/3lgr/proton-drive-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet)](https://modelcontextprotocol.io)

An MCP server (and companion CLI) that lets an AI assistant such as Claude work with **Proton Drive** and **Proton
Photos** through the official `proton-drive` command-line client: browse, search, upload, download, share, trash and
restore, with end-to-end encryption left to Proton's own CLI. This fork keeps the tools of the upstream project (minus `drive_write_file`, removed on purpose in 2.0.1) and
puts the safety controls **in the server, where a manipulated model cannot talk its way past them**.

> **Unofficial.** This is an independent fork of [googlarz/proton-drive-mcp](https://github.com/googlarz/proton-drive-mcp)
> (MIT, v1.5.2). It is **not affiliated with, endorsed by or supported by Proton AG**. "Proton" and "Proton Drive" are
> trademarks of Proton AG. You need the official CLI installed and signed in; this project never handles your password.
> Security issues: see [SECURITY.md](SECURITY.md).

## Why this fork

An assistant that can delete, share and download files is only as safe as the weakest rule that a prompt injection
(a file name, an invitation text, a document) can talk it out of. Version 2.0.0 moves those rules into code:

| Area | What changed |
|---|---|
| **Consent the model cannot fake** | One gate table (`src/policy/gates.ts`). With a client that supports MCP elicitation the human is **always** asked, whatever `confirmed` the model sent. Without it, irreversible or outward-facing tools (empty trash, permanent delete, sharing, public links, logout, invitation accept/reject, local `remove`) **fail closed** unless you set `PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE=1`. Prompts show values with every non-ASCII character escaped. |
| **Local files** | Downloads go through a private staging directory and a pure plan (no symlinks, hardlinks, FIFOs, dot-names, traversal or overwrites; `remove` never deletes a non-empty folder). Uploads run from a frozen, hashed snapshot of the validated tree (no secrets, no symlinks), bound to what was approved. Wider credential denylist; `PROTON_DRIVE_LOCAL_ROOT` narrows access without switching the denylist off; case-insensitive on macOS/Windows. |
| **Remote paths** | Drive roots are never the subject of a mutation; `drive_delete` accepts only `/trash/<name>` or `/photos-trash/<name>`. |
| **Sharing policy** | Public links through the tools must be viewer-only, password-protected (8+ characters) and expire within 90 days; no `admin` invitations; optional domain allowlist; strict e-mail/role canonicalisation (`PROTON_DRIVE_SHARE_POLICY`, `PROTON_DRIVE_SHARE_ALLOWED_DOMAINS`). |
| **Untrusted content** | Everything that carries text written by others (names, paths, invitations, file content) is returned in an `{untrusted, source, notice, content}` envelope, sanitised by a linear Unicode-category scanner with visible `⟦removed:…⟧` markers and a per-response delimiter.  |
| **The CLI binary** | Run by absolute path with a minimal environment; optional `PROTON_DRIVE_BIN_SHA256` pin: only a verified private copy is executed. `doctor` warns about unpinned, PATH-resolved or group/world-writable binaries. |
| **Parsing** | Document parsing was **removed** (PDF/DOCX). `drive_read_content` reads plain UTF-8 text only, with a byte cap enforced while downloading; binaries are refused with a clear error. Smaller attack surface, fewer dependencies. |
| **Logs and errors** | Allowlist model: error codes with fixed text and length+hash markers instead of CLI output, paths, links or e-mail addresses. |
| **Supply chain** | `@modelcontextprotocol/sdk` updated and `proxy-addr` overridden (`npm audit` clean); release workflows split into verify/publish jobs, pinned npm, SHA256SUMS and build-provenance attestation, no overwrites; Docker base pinned by digest; manual `npm publish` is blocked. |
| **Code** | `index.ts` and `drive.ts` split into cohesive modules; `npm run test:coverage`. |

### New environment variables

| Variable | Purpose |
|---|---|
| `PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE` | Accept prompt-level `confirmed` for irreversible tools when the client cannot ask the human. |
| `PROTON_DRIVE_SHARE_POLICY` / `PROTON_DRIVE_SHARE_ALLOWED_DOMAINS` | Sharing policy and invitation domain allowlist. |
| `PROTON_DRIVE_BIN_SHA256` | Pin the `proton-drive` binary by hash (verified private copy is executed). |
| `PROTON_DRIVE_PASS_ENV` | Extra environment names (or `PREFIX_*`) to pass to the CLI. |
| `PROTON_DRIVE_UPLOAD_MAX_BYTES` / `PROTON_DRIVE_DOWNLOAD_MAX_BYTES` | Ceilings for the upload snapshot and for one download. |

The full table is under [Environment variables](#environment-variables). Behaviour changes that can break existing
setups are listed in the [CHANGELOG](CHANGELOG.md) under 2.0.0 and 2.0.1.

### Fixed in 2.0.1 (independent final review)

- **Shared destinations (N-01).** The "destination is already shared" gate now fails closed: a sharing lookup that
  fails counts as shared (the human is asked, and the prompt says the state could not be verified), the destination
  **and every ancestor** are checked, and the same gate covers `drive_upload`, `photos_add_to_album` (shared albums)
  and bulk moves, besides `drive_move` / `drive_copy`. `photos_upload` goes to your private timeline and has no
  destination to gate.
- **Sync-folder tools (N-02).** `drive_write_file` was **removed** (breaking, deliberate): a model that can write into
  a folder that other programs trust (git hooks, shell rc files, editor tasks, CI workflows) can plant code, and that
  cannot be made safe by a denylist. `drive_read_file` compares names the way the file system does and refuses known
  secrets. To put a file in Drive use `drive_upload` from the allowlisted local folder.
- **Delete by uid (N-03).** The approval prompt shows the item's resolved, escaped name, not just a uid; names that
  resolve to `.` or `..` are refused.
- **Scratch directories (N-05, N-07).** There is no fixed or shared temp location: each process creates its own random
  0700 directory under the OS temp dir (or, if that is unusable, `<allowed root>/.pdmcp-private-<random>`), verified as a
  real directory of yours, and every operation's scratch directory lives inside it. The byte and entry ceiling is
  enforced **while** the CLI writes (the transfer is aborted the moment it is crossed); cleanup runs in `finally` and at
  exit, entry by entry without following links. Nothing sweeps old directories, so the verified CLI copy of another
  running instance and your own folders are never touched.
- **`PROTON_DRIVE_PASS_ENV` (N-08).** `*` alone and prefixes shorter than 3 characters are refused; any use is listed by
  `doctor`.

## Quick start

1. Install the official [Proton Drive CLI](https://proton.me/download/drive/cli/index.html), then sign in once: `proton-drive auth login`.
2. Install this server from the repository (see [Install](#install)) and run `proton-drive-cli doctor`.
3. Connect your MCP client (Claude Code, Claude Desktop) as shown under [Connect to Claude Desktop](#connect-to-claude-desktop).
4. Try: "Find files named *invoice*." (`drive_search`), "What is using my Drive space?" (`drive_usage`), "Who has access
   to my shared folders?" (`drive_sharing_audit`), "Tidy up /Downloads, show me a plan first." (`drive_bulk_move`).

**Use a client that supports elicitation** (Claude Code does). Without it the irreversible tools are refused by design.

## Why a server and not just the CLI?

For sync, backups and cron jobs, use the official CLI directly. This project wraps it so an assistant can drive it, and
adds what the CLI lacks: search, tree, usage, duplicates, sharing audit, content reading and a sync plan, all computed
locally so encryption stays intact. It also smooths over CLI rough edges (per-item failures with exit code 0, random
order, `database is locked`) and, in this fork, enforces the policies above. It needs the official CLI; it does not
replace it.

## What you get

- 46 tools for Drive, sharing, trash, invitations, Photos albums, content reading and analytics (see [Tools](#tools)).
- A companion CLI for 45 of the 46 operations (`drive_read_file`, which reads the local sync folder, is MCP-only). Typed by a human, it uses `--confirm` flags instead of elicitation and is not subject to the sharing policy.
- No credential handling: authentication lives in the official CLI and your OS keychain.
- Every CLI call is a `spawn` with a discrete argument array and no shell.

## Credits

Original project: **Dawid Piaskowski** ([googlarz](https://github.com/googlarz)), MIT. This fork: **Elger Rodrigues**
([3lgr](https://github.com/3lgr)). Both copyright lines are kept in [LICENSE](LICENSE).

---

## Privacy model

Your files travel: **Proton Drive (cloud, E2E encrypted) → Proton Drive CLI (local, decrypts) → this MCP server (local) → your AI client**.

The CLI does all cryptography locally. This server calls it as a subprocess and forwards results: it never receives your
password and never stores credentials. Authentication state lives in your OS keychain, managed by the official CLI. If
you use a hosted model, file content you ask it to act on is sent to that provider under its own privacy policy.

---

## Prerequisites

**1. Proton Drive CLI** — download from [proton.me/download/drive/cli](https://proton.me/download/drive/cli/index.html) and add to your `PATH`.

**2. Authenticate the CLI** — run once in your terminal:

```bash
proton-drive auth login
```

This opens a browser for Proton's standard sign-in flow. Credentials are stored in your OS keychain — not on disk, not in config files.

**3. Node.js 22 or later** — `node --version` to check.

---

## Install

This fork is **not published on npm**. Install it from the repository, pinned to a release tag:

```bash
# global install from a tag (builds on install; read the tag's diff first)
npm install -g github:3lgr/proton-drive-mcp#v2.0.3

# or from a clone
git clone https://github.com/3lgr/proton-drive-mcp.git
cd proton-drive-mcp
git checkout v2.0.3
npm ci --ignore-scripts && npm run build
node dist/index.js        # the MCP server
```

Release bundles (`.mcpb`) are attached to GitHub releases with a `SHA256SUMS` file and a build-provenance attestation
(`gh attestation verify <file> --repo 3lgr/proton-drive-mcp`). Do not run a floating version (`npx -y <name>` with no
version) of a program that holds your Proton session.

> **The npm package named `proton-drive-mcp` is the upstream project, not this fork.** `npx proton-drive-mcp` (or
> `npx -y proton-drive-mcp`) installs and runs upstream code, which has none of the controls described here. This fork
> is installed from the repository, pinned to a tag, as shown above.

---

## Connect to Claude Desktop

Add to your `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows** (informational only, this project does not support Windows): `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "proton-drive-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/proton-drive-mcp/dist/index.js"],
      "env": { "PROTON_DRIVE_BIN": "/absolute/path/to/proton-drive" }
    }
  }
}
```

Claude Desktop starts servers with a minimal `PATH`, so a `proton-drive` in `~/.local/bin` is usually not found. Set `PROTON_DRIVE_BIN` to the output of `which proton-drive` (the default install location is `~/.local/bin/proton-drive`, written out in full, e.g. `/Users/you/.local/bin/proton-drive`). Use the absolute path of `node` as `command` if Claude Desktop cannot find it (`which node`). `proton-drive-cli setup-claude-desktop --write` writes this entry for you.

Restart Claude Desktop. Check **`+` → Connectors → proton-drive-mcp** to confirm the server is connected.

> **Tip:** Make sure `proton-drive auth login` has been run at least once before starting Claude Desktop.

### One-click install (MCPB bundle)

Instead of editing JSON, download `proton-drive-mcp-<version>.mcpb` from the [latest GitHub release](https://github.com/3lgr/proton-drive-mcp/releases/latest) and open it (or drag it into **Settings → Extensions** in Claude Desktop). In the extension settings, set **proton-drive CLI path** to the output of `which proton-drive` (usually `~/.local/bin/proton-drive`); optionally set the **Proton Drive sync folder** to enable `drive_read_file`, and the **Persistent search index** switch (off by default; it stores file names in plain text on this computer, see [Persistent index](#persistent-index-opt-in)). You still need the official `proton-drive` CLI installed and `proton-drive auth login` done once.

### If installed globally

```json
{
  "mcpServers": {
    "proton-drive-mcp": {
      "command": "proton-drive-mcp"
    }
  }
}
```

---

## Setup and diagnostics

Two commands of the companion CLI help when Claude Desktop reports "proton-drive CLI not found" (it starts servers with a minimal `PATH`):

```bash
# Read-only checks: Node >= 22, proton-drive CLI + version, auth, PROTON_DRIVE_SYNC_PATH, your Claude Desktop entry
proton-drive-cli doctor [--json] [--config <path>]

# Dry run: prints the entry it would add and the target file, changes nothing
proton-drive-cli setup-claude-desktop [--config <path>] [--sync-path <dir>]

# Apply it (timestamped backup first; only mcpServers["proton-drive-mcp"] is touched)
proton-drive-cli setup-claude-desktop --sync-path "$HOME/Proton Drive" --write

# Also pin the CLI: records the sha256 of the resolved binary as PROTON_DRIVE_BIN_SHA256 in the entry
proton-drive-cli setup-claude-desktop --write --pin
```

`doctor` exits 1 if any check fails (warnings do not fail). It only ever reports on the `proton-drive-mcp` entry of the config, never on other servers. `setup-claude-desktop` writes an absolute path to `node`, of this package's `dist/index.js`, and of the resolved `proton-drive` binary (`PROTON_DRIVE_BIN`). It refuses to run if the CLI cannot be found, the config file is not valid JSON, or the package is running from a temporary `npx` cache (install it first with `npm install -g github:3lgr/proton-drive-mcp#v2.0.3`). The `node` it writes is the one running the command, but when a `node` on your `PATH` (e.g. `/opt/homebrew/bin/node`) is the same file it uses that stable path instead of the versioned one (`/opt/homebrew/Cellar/node/<version>/bin/node`), and only if that location is not writable by group or others; otherwise it falls back to the real path. Re-running keeps what is already in the entry (the pin and any extra variables such as `PROTON_DRIVE_LOCAL_ROOT`); `--pin` is the only thing that changes the pin, and without `--pin` a binary that no longer matches the stored pin is refused rather than trusted again. `--pin` trusts the binary that is on disk right now, so only use it on a CLI you installed from Proton. `doctor` reads the pin from the entry (the one the server started by Claude Desktop actually uses), compares it with the binary and warns when the entry has none. Re-running with unchanged settings leaves the file alone; otherwise the file is replaced atomically and a timestamped `.bak-…` copy is kept.

The default config location is per OS (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`, Linux `$XDG_CONFIG_HOME` or `~/.config/Claude/`); use `--config` or the `CLAUDE_DESKTOP_CONFIG` environment variable to point elsewhere. On Windows the CLI lookup honours `PATHEXT`.

**Claude Desktop only reads its config at startup: fully quit and restart it afterwards** (closing the window is not enough).

### When Proton updates the CLI

A pinned CLI (`PROTON_DRIVE_BIN_SHA256`) is refused after any change to the binary, including a legitimate upgrade. That is the pin working: the server will not run it and `doctor` reports `cli-integrity` as failed with the pinned and current hashes. After you have upgraded the CLI on purpose (and, ideally, checked the version with `proton-drive version`):

```bash
proton-drive-cli doctor                              # confirms the mismatch and the new version
proton-drive-cli setup-claude-desktop --write --pin  # recomputes the sha256 and updates the entry (backup first)
```

Then fully quit and restart Claude Desktop. Without `--pin`, `setup-claude-desktop` stops with the old and new hash instead of re-trusting the new binary. If you pin by hand: `shasum -a 256 "$(which proton-drive)"`. A CLI minor version outside the tested list (0.8, 0.9) only produces a warning.

### When Node changes

The entry stores an absolute path to `node`. A path through your package manager's stable link (`/opt/homebrew/bin/node`) survives `brew upgrade node`; a versioned one (`.../Cellar/node/26.11.1/bin/node`) does not, and Claude Desktop then reports the server as failed to start. After switching Node versions (brew, nvm, fnm...) or if `doctor` says the entry's `command` does not resolve, re-run `proton-drive-cli setup-claude-desktop --write` (the pin and other variables stay). Node 22, 24 and 26 are covered by CI.

---

## Try it: example Claude prompts

**Backup a build artifact**
> "Upload ./dist/app-v2.zip to /my-files/Releases and tell me if it succeeded."

**Morning file triage**
> "List everything in /my-files. Tell me what's larger than 10MB and what was modified most recently."

**Share a folder with a colleague**
> "Share /my-files/Q2-Reports with alice@proton.me as editor. Add a message: 'Please review before Friday.'"

**Offboarding**
> "Revoke bob@company.com's access from /my-files/Projects and /shared/Design. Confirm when done."

**Automated download**
> "Download /my-files/contracts/nda-2026.pdf to ~/Documents/Legal/."

**Trash cleanup**
> "List what's in the trash and empty it once I confirm."

---

## CLI

```bash
proton-drive-cli <command> [args]
```

### Auth & info

```bash
proton-drive-cli auth status          # probes /my-files; the CLI has no dedicated status command
proton-drive-cli auth logout          # log out (clears OS keychain session)
proton-drive-cli version              # CLI and SDK version
```

### Files & folders

```bash
proton-drive-cli list /my-files
proton-drive-cli list /my-files/Reports
proton-drive-cli info /my-files/report.pdf       # full metadata, incl. revision details
proton-drive-cli read /my-files/notes.md --max-chars 5000   # text of a file, paged with --offset

proton-drive-cli mkdir /my-files/NewFolder

proton-drive-cli upload ./report.pdf /my-files/Reports
proton-drive-cli upload ./dist /my-files/Releases --file-conflict replace --folder-conflict merge

proton-drive-cli download /my-files/report.pdf ./local/report.pdf
proton-drive-cli download /my-files/Reports ./local/Reports --file-conflict rename --folder-conflict merge

proton-drive-cli rename /my-files/old-name.pdf new-name.pdf   # in place, no move
proton-drive-cli move /my-files/old-name.pdf /my-files/new-name.pdf
proton-drive-cli copy /my-files/report.pdf /my-files/Archive
proton-drive-cli delete /trash/obsolete-draft.pdf --confirm   # only works on items already in trash

# Machine-readable output (pipe-friendly)
proton-drive-cli list /my-files --json | jq '.[].name'
```

### Sharing

```bash
proton-drive-cli share status /my-files/Reports
proton-drive-cli share invite /my-files/Reports alice@pm.me editor
proton-drive-cli share invite /my-files/Reports bob@pm.me viewer --message "FYI"
proton-drive-cli share revoke /my-files/Reports alice@pm.me
proton-drive-cli share remove-all /my-files/Reports --confirm   # strip every member + pending invite

proton-drive-cli share set-url /my-files/Reports --role viewer --expiration 2026-06-06
proton-drive-cli share remove-url /my-files/Reports
```

### Trash

```bash
proton-drive-cli trash /my-files/old-draft.pdf        # move to trash
proton-drive-cli trash list                            # see what's in trash
proton-drive-cli restore /my-files/old-draft.pdf       # restore from trash
proton-drive-cli trash empty --confirm                  # permanently delete all trashed items
```

### Search, analytics and cleanup
`drive_search` · `drive_tree` · `drive_usage` · `drive_find_duplicates` · `drive_sharing_audit` · `drive_sync_plan` · `drive_bulk_move` · `drive_bulk_trash`

```bash
proton-drive-cli tree /my-files --depth 2
proton-drive-cli search /my-files --ext pdf --min-size 1000000
proton-drive-cli usage /my-files --top 20 --older-than 365
proton-drive-cli duplicates /my-files --min-size 1000000 [--verify]
proton-drive-cli share audit /my-files
proton-drive-cli sync-plan ./local /my-files/backup --direction up
proton-drive-cli bulk-move /my-files/Archive /my-files/a.pdf /my-files/b.pdf          # plan only
proton-drive-cli bulk-trash /my-files/old1.txt /my-files/old2.txt --confirm           # apply
proton-drive-cli index status                                                         # persistent index: enabled?, path, size, age, entries
proton-drive-cli index clear                                                          # delete the saved index file
```

- The first walk of a large drive can take minutes (measured about 21 s per 1,200 files at the default concurrency (12); about 25 s at concurrency 8). `drive_search`, `drive_tree` and `drive_usage` stop waiting after 25 s (`PROTON_DRIVE_WALK_BUDGET_MS`, 0 = never) and return what was listed so far with `partial: true`, `continuing: true` (the walk is still running) and a `note`; the same walk keeps running in the background, so repeating the call returns the full result from cache. `drive_find_duplicates`, `drive_sharing_audit` and `drive_sync_plan` always wait for the complete walk. Later calls reuse a 5-minute in-memory cache; `refresh` bypasses it. With the opt-in persistent index, a saved copy up to 24 h old can answer first (marked `stale: true`).
- Walks skip `.git` and `node_modules` by default.
- With `PROTON_DRIVE_INDEX=1`, results may come from a saved index (`stale: true` = served from the saved index, not a walk made now) while a refresh runs; repeat the call or pass `refresh: true` for a fresh read. Off by default, see [Persistent index](#persistent-index-opt-in).
- Read-only tools (`drive_search`, `drive_tree`, `drive_usage`, `drive_find_duplicates`, `drive_sharing_audit`, `drive_sync_plan`) change nothing. `drive_bulk_move` and `drive_bulk_trash` are two-step: call without `confirmed` for the plan, then with `confirmed: true` to apply. Bulk trash is reversible with `drive_restore`.
- Duplicate detection uses the sha1 the uploader claimed, which is unverified. `verify: true` downloads the candidates and hashes them.
- The sharing audit flags an invitee as external when the address is outside Proton domains, so Proton users on a custom domain are over-flagged.
- Sizes are sums of file sizes, not your account quota.
- `drive_usage` trash stats always make one uncached `/trash` listing (~2.5 s), even when the walk is cached.

### Persistent index (opt-in)

By default every new server process (each Claude Desktop session) walks the drive again on the first `drive_search`, `drive_tree`, `drive_usage` or `drive_find_duplicates`: about 21 s per 1,200 files at the default concurrency (12), minutes on big drives. Set `PROTON_DRIVE_INDEX=1` to keep completed walks on disk and answer instantly after a restart.

**Privacy: this is off by default.** Your Drive is end-to-end encrypted, but the index is a **plaintext** copy of file and folder names, paths, sizes, dates and claimed sha1 hashes on your local disk. Anyone who can read your user account's files (or your backups) can read it. Enable it only on a machine you trust.

- **What is stored:** the node list of up to 8 recent complete walks under `/my-files` (partial or failed walks are never saved, so a `drive_tree` that stops at its depth limit is not stored), plus a fingerprint of your account's Drive root. No file contents, no credentials, no tokens.
- **Where:** `PROTON_DRIVE_INDEX_DIR` if set; otherwise `~/Library/Caches/proton-drive-mcp` (macOS) or `$XDG_CACHE_HOME/proton-drive-mcp` / `~/.cache/proton-drive-mcp` (Linux). One file, `walk-index.json`, mode `0600` in a `0700` directory, written atomically. Use a dedicated directory: a pre-existing directory with group/other access (or owned by someone else) is refused with one warning and never chmodded; a missing one is created `0700`. A symlinked directory or file is refused. A saved file with loose permissions, another owner, a future timestamp, or above 200 MB is ignored. Not written above 200 MB.
- **Account check:** before any saved data is served, one `list /my-files` (~2 s) confirms it belongs to the account that is logged in now; if the check fails (network, rate limit) nothing is served from disk for that call and the file is kept; a proven account mismatch deletes it. Either way the drive is walked fresh.
- **Freshness:** data up to `PROTON_DRIVE_INDEX_MAX_AGE_H` hours old (default 24; `0` = never use saved data) is returned immediately with `stale: true` (and `refreshing: true` while one background walk replaces it); a repeated call then returns the fresh walk. A failed or incomplete background walk is not retried for 5 minutes within the same server process (`PROTON_DRIVE_INDEX_REFRESH_COOLDOWN_MS`); a new process tries once again. The saved data is account-checked first (see above). `drive_sync_plan`, `drive_find_duplicates` and the sharing audit never use saved data. `refresh: true` always does a blocking fresh walk. Writes made through this server drop the affected entries from memory and disk.
- **Read-only directory:** an index in a directory (or file) you cannot write to is ignored, because it could not be kept current after the server's own writes.
- **Limits:** `drive_tree` with a depth limit is not answered from the saved full walk (it walks live); changes made by other clients or processes are not seen until the data is refreshed.
- **Check or remove it:** `proton-drive-cli index status` and `proton-drive-cli index clear` (or just delete the file). In the MCPB bundle, the **Persistent search index** setting is the opt-in.

### Photos

```bash
proton-drive-cli album list
proton-drive-cli album create "Summer 2026"
proton-drive-cli album update /albums/Summer2026 --name "Summer Trip"
proton-drive-cli album add-photo /albums/Summer2026 /photos/IMG_001.jpg

proton-drive-cli photo timeline
proton-drive-cli photo download /photos/IMG_001.jpg ./local/photos --conflict rename
proton-drive-cli photo upload ./camera-roll --conflict skip
```

### Pipe and script

```bash
# Backup build output after CI
proton-drive-cli upload ./dist /my-files/Releases/$(date +%Y-%m-%d) --file-conflict rename --folder-conflict rename

# Download all contracts for audit
proton-drive-cli download /my-files/Contracts ./audit/contracts

# Nightly backup via cron
0 2 * * * proton-drive-cli upload ~/Documents /my-files/Backups/$(date +%Y-%m-%d) --file-conflict skip --folder-conflict skip

# Check who has access before a team change
proton-drive-cli share status /my-files/Projects
```

---

## Prompts

The server offers four MCP prompts (also declared in the MCPB manifest): `organise-folder` (`path`), `find-files` (`description`), `storage-audit` and `sharing-audit`. In Claude Code they are listed as `/servername:promptname (MCP)`, and `/mcp__servername__promptname` also runs them. Other clients show them as prompts. A prompt is hidden when a tool it needs is outside the active tool tier: with `PROTON_DRIVE_TOOL_TIER=core` only `find-files` is offered.

---

## Tool surface

### Auth
`drive_auth_status` · `drive_auth_logout` · `drive_version`

### Filesystem
`drive_list` · `drive_info` · `drive_read_content` · `drive_tree` · `drive_search` · `drive_mkdir` · `drive_upload` · `drive_download` · `drive_rename` · `drive_move` · `drive_delete`

### Sharing
`drive_share_status` · `drive_share_invite` · `drive_share_revoke` · `drive_share_remove_all` · `drive_share_set_url` · `drive_share_remove_url`

### Trash
`drive_list_trash` · `drive_trash` · `drive_restore` · `drive_empty_trash`

### Local sync (requires `PROTON_DRIVE_SYNC_PATH`)
`drive_read_file`

### Copy
`drive_copy`

### Plan & bulk
`drive_sync_plan` · `drive_bulk_move` · `drive_bulk_trash`

### Invitations
`drive_list_invitations` · `drive_invitation_accept` · `drive_invitation_reject` · `drive_share_leave`

### Analytics
`drive_usage` · `drive_find_duplicates` · `drive_sharing_audit`

### Photos
`photos_list_albums` · `photos_create_album` · `photos_update_album` · `photos_delete_album` · `photos_list_album_photos` · `photos_add_to_album` · `photos_remove_from_album` · `photos_list_timeline` · `photos_download` · `photos_upload`

---

## Tool reference

| Tool | Description | Key parameters |
|------|-------------|----------------|
| `drive_auth_status` | Check if authenticated (probes `/my-files` — no native status command) | — |
| `drive_auth_logout` | Log out (clear session) ⚠️ | `confirmed: true` |
| `drive_version` | CLI and SDK version info | — |
| `drive_list` | List files and folders at a path (paginated, default 200; `/` lists the roots) | `path`, `limit?`, `offset?` |
| `drive_info` | Get metadata for one file/folder, including revision details (noise trimmed) | `path`, `verbose?` (raw CLI node) |
| `drive_read_content` | Read the text of a file stored in Drive (no sync folder needed): UTF-8 plain text and code only; PDF, Office and other binaries are refused. Paged; content is untrusted data. See [Reading file contents](#reading-file-contents) | `path`, `maxChars?` (default 20000, max 100000), `offset?` |
| `drive_tree` | Folder overview: per-folder file counts and size totals (largest first), depth-limited, cached 5 min | `path?`, `depth?` (default 2, max 10), `limit?`, `foldersOnly?`, `refresh?` |
| `drive_search` | Find files/folders under a path in one cached walk: name (substring/glob; a glob containing `/` matches the path relative to `path`), type, extension, MIME prefix, size, modified date; sortable, paginated. Reports `walk.complete` — false means the walk was cut short and matches may be missing | `query?`, `glob?`, `path?`, `type?`, `mediaType?`, `extensions?`, `minSize?`, `maxSize?`, `modifiedAfter?`, `modifiedBefore?`, `sort?`, `limit?` (default 50, max 500), `offset?`, `refresh?` |
| `drive_mkdir` | Create a new empty folder | `path` |
| `drive_upload` | Upload local file or folder | `localPath`, `remotePath`, `fileConflictStrategy?` (skip/create-new-revision/rename/replace), `folderConflictStrategy?` (skip/merge/rename/replace), `confirmed?` (**required for `replace`** — it trashes the existing remote item) |
| `drive_download` | Download to local path | `remotePath`, `localPath`, `fileConflictStrategy?` (skip/rename/remove), `folderConflictStrategy?` (skip/merge/rename/remove), `confirmed?` (**required for `remove`** — it deletes the existing local item) |
| `drive_rename` | Rename in place, no move | `path`, `newName` |
| `drive_move` | Move and/or rename | `sourcePath`, `destinationPath` |
| `drive_copy` | Copy file or folder into another Drive folder | `sourcePath`, `destinationPath` (target *parent folder*), `newName?` |
| `drive_delete` | Permanently delete an item already in trash ⚠️ | `path`, `confirmed: true` |
| `drive_list_trash` | List items currently in trash (paginated, default 100; includes `uid` — names are not unique in trash) | `limit?`, `offset?` |
| `drive_share_status` | Get sharing members and URL | `path` |
| `drive_usage` | Storage analytics for a subtree: totals, largest files/folders, extension and media-type breakdown, old files, trash stats (sum of file sizes, not the account quota) | `path?`, `top?`, `olderThanDays?`, `refresh?` |
| `drive_find_duplicates` | Likely duplicate groups (claimed sha1 / same size; `verify` downloads and sha256s candidates), wasted bytes, suggested keeper — never deletes | `path?`, `minSize?`, `verify?`, `maxVerifyBytes?`, `maxVerifyTotalBytes?` (default 500 MB, max 2 GB), `limit?`, `refresh?` |
| `drive_sharing_audit` | Public links (no URL), invitees, pending invitations and risk flags for shared items (max 100) | `path?`, `refresh?` |
| `drive_share_invite` | Invite a user (sends an email) ⚠️ | `path`, `email`, `role` (viewer/editor/admin), `message?`, `confirmed: true` |
| `drive_share_revoke` | Revoke one person's access (fails if not a member) ⚠️ | `path`, `email`, `confirmed: true` |
| `drive_share_remove_all` | Remove every member + pending invitation at once ⚠️ | `path`, `confirmed: true` |
| `drive_share_set_url` | Create/replace a public share link ⚠️ (re-running without `password`/`expiration` removes them; expiry max ~90 days) | `path`, `role?` (viewer/editor), `password?`, `expiration?`, `confirmed: true` |
| `drive_share_remove_url` | Remove the public share link ⚠️ | `path`, `confirmed: true` |
| `drive_trash` | Move to trash | `path` |
| `drive_sync_plan` | Read-only diff of a local folder vs a Drive folder (nothing transferred) | `localPath`, `drivePath`, `direction?` (up/down/both), `ignore?`, `compare?` (size-mtime/sha1), `limit?` |
| `drive_bulk_move` | Move up to 200 items into an existing folder; without `confirmed` returns the plan and problems only | `sources`, `destinationFolder`, `confirmed?` (**required to apply**) |
| `drive_bulk_trash` | Trash up to 200 items (recoverable); without `confirmed` returns the plan and problems only | `paths`, `confirmed?` (**required to apply**) |
| `drive_restore` | Restore from trash | `path` |
| `drive_empty_trash` | Permanently delete all trash ⚠️ | `confirmed: true` |
| `drive_read_file` | Read text file from local sync folder | `path` |
| `drive_list_invitations` | List pending sharing invitations received | — |
| `drive_invitation_accept` | Accept a pending invitation | `uid` (from `drive_list_invitations`) |
| `drive_invitation_reject` | Reject a pending invitation ⚠️ | `uid` (from `drive_list_invitations`), `confirmed: true` |
| `drive_share_leave` | Leave a shared folder shared with you ⚠️ | `path`, `confirmed: true` |
| `photos_list_albums` | List all Proton Photos albums | — |
| `photos_create_album` | Create a new empty album | `name` |
| `photos_update_album` | Rename an album or change its cover photo | `albumPath`, `name?`, `coverPhotoUid?` |
| `photos_delete_album` | Delete an album ⚠️ | `albumPath`, `confirmed: true`, `force?`, `save?` |
| `photos_list_album_photos` | List photos in an album (paginated, default 100) | `albumPath`, `loadDetails?`, `limit?`, `offset?` |
| `photos_add_to_album` | Add a photo from your library to an album | `albumPath`, `photoPath` |
| `photos_remove_from_album` | Remove a photo from an album (keeps it in library) ⚠️ | `albumPath`, `photoPath`, `confirmed: true` |
| `photos_list_timeline` | List photos in your full library timeline (paginated, default 50) | `loadDetails?`, `limit?`, `offset?` |
| `photos_download` | Download photos to a local folder | `photoPaths`, `localFolder`, `conflictStrategy?` (skip/rename/remove), `confirmed?` (**required for `remove`**) |
| `photos_upload` | Upload local files directly into your Photos library | `localPaths`, `conflictStrategy?` (skip/rename) |

> ⚠️ **Destructive and outward-facing tools** (deleting, sharing, public links, logout, invitations and the `replace`/`remove` conflict strategies) are gated. With an elicitation-capable client the human is asked every time; `confirmed: true` is only the model's way of saying it has described the action, and on a client without elicitation the irreversible ones are refused unless `PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE=1`. The companion CLI requires `--confirm`. Tool arguments are validated against the published schema — unknown or mistyped arguments are rejected.

---

## Compared with other Drive MCPs

| Capability | Generic S3/GDrive MCPs | proton-drive-mcp |
|---|---|---|
| End-to-end encryption | No | Yes (via Proton CLI) |
| Credential exposure | API keys in config | Zero — OS keychain only |
| Sharing & invitations | Rarely | Full (invite, revoke, status) |
| Trash & restore | Rarely | Full |
| CLI parity | No | The CLI mirrors every MCP tool except `drive_read_file` |
| Shell injection safe | Varies | Yes: `spawn` with argument arrays, no shell |

---

## Operational notes

- Long listings are paginated (`limit` / `offset`, response `{total, offset, limit, hasMore, items}`) to keep responses small. Responses are compact JSON.
- Local paths passed to upload/download/photos tools are checked: credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude*`, keychains, `.env` files, …) are refused. Set `PROTON_DRIVE_LOCAL_ROOT` to allow only specific directories (the credential and secret-name denylist stays active inside them). Folder uploads are scanned recursively first and refused if they hold a secret-looking file or any symlink.
- `drive_read_file` refuses to follow symlinks out of `PROTON_DRIVE_SYNC_PATH`, compares names as the file system does (case, Unicode form, trailing dots) and refuses known secrets (`.env*`, `id_*`, `*.pem`, `*.key`, `.ssh/`, `.aws/`, `.git/config`...). There is no tool that writes into the sync folder: `drive_write_file` was removed in 2.0.1 because a folder that other programs trust (git hooks, shell rc files, editor tasks, CI workflows) cannot be made safe against planted files. Use `drive_upload` from the allowlisted local folder.
- Error messages carry a fixed code and text, never the CLI's own output: the CLI's words are classified and withheld (with a length and short hash for correlation), so names, paths, links and passwords it prints do not reach the model or the log.
- Tools that return names, paths, e-mail addresses, invitations or file text wrap the result in an `untrusted` envelope and mark hidden or control characters visibly. Treat everything inside as data, never as instructions.
- Downloads are staged in a private directory beside the destination, validated and promoted by a plan (nothing is overwritten; `.`-named items, links and special files are refused). Uploads are copied to a private, hashed snapshot first; folders with secrets or links are refused.
- `drive_move` accepts a full destination path (parent + new name) for a familiar interface, but the underlying CLI only has separate `move` (change parent) and `rename` (change name) commands — this MCP translates automatically, issuing one or both as needed.
- `drive_delete` only works on items already in `/trash` or `/photos-trash` — the CLI rejects live paths. Trash an item first with `drive_trash`, or use `drive_empty_trash` to clear everything at once.
- Confirmation gates (one table, `src/policy/gates.ts`): when the client declares MCP elicitation (form mode) the human is **always** asked before a gated call runs, whatever `confirmed` the model sent; only an explicit approval runs it, and after 5 declined prompts in a minute the server stops prompting. When the client cannot elicit, the irreversible or outward-facing tools (`drive_empty_trash`, `drive_delete`, `drive_share_*`, `drive_auth_logout`, `photos_delete_album`, `drive_invitation_accept`/`reject`, and the `remove` download strategy) **fail closed**: a model-supplied `confirmed: true` is not consent. Set `PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE=1` to accept prompt-level `confirmed` for them. Less dangerous gated tools (`drive_bulk_*`, `photos_remove_from_album`, upload `replace`, uploads or moves into an already shared folder) keep prompt-level `confirmed`. Confirmation prompts need a client that supports elicitation (Claude Code CLI today; Claude Desktop is unverified).
- Walk-based tools (`drive_tree`, `drive_search`, `drive_usage`, `drive_find_duplicates`) read from a cache up to 5 minutes old (with the opt-in persistent index, up to 24 h old and marked `stale: true`; `drive_sharing_audit`, `drive_sync_plan` and `drive_find_duplicates` never use the saved index); changes made by other clients or processes are not seen until it expires or you pass `refresh: true`. The first walk of a large drive can take minutes (measured about 21 s per 1,200 files at the default concurrency (12)); `drive_search`, `drive_tree` and `drive_usage` return a `partial: true` result after 25 s and finish the walk in the background.
- `drive_auth_status` has no native CLI equivalent — it probes by resolving `/my-files` and reports authenticated based on whether that succeeds.
- Paths are always Drive-absolute: `/my-files/folder/file.pdf`. Relative paths are not supported.
- All calls include `--json` automatically, except `drive_version`, whose underlying CLI command ignores `--json` and always prints plain text — this MCP parses it directly.

### Token cost

`tools/list` is sent to the model in every session. Measured payload (JSON bytes): `full` 39.9 KB (46 tools), `core` 18.6 KB (19 tools). Set `PROTON_DRIVE_TOOL_TIER=core` to load only:

`drive_auth_status`, `drive_version`, `drive_list`, `drive_info`, `drive_read_content`, `drive_list_trash`, `drive_search`, `drive_tree`, `drive_mkdir`, `drive_upload`, `drive_download`, `drive_rename`, `drive_move`, `drive_copy`, `drive_trash`, `drive_restore`, `drive_share_status`, `photos_list_timeline`, `photos_download`.

Left out of `core` (use `full`): permanent deletion (`drive_delete`, `drive_empty_trash`), `drive_auth_logout`, public links, invitations and invites, album management, `photos_upload` and the sync-file tools. A call to a hidden tool returns an error asking for `PROTON_DRIVE_TOOL_TIER=full`; no CLI command runs.

### Reading file contents

`drive_read_content` returns the text of a file stored in Drive, without a sync folder: it downloads the file into a private temp directory (mode 0700, always removed afterwards), decodes it as UTF-8 and returns it in pages (`offset` / `maxChars`, default 20000, max 100000 characters; the reply carries `nextOffset` while more remains). Expect 2-4 s per read.

- **Formats:** plain text, markdown, json, csv/tsv, yaml, xml, html (tags are kept as is), log and common code files (UTF-8; binary or non-UTF-8 content is refused as "not text"). `.docx`, `.pdf` and every other binary format are refused with a clear message (**document parsing was removed in 2.0.0 to keep the attack surface small**; use `drive_download` and open the file yourself). Folders and Proton Docs/Sheets are refused too.
- **Caps:** files over 10 MB are refused before downloading (`PROTON_DRIVE_READ_MAX_BYTES`, hard maximum 50 MB), and the download is stopped as soon as more bytes than that are on disk (the declared size is never trusted).
- **Isolation:** the file goes through the same staged, validated download path as every other transfer (private temp directory, no links, name checks), and is removed afterwards.
- **Untrusted content:** file text comes from your drive and may contain instructions aimed at the model (prompt injection). The tool returns it as data, nothing is executed, and its description tells the model to treat it as data, never as instructions.

## Known limitations

Limits of this fork's hardening (the closed CLI cannot be inspected):

- Whether the CLI sanitises remote names, follows symlinks on upload, or treats unusual paths is **not verifiable**; the server validates before and after the CLI runs and refuses when it cannot be sure.
- Link passwords are passed to the CLI as an argument (visible in the process list of the machine for the duration of the call); they are never logged or returned.
- Moving, copying, uploading or adding to an album **inside a shared folder or album** asks the human first (the destination and its ancestors are checked; a failed lookup counts as shared). On a client **without** elicitation that gate is still a model-supplied `confirmed: true` (it is not one of the strict tools), so use a client that can ask. The sharing policy does not inspect who the members are.
- **The closed CLI can write outside the staging folder.** The server hands the CLI a private staging directory and validates what arrives there, but a CLI that writes somewhere else (another path, a cache, a temp file) is not observed and cannot be stopped by this server. It is inherent to wrapping a closed binary; pin the binary (`PROTON_DRIVE_BIN_SHA256`) and keep it up to date.
- A scratch directory left by a process killed with SIGKILL (`pdmcp-XXXXXX` in your temp dir) is **not** removed automatically: an orphan is preferred to a sweep that could delete something that is not ours. Delete it by hand; it only holds partial downloads.
- The text inside an untrusted envelope can still try to persuade a model. The envelope and markers lower the odds; they are not a guarantee.
- Document formats (PDF, Office) are not parsed at all; only plain UTF-8 text is read.
- Fail-closed choices can reject legitimate input: `.key` files (Keynote), uploads with hardlinks or symlinks, downloads of folders that cannot be listed completely.
- The hardening was tested with a fake CLI; it has not been exercised against a live account. Windows is unsupported.

Limits that come from the upstream `proton-drive` CLI (v0.8.0), not from this server:

- Big folders cannot be copied yet (`drive_copy` fails with `InvalidRequirementsAPIError` code 2000).
- A `"` in a name becomes `_` when the item is downloaded locally.
- Public-link expiration can be at most ~90 days ahead, to the minute.
- `drive_share_status` only reports sharing set directly on the item — access inherited from a shared parent folder is not shown.
- Roots (`/my-files`, `/photos`, …) cannot be shared; `drive_share_status` on a root returns an error.
- `photos_list_timeline` pages are not a snapshot: photos added or removed between calls shift later pages.
- Upload/download counts include folders, not only files.
- `/albums/...` paths cannot be downloaded — download a photo via `/photos/<name>`.
- A name ending in a backslash (e.g. `tail\`, created by another client) cannot be used as a parent in a path: the CLI reads `tail\/child` as an escaped `/`, and has no escape for a literal backslash (`\\` does not work either). The folder itself is reachable; its children are not reachable by path.
- Trashed items are addressed by name only. When two items in `/trash` or `/photos-trash` share a name, `drive_restore` and `drive_delete` refuse (listing the uids) instead of acting on an arbitrary one — restore or delete that item in the Proton Drive web or desktop app.
- When several programs use the CLI at the same moment (e.g. Claude Desktop and Claude Code), its local cache can briefly report `database is locked`. Read-only calls are retried automatically; writes are not (a retry could repeat the change), so just run the write again. The same read-only retry (up to two more attempts, short jittered backoff, honoring a `Retry-After` of at most 5 s and the call's overall timeout) also covers rate limiting (HTTP 429), single-request timeouts (`Request timed out`) and transient network resets; auth and not-found errors are never retried.

## Compatibility

| Component | Tested with |
|---|---|
| Proton Drive CLI | 0.8.x (SDK js 0.21), 0.9.x (SDK js 0.22; read-only live suite and list/create/trash exercised on 0.9.0) |
| macOS | Live-tested against a real account |
| Linux | CI with a fake CLI only |
| Windows | Not supported (see [Platform support](#platform-support)) |

### Clients

| Client | Elicitation (human asked for gated tools) | Status |
|---|---|---|
| Claude Code (CLI) | Yes | Prompts for every gated call |
| Claude Desktop, Chat | No | Irreversible and outward-facing tools (empty trash, permanent delete, sharing, public links, logout, invitations, `remove`) are **refused**, by design |
| Claude Desktop, Code tab | Not verified | To be checked; assume the same as Chat until confirmed |

`proton-drive-cli doctor` warns when the installed CLI is not 0.8.x or 0.9.x, and the server logs one warning line to stderr at startup. Other versions may work but are unverified. If something breaks, open an issue at [github.com/3lgr/proton-drive-mcp/issues](https://github.com/3lgr/proton-drive-mcp/issues) with the output of `proton-drive version` and `proton-drive-cli doctor`.

## Platform support

Developed and live-tested on **macOS**. CI runs the test suite on Ubuntu and macOS (Node 22, 24 and 26). **Windows is not supported.** Proton does ship a Windows build of its CLI (x64 and arm64, per the [CLI download page](https://proton.me/download/drive/cli/index.html)), so the blocker is on this project's side: the test suite has never passed on Windows, CI does not run it, and the Windows paths in `doctor` / `setup-claude-desktop` (`%APPDATA%`, `PATHEXT` lookup) are untested. The system-PATH warning in `doctor` only knows POSIX directories. Supporting Windows would need a Windows CI job, a passing test suite there, and a live test against the Windows CLI. Linux is covered by CI with the fake CLI but has not been live-tested against a real Proton account.

## Testing status

Every tool group was live-tested by the upstream project on 2026-09-28 against a real Proton account (CLI 0.8.0, v1.5.2). **This fork's hardening was tested against a fake CLI only**; it has not been exercised against a real account, **except** `drive_share_leave`, `drive_invitation_accept` and `drive_invitation_reject`. Those three have never been tested against a real account, because the maintainer has no second Proton account to share from; they are only unit-tested against a fake CLI.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PROTON_DRIVE_SYNC_PATH` | Optional | Absolute path to your local Proton Drive sync folder root (e.g. `/Users/you/Proton Drive`). Required only for `drive_read_file`. |
| `PROTON_DRIVE_BIN` | Optional | Override the `proton-drive` binary name or path (default: `proton-drive`; an empty value counts as unset). Useful for non-standard installations. |
| `PROTON_DRIVE_BIN_SHA256` | Optional | sha256 (64 hex characters, optional `sha256:` prefix; empty = not pinned) of the `proton-drive` binary. When set, the binary is copied into a private `0700` temp directory, the hash is taken of the copy, the copy is made read-only and **only the copy is executed**, so a later swap of the original changes nothing; any mismatch, read error or malformed value refuses to run it. Needs a temp directory that allows execution and room for one copy of the binary; the copy is removed on shutdown. Without a pin the binary still runs by resolved absolute path. `doctor` warns when the binary is unpinned, found through `PATH`, or sits in a location writable by others. |
| `PROTON_DRIVE_LOCAL_ROOT` | Optional | Path-delimiter-separated list of local directories that upload/download/photos/sync-plan tools may touch. **Unset = only the dedicated folder `~/ProtonDriveMCP`** (created `0700` on first use). Each root must exist, must not be a symlink, must not be `/` or your home folder and must not contain protected locations; it is resolved with `realpath.native`. The denylist (credential folders, secret-looking names such as `.env`, `*.pem`, `*.key`, `*.kdbx`) and the recursive upload scan stay active inside the roots. |
| `PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH` | Optional | Set to `1` (or `true`) to lift the local allowlist (the assistant can then reach any local path outside the credential denylist). **Not recommended**; `doctor` warns. Default is the dedicated folder above. |
| `PROTON_DRIVE_ALLOW_SENSITIVE_PATHS` | Optional | Set to `1` (or `true`) to disable the built-in credential-location denylist (not recommended). |
| `PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE` | Optional | Set to `1` (or `true`) to let irreversible or outward-facing tools (`drive_empty_trash`, `drive_delete`, `drive_share_*`, `drive_auth_logout`, `photos_delete_album`, `drive_invitation_*`, `remove` download strategies) run on a model-supplied `confirmed: true` when the MCP client cannot ask the human (no elicitation). Default: those calls are refused. Ignored when the client supports elicitation: the human is always asked. |
| `PROTON_DRIVE_DOWNLOAD_MAX_BYTES` | Optional | Most bytes one `drive_download`/`photos_download` call may bring in (default 53687091200 = 50 GiB). Checked against the remote listing before the transfer and against the real bytes in the staging area before anything is placed. |
| `PROTON_DRIVE_UPLOAD_MAX_BYTES` | Optional | Most bytes one `drive_upload`/`photos_upload` call may send (default 5368709120 = 5 GiB). Uploads run from a private snapshot of the validated tree (so the CLI cannot see anything that changed after validation); the snapshot needs that much free space in the temp directory. Larger trees are refused, never sent from the original. |
| `PROTON_DRIVE_SHARE_POLICY` | Optional | `strict` (default) or exactly `off` (any other value, including `OFF`, stays strict). Strict: public links made through the MCP tools must be `viewer`, carry a password of at least 8 characters and expire within 90 days; invitations may not use the `admin` role. `off` lifts these rules. Not applied to the companion CLI (typed by a human). |
| `PROTON_DRIVE_SHARE_ALLOWED_DOMAINS` | Optional | Comma-separated e-mail domains that `drive_share_invite` may target (exact match, case-insensitive; no subdomains). Unset = any domain (each invite is still gated). |
| `CLAUDE_DESKTOP_CONFIG` | Optional | Path of the Claude Desktop config that `doctor` and `setup-claude-desktop` read/write instead of the per-OS default. |
| `PROTON_DRIVE_RETRY_BASE_MS` | Optional | Test hook: base backoff in ms for retrying read-only calls (default 250). |
| `PROTON_DRIVE_WALK_TTL_MS` | Optional | How long `drive_tree`/`drive_search` reuse a cached folder walk, in ms (default 300000; 0 disables the cache). Results can be up to this old, and changes made by other clients or processes are not seen until it expires or `refresh: true`. The first walk of a large drive can take minutes. The cache is dropped for any path this server writes to. |
| `PROTON_DRIVE_WALK_BUDGET_MS` | Optional | How long `drive_search`/`drive_tree`/`drive_usage` wait for a folder walk before returning a `partial: true` result, in ms (default 25000; 0 = wait for the whole walk). The walk keeps running and fills the cache for the next call. Duplicates, sharing audit and sync plan always wait. |
| `PROTON_DRIVE_WALK_CONCURRENCY` | Optional | Parallel folder listings per walk (default and maximum 12). |
| `PROTON_DRIVE_INDEX` | Optional | Set to `1` (or `true`) to keep completed folder walks in a **plaintext** on-disk index so searches are fast after a restart. Off by default. See [Persistent index](#persistent-index-opt-in). |
| `PROTON_DRIVE_INDEX_DIR` | Optional | Directory for the index file (default: `~/Library/Caches/proton-drive-mcp` on macOS, `$XDG_CACHE_HOME` or `~/.cache/proton-drive-mcp` elsewhere). Use a dedicated directory: if it exists it must be yours with mode `0700` (group/other access is refused); a missing one is created `0700`. The file is `0600`. |
| `PROTON_DRIVE_INDEX_MAX_AGE_H` | Optional | Oldest saved index data that may be served, in hours (default 24; 0 = never serve saved data). Served data is marked `stale: true` and refreshed in the background (`drive_sync_plan`, `drive_find_duplicates` and the sharing audit never use it). |
| `PROTON_DRIVE_READ_MAX_BYTES` | Optional | Largest file `drive_read_content` will download, in bytes (default 10485760 = 10 MB; values above 52428800 = 50 MB are clamped). Larger files are refused before any download. |
| `PROTON_DRIVE_TOOL_TIER` | Optional | `full` (default, all 46 tools) or `core` (19 everyday tools; see [Token cost](#token-cost)). Tools outside the active tier are hidden from `tools/list` and refused at call time. Read once at startup; an unknown value falls back to `full` with a warning on stderr. |

> **Opt-outs are parsed strictly.** The boolean switches above (`PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH`, `PROTON_DRIVE_ALLOW_SENSITIVE_PATHS`, `PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE`) are on only for exactly `1` or `true`. Empty, `yes`, `on`, `TRUE`, ` 1` and every other value leave the control in force, so a typo can never relax security. `proton-drive-mcp doctor` lists every opt-out that is active. Opting out of one control relaxes only that control: `PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH` does not weaken the confirmation gates or the sharing policy.

---

## Troubleshooting

**"PROTON_DRIVE_SYNC_PATH is not set"**  
Add `"PROTON_DRIVE_SYNC_PATH": "/absolute/path/to/your/Proton Drive"` to your Claude Desktop MCP config env block. The path must point to the root folder that the Proton Drive desktop app syncs to.

**"proton-drive CLI not found"**  
Download from [proton.me/download/drive/cli](https://proton.me/download/drive/cli/index.html) and ensure the binary is in your `PATH`. Verify with `which proton-drive`.

**"Not authenticated"**  
Run `proton-drive auth login` in your terminal. Auth state is stored in your OS keychain and persists across sessions.

**Claude can't see the connector**  
Restart Claude Desktop fully after changing the MCP config. Check **`+` → Connectors → proton-drive-mcp**. The Proton Drive CLI must be in the `PATH` that Claude Desktop inherits (on macOS this may differ from your shell PATH — use the full binary path in config if needed).

**Upload fails on image files**  
The CLI generates WebP thumbnails by default using Bun's image API. If Bun isn't installed or doesn't support thumbnails on your platform, the MCP passes `--skip-thumbnails` to bypass this. No action needed.

**Custom binary path**  
If the `proton-drive` binary is installed under a non-standard name or location, set `PROTON_DRIVE_BIN` in your environment:
```bash
PROTON_DRIVE_BIN=/usr/local/bin/proton-drive proton-drive-mcp
```
(after `npm install -g github:3lgr/proton-drive-mcp#v2.0.3`; do **not** use `npx proton-drive-mcp`, which is the upstream
package). Or in Claude Desktop config, pointing at the pinned install:
```json
{
  "mcpServers": {
    "proton-drive-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/proton-drive-mcp/dist/index.js"],
      "env": { "PROTON_DRIVE_BIN": "/usr/local/bin/proton-drive" }
    }
  }
}
```
Find the path with `npm root -g` (global install from the tag) or use your clone's `dist/index.js`.

**Windows**  
Windows is not supported (see [Platform support](#platform-support)). If you try anyway, use the full path to the launcher in your Claude Desktop config if the command can't be found:
```json
{
  "mcpServers": {
    "proton-drive-mcp": {
      "command": "C:\\path\\to\\proton-drive-mcp.cmd"
    }
  }
}
```

---

## Development

```bash
git clone https://github.com/3lgr/proton-drive-mcp.git
cd proton-drive-mcp
npm install
npm run build
npm test
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

Bug reports and pull requests welcome: [github.com/3lgr/proton-drive-mcp/issues](https://github.com/3lgr/proton-drive-mcp/issues)

## License

MIT
