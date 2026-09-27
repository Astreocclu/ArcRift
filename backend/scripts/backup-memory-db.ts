import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const sourcePath = arg("--db");
  const outPath = arg("--out");
  if (!sourcePath || !outPath) throw new Error("Usage: --db SOURCE --out BACKUP");
  if (fs.existsSync(outPath)) throw new Error(`Refusing to overwrite backup: ${outPath}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(outPath);
  } finally {
    source.close();
  }
  fs.chmodSync(outPath, 0o600);
  process.stdout.write(`backup=${outPath}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
