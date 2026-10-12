// Tool definitions: photos group. Descriptions and schemas are the model-facing contract; gates and annotations are
// layered on in ../catalog.ts.
export const PHOTOS_TOOLS = [
  // Photos / Albums
    {
      name: "photos_list_albums",
      description:
        "List all Proton Photos albums: [{name, photoCount, isShared, creationTime?}]. Album paths are /albums/<name>.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  {
      name: "photos_create_album",
      description:
        "Create an empty Proton Photos album. Pass the name, not a path; it is created at /albums/<name>. Fails if the name exists.",
      annotations: { destructiveHint: false },
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the new album. E.g. 'Vacation 2024'. Must be non-empty.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  {
      name: "photos_update_album",
      description:
        "Rename an album or change its cover photo. At least one of name or coverPhotoUid is required; find a cover nodeUid with photos_list_album_photos.",
      annotations: { destructiveHint: false },
      inputSchema: {
        type: "object",
        properties: {
          albumPath: {
            type: "string",
            description: "Album path, /albums/<name>.",
          },
          name: {
            type: "string",
            description: "New name for the album. Omit to leave unchanged.",
          },
          coverPhotoUid: {
            type: "string",
            description: "nodeUid (from photos_list_album_photos) of the photo to set as the album cover. Omit to leave unchanged.",
          },
        },
        required: ["albumPath"],
        additionalProperties: false,
      },
    },
  {
      name: "photos_delete_album",
      description:
        "Delete a Proton Photos album. Requires confirmed=true. Refuses an album that still contains photos unless force=true. Never deletes your own photos; they stay in the timeline. save maps to the CLI's undocumented --save option (no observable difference for your own photos) — leave it off unless asked. Show the user the album name and photo count first.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          albumPath: {
            type: "string",
            description: "Album path, /albums/<name>.",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true. Confirms the user has acknowledged the deletion.",
          },
          force: {
            type: "boolean",
            description: "If true, delete even if the album still contains photos. Default false.",
          },
          save: {
            type: "boolean",
            description: "CLI --save option (undocumented, no observable effect). Default false.",
          },
        },
        required: ["albumPath", "confirmed"],
        additionalProperties: false,
      },
    },
  {
      name: "photos_list_album_photos",
      description:
        "List the photos in an album. Returns {items, total, offset, limit, hasMore} (default limit 100, newest capture first, ties by nodeUid; without loadDetails there is no captureTime, so the order is by nodeUid); items are [{nodeUid}], or with loadDetails=true also name, mediaType, sizes, captureTime and tags. Items come in a stable sorted order; each page is a fresh read, so changes between page calls can still shift items. To add or remove photos use their /photos/ path, not the nodeUid.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          albumPath: {
            type: "string",
            description: "Album path, /albums/<name>.",
          },
        },
        required: ["albumPath"],
        additionalProperties: false,
      },
    },
  {
      name: "photos_add_to_album",
      description:
        "Add a photo already in your library to an album (does not upload). Find album paths with photos_list_albums.",
      annotations: { destructiveHint: false },
      inputSchema: {
        type: "object",
        properties: {
          albumPath: {
            type: "string",
            description: "Album path, /albums/<name>.",
          },
          photoPath: {
            type: "string",
            description: "Photo path, /photos/<name>.",
          },
        },
        required: ["albumPath", "photoPath"],
        additionalProperties: false,
      },
    },
  {
      name: "photos_remove_from_album",
      description:
        "Remove a photo from an album without deleting it from your library; it stays in the timeline.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          albumPath: {
            type: "string",
            description: "Album path, /albums/<name>.",
          },
          photoPath: {
            type: "string",
            description: "Photo path, /photos/<name>.",
          },
        },
        required: ["albumPath", "photoPath"],
        additionalProperties: false,
      },
    },
  {
      name: "photos_list_timeline",
      description:
        "List photos in your full Proton Photos timeline. Returns {items, total, offset, limit, hasMore} (default limit 50, newest first, ties by nodeUid; each page is a fresh read, so changes between pages can shift items); items are [{nodeUid, captureTime, tags}], or with loadDetails=true also {name, mediaType, creationTime, totalStorageSize} (about 50% more tokens). Download by path with photos_download.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          loadDetails: {
            type: "boolean",
            description: "If true, fetch full node metadata for each photo instead of just its nodeUid. Default false.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  {
      name: "photos_download",
      description:
        "Download photos from your timeline to a local folder by /photos/<name> path. /albums/<album>/<photo> paths are rejected by the CLI — use the /photos/ path. Timeline photos can share a filename: with conflictStrategy 'remove' or 'skip' only one copy survives locally; use 'rename' to keep all. Fails if any item fails.",
      annotations: { openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          photoPaths: {
            type: "array",
            items: { type: "string" },
            maxItems: 200,
            description: "One or more absolute photo paths to download (each must start with '/'). E.g. ['/photos/IMG_001.jpg']",
          },
          localFolder: {
            type: "string",
            description: "Absolute local destination folder (must start with '/'). Created if it does not exist.",
          },
          conflictStrategy: {
            type: "string",
            enum: ["skip", "rename", "remove"],
            description:
              "'skip' keeps the existing local file (default). 'rename' downloads under a unique name. 'remove' deletes the local file first — confirm with user.",
          },
        },
        required: ["photoPaths", "localFolder"],
        additionalProperties: false,
      },
    },
  {
      name: "photos_upload",
      description:
        "Upload local photo or video files into your Proton Photos library. Non-photo/video files are skipped and counted in skippedItems (with duplicate skips). Folders are recursed but flattened — structure is not preserved. Never overwrites: duplicates (name + content hash) resolve to 'rename' or 'skip' only.",
      annotations: { openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          localPaths: {
            type: "array",
            items: { type: "string" },
            maxItems: 200,
            description: "One or more absolute local paths to files or folders to upload (each must start with '/').",
          },
          conflictStrategy: {
            type: "string",
            enum: ["skip", "rename"],
            description: "How to handle duplicate photos (matched by name + content hash). 'skip' leaves the existing photo unchanged (default); 'rename' uploads under a unique name.",
          },
        },
        required: ["localPaths"],
        additionalProperties: false,
      },
    },
] as const;
