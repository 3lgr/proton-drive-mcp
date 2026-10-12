# Contributing

Thanks for helping. This fork is security-focused, so changes are held to a few extra rules.

## Setup

```bash
npm ci --ignore-scripts
npm run lint          # tsc --noEmit
npm test              # builds, then node:test against dist/ with a fake CLI (never a real account)
npm run test:coverage
npm audit --audit-level=high
npm run pack:check
```

Node 22 or newer; CI runs 22, 24 and 26. `npm run test:coverage` is a local tool, CI does not run it. It exited 0
on Node 22.23 and 26.11 when this was checked (2026-10-12). If you see `coverage file is empty` on a newer Node,
first make sure no other `npm test` or build is running in the same checkout (the build wipes `dist/`, which the
coverage run reads), then report it with the Node version. Tests use `test/helpers/fake-cli.mjs` as `PROTON_DRIVE_BIN`; `test/live.test.mjs` only runs with
`PROTON_DRIVE_LIVE` and a real account, which you should not use for destructive tools.

## Rules

- **Tests first** for logic (red, green, refactor). A behaviour change that touches a security control needs a
  regression test that fails without the change.
- **Every tool needs a `TOOL_POLICY` entry** (`src/server/policy.ts`): class, consent mode, validator and the names of
  its local-path arguments. Startup and `test/policy-matrix.test.mjs` fail for a tool without one. Boolean opt-outs go
  through `envFlag()` (exactly `1` or `true`), never an ad-hoc comparison.
- **Gates live in one table** (`src/policy/gates.ts`). A new tool that deletes, shares or leaves the machine must be
  classified there and in `src/policy/sharePolicy.ts` (the parity tests fail otherwise).
- **No free strings in logs or errors.** Use `src/utils/safeOutput.ts` (codes, markers). Text from the CLI, the file
  system or the remote side is never repeated.
- Small, focused files (< 800 lines), functions under ~50 lines, immutable data where practical.
- Conventional commits (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`). No secrets, no `.env`.
- New environment variable: read it as `process.env["NAME"]` and add it to the README table (a test enforces this).

## Releases and Trusted Publishing

Releases are published only by `.github/workflows/publish.yml`, on a `vX.Y.Z` tag that is on `main` and matches
`package.json`. A manual `npm publish` is blocked by `scripts/block-manual-publish.mjs`.

To use the workflow in your own fork:

1. Create a GitHub Environment named `npm-publish` (add required reviewers).
2. On npmjs.com, open the package settings, **Trusted Publisher**, and register: your GitHub user/org and
   repository, workflow file `publish.yml`, environment `npm-publish`. No npm token is stored anywhere.
3. Tag and push: `git tag -s vX.Y.Z && git push origin vX.Y.Z`.

The `.mcpb` bundle workflow (`mcpb-release.yml`) attaches the bundle, `SHA256SUMS` and a build-provenance
attestation to a published GitHub release; verify with `gh attestation verify <file> --repo <owner>/<repo>`.

## Reporting vulnerabilities

Privately, see [SECURITY.md](SECURITY.md).
