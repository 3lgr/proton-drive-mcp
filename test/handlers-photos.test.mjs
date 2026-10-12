// Photos/album handlers: validation branches, ordering and pagination, the consent gate and its shared-album note,
// and transfer failures. The CLI is a runner stub (no subprocess); local files live in temp dirs.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveService } from "../dist/services/drive.js";
import { photosHandlers } from "../dist/server/handlers/photos.js";
import { loadSharePolicy } from "../dist/policy/sharePolicy.js";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pdphotos-")); dirs.push(d); return d; };

const album = (name, photoCount = 0, extra = {}) => ({ uid: `u-${name}`, name: { ok: true, value: name }, album: { photoCount }, ...extra });
const photo = (id, captureTime, extra = {}) => ({ nodeUid: id, captureTime, tags: [], ...extra });
const SUMMARY = (o = {}) => ({ transferredItems: 1, transferredBytes: 10, skippedItems: 0, failedItems: 0, ...o });

/** answers: { "album list": payload, "album photos": payload, "photo timeline": payload, "photo download": payload, ... } */
function setup(answers = {}, { policy = "off", gateFails } = {}) {
  const calls = [];
  const gates = [];
  const runner = async (args) => {
    calls.push([...args]);
    const key = args.slice(0, 2).join(" ");
    const v = answers[key];
    return typeof v === "function" ? v(args) : v ?? null;
  };
  const ctx = {
    drive: new DriveService(runner),
    sharePolicy: loadSharePolicy({ PROTON_DRIVE_SHARE_POLICY: policy }),
    gate: async (tool, a, prompt) => {
      gates.push({ tool, a, prompt });
      if (gateFails) throw new Error("approval refused");
    },
  };
  return { ctx, calls, gates, mutations: () => calls.filter((c) => !["list", "photos", "timeline"].includes(c[1])) };
}
const text = (r) => r.content[0].text;
const data = (r) => { assert.notEqual(r.isError, true, text(r)); return JSON.parse(text(r)); };

