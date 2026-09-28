import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { runPiProcess } from "../../src/services/pi-executor";

const execFileAsync = promisify(execFile);

describe("pi process executor", () => {
  it("closes stdin so a pi-compatible process waiting for EOF can start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "arcrift-pi-eof-"));
    const stub = path.join(root, "pi-stub.js");
    fs.writeFileSync(stub, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ok:true})));",
      "",
    ].join("\n"), { mode: 0o700 });

    try {
      await expect(execFileAsync(stub, [], { timeout: 150, killSignal: "SIGKILL" })).rejects.toMatchObject({ killed: true });

      const started = Date.now();
      const result = await runPiProcess([], { executable: stub, timeoutMs: 2_000 });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result).toMatchObject({
        stdout: '{"ok":true}',
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
      });
      expect(result.stdinClosed).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
