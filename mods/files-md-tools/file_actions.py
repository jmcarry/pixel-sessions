"""Perform one explicitly selected file action on the owning machine."""
import ctypes
import errno
import os
from pathlib import Path
import stat
import subprocess
import sys


def rename_exclusive(source, destination):
    if os.name == "nt":
        os.rename(source, destination)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    src, dst = os.fsencode(source), os.fsencode(destination)
    if sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        rc = libc.renamex_np(src, dst, 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rc = libc.renameat2(-100, src, -100, dst, 1)  # AT_FDCWD, RENAME_NOREPLACE
    else:
        raise ValueError("This machine does not provide a no-overwrite rename.")
    if rc:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise ValueError("A file or folder with that name already exists.")
        raise OSError(code, os.strerror(code))


def perform(action, filename, name=None):
    path = Path(filename)
    if not path.is_absolute() or path.name in ("", ".", ".."):
        raise ValueError("Expected the full path of a file.")
    mode = path.lstat().st_mode
    if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
        raise ValueError("This action applies to files and file links.")
    if action == "rename":
        if not name or not name.strip() or name in (".", "..") or any(
            char in ("/", "\\") or ord(char) < 32 for char in name
        ):
            raise ValueError("Enter a file name without path separators or control characters.")
        if name != path.name:
            rename_exclusive(path, path.with_name(name))
    elif action == "trash":
        result = subprocess.run(["/usr/bin/trash", str(path)], capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise ValueError(result.stderr.strip() or "Could not move the file to Trash.")
    elif action == "delete":
        path.unlink()
    else:
        raise ValueError("Unknown file action.")


if __name__ == "__main__":
    try:
        perform(*sys.argv[1:])
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
