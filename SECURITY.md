# Security policy

This is an unofficial, hardened fork of [googlarz/proton-drive-mcp](https://github.com/googlarz/proton-drive-mcp),
maintained by Elger Rodrigues ([3lgr](https://github.com/3lgr)). It is not affiliated with Proton AG.

## Supported versions

Only the latest tagged release of this fork (currently the 2.x line) receives security fixes.

## Reporting a vulnerability

Report privately through GitHub Security Advisories of this repository:
<https://github.com/3lgr/proton-drive-mcp/security/advisories/new>

Please do not open public issues or pull requests for vulnerabilities, and do not include real Proton account data,
session material or file contents in a report.

Service levels (best effort, one maintainer):

| Step | Target |
|---|---|
| Acknowledgement | within 3 business days |
| Triage and severity assessment | within 7 days |
| Fix or mitigation for High/Critical | within 30 days |
| Fix for Medium/Low | next release, normally within 90 days |
| Coordinated disclosure | after a fix is released, or 90 days after the report, whichever comes first |

Issues in the closed-source `proton-drive` CLI itself belong to Proton (<https://proton.me/security>).
Issues in the upstream project that this fork has not touched may also be reported upstream.

## Security model

This server wraps the official `proton-drive` CLI, which holds a live, authenticated Proton session on the machine
where it runs. Whoever can call the server's tools can act as the signed-in user. The adversary this fork designs
against is a **manipulated model**: text in a file name, an invitation, a shared document or a web page that persuades
the assistant to do something the user did not ask for.

What the server enforces itself (so the model cannot talk its way past it):

- consent for irreversible or outward-facing actions: the human is always asked when the client supports MCP
  elicitation; otherwise those tools fail closed unless the operator opts in (`PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE=1`);
- local file policy: an allowlist of local folders (default `~/ProtonDriveMCP`, or `PROTON_DRIVE_LOCAL_ROOT`) with the credential denylist as a second layer, staged and planned downloads,
  snapshotted and manifest-bound uploads, no symlinks/hardlinks/special files;
- sharing policy for links and invitations, and a gate for putting data into a folder or album that is already shared (the destination and its ancestors are checked; a failed lookup counts as shared);
- no tool writes into the local sync folder (`drive_write_file` was removed in 2.0.1); `drive_read_file` refuses known secrets;
- untrusted-content envelope and sanitiser for every string that comes from Drive; allowlist-only logs and errors;
- binary pinning and a private verified copy (`PROTON_DRIVE_BIN_SHA256`), minimal child environment;
- no document parsing at all: `drive_read_content` reads plain UTF-8 text only (PDF/Office parsers were removed to keep the attack surface small).

- scratch space: no fixed or shared location (a random 0700 directory per process), the download ceiling is enforced while the CLI writes, cleanup per entry without following links, no global sweep;

What it does not do:

- it cannot make the model's own reasoning trustworthy; the envelope and markers raise the bar, they are not a proof;
- it cannot verify what the closed CLI does with names it is given, and it cannot detect a CLI that writes outside the staging folder it was handed (see "Known limitations" in the README);
- it does not protect against a malicious local user or a compromised machine (the session lives in your keychain);
- Windows is untested and unsupported.

Operator guidance: run only MCP clients you trust, prefer a client with elicitation, set `PROTON_DRIVE_LOCAL_ROOT`,
pin the CLI binary and keep `PROTON_DRIVE_SHARE_POLICY` strict.
