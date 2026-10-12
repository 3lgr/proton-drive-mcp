// drive_usage / drive_find_duplicates / drive_sharing_audit through their handlers: argument defaults, validation,
// pass-through of every option, refresh semantics and error mapping. The CLI is a runner stub, not a subprocess.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DriveService } from "../dist/services/drive.js";
import { analyticsHandlers } from "../dist/server/handlers/analytics.js";
import { resetWalkCacheForTests, invalidatePath, abortBackgroundRefreshes, flushWalkIndexForTests } from "../dist/services/walk.js";

const folder = (name, extra = {}) => ({ uid: `d-${name}`, type: "folder", name: { ok: true, value: name }, ...extra });
const file = (name, size, extra = {}) => ({
  uid: `f-${name}`, type: "file", name: { ok: true, value: name }, mediaType: "text/plain",
  modificationTime: "2026-01-02T00:00:00.000Z",
  activeRevision: { claimedSize: size, claimedModificationTime: "2025-05-05T00:00:00.000Z", claimedDigests: { sha1: `sha-${size}` } },
  ...extra,
});

/** Runner stub: tree maps a folder path to its listing; shares maps a path to a `sharing status` payload (or an Error). */
function stub({ tree, shares = {} }) {
  const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "filesystem" && args[1] === "list") {
      const v = tree[args[2]];
      if (v === undefined) throw new Error(`Node not found: ${args[2]}`);
      return v;
    }
    if (args[0] === "sharing" && args[1] === "status") {
      const v = shares[args[2]];
      if (v instanceof Error) throw v;
      return v ?? null;
    }
    if (args[0] === "filesystem" && args[1] === "list-trash") return [];
    return null;
  };
  return { ctx: { drive: new DriveService(runner) }, lists: () => calls.filter((c) => c[1] === "list" && c[2] !== "/trash").map((c) => c[2]), calls };
}
const data = (res) => { assert.equal(res.isError, undefined, res.content[0].text); return JSON.parse(res.content[0].text); };

beforeEach(() => { resetWalkCacheForTests(); invalidatePath("/"); });
afterEach(async () => { abortBackgroundRefreshes(); await flushWalkIndexForTests(); resetWalkCacheForTests(); });

const TREE = {
  "/my-files": [folder("docs"), file("big.bin", 5000), file("small.txt", 10)],
  "/my-files/docs": [file("a.pdf", 3000, { mediaType: "application/pdf" }), file("copy-of-big.bin", 5000)],
  "/trash": [],
};

describe("drive_usage handler", () => {
  it("defaults the path to /my-files and totals the whole tree", async () => {
    const s = stub({ tree: TREE });
    const r = data(await analyticsHandlers.drive_usage({}, s.ctx));
    assert.equal(r.root, "/my-files");
    assert.deepEqual(r.totals, { files: 4, folders: 1, bytes: 13010 });
    assert.deepEqual(s.lists(), ["/my-files", "/my-files/docs"]);
    assert.equal(r.trash.count, 0);
  });
  it("passes top through to the ranking", async () => {
    const s = stub({ tree: TREE });
    const r = data(await analyticsHandlers.drive_usage({ top: 1 }, s.ctx));
    assert.equal(r.largestFiles.length, 1);
    assert.equal(r.largestFiles[0].bytes ?? r.largestFiles[0].size, 5000);
  });
  it("passes olderThanDays through (modification time 2026-01 counts as old for a 1-day cut-off)", async () => {
    const s = stub({ tree: TREE });
    const r = data(await analyticsHandlers.drive_usage({ olderThanDays: 1 }, s.ctx));
    assert.equal(r.olderThan.count, 4);
    assert.equal(r.olderThan.undated, 0);
  });
  it("rejects a path that is not an absolute drive path before any CLI call", async () => {
    const s = stub({ tree: TREE });
    await assert.rejects(analyticsHandlers.drive_usage({ path: "my-files" }, s.ctx), /absolute/);
    await assert.rejects(analyticsHandlers.drive_usage({ path: "/my-files/../x" }, s.ctx), /segments/);
    await assert.rejects(analyticsHandlers.drive_usage({ path: "/" }, s.ctx), /not '\/'/);
    assert.equal(s.calls.length, 0);
  });
  it("uses the walk cache by default and re-lists with refresh: true", async () => {
    const s = stub({ tree: TREE });
    await analyticsHandlers.drive_usage({}, s.ctx);
    const first = s.lists().length;
    await analyticsHandlers.drive_usage({}, s.ctx);
    assert.equal(s.lists().length, first, "second call is served from the cache");
    await analyticsHandlers.drive_usage({ refresh: true }, s.ctx);
    assert.equal(s.lists().length, first * 2, "refresh walks again");
  });
  it("a missing folder surfaces the CLI error to the caller", async () => {
    const s = stub({ tree: TREE });
    await assert.rejects(analyticsHandlers.drive_usage({ path: "/my-files/nope" }, s.ctx), /not found/i);
  });
});

