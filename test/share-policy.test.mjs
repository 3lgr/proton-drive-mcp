// F-06: share policy for the model-facing tools.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSharePolicy, checkPublicLink, checkInvite, EXPOSURE_TOOLS, NON_EXPOSING_TOOLS } from "../dist/policy/sharePolicy.js";
import { validateEmail, canonicalDomain } from "../dist/utils/validation.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

const NOW = new Date("2026-10-11T00:00:00Z");
describe("sharePolicy (pure)", () => {
  it("defaults to strict; only 'off' disables; unknown values stay strict", () => {
    assert.equal(loadSharePolicy({}).mode, "strict");
    assert.equal(loadSharePolicy({ PROTON_DRIVE_SHARE_POLICY: "OFF" }).mode, "strict", "only the exact word off relaxes it");
    assert.equal(loadSharePolicy({ PROTON_DRIVE_SHARE_POLICY: " off" }).mode, "strict");
    assert.equal(loadSharePolicy({ PROTON_DRIVE_SHARE_POLICY: "off" }).mode, "off");
    assert.equal(loadSharePolicy({ PROTON_DRIVE_SHARE_POLICY: "loose" }).mode, "strict");
  });
  it("parses the domain allowlist (punycode, exact; leading dot = subdomains)", () => {
    assert.deepEqual(loadSharePolicy({ PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: " Example.com, @proton.me ,.corp.io,," }).allowedDomains, ["example.com", "proton.me", ".corp.io"]);
    assert.deepEqual(loadSharePolicy({ PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "bücher.example" }).allowedDomains, ["xn--bcher-kva.example"]);
    assert.throws(() => loadSharePolicy({ PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "not a domain" }), /invalid entry/);
  });
  const strict = loadSharePolicy({});
  it("public link: viewer + password + expiration within 90 days", () => {
    checkPublicLink(strict, { role: "viewer", password: "correct horse", expiration: "2026-12-01" }, NOW);
    assert.throws(() => checkPublicLink(strict, { role: "editor", password: "correct horse", expiration: "2026-12-01" }, NOW), /viewer/);
    assert.throws(() => checkPublicLink(strict, { role: "viewer", expiration: "2026-12-01" }, NOW), /password/);
    assert.throws(() => checkPublicLink(strict, { role: "viewer", password: "short", expiration: "2026-12-01" }, NOW), /password/);
    assert.throws(() => checkPublicLink(strict, { role: "viewer", password: "correct horse" }, NOW), /expiration/);
    assert.throws(() => checkPublicLink(strict, { role: "viewer", password: "correct horse", expiration: "2026-10-01" }, NOW), /past/);
    assert.throws(() => checkPublicLink(strict, { role: "viewer", password: "correct horse", expiration: "2027-06-01" }, NOW), /90 days/);
    assert.throws(() => checkPublicLink(strict, { role: "viewer", password: "correct horse", expiration: "tomorrow" }, NOW), /ISO date/);
  });
  it("off lifts every rule", () => {
    const off = loadSharePolicy({ PROTON_DRIVE_SHARE_POLICY: "off", PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "x.com" });
    checkPublicLink(off, { role: "editor" }, NOW);
    checkInvite(off, "a@evil.com", "admin");
  });
  it("invites: returns the canonical e-mail and lower-case role; admin refused", () => {
    assert.deepEqual(checkInvite(strict, " Alice@Example.COM ", "Editor"), { email: "alice@example.com", role: "editor" });
    for (const role of ["admin", "ADMIN", "Admin"]) assert.throws(() => checkInvite(strict, "a@b.co", role), /admin/, role);
    assert.throws(() => checkInvite(strict, "a@b.co", "owner"), /role must be/);
    assert.throws(() => checkInvite(strict, "a@b.co", ""), /role must be/);
  });
  it("invites: allowlist is exact equality; only an explicit leading dot admits subdomains", () => {
    const p = loadSharePolicy({ PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "corp.com,.partner.io" });
    checkInvite(p, "x@CORP.com", "viewer");
    checkInvite(p, "x@a.partner.io", "viewer");
    for (const bad of ["x@corp.com.evil.io", "x@sub.corp.com", "x@partner.io", "x@evilcorp.com", "x@xcorp.com"]) {
      assert.throws(() => checkInvite(p, bad, "viewer"), /limited to these domains/, bad);
    }
  });
  it("homograph / IDN: compared in punycode, so a look-alike never equals the ASCII domain", () => {
    const p = loadSharePolicy({ PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "example.com" });
    assert.throws(() => checkInvite(p, "a@\u0435xample.com", "viewer"), /limited to these domains/); // Cyrillic е
    assert.throws(() => checkInvite(p, "a@exam\u200Bple.com", "viewer"));
    assert.equal(validateEmail("a@b\u00FCcher.example"), "a@xn--bcher-kva.example");
  });
  it("parser differentials are rejected, never interpreted", () => {
    const p = loadSharePolicy({ PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "x.com" });
    for (const bad of [
      "a@x.com,b@evil.com", "a@x.com;b@evil.com", '"a@x.com"@evil.com', "a@evil.com@x.com", "a@x.com@evil.com", "Alice <a@x.com>",
      "a@x.com (comment)", "(c)a@x.com", "a b@x.com", "a@x .com", "a@x.com\u0000", "a\u0000@x.com", "@x.com", "a@", "a@x", "a@.x.com",
      "a@x..com", "a@-x.com", "a..b@x.com", ".a@x.com", "a.@x.com", "a@x.com.", "\u00E1@x.com", "a@[127.0.0.1]", "a@1.2.3.4", "a%40evil.com@x.com",
    ]) {
      assert.throws(() => checkInvite(p, bad, "viewer"), (e) => /invalid email|control characters/.test(e.message), JSON.stringify(bad));
    }
  });
  it("mode off still normalises and validates (only the policy rules are lifted)", () => {
    const off = loadSharePolicy({ PROTON_DRIVE_SHARE_POLICY: "off" });
    assert.deepEqual(checkInvite(off, "A@B.co", "ADMIN"), { email: "a@b.co", role: "admin" });
    assert.throws(() => checkInvite(off, "a@b.co,c@d.co", "viewer"), /invalid email/);
  });
  it("canonicalDomain basics", () => {
    assert.equal(canonicalDomain("Example.COM"), "example.com");
    assert.equal(canonicalDomain("localhost"), undefined);
    assert.equal(canonicalDomain("a_b.com"), undefined);
  });
});

