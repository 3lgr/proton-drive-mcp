// F-08: roots are never the subject of a mutation, and drive_delete/restore only ever see /trash/<name>.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";
import { isRootPath, assertMutablePath, assertDestinationFolder, TRASH_ITEM_RE } from "../dist/policy/remoteRoots.js";

describe("remoteRoots helpers", () => {
  it("recognises roots, including spelling variants", () => {
    for (const p of ["/", "/my-files", "/my-files/", "//my-files", "/MY-FILES", "/photos", "/albums", "/trash", "/photos-trash", "/shared-with-me", "/shared-by-me", "/devices"]) {
      assert.equal(isRootPath(p), true, p);
    }
    for (const p of ["/my-files/a", "/trash/a", "/my-filesx", "/photos/a.jpg"]) assert.equal(isRootPath(p), false, p);
  });

  it("assertMutablePath refuses roots, assertDestinationFolder allows only /my-files among them", () => {
    assert.throws(() => assertMutablePath("/my-files", "trash"), /root/);
    assertMutablePath("/my-files/a", "trash");
    assertDestinationFolder("/my-files", "upload");
    assertDestinationFolder("/my-files/x", "upload");
    for (const p of ["/", "/trash", "/photos-trash", "/albums", "/shared-by-me"]) assert.throws(() => assertDestinationFolder(p, "upload"), /root|cannot/);
  });

  it("TRASH_ITEM_RE accepts only a single level under /trash or /photos-trash (with \\/ escapes)", () => {
    for (const p of ["/trash/a.txt", "/photos-trash/IMG_1.jpg", "/trash/raw\\/slash"]) assert.match(p, TRASH_ITEM_RE, p);
    for (const p of ["/trash", "/trash/", "/my-files/a", "/trash/a/b", "/trashy/a", "/photos-trash"]) assert.doesNotMatch(p, TRASH_ITEM_RE, p);
  });
});

async function refused(tool, args) {
  const sb = makeSandbox();
  const c = await startServer("json", sb);
  try {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} should be refused: ${r.text}`);
    assert.deepEqual(nonVersionCalls(sb.argvLog), [], `${tool} must not reach the CLI`);
    return r.text;
  } finally { await c.close(); sb.cleanup(); }
}
async function allowed(tool, args) {
  const sb = makeSandbox();
  const c = await startServer("json", sb);
  try {
    const r = await c.call(tool, args);
    assert.equal(r.isError, false, r.text);
    assert.ok(nonVersionCalls(sb.argvLog).length > 0);
  } finally { await c.close(); sb.cleanup(); }
}

describe("write tools refuse roots before spawning the CLI", () => {
  for (const root of ["/", "/my-files", "/my-files/", "//my-files", "/photos", "/trash", "/shared-with-me"]) {
    it(`drive_trash ${root}`, () => refused("drive_trash", { path: root }));
    it(`drive_rename ${root}`, () => refused("drive_rename", { path: root, newName: "x" }));
    it(`drive_move source ${root}`, () => refused("drive_move", { sourcePath: root, destinationPath: "/my-files/x" }));
  }
  it("drive_move destination root", () => refused("drive_move", { sourcePath: "/my-files/a", destinationPath: "/my-files" }));
  it("drive_copy source root", () => refused("drive_copy", { sourcePath: "/my-files", destinationPath: "/my-files/x" }));
  it("drive_copy destination folder / and /trash", async () => {
    await refused("drive_copy", { sourcePath: "/my-files/a", destinationPath: "/" });
    await refused("drive_copy", { sourcePath: "/my-files/a", destinationPath: "/trash" });
  });
  it("drive_mkdir of a root", async () => {
    await refused("drive_mkdir", { path: "/my-files" });
    await refused("drive_mkdir", { path: "/trash" });
  });
  it("drive_upload destination / and /trash", async () => {
    await refused("drive_upload", { localPath: "/tmp", remotePath: "/" });
    await refused("drive_upload", { localPath: "/tmp", remotePath: "/trash" });
  });
  it("sharing mutations on a root", async () => {
    await refused("drive_share_invite", { path: "/my-files", email: "a@b.co", role: "viewer", confirmed: true });
    await refused("drive_share_set_url", { path: "/my-files", confirmed: true });
    await refused("drive_share_remove_url", { path: "/my-files", confirmed: true });
    await refused("drive_share_leave", { path: "/shared-with-me", confirmed: true });
    await refused("drive_share_revoke", { path: "/my-files", email: "a@b.co", confirmed: true });
    await refused("drive_share_remove_all", { path: "/", confirmed: true });
  });
  it("photos album tools keep their /albums/<name> requirement", async () => {
    await refused("photos_delete_album", { albumPath: "/albums", confirmed: true });
  });
  it("drive_write_file on the root", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_SYNC_PATH: sb.dir });
    try {
      const r = await c.call("drive_write_file", { path: "/my-files", content: "x" });
      assert.equal(r.isError, true);
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("normal paths still work", () => {
  it("trash/rename/move/copy/mkdir/upload on non-root paths", async () => {
    await allowed("drive_trash", { path: "/my-files/a.txt" });
    await allowed("drive_rename", { path: "/my-files/a.txt", newName: "b.txt" });
    await allowed("drive_copy", { sourcePath: "/my-files/a.txt", destinationPath: "/my-files" });
    await allowed("drive_mkdir", { path: "/my-files/new" });
    await allowed("drive_upload", { localPath: "/tmp", remotePath: "/my-files" });
  });
});

describe("drive_delete / drive_restore only accept /trash/<name> or /photos-trash/<name>", () => {
  for (const p of ["/my-files/a.txt", "/my-files", "/trash", "/trash/a/b", "/photos/a.jpg", "/photos-trash", "/", "/trashy/a"]) {
    it(`drive_delete ${p} is refused without spawning`, async () => {
      const text = await refused("drive_delete", { path: p, confirmed: true });
      assert.match(text, /\/trash\/<name>|\/photos-trash\/<name>/);
    });
  }
  it("accepted shapes reach the CLI", async () => {
    await allowed("drive_delete", { path: "/trash/a.txt", confirmed: true });
    await allowed("drive_delete", { path: "/photos-trash/IMG_1.jpg", confirmed: true });
  });
});
