import { spawn } from "child_process";

export interface PiProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdinClosed: boolean;
  startedAtCt: string;
  endedAtCt: string;
  durationMs: number;
  spawnError?: string;
  bufferExceeded?: boolean;
}

export interface PiProcessOptions {
  executable?: string;
  timeoutMs: number;
  maxBufferBytes?: number;
}

const CT_ZONE = "America/Chicago";

export function formatCt(date = new Date()): string {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: CT_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}.${String(date.getMilliseconds()).padStart(3, "0")} CT`;
}

export function runPiProcess(args: string[], options: PiProcessOptions): Promise<PiProcessResult> {
  const executable = options.executable ?? "/home/astre/bin/pi";
  const maxBufferBytes = options.maxBufferBytes ?? 4 * 1024 * 1024;
  const started = new Date();
  const startedMonotonic = process.hrtime.bigint();

  return new Promise(resolve => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let stdinClosed = false;
    let bufferExceeded = false;
    let spawnError: string | undefined;
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const ended = new Date();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
        timedOut,
        stdinClosed,
        startedAtCt: formatCt(started),
        endedAtCt: formatCt(ended),
        durationMs: Number((process.hrtime.bigint() - startedMonotonic) / BigInt(1_000_000)),
        ...(spawnError ? { spawnError } : {}),
        ...(bufferExceeded ? { bufferExceeded } : {}),
      });
    };

    const append = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxBufferBytes) {
        bufferExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", chunk => append(stdout, Buffer.from(chunk), "stdout"));
    child.stderr.on("data", chunk => append(stderr, Buffer.from(chunk), "stderr"));
    child.on("error", error => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on("close", finish);

    child.stdin.on("error", () => undefined);
    child.stdin.end();
    stdinClosed = true;

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref();
  });
}
