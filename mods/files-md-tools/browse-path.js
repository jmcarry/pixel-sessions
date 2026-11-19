import { exec } from "herdr";

// Path and base are separate arguments, so spaces and shell metacharacters are literal.
const DIRECTORY = `
from pathlib import Path
import os, sys
try:
    folder = Path(sys.argv[1]).expanduser()
    if not folder.is_absolute():
        folder = (Path(sys.argv[2]) if sys.argv[2] else Path.home()) / folder
    folder = folder.resolve(strict=True)
    with os.scandir(folder):
        pass
    sys.stdout.buffer.write(str(folder).encode("utf-8"))
except (OSError, RuntimeError, ValueError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;

export async function resolveDirectory(path, base, on) {
  if (!path.trim()) throw new Error("Enter a folder path.");
  const result = await exec("python3", ["-c", DIRECTORY, path, base ?? ""], { on, timeout: 5000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Cannot open that folder.");
  return result.stdout;
}
