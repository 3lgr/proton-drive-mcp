// F-06: share policy for the model-facing tools.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSharePolicy, checkPublicLink, checkInvite } from "../dist/policy/sharePolicy.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

const NOW = new Date("2026-10-11T00:00:00Z");
describe("sharePolicy (pure)", () => {
  it("defaults to strict; only 'off' disables; unknown values stay strict", () => {
    assert.equal(loadSharePolicy({}).mode, "strict");
    assert.equal(loadSharePolicy({ PROTON_DRIVE_SHARE_POLICY: "OFF" }).mode, "off");
    assert.equal(loadSharePolicy({ PROTON_DRIVE_SHARE_POLICY: "loose" }).mode, "strict");
  });
  it("parses the domain allowlist", () => {
    assert.deepEqual(loadSharePolicy({ PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: " Example.com, @proton.me ,," }).allowedDomains, ["example.com", "proton.me"]);
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
  it("invites: admin refused; domain allowlist enforced case-insensitively", () => {
    assert.throws(() => checkInvite(strict, "a@b.co", "admin"), /admin/);
    checkInvite(strict, "a@b.co", "editor");
    const p = loadSharePolicy({ PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "corp.com" });
    checkInvite(p, "x@CORP.com", "viewer");
    assert.throws(() => checkInvite(p, "x@corp.com.evil.io", "viewer"), /limited to these domains/);
    assert.throws(() => checkInvite(p, "x@sub.corp.com", "viewer"), /limited to these domains/);
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
  it("invite: admin refused, off-list domain refused, listed domain allowed", async () => {
    let x = await run("drive_share_invite", { path: "/my-files/a", email: "a@b.co", role: "admin", confirmed: true });
    assert.equal(x.r.isError, true); assert.deepEqual(x.calls, []);
    x = await run("drive_share_invite", { path: "/my-files/a", email: "a@evil.io", role: "viewer", confirmed: true }, { PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "corp.com" });
    assert.equal(x.r.isError, true); assert.deepEqual(x.calls, []);
    x = await run("drive_share_invite", { path: "/my-files/a", email: "a@corp.com", role: "editor", confirmed: true }, { PROTON_DRIVE_SHARE_ALLOWED_DOMAINS: "corp.com" });
    assert.equal(x.r.isError, false, x.r.text);
  });
});
