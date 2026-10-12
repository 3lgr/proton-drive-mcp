import type { Handler } from "../context.js";
import { filesystemHandlers } from "./filesystem.js";
import { sharingHandlers } from "./sharing.js";
import { photosHandlers } from "./photos.js";
import { contentHandlers } from "./content.js";
import { analyticsHandlers } from "./analytics.js";

export const HANDLERS: Readonly<Record<string, Handler>> = {
  ...filesystemHandlers, ...sharingHandlers, ...photosHandlers, ...contentHandlers, ...analyticsHandlers,
};
