// Allowlist output model: logs and errors returned to the model carry only closed-vocabulary fields; every free
// string from the CLI / file system / remote side becomes a «str:len=.. id=..» marker. No sentinel may ever appear.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeCliFailure, safeValue, strMarker, ERROR_CODES } from "../dist/utils/safeOutput.js";
import { logger } from "../dist/utils/logger.js";
import { makeSandbox, startServer } from "./helpers/mcp-client.mjs";

const S = "ZQXSENTINEL7731";
const variants = (s) => [s, s.toLowerCase(), s.toUpperCase(), Buffer.from(s).toString("base64").replace(/=+$/, ""), encodeURIComponent(s), [...s].map((c) => c.charCodeAt(0).toString(16)).join("")];
const leaks = (text) => variants(S).filter((v) => text.includes(v));

// Hostile CLI output: a secret in every shape the coordinator listed, plus structural tricks.
const SHAPES = [
  `--password=${S}`, `--password ${S}`, `--password "${S}"`, `--password '${S}'`, `--password\t${S}`, `--PASSWORD=${S}`,
  `{"token":"${S}"}`, `{"error":{"message":"bad ${S}"}}`, `[{"password":"${S}"}]`,
  `https://drive.proton.me/urls/${S}`, `https://drive.proton.me/urls/ABC#${S}`, `https://drive.proton.me/urls/ABC?token=${S}`, `HTTPS://DRIVE.PROTON.ME/URLS/${S}`,
  `https://drive.proton.me/urls/ZQX%53ENTINEL7731`, `${S}@example.com`, `/Users/${S}/Documents/secret.txt`, `C:\\Users\\${S}\\x`,
  `Authorization: Bearer ${S}${S}`, `cookie=${S}; Path=/`, `line one\nlinha dois ${S}\r\nthree`, `\u001b[31m${S}\u001b[0m`, `${S.split("").join("\u200b")}`,
  `\uff3a\uff31\uff38SENTINEL7731 ${S}`, `Error: ENOENT: no such file or directory, open '/home/${S}/.ssh/id'`, `quota exceeded for ${S}`,
  `x`.repeat(5000) + S, S.repeat(300),
];

describe("describeCliFailure never repeats the CLI's words", () => {
  for (const shape of SHAPES) {
    it(`withholds ${JSON.stringify(shape.slice(0, 40))}`, () => {
      const { code, message } = describeCliFailure(shape, 1);
      assert.ok(code in ERROR_CODES);
      assert.deepEqual(leaks(message), []);
      assert.match(message, /withheld: \u00abstr:len=\d+ id=[0-9a-f]{4}\u00bb/);
      assert.ok(message.length < 400);
    });
  }
  it("classifies from a closed set and falls back to CLI_FAILED", () => {
    assert.equal(describeCliFailure("storage quota exceeded").code, "QUOTA_EXCEEDED");
    assert.equal(describeCliFailure("Item not found: /x").code, "NOT_FOUND");
    assert.equal(describeCliFailure("something weird " + S).code, "CLI_FAILED");
  });
});

describe("safeValue / logger", () => {
  it("strings, objects and errors are reduced to markers, class names and codes", () => {
    assert.match(safeValue(S), /^\u00abstr:len=15 id=[0-9a-f]{4}\u00bb$/);
    assert.equal(safeValue(42), "42");
    assert.equal(safeValue(true), "true");
    const err = Object.assign(new Error(`failed for ${S}`), { code: "ECONNRESET" });
    assert.equal(safeValue(err), "Error(code=ECONNRESET)");
    assert.doesNotMatch(safeValue({ password: S, nested: { token: S } }), new RegExp(S));
    assert.doesNotMatch(safeValue([S, S]), new RegExp(S));
  });
  it("the same value has the same id within a run, different values differ", () => {
    assert.equal(strMarker("a"), strMarker("a"));
    assert.notEqual(strMarker("a"), strMarker("b"));
  });
  it("logger output contains no sentinel whatever is passed as a value", () => {
    const written = [];
    const orig = process.stderr.write;
    process.stderr.write = (m) => { written.push(String(m)); return true; };
    try {
      const err = Object.assign(new Error(`bad ${S} --password=${S}`), { code: "E_X", stderr: S });
      for (const shape of SHAPES) {
        logger.warn("something happened", shape, err, { password: shape }, [shape], 7);
        logger.error("failed", new Error(shape));
        logger.info("info", shape);
      }
    } finally { process.stderr.write = orig; }
    const all = written.join("");
    assert.deepEqual(leaks(all), []);
    assert.match(all, /something happened/);
  });
});

describe("end to end: hostile CLI output never reaches the model or the server log", () => {
  for (const [label, env] of [
    ["stderr", (s) => ({ FAKE_FAIL_STDERR: s })],
    ["stdout", (s) => ({ FAKE_FAIL_STDOUT: s })],
    ["stdout json error", (s) => ({ FAKE_FAIL_STDOUT: JSON.stringify({ error: { message: s } }) })],
  ]) {
    it(`${label}: all shapes`, async () => {
      for (const shape of SHAPES.filter((s) => s.length < 600)) {
        const sb = makeSandbox();
        const c = await startServer("fail-custom", sb, env(shape));
        try {
          const r = await c.call("drive_info", { path: "/my-files/a.txt" });
          assert.equal(r.isError, true);
          assert.deepEqual(leaks(r.text), [], `leak in result for ${JSON.stringify(shape.slice(0, 40))}: ${r.text}`);
          assert.deepEqual(leaks(c.stderr), [], "leak in the server log");
        } finally { await c.close(); sb.cleanup(); }
      }
    });
  }
});