describe("drive_find_duplicates handler", () => {
  it("groups same-size files that share the claimed sha1, suggests a keeper and never deletes", async () => {
    const s = stub({ tree: TREE });
    const r = data(await analyticsHandlers.drive_find_duplicates({ minSize: 1 }, s.ctx));
    assert.equal(r.verifyRequested, false);
    const g = r.groups.find((x) => x.sizeBytes === 5000);
    assert.ok(g, JSON.stringify(r.groups));
    assert.deepEqual(g.members.map((m) => m.path).sort(), ["/my-files/big.bin", "/my-files/docs/copy-of-big.bin"]);
    assert.equal(g.wastedBytes, 5000);
    assert.ok(!s.calls.some((c) => c[1] === "delete" || c[1] === "download"));
  });
  it("minSize excludes small groups", async () => {
    const s = stub({ tree: TREE });
    const all = data(await analyticsHandlers.drive_find_duplicates({ minSize: 1 }, s.ctx));
    const big = data(await analyticsHandlers.drive_find_duplicates({ minSize: 6000 }, s.ctx));
    assert.ok(all.totalGroups >= 1);
    assert.equal(big.totalGroups, 0);
  });
  it("limit caps the reported groups but not totalGroups", async () => {
    const tree = {
      "/my-files": [file("a1", 2000), file("a2", 2000), file("b1", 3000), file("b2", 3000), file("c1", 4000), file("c2", 4000)],
    };
    const r = data(await analyticsHandlers.drive_find_duplicates({ limit: 2, minSize: 1 }, stub({ tree }).ctx));
    assert.equal(r.groups.length, 2);
    assert.equal(r.totalGroups, 3);
  });
  it("refuses an out-of-range maxVerifyTotalBytes before walking", async () => {
    const s = stub({ tree: TREE });
    await assert.rejects(analyticsHandlers.drive_find_duplicates({ maxVerifyTotalBytes: 0 }, s.ctx), /maxVerifyTotalBytes/);
    await assert.rejects(analyticsHandlers.drive_find_duplicates({ maxVerifyTotalBytes: 2_000_000_001 }, s.ctx), /maxVerifyTotalBytes/);
    assert.equal(s.calls.length, 0);
  });
  it("rejects a bad path and defaults to /my-files", async () => {
    const s = stub({ tree: TREE });
    await assert.rejects(analyticsHandlers.drive_find_duplicates({ path: "/" }, s.ctx));
    const r = data(await analyticsHandlers.drive_find_duplicates({}, s.ctx));
    assert.equal(r.root, "/my-files");
  });
});

describe("drive_sharing_audit handler", () => {
  const tree = {
    "/my-files": [
      folder("pub", { isShared: true, isSharedByUrl: true }),
      folder("team", { isShared: true }),
      folder("private"),
    ],
    "/my-files/pub": [], "/my-files/team": [], "/my-files/private": [],
  };
  const shares = {
    "/my-files/pub": { members: [], urlAccess: { url: "https://drive.proton.me/urls/SECRET", role: "editor", customPassword: "x" } },
    "/my-files/team": { members: [{ inviteeEmail: "bob@gmail.com", role: "viewer" }], protonInvitations: [], nonProtonInvitations: [] },
  };
  it("audits only shared nodes, flags risks and never prints the link URL", async () => {
    const s = stub({ tree, shares });
    const r = data(await analyticsHandlers.drive_sharing_audit({}, s.ctx));
    assert.equal(r.sharedNodes, 2);
    assert.equal(r.audited, 2);
    const pub = r.items.find((i) => i.path === "/my-files/pub");
    assert.ok(pub.flags.includes("public-link-no-expiry"));
    assert.ok(pub.flags.includes("public-link-editor"));
    assert.equal(pub.publicLink.passwordProtected, true);
    const team = r.items.find((i) => i.path === "/my-files/team");
    assert.ok(team.flags.includes("external-invitee"));
    assert.ok(!JSON.stringify(r).includes("SECRET"), "the public link URL must be omitted");
    assert.ok(!s.calls.some((c) => c[2] === "/my-files/private" && c[0] === "sharing"));
  });
  it("one failing status lookup is reported per item, not fatal", async () => {
    const s = stub({ tree, shares: { ...shares, "/my-files/team": new Error("boom") } });
    const r = data(await analyticsHandlers.drive_sharing_audit({}, s.ctx));
    assert.equal(r.items.length, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].path, "/my-files/team");
  });
  it("rejects a bad path; refresh re-walks", async () => {
    const s = stub({ tree, shares });
    await assert.rejects(analyticsHandlers.drive_sharing_audit({ path: "relative" }, s.ctx));
    await analyticsHandlers.drive_sharing_audit({}, s.ctx);
    const n = s.lists().length;
    await analyticsHandlers.drive_sharing_audit({ refresh: true }, s.ctx);
    assert.equal(s.lists().length, n * 2);
  });
});