describe("tools enforce the policy before any CLI call", () => {
  async function run(tool, args, env = {}) {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_SHARE_POLICY: "strict", ...env });
    try { const r = await c.call(tool, args); return { r, calls: nonVersionCalls(sb.argvLog) }; }
    finally { await c.close(); sb.cleanup(); }
  }
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  it("set_url without password/expiration, or as editor, is refused", async () => {
    for (const extra of [{}, { password: "longenough1" }, { expiration: soon }, { password: "longenough1", expiration: soon, role: "editor" }]) {
      const { r, calls } = await run("drive_share_set_url", { path: "/my-files/a", confirmed: true, ...extra });
      assert.equal(r.isError, true, JSON.stringify(extra));
      assert.match(r.text, /share policy/);
      assert.deepEqual(calls, []);
    }
  });
  it("a compliant link goes through", async () => {
    const { r, calls } = await run("drive_share_set_url", { path: "/my-files/a", confirmed: true, password: "longenough1", expiration: soon });
    assert.equal(r.isError, false, r.text);
    assert.ok(calls.length > 0);
  });
  it("PROTON_DRIVE_SHARE_POLICY=off restores the old behaviour", async () => {
    const { r } = await run("drive_share_set_url", { path: "/my-files/a", confirmed: true, role: "editor" }, { PROTON_DRIVE_SHARE_POLICY: "off" });
    assert.equal(r.isError, false, r.text);
  });
  it("every tool is classified: exposure tools go through the policy, the rest are explicitly non-exposing (default deny)", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const names = (await c.listTools()).map((t) => t.name);
      const unclassified = names.filter((n) => !EXPOSURE_TOOLS.has(n) && !NON_EXPOSING_TOOLS.has(n));
      assert.deepEqual(unclassified, [], "classify new tools in src/policy/sharePolicy.ts");
      assert.deepEqual([...EXPOSURE_TOOLS].sort(), ["drive_share_invite", "drive_share_set_url"]);
    } finally { await c.close(); sb.cleanup(); }
  });
  it("mixed-case role and a smuggled second address are refused before the CLI", async () => {
    for (const args of [{ role: "ADMIN" }, { email: "a@x.com,b@evil.com", role: "viewer" }]) {
      const { r, calls } = await run("drive_share_invite", { path: "/my-files/a", email: "a@b.co", confirmed: true, ...args });
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.deepEqual(calls, []);
    }
  });
  it("the canonical e-mail is what the CLI receives", async () => {
    const { r, calls } = await run("drive_share_invite", { path: "/my-files/a", email: " Bob@Example.COM ", role: "editor", confirmed: true });
    assert.equal(r.isError, false, r.text);
    const argv = calls.find((a) => a[0] === "sharing" && a[1] === "invite");
    assert.equal(argv[argv.indexOf("--user") + 1], "bob@example.com");
    assert.equal(argv[argv.indexOf("--role") + 1], "editor");
  });
  it("invite: admin refused, off-list domain refused, listed domain allowed", async () => {
    let x = await run("drive_share_invite", { path: "/my-files/a", email: "a@b.co", role: "admin", confirmed: true });
    assert.equal(x.r.isError, true); assert.deepEqual(x.calls, []);
    x = await run("drive_share_invite", { path: "/my-files/a", email: "a@evil.io", role: "viewer", confirmed: true }, { PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "corp.com" });
    assert.equal(x.r.isError, true); assert.deepEqual(x.calls, []);
    x = await run("drive_share_invite", { path: "/my-files/a", email: "a@corp.com", role: "editor", confirmed: true }, { PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "corp.com" });
    assert.equal(x.r.isError, false, x.r.text);
  });
});
