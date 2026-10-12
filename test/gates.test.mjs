// F-01: one gate table, and an approval policy that a model-supplied `confirmed:true` cannot satisfy by itself.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GATES, STRICT_TOOLS, gateApplies, refusalMessage, descriptionSuffix } from "../dist/policy/gates.js";
import { createApprover } from "../dist/policy/approval.js";
import { parseStrategy, UPLOAD_FILE_STRATEGIES, DOWNLOAD_FILE_STRATEGIES } from "../dist/policy/strategies.js";

describe("gate table", () => {
  it("lists every irreversible or external tool as strict", () => {
    for (const t of [
      "drive_empty_trash", "drive_delete", "drive_auth_logout", "photos_delete_album", "drive_invitation_reject", "drive_invitation_accept",
      "drive_share_invite", "drive_share_revoke", "drive_share_set_url", "drive_share_remove_url", "drive_share_remove_all", "drive_share_leave",
    ]) {
      assert.equal(GATES[t]?.strict, true, `${t} must be strict`);
      assert.ok(STRICT_TOOLS.has(t));
    }
  });

  it("local deletion by strategy 'remove' is strict, remote replace/overwrite are gated but not strict", () => {
    assert.equal(GATES.drive_download.strict, true);
    assert.equal(GATES.photos_download.strict, true);
    assert.equal(GATES.drive_upload.strict, false);
    assert.equal(GATES.drive_bulk_move.strict, false);
    assert.equal(GATES.drive_bulk_trash.strict, false);
    assert.equal(GATES.photos_remove_from_album.strict, false);
  });

  it("conditional gates apply only to the dangerous argument values", () => {
    assert.equal(gateApplies("drive_upload", { fileConflictStrategy: "replace" }), true);
    assert.equal(gateApplies("drive_upload", { folderConflictStrategy: "replace" }), true);
    assert.equal(gateApplies("drive_upload", { fileConflictStrategy: "rename" }), false);
    assert.equal(gateApplies("drive_upload", {}), false);
    assert.equal(gateApplies("drive_download", { fileConflictStrategy: "remove" }), true);
    assert.equal(gateApplies("drive_download", { folderConflictStrategy: "remove" }), true);
    assert.equal(gateApplies("drive_download", { fileConflictStrategy: "skip" }), false);
    assert.equal(gateApplies("photos_download", { conflictStrategy: "remove" }), true);
    assert.equal(gateApplies("photos_download", { conflictStrategy: "skip" }), false);
    assert.equal(gateApplies("drive_delete", {}), true);
    assert.equal(gateApplies("drive_list", {}), false);
  });

  it("bulk tools are gated only on the apply call", () => {
    assert.equal(gateApplies("drive_bulk_trash", { paths: ["/a"] }), false);
    assert.equal(gateApplies("drive_bulk_trash", { paths: ["/a"], confirmed: true }), true);
  });

  it("refusal text names the tool, the consequence and confirmed=true", () => {
    const m = refusalMessage("drive_delete");
    assert.match(m, /drive_delete/);
    assert.match(m, /confirmed=true/);
  });

  it("description suffix keeps the documented wording", () => {
    assert.match(descriptionSuffix("drive_share_invite") ?? "", /Requires confirmed=true after explicit user approval/);
    assert.match(descriptionSuffix("drive_upload") ?? "", /'replace'/);
    assert.equal(descriptionSuffix("drive_list"), undefined);
  });
});

