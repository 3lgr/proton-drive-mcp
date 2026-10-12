// Stands in for the "unpdf" module inside the sandboxed parser process and reports what the process may do.
export async function getDocumentProxy() {
  const fs = await import("node:fs");
  const cp = await import("node:child_process");
  const probe = {};
  const attempt = (name, fn) => { try { fn(); probe[name] = "ALLOWED"; } catch (e) { probe[name] = e.code ?? e.message; } };
  attempt("write", () => fs.writeFileSync(`${process.env.TMPDIR ?? "/tmp"}/pdmcp-parser-escape-${process.pid}`, "x"));
  attempt("spawn", () => cp.execSync("true"));
  attempt("readOutside", () => fs.readFileSync("/etc/hosts"));
  try { const { Worker } = await import("node:worker_threads"); new Worker("1", { eval: true }); probe.worker = "ALLOWED"; } catch (e) { probe.worker = e.code ?? e.message; }
  probe.envKeys = Object.keys(process.env);
  throw new Error("PROBE " + JSON.stringify(probe));
}
