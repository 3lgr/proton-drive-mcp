# Spec: proton-drive-mcp

## Objective

An MCP server (+ companion CLI) that exposes Proton Drive and Proton Photos to Claude and other MCP clients: list, upload, download, organise, share and trash files without leaving the AI workflow.

It wraps the official `proton-drive` CLI binary as a subprocess. The CLI owns authentication (OS keychain), end-to-end encryption and every Proton API call; this project adds the MCP protocol layer, input validation, safety gates and response shaping on top. No credentials pass through this project.

**User:** Claude Code / Claude Desktop users who already have the Proton Drive CLI installed and logged in (`proton-drive auth login`).

## Tech stack

TypeScript (ESM), Node.js >= 22, `@modelcontextprotocol/sdk`, `tsc`, `node:test`, npm. Published as `proton-drive-mcp` (bins: `proton-drive-mcp`, `proton-drive-cli`).

## Commands

```
Build:   npm run build
Lint:    npm run lint          # tsc --noEmit
Test:    npm test              # build + all test/*.test.mjs
Start:   node dist/index.js    # MCP server over stdio
CLI:     node dist/cli.js <command>
```

## Project structure

```
src/index.ts              MCP server: TOOLS (schemas), tool-surface derivation (gates, pagination),
                          schema enforcement, dispatch, lifecycle (signals, cancellation)
src/cli.ts                Companion CLI (mirrors 45 of 47 tools; drive_read_file/drive_write_file are MCP-only)
src/services/content.ts   drive_read_content: guarded private-temp download, UTF-8 text only, paging
src/services/drive.ts     DriveService: one method per operation, CLI argv building, response parsing
src/utils/subprocess.ts   Runs the CLI: timeouts, process-group kill, cancellation, sanitized errors
src/utils/validation.ts   Argument validators (flag injection, traversal, types)
src/utils/localguard.ts   Credential-location denylist / PROTON_DRIVE_LOCAL_ROOT allowlist
src/utils/syncfs.ts       Symlink-safe read/write inside PROTON_DRIVE_SYNC_PATH
src/utils/isMainModule.ts Entry-point detection (realpath, so npm's .bin symlink works)
src/types/index.ts        Shared response types
test/                     Unit tests (injected runner) + real-process tests (fake CLI over stdio)
```

## Tools (47)

- **Auth / meta:** `drive_auth_status`, `drive_auth_logout`, `drive_version`
- **Filesystem:** `drive_list`, `drive_info`, `drive_read_content`, `drive_tree`, `drive_search`, `drive_mkdir`, `drive_upload`, `drive_download`, `drive_rename`, `drive_move`, `drive_copy`
- **Trash:** `drive_list_trash`, `drive_trash`, `drive_restore`, `drive_delete`, `drive_empty_trash`
- **Sharing:** `drive_share_status`, `drive_share_invite`, `drive_share_revoke`, `drive_share_remove_all`, `drive_share_set_url`, `drive_share_remove_url`, `drive_share_leave`
- **Invitations:** `drive_list_invitations`, `drive_invitation_accept`, `drive_invitation_reject`
- **Plan & bulk:** `drive_sync_plan` (plan only), `drive_bulk_move`, `drive_bulk_trash` (plan first, `confirmed` to apply)
- **Analytics:** `drive_usage`, `drive_find_duplicates`, `drive_sharing_audit`
- **Photos:** `photos_list_albums`, `photos_create_album`, `photos_update_album`, `photos_delete_album`, `photos_list_album_photos`, `photos_add_to_album`, `photos_remove_from_album`, `photos_list_timeline`, `photos_download`, `photos_upload`
- **Local sync folder (needs `PROTON_DRIVE_SYNC_PATH`):** `drive_read_file`, `drive_write_file`

## Design rules learned from the live CLI

- The CLI reports per-item success of `move/copy/trash/restore/delete/...` as `[{uid, ok, error}]` with **exit code 0** — every such result must be checked (`assertItemsOk`).
- Node names, authors etc. are `{ok, value}` verification wrappers, never plain strings.
- A literal `/` in a node name is escaped as `\/` in CLI paths; names this server creates may not contain `/`, `.`/`..`, a leading `-`, or control characters.
- Names and paths are not trimmed (trailing spaces are real). Tool arguments are type-checked; non-strings are rejected.
- `set-url` replaces link settings; `sharing remove` and `album create` do not validate membership/uniqueness themselves, so the service does.