describe("album management", () => {
  it("photos_list_albums maps the CLI shape (nested photoCount, unwrapped name)", async () => {
    const s = setup({ "album list": [album("Trip", 3, { isShared: true })] });
    const r = data(await photosHandlers.photos_list_albums({}, s.ctx));
    assert.deepEqual(r.map((a) => [a.name, a.photoCount, a.isShared]), [["Trip", 3, true]]);
  });
  it("photos_create_album rejects an empty, blank or non-string name without touching the CLI", async () => {
    const s = setup();
    for (const name of [undefined, "", "   ", 42, ["x"]]) {
      const r = await photosHandlers.photos_create_album({ name }, s.ctx);
      assert.equal(r.isError, true, JSON.stringify(name));
      assert.match(text(r), /name must be a non-empty string/);
    }
    assert.equal(s.calls.length, 0);
  });
  it("photos_create_album refuses a duplicate name and creates a new one", async () => {
    const dup = setup({ "album list": [album("Trip")] });
    await assert.rejects(photosHandlers.photos_create_album({ name: "Trip" }, dup.ctx), /already exists/);
    assert.deepEqual(dup.mutations(), []);
    const s = setup({ "album list": [album("Other")] });
    const r = data(await photosHandlers.photos_create_album({ name: "Trip" }, s.ctx));
    assert.match(r.message, /Album created: Trip/);
    assert.deepEqual(s.calls.at(-1), ["album", "create", "Trip"]);
  });
  it("photos_update_album validates the prefix and requires something to change", async () => {
    const s = setup({ "album list": [album("Trip")] });
    const a = await photosHandlers.photos_update_album({ albumPath: "/my-files/Trip", name: "X" }, s.ctx);
    assert.match(text(a), /must start with \/albums\//);
    const b = await photosHandlers.photos_update_album({ albumPath: "/albums/Trip" }, s.ctx);
    assert.match(text(b), /At least one of name or coverPhotoUid/);
    const c = await photosHandlers.photos_update_album({ albumPath: "/albums/Trip", name: "  ", coverPhotoUid: "" }, s.ctx);
    assert.match(text(c), /At least one of name or coverPhotoUid/);
    assert.deepEqual(s.mutations(), []);
  });
  it("photos_update_album passes --name and --cover-photo-uid, and reports the new path", async () => {
    const s = setup({ "album list": [album("Trip")] });
    const r = data(await photosHandlers.photos_update_album({ albumPath: "/albums/Trip", name: "Trip 2026", coverPhotoUid: "p1" }, s.ctx));
    assert.equal(r.message, "Album updated: /albums/Trip 2026");
    assert.deepEqual(s.calls.at(-1), ["album", "update", "/albums/Trip", "--name", "Trip 2026", "--cover-photo-uid", "p1"]);
    const only = setup({ "album list": [album("Trip")] });
    const r2 = data(await photosHandlers.photos_update_album({ albumPath: "/albums/Trip", coverPhotoUid: "p9" }, only.ctx));
    assert.equal(r2.message, "Album updated: /albums/Trip");
  });
  it("photos_update_album refuses an ambiguous album path (two albums with that name)", async () => {
    const s = setup({ "album list": [album("Trip"), album("Trip")] });
    await assert.rejects(photosHandlers.photos_update_album({ albumPath: "/albums/Trip", name: "X" }, s.ctx), /Ambiguous album path/);
    assert.deepEqual(s.mutations(), []);
  });
  it("photos_delete_album refuses a non-empty album unless force, then passes --force/--save", async () => {
    const s = setup({ "album list": [album("Trip", 4)] });
    await assert.rejects(photosHandlers.photos_delete_album({ albumPath: "/albums/Trip" }, s.ctx), /still contains 4 photo/);
    assert.deepEqual(s.mutations(), []);
    const r = data(await photosHandlers.photos_delete_album({ albumPath: "/albums/Trip", force: true, save: true }, s.ctx));
    assert.match(r.message, /Album deleted: \/albums\/Trip/);
    assert.deepEqual(s.calls.at(-1), ["album", "delete", "/albums/Trip", "--force", "--save"]);
  });
});

describe("album contents and timeline", () => {
  const photos = [
    photo("old", "2024-01-01T00:00:00Z"), photo("new", "2026-05-01T00:00:00Z"),
    photo("mid-b", "2025-01-01T00:00:00Z"), photo("mid-a", "2025-01-01T00:00:00Z"),
  ];
  it("photos_list_album_photos requires /albums/ and orders newest first, ties by id", async () => {
    const s = setup({ "album list": [album("Trip")], "album photos": photos });
    const bad = await photosHandlers.photos_list_album_photos({ albumPath: "/photos/x" }, s.ctx);
    assert.match(text(bad), /must start with \/albums\//);
    const r = data(await photosHandlers.photos_list_album_photos({ albumPath: "/albums/Trip" }, s.ctx));
    assert.deepEqual(r.items.map((p) => p.nodeUid), ["new", "mid-a", "mid-b", "old"]);
    assert.equal(r.total, 4);
    assert.equal(r.hasMore, false);
  });
  it("paginates with a stable order and passes --load-details", async () => {
    const s = setup({ "album list": [album("Trip")], "album photos": photos });
    const p1 = data(await photosHandlers.photos_list_album_photos({ albumPath: "/albums/Trip", limit: 3, offset: 0, loadDetails: true }, s.ctx));
    const p2 = data(await photosHandlers.photos_list_album_photos({ albumPath: "/albums/Trip", limit: 3, offset: 3 }, s.ctx));
    assert.equal(p1.hasMore, true);
    assert.equal(p2.hasMore, false);
    assert.deepEqual([...p1.items, ...p2.items].map((p) => p.nodeUid), ["new", "mid-a", "mid-b", "old"]);
    assert.ok(s.calls.some((c) => c[1] === "photos" && c.includes("--load-details")));
  });
  it("photos_list_timeline sorts, paginates and forwards loadDetails", async () => {
    const s = setup({ "photo timeline": photos });
    const r = data(await photosHandlers.photos_list_timeline({ limit: 2, loadDetails: true }, s.ctx));
    assert.deepEqual(r.items.map((p) => p.nodeUid), ["new", "mid-a"]);
    assert.equal(r.hasMore, true);
    assert.deepEqual(s.calls.at(-1), ["photo", "timeline", "--load-details"]);
  });
  it("an empty timeline is an empty page, not an error", async () => {
    const r = data(await photosHandlers.photos_list_timeline({}, setup({ "photo timeline": null }).ctx));
    assert.deepEqual(r, { total: 0, offset: 0, limit: 50, hasMore: false, items: [] });
  });
  it("photos_remove_from_album forwards both paths and surfaces a per-item failure", async () => {
    const ok = setup({ "album list": [album("Trip")], "album remove-photo": [{ uid: "p", ok: true }] });
    const r = data(await photosHandlers.photos_remove_from_album({ albumPath: "/albums/Trip", photoPath: "/photos/a.jpg" }, ok.ctx));
    assert.match(r.message, /Removed \/photos\/a\.jpg from \/albums\/Trip/);
    const bad = setup({ "album list": [album("Trip")], "album remove-photo": [{ uid: "p", ok: false, error: { name: "NodeNotFound", code: 1 } }] });
    await assert.rejects(photosHandlers.photos_remove_from_album({ albumPath: "/albums/Trip", photoPath: "/photos/a.jpg" }, bad.ctx), /Remove from album failed: NodeNotFound/);
  });
});

describe("photos_add_to_album consent gate", () => {
  const args = { albumPath: "/albums/Trip", photoPath: "/photos/a.jpg" };
  it("validates both prefixes before any gate or CLI call", async () => {
    const s = setup({ "album list": [album("Trip")] });
    assert.match(text(await photosHandlers.photos_add_to_album({ ...args, albumPath: "/my-files/Trip" }, s.ctx)), /albumPath must start with \/albums\//);
    assert.match(text(await photosHandlers.photos_add_to_album({ ...args, photoPath: "/my-files/a.jpg" }, s.ctx)), /photoPath must start with \/photos\//);
    assert.equal(s.gates.length, 0);
    assert.equal(s.calls.length, 0);
  });
  it("a private album: gate is asked with sharedDestination false and no warning, then the photo is added", async () => {
    const s = setup({ "album list": [album("Trip", 0, { isShared: false })], "album add-photo": [{ uid: "p", ok: true }] }, { policy: "strict" });
    const r = data(await photosHandlers.photos_add_to_album(args, s.ctx));
    assert.match(r.message, /Added \/photos\/a\.jpg to \/albums\/Trip/);
    assert.equal(s.gates[0].tool, "photos_add_to_album");
    assert.equal(s.gates[0].a.sharedDestination, false);
    assert.doesNotMatch(s.gates[0].prompt, /WARNING/);
    assert.deepEqual(s.calls.at(-1), ["album", "add-photo", "/albums/Trip", "/photos/a.jpg"]);
  });
  it("a shared album: the prompt warns that other people will see the photo", async () => {
    const s = setup({ "album list": [album("Trip", 0, { isShared: true })], "album add-photo": [{ uid: "p", ok: true }] }, { policy: "strict" });
    await photosHandlers.photos_add_to_album(args, s.ctx);
    assert.equal(s.gates[0].a.sharedDestination, true);
    assert.match(s.gates[0].prompt, /already shared with other people/);
  });
  it("sharing state unverifiable (lookup fails) is treated as shared and says so", async () => {
    const s = setup({ "album list": () => { throw new Error("offline"); }, "album add-photo": [] }, { policy: "strict" });
    await assert.rejects(photosHandlers.photos_add_to_album(args, s.ctx)); // assertAlbumUnambiguous also lists
    assert.equal(s.gates[0].a.sharedDestination, true);
    assert.match(s.gates[0].prompt, /could not be verified/);
  });
  it("policy off does not look the album up for the gate", async () => {
    const s = setup({ "album list": [album("Trip", 0, { isShared: true })], "album add-photo": [] }, { policy: "off" });
    await photosHandlers.photos_add_to_album(args, s.ctx);
    assert.equal(s.gates[0].a.sharedDestination, false);
  });
  it("a refused approval stops before the CLI is asked to add anything", async () => {
    const s = setup({ "album list": [album("Trip")], "album add-photo": [] }, { gateFails: true });
    await assert.rejects(photosHandlers.photos_add_to_album(args, s.ctx), /approval refused/);
    assert.ok(!s.calls.some((c) => c[1] === "add-photo"));
  });
});

describe("photos_download", () => {
  it("rejects a missing or empty photoPaths and an invalid conflict strategy", async () => {
    const s = setup();
    for (const photoPaths of [undefined, [], "/photos/a.jpg"]) {
      const r = await photosHandlers.photos_download({ photoPaths, localFolder: tmp() }, s.ctx);
      assert.match(text(r), /photoPaths must be a non-empty array/);
    }
    await assert.rejects(photosHandlers.photos_download({ photoPaths: ["/photos/a.jpg"], localFolder: tmp(), conflictStrategy: "overwrite-everything" }, s.ctx));
    assert.equal(s.calls.length, 0);
    assert.equal(s.gates.length, 0);
  });
  it("rejects an album path (the CLI cannot fetch those) before the gate", async () => {
    const s = setup();
    await assert.rejects(photosHandlers.photos_download({ photoPaths: ["/albums/Trip/a.jpg"], localFolder: tmp() }, s.ctx), /album paths are not supported|\/albums\//);
    assert.equal(s.calls.length, 0);
  });
  it("success: the gate sees the strategy, the CLI gets the paths and a staging folder, summary comes back", async () => {
    const s = setup({ "photo download": SUMMARY({ transferredItems: 2 }) });
    const dest = tmp();
    const r = data(await photosHandlers.photos_download({ photoPaths: ["/photos/a.jpg", "/photos/b.jpg"], localFolder: dest, conflictStrategy: "rename" }, s.ctx));
    assert.equal(r.transferredItems, 2);
    assert.equal(s.gates[0].tool, "photos_download");
    assert.equal(s.gates[0].a.conflictStrategy, "rename");
    const call = s.calls.at(-1);
    assert.deepEqual(call.slice(0, 4), ["photo", "download", "/photos/a.jpg", "/photos/b.jpg"]);
    assert.notEqual(call[4], dest, "downloads land in a private staging folder, not straight in the destination");
    assert.deepEqual(call.slice(-2), ["--conflict-strategy", "rename"]);
  });
  it("a partly failed transfer is an error that carries the counts", async () => {
    const s = setup({ "photo download": SUMMARY({ transferredItems: 1, failedItems: 2 }) });
    const r = await photosHandlers.photos_download({ photoPaths: ["/photos/a.jpg"], localFolder: tmp() }, s.ctx);
    assert.equal(r.isError, true);
    assert.match(text(r), /2 failed item\(s\)\. transferred=1/);
  });
  it("a refused approval never reaches the CLI", async () => {
    const s = setup({ "photo download": SUMMARY() }, { gateFails: true });
    await assert.rejects(photosHandlers.photos_download({ photoPaths: ["/photos/a.jpg"], localFolder: tmp() }, s.ctx), /approval refused/);
    assert.equal(s.calls.length, 0);
  });
});

describe("photos_upload", () => {
  const localFile = (content = "jpeg-bytes") => { const d = tmp(); const f = join(d, "IMG_1.jpg"); writeFileSync(f, content); return f; };
  it("rejects a missing or empty localPaths", async () => {
    const s = setup();
    for (const localPaths of [undefined, [], "x.jpg"]) {
      assert.match(text(await photosHandlers.photos_upload({ localPaths }, s.ctx)), /localPaths must be a non-empty array/);
    }
    assert.equal(s.calls.length, 0);
  });
  it("uploads a snapshot of the file with the chosen strategy (default skip)", async () => {
    let seen;
    const f = localFile("exact-bytes");
    const s = setup({ "photo upload": (args) => { seen = { args, content: readFileSync(args[2], "utf8") }; return SUMMARY(); } });
    const r = data(await photosHandlers.photos_upload({ localPaths: [f] }, s.ctx));
    assert.equal(r.transferredItems, 1);
    assert.equal(seen.content, "exact-bytes");
    assert.notEqual(seen.args[2], f, "the CLI is handed a private snapshot, not the original path");
    assert.deepEqual(seen.args.slice(-2), ["--conflict-strategy", "skip"]);
    const s2 = setup({ "photo upload": SUMMARY() });
    await photosHandlers.photos_upload({ localPaths: [f], conflictStrategy: "rename" }, s2.ctx);
    assert.deepEqual(s2.calls.at(-1).slice(-2), ["--conflict-strategy", "rename"]);
  });
  it("a failed item turns the call into an error with the counts", async () => {
    const s = setup({ "photo upload": SUMMARY({ transferredItems: 0, failedItems: 1 }) });
    const r = await photosHandlers.photos_upload({ localPaths: [localFile()] }, s.ctx);
    assert.equal(r.isError, true);
    assert.match(text(r), /1 failed item\(s\)\. transferred=0/);
  });
  it("a missing local file or a bad strategy fails before the CLI runs", async () => {
    const s = setup({ "photo upload": SUMMARY() });
    const d = tmp(); mkdirSync(join(d, "x"));
    await assert.rejects(photosHandlers.photos_upload({ localPaths: [join(d, "nope.jpg")] }, s.ctx));
    await assert.rejects(photosHandlers.photos_upload({ localPaths: [localFile()], conflictStrategy: "remove" }, s.ctx));
    assert.equal(s.calls.length, 0);
  });
});
