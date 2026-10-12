// Preloaded into every test process (npm test --import): a developer's own
// PROTON_DRIVE_INDEX* settings must never make a test touch the real cache dir.
for (const k of Object.keys(process.env)) if (k.startsWith("PROTON_DRIVE_INDEX")) delete process.env[k];

// The local-path allowlist (default folder ~/ProtonDriveMCP) is covered by test/local-allowlist.test.mjs. Every other
// suite uses temp directories wherever it likes, so it runs with the documented opt-out; the denylist stays active.
process.env.PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH = "1";
