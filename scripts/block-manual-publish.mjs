#!/usr/bin/env node
// prepublishOnly guard: `npm publish` from a developer machine must never ship this package by accident.
// Releases are published by .github/workflows/publish.yml (tag push, OIDC trusted publishing, tested tarball).
if (process.env.GITHUB_ACTIONS === "true" && /^refs\/tags\/v/.test(process.env.GITHUB_REF ?? "")) process.exit(0);
console.error("Refusing to publish: releases go out only through the tag-triggered publish workflow (see CONTRIBUTING.md).");
process.exit(1);