describe("approval policy", () => {
  const strict = GATES.drive_empty_trash;
  const soft = GATES.drive_bulk_trash;
  const mk = (over = {}) => {
    const asked = [];
    const approver = createApprover({
      canElicit: () => over.canElicit ?? false,
      elicit: async (m) => { asked.push(m); return over.answer ?? false; },
      env: over.env ?? {},
      now: over.now,
    });
    return { approver, asked };
  };

  it("elicitation-capable client: confirmed:true from the model is irrelevant, the human is always asked", async () => {
    const { approver, asked } = mk({ canElicit: true, answer: true });
    const v = await approver("drive_empty_trash", strict, { confirmed: true }, "msg");
    assert.equal(v.allowed, true);
    assert.equal(v.via, "human");
    assert.equal(asked.length, 1);
  });

  it("elicitation: a decline refuses even though the model said confirmed:true", async () => {
    const { approver } = mk({ canElicit: true, answer: false });
    const v = await approver("drive_empty_trash", strict, { confirmed: true }, "msg");
    assert.equal(v.allowed, false);
    assert.equal(v.kind, "declined");
  });

  it("no elicitation + strict tool + confirmed:true: fails closed without the opt-in", async () => {
    const { approver, asked } = mk({ canElicit: false });
    const v = await approver("drive_empty_trash", strict, { confirmed: true }, "msg");
    assert.equal(v.allowed, false);
    assert.equal(v.kind, "blocked-no-elicitation");
    assert.match(v.message, /PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE/);
    assert.equal(asked.length, 0);
  });

  it("no elicitation + strict tool + opt-in env: prompt-level confirmed:true is enough", async () => {
    const { approver } = mk({ canElicit: false, env: { PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: "1" } });
    const ok = await approver("drive_empty_trash", strict, { confirmed: true }, "msg");
    assert.equal(ok.allowed, true);
    assert.equal(ok.via, "unattended-optin");
    const no = await approver("drive_empty_trash", strict, { confirmed: false }, "msg");
    assert.equal(no.allowed, false);
    assert.equal(no.kind, "needs-confirm");
  });

  it("opt-in only counts when exactly '1' or 'true'", async () => {
    for (const val of ["yes", "0", "", "false", "TRUE", " 1", "1 ", "on", "no"]) {
      const { approver } = mk({ env: { PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: val } });
      const v = await approver("drive_empty_trash", strict, { confirmed: true }, "m");
      assert.equal(v.allowed, false, `value ${JSON.stringify(val)}`);
    }
  });

  it("no elicitation + non-strict tool: confirmed:true passes, absent refuses", async () => {
    const { approver } = mk({ canElicit: false });
    assert.equal((await approver("drive_bulk_trash", soft, { confirmed: true }, "m")).allowed, true);
    const v = await approver("drive_bulk_trash", soft, {}, "m");
    assert.equal(v.allowed, false);
    assert.equal(v.kind, "needs-confirm");
  });

  it("after 5 declines within a minute the human is no longer asked", async () => {
    let t = 1_000_000;
    const { approver, asked } = mk({ canElicit: true, answer: false, now: () => t });
    for (let i = 0; i < 8; i++) await approver("drive_empty_trash", strict, { confirmed: true }, "m");
    assert.equal(asked.length, 5);
    const v = await approver("drive_empty_trash", strict, { confirmed: true }, "m");
    assert.equal(v.kind, "rate-limited");
    t += 61_000;
    await approver("drive_empty_trash", strict, { confirmed: true }, "m");
    assert.equal(asked.length, 6);
  });

  it("an elicit callback that throws is a decline, never an approval", async () => {
    const approver = createApprover({ canElicit: () => true, elicit: async () => { throw new Error("boom"); }, env: {} });
    const v = await approver("drive_empty_trash", strict, { confirmed: true }, "m");
    assert.equal(v.allowed, false);
  });
});

describe("strategies", () => {
  it("defaults, accepts members and rejects everything else", () => {
    assert.equal(parseStrategy(undefined, UPLOAD_FILE_STRATEGIES, "fileConflictStrategy", "skip"), "skip");
    assert.equal(parseStrategy("replace", UPLOAD_FILE_STRATEGIES, "fileConflictStrategy", "skip"), "replace");
    assert.throws(() => parseStrategy("merge", DOWNLOAD_FILE_STRATEGIES, "fileConflictStrategy", "skip"), /fileConflictStrategy must be skip, rename, or remove/);
    assert.throws(() => parseStrategy(["skip"], DOWNLOAD_FILE_STRATEGIES, "x", "skip"), /x must be/);
  });
});