## CLI compatibility

Tested against Proton Drive CLI 0.8.x (`TESTED_CLI = "0.8"` in `src/utils/cliVersion.ts`). `doctor` adds a `cli-version` check (warn, never fail, when the major.minor differs or cannot be parsed) and the server logs one stderr warning after `initialize` in the same cases.

## Safety model

- All argv built as arrays for `spawn` (no shell); flag injection blocked by validators. The CLI runs by absolute path
  with a minimal environment; `PROTON_DRIVE_BIN_SHA256` pins it (a verified private copy is what runs).
- **Gates** (`src/policy/gates.ts`, one table). A gated call needs consent that the model cannot supply:
  - client supports MCP elicitation: the human is always asked (the model's `confirmed` is irrelevant);
  - otherwise, strict tools (irreversible or outward-facing) are refused unless `PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE=1`,
    and non-strict gated tools accept prompt-level `confirmed: true`;
  - the companion CLI is typed by a human: the same table says which commands need `--confirm`.
  `confirmed` is therefore a hint for non-eliciting clients, never proof of consent.
- **Registry and dispatcher** (`src/server/policy.ts`, `src/server/dispatch.ts`): default deny. Each tool has a
  `TOOL_POLICY` entry (class, consent `none|dispatcher|handler`, validator, local-path args). The dispatcher resolves
  declared local arguments against the allowlist, runs validation and the gate for dispatcher-consent tools, and wraps
  the drive for handler-consent tools so a mutating call before the gate is refused. `assertRegistryComplete` runs at
  startup. Limitation: only dispatcher-consent tools receive dispatcher-normalised arguments; other handlers still
  validate their own raw arguments.
- Opt-out switches are strict booleans (`src/utils/envFlag.ts`: exactly `1` or `true`); `doctor` lists the active ones.
- Local paths: an ALLOWLIST (default `~/ProtonDriveMCP`, or `PROTON_DRIVE_LOCAL_ROOT`; `PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH=1`
  lifts it) resolved with `realpath.native`; the credential and secret-name denylist stays as defence in depth. Downloads: names validated, private staging, pure plan, no
  overwrite. Uploads: frozen hashed snapshot bound to the approved manifest.
- Remote paths: roots are never mutated; `drive_delete` accepts only trash items.
- Sharing policy for links and invitations (`PROTON_DRIVE_SHARE_POLICY`).
- Everything that carries text from Drive is returned in an untrusted envelope and sanitised; logs and errors use a
  closed vocabulary (codes, markers), never CLI output.
- Document parsing was removed (2.0.0): `drive_read_content` reads plain UTF-8 text only; binaries, PDF and Office files are refused. Less parsing code, less attack surface.
- CLI children run in their own process group and are killed on timeout, cancellation, disconnect and SIGTERM/SIGINT.

## Testing strategy

- Unit tests drive `DriveService` with an injected runner (argv assertions, response parsing, collision/ambiguity handling).
- Real-process tests spawn `dist/index.js` / `dist/cli.js` against a fake `PROTON_DRIVE_BIN` over stdio (gates, schema enforcement, error sanitization, lifecycle, symlink launch, parity of tools/README/glama/smithery).
- `test/live.test.mjs` is an opt-in read-only smoke test against a real account (`PROTON_DRIVE_LIVE=1`).
- CI: lint + tests on Ubuntu and macOS × Node 22/24 (Windows is not tested or supported: Proton ships a Windows CLI, but this project has no passing Windows suite or CI job), `npm audit`, and a pack-and-install smoke test that launches the real bin symlink.

## Boundaries

- **Always:** validate every argument, check `{ok:false}` results, keep responses bounded (pagination), test against the real CLI before claiming a behaviour.
- **Ask first:** new tools, changing a tool's response shape, dependency majors, changing CI/publish.
- **Never:** log or echo secrets, bypass a confirmation gate, run destructive tools against a real account in automated tests.
