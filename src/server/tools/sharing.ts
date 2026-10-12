// Tool definitions: sharing group. Descriptions and schemas are the model-facing contract; gates and annotations are
// layered on in ../catalog.ts.
export const SHARING_TOOLS = [
  // Sharing
    {
      name: "drive_share_status",
      description:
        "Return the sharing state of a Proton Drive path: {isShared, members: [{email, role, addedAt?, status: 'accepted'|'pending'}], shareUrl?}. members includes pending invitations, including to non-Proton addresses — check status. Call before drive_share_invite (avoid duplicates) and drive_share_revoke (confirm the email). Read-only.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute remote path of an existing file or folder, e.g. /my-files/project.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  {
      name: "drive_share_invite",
      description:
        "Invite a person to a Proton Drive file or folder by email. Immediately sends an email notification — confirm the address and role with the user first. Roles: 'viewer' (read-only), 'editor' (read + write), 'admin' (read + write + reshare). Run drive_share_status first: a duplicate invitation may silently overwrite the existing role.",
      annotations: { openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute remote Drive path to share (must start with '/').",
          },
          email: {
            type: "string",
            description: "Email address of the person to invite.",
          },
          role: {
            type: "string",
            enum: ["viewer", "editor", "admin"],
            description:
              "'viewer' = read-only, 'editor' = read + write, 'admin' = read + write + reshare.",
          },
          message: {
            type: "string",
            description: "Optional message included in the invitation email (max 500 characters — Proton rejects longer ones).",
          },
        },
        required: ["path", "email", "role"],
        additionalProperties: false,
      },
    },
  {
      name: "drive_share_revoke",
      description:
        "Remove one person's access (accepted or pending) to a Proton Drive file or folder; they are not notified. Fails if the address is not a current member or invitee (case-insensitive match). Confirm the email with drive_share_status first. To change a role, revoke and re-invite. To remove everyone use drive_share_remove_all.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute remote path of the shared item, as used when inviting.",
          },
          email: {
            type: "string",
            description: "Email of the member to remove, as shown by drive_share_status.",
          },
        },
        required: ["path", "email"],
        additionalProperties: false,
      },
    },
  // Invitations
    {
      name: "drive_list_invitations",
      description:
        "List pending sharing invitations from other users: [{uid, role, invitedByEmail, invitedAt?, nodeName, nodeType}]. Use the uid with drive_invitation_accept / drive_invitation_reject.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  {
      name: "drive_invitation_accept",
      description:
        "Accept a pending sharing invitation; the shared folder then appears in your Drive. Get the uid from drive_list_invitations — never guess it.",
      annotations: { destructiveHint: false },
      inputSchema: {
        type: "object",
        properties: {
          uid: {
            type: "string",
            description: "Invitation uid from drive_list_invitations.",
          },
        },
        required: ["uid"],
        additionalProperties: false,
      },
    },
  {
      name: "drive_invitation_reject",
      description:
        "Reject a pending sharing invitation permanently; the sender is not notified. Get the uid from drive_list_invitations — never guess it.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          uid: {
            type: "string",
            description: "Invitation uid from drive_list_invitations.",
          },
        },
        required: ["uid"],
        additionalProperties: false,
      },
    },
  {
      name: "drive_share_leave",
      description:
        "Leave a Proton Drive folder shared with you; the owner and other members are unaffected. For your own folders use drive_share_revoke.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute remote Drive path of the shared folder to leave (must start with '/'). E.g. /shared-with-me/project",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  {
      name: "drive_share_set_url",
      description:
        "Create or update a public share link: anyone with the link gets the given role, no Proton account needed. Calling again on the same path REPLACES the link's settings (same URL): omitting password/expiration removes them, and the result then carries a warning. Expiration is at most ~90 days out. Returns {url?, role?, expirationTime?, warning?}; fields may be absent. The password is passed as a CLI argument and is visible in the process list and shell history of the machine running this server. For private sharing use drive_share_invite.",
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute remote Drive path to create a public link for (must start with '/').",
          },
          role: {
            type: "string",
            enum: ["viewer", "editor"],
            description: "Access level for anyone with the link. Defaults to 'viewer' if omitted.",
          },
          password: {
            type: "string",
            description: "Optional custom password required to access the link. Omit for no password.",
          },
          expiration: {
            type: "string",
            description: "Optional expiration date in ISO format, e.g. '2026-06-06'. Omit for no expiration.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  {
      name: "drive_share_remove_url",
      description:
        "Remove the public share link from a file or folder; it stops working immediately. Member access is unaffected.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute remote Drive path whose public link should be removed (must start with '/').",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  {
      name: "drive_share_remove_all",
      description:
        "Remove access for every member and pending invitation (Proton and non-Proton) on a shared path in one call. Requires confirmed=true; run drive_share_status first to show who loses access. Does NOT remove a public link (the result says if one is active; use drive_share_remove_url). For one person use drive_share_revoke.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute remote Drive path to strip all sharing access from (must start with '/').",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true. Confirms the user has acknowledged this removes everyone's access at once.",
          },
        },
        required: ["path", "confirmed"],
        additionalProperties: false,
      },
    },
] as const;
