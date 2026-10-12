// N-08: PROTON_DRIVE_PASS_ENV can name variables or SPECIFIC prefixes; "*" alone or a tiny prefix would hand the
// whole environment (cloud keys, tokens) to the CLI. Any use is reported by doctor.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv, parsePassEnv } from "../dist/utils/childEnv.js";
import { activeOptOuts } from "../dist/utils/envFlag.js";

const parent = { HOME: "/h", PATH: "/p", AWS_SECRET_ACCESS_KEY: "s3cr3t", GITHUB_TOKEN: "t", MYAPP_TOKEN: "m", MY_FLAG: "1", AB_X: "x" };

describe("N-08 PROTON_DRIVE_PASS_ENV", () => {
  for (const bad of ["*", " * ", "**", "A*", "AB*", "*,FOO", "?*"]) {
    it(`${JSON.stringify(bad)} passes nothing extra`, () => {
      const env = buildChildEnv({ ...parent, PROTON_DRIVE_PASS_ENV: bad });
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.MYAPP_TOKEN, undefined);
      assert.equal(env.AB_X, undefined);
    });
  }
  it("a prefix of 3+ characters and exact names still work", () => {
    const env = buildChildEnv({ ...parent, PROTON_DRIVE_PASS_ENV: "MYAPP_*, GITHUB_TOKEN" });
    assert.equal(env.MYAPP_TOKEN, "m");
    assert.equal(env.GITHUB_TOKEN, "t");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(buildChildEnv({ ...parent, PROTON_DRIVE_PASS_ENV: "MY_*" }).MY_FLAG, "1");
  });
  it("parsePassEnv reports what it accepted and what it refused", () => {
    const p = parsePassEnv("*, AB*, MYAPP_*, GITHUB_TOKEN");
    assert.deepEqual(p.exact, ["GITHUB_TOKEN"]);
    assert.deepEqual(p.prefixes, ["MYAPP_"]);
    assert.deepEqual(p.refused.sort(), ["*", "AB*"]);
  });
  it("any use is listed in activeOptOuts (doctor), including a refused value", () => {
    assert.deepEqual(activeOptOuts({}), []);
    const used = activeOptOuts({ PROTON_DRIVE_PASS_ENV: "MYAPP_*" }).join("\n");
    assert.match(used, /PROTON_DRIVE_PASS_ENV/);
    assert.match(used, /MYAPP_\*/);
    const refused = activeOptOuts({ PROTON_DRIVE_PASS_ENV: "*" }).join("\n");
    assert.match(refused, /PROTON_DRIVE_PASS_ENV/);
    assert.match(refused, /refused/);
  });
});
