// The single table of confirmation gates. Everything that decides "does this call need a human?" reads
// this table: the MCP server (index.ts), the schema/description generator, and the companion CLI (cli.ts).
//
// strict  = irreversible, outward-facing or privilege-changing. Without human elicitation these fail
//           closed unless PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE=1 (see approval.ts).
// applies = which argument shapes are gated (conditional gates: replace/remove strategies).

export type Args = Record<string, unknown>;

type Describe = "always" | "schema" | { readonly when: string };

export interface GateSpec {
  readonly strict: boolean;
  /** What happens if the call goes through. Shown to the human and to the model, so keep it factual. */
  readonly consequence: string;
  readonly applies: (a: Args) => boolean;
  /** "always": suffix appended to the description; "schema": the static schema already says it; {when}: conditional suffix. */
  readonly describe: Describe;
  /** The companion CLI requires `--confirm` for the same condition. */
  readonly cliConfirm: boolean;
  /** The handler asks for approval itself, after planning (bulk tools), instead of up front. */
  readonly deferred?: boolean;
}

const always = (): boolean => true;
const confirmedTrue = (a: Args): boolean => a.confirmed === true;

export const GATES: Readonly<Record<string, GateSpec>> = {
  drive_auth_logout: {
    strict: true, applies: always, describe: "always", cliConfirm: false,
    consequence: "ends the stored Proton Drive session for every client on this machine.",
  },
  drive_delete: {
    strict: true, applies: always, describe: "schema", cliConfirm: true,
    consequence: "PERMANENTLY deletes an item that is in the trash. This cannot be undone.",
  },
  drive_empty_trash: {
    strict: true, applies: always, describe: "schema", cliConfirm: true,
    consequence: "PERMANENTLY deletes ALL items in the trash. This cannot be undone. Use drive_list_trash first and show the user what will go.",
  },
  photos_delete_album: {
    strict: true, applies: always, describe: "schema", cliConfirm: true,
    consequence: "deletes a Proton Photos album. Show the user the album name and photo count first.",
  },
  drive_invitation_accept: {
    strict: true, applies: always, describe: "always", cliConfirm: false,
    consequence: "accepts a sharing invitation from another user; their folder, whose content is untrusted, then appears in your Drive.",
  },
  drive_invitation_reject: {
    strict: true, applies: always, describe: "always", cliConfirm: false,
    consequence: "declines the invitation permanently.",
  },
  drive_share_invite: {
    strict: true, applies: always, describe: "always", cliConfirm: false,
    consequence: "immediately emails the invitee and grants them access.",
  },
  drive_share_revoke: {
    strict: true, applies: always, describe: "always", cliConfirm: false,
    consequence: "removes a person's access.",
  },
  drive_share_set_url: {
    strict: true, applies: always, describe: "always", cliConfirm: false,
    consequence: "creates or replaces a PUBLIC link that anyone with the URL can open.",
  },
  drive_share_remove_url: {
    strict: true, applies: always, describe: "always", cliConfirm: false,
    consequence: "disables the public link.",
  },
  drive_share_remove_all: {
    strict: true, applies: always, describe: "schema", cliConfirm: true,
    consequence: "removes everyone's access and every pending invitation at once. Use drive_share_status first to show who loses access.",
  },
  drive_share_leave: {
    strict: true, applies: always, describe: "always", cliConfirm: false,
    consequence: "removes your own access to a shared folder.",
  },
  // `sharedDestination` is set by the handler (never the model) after looking the destination and its ancestors up.
  drive_upload: {
    strict: false, cliConfirm: true,
    applies: (a) => a.fileConflictStrategy === "replace" || a.folderConflictStrategy === "replace" || a.sharedDestination === true,
    describe: { when: "when a conflict strategy is 'replace' (it trashes the existing remote item) or the destination is shared" },
    consequence: "uploads into the destination; with strategy 'replace' it trashes the existing remote item, and when the destination is shared with other people they will be able to see the upload.",
  },
  // Deleting LOCAL data cannot be undone from here, so unlike remote replace this one is strict.
  drive_download: {
    strict: true, cliConfirm: true,
    applies: (a) => a.fileConflictStrategy === "remove" || a.folderConflictStrategy === "remove",
    describe: { when: "when fileConflictStrategy or folderConflictStrategy is 'remove' (it deletes the existing LOCAL file or folder)" },
    consequence: "with strategy 'remove' deletes the existing LOCAL file or folder before downloading.",
  },
  photos_download: {
    strict: true, cliConfirm: true,
    applies: (a) => a.conflictStrategy === "remove",
    describe: { when: "when conflictStrategy is 'remove' (it deletes the existing LOCAL file)" },
    consequence: "with conflictStrategy 'remove' deletes the existing LOCAL file before downloading.",
  },
  // Moving or copying into a folder that is ALREADY shared exposes the item to its members. The handlers set
  // `sharedDestination` (never the model: the schema has no such argument) after looking the destination up.
  drive_move: {
    strict: false, cliConfirm: false, describe: { when: "when the destination folder is already shared with other people (the item would become visible to them)" },
    applies: (a) => a.sharedDestination === true,
    consequence: "moves the item into a folder that is already shared with other people, so they will be able to see it.",
  },
  drive_copy: {
    strict: false, cliConfirm: false, describe: { when: "when the destination folder is already shared with other people (the copy would become visible to them)" },
    applies: (a) => a.sharedDestination === true,
    consequence: "copies the item into a folder that is already shared with other people, so they will be able to see the copy.",
  },
  // Adding to an album that is already shared exposes the photo to its members. The handler sets `sharedDestination`.
  photos_add_to_album: {
    strict: false, cliConfirm: false, describe: { when: "when the album is shared" },
    applies: (a) => a.sharedDestination === true,
    consequence: "adds the photo to an album that is shared with other people (or whose sharing could not be verified), so they will be able to see it.",
  },
  photos_remove_from_album: {
    strict: false, applies: always, describe: "always", cliConfirm: false,
    consequence: "removes a photo from the album.",
  },
  drive_bulk_move: {
    strict: false, applies: confirmedTrue, describe: "always", cliConfirm: true, deferred: true,
    consequence: "moves several items.",
  },
  drive_bulk_trash: {
    strict: false, applies: confirmedTrue, describe: "always", cliConfirm: true, deferred: true,
    consequence: "moves several items to the trash.",
  },
};

export const STRICT_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(GATES).filter(([, g]) => g.strict).map(([name]) => name),
);

export function gateApplies(tool: string, a: Args): boolean {
  const g = GATES[tool];
  return g !== undefined && g.applies(a);
}

/** What the model sees when a gated call arrives without approval. Always mentions confirmed=true. */
export function refusalMessage(tool: string): string {
  const g = GATES[tool];
  const what = g ? ` ${g.consequence}` : "";
  return `${tool}${what} It requires confirmed=true. Describe this to the user, get their explicit OK, then call again with confirmed=true.`;
}

/** Text appended to the tool description, derived from the table. */
export function descriptionSuffix(tool: string): string | undefined {
  const g = GATES[tool];
  if (!g || g.describe === "schema") return undefined;
  if (g.describe === "always") return " Requires confirmed=true after explicit user approval.";
  return ` Requires confirmed=true ${g.describe.when}.`;
}

/** Tools whose schema must carry an optional `confirmed` property (those whose static schema lacks it). */
export function needsConfirmedProp(tool: string): boolean {
  const g = GATES[tool];
  return g !== undefined && g.describe !== "schema";
}
