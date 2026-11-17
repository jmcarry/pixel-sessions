#!/usr/bin/env python3
# Modified for Pixel Sessions; see THIRD_PARTY_NOTICES.md for provenance and license scope.
"""Prepare bounded, versioned previews without modifying source images."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

MAX_BYTES = 64 * 1024 * 1024
MAX_PIXELS = 80_000_000
PREVIEW_EDGE = 2048
MAX_RENDER_BYTES = 15 * 1024 * 1024  # Herdr's embedded assets must be below 16 MiB.
MAX_CACHE_BYTES = 256 * 1024 * 1024
MAX_CACHE_FILES = 128
CACHE_VERSION = 3
NATIVE = {"jpg", "jpeg", "jpe", "png", "svg"}
CACHE_NAME = re.compile(r"[a-f0-9]{64}\.(?:png|jpe?g|jpe|svg)$")


def raster_size(path):
    result = subprocess.run(["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
                            capture_output=True, text=True, timeout=15)
    values = re.findall(r"pixel(?:Width|Height):\s*(\d+)", result.stdout)
    if result.returncode or len(values) != 2:
        raise ValueError("macOS cannot read this image format or the file is damaged")
    return int(values[0]), int(values[1])


def svg_size(path):
    # Read the root attributes, without retaining a large vector document in memory.
    with open(path, "rb") as stream:
        _, root = next(ET.iterparse(stream, events=("start",)))
    if root.tag.rsplit("}", 1)[-1] != "svg":
        raise ValueError("This file does not contain an SVG image")
    def px(value):
        match = re.fullmatch(r"\s*([\d.]+)(px|in|cm|mm|pt|pc)?\s*", value or "")
        units = {"px": 1, "in": 96, "cm": 96 / 2.54, "mm": 96 / 25.4, "pt": 96 / 72, "pc": 16}
        return float(match[1]) * units.get(match[2], 1) if match else None
    width, height = px(root.get("width")), px(root.get("height"))
    box = re.split(r"[\s,]+", root.get("viewBox", "").strip())
    if len(box) == 4:
        box_width, box_height = float(box[2]), float(box[3])
        if box_width > 0 and box_height > 0:
            if width and not height: height = width * box_height / box_width
            if height and not width: width = height * box_width / box_height
            width, height = width or box_width, height or box_height
    return width or 512, height or 512


def prune_cache(directory, keep):
    """LRU cleanup of generated images only; never follows or removes source files."""
    entries = []
    for path in directory.iterdir():
        try:
            if path.is_symlink() or not path.is_file():
                continue
            stat = path.stat()
            if CACHE_NAME.fullmatch(path.name):
                entries.append((stat.st_mtime_ns, path, stat.st_size))
            elif path.name.endswith(".tmp") and time.time() - stat.st_mtime > 3600:
                path.unlink(missing_ok=True)
        except OSError:
            continue
    total = sum(size for _, _, size in entries)
    count = len(entries)
    for _, path, size in sorted(entries):
        if total <= MAX_CACHE_BYTES and count <= MAX_CACHE_FILES:
            break
        if path == keep:
            continue
        try:
            path.unlink(missing_ok=True)
            total -= size
            count -= 1
        except OSError:
            continue
    return count, total


def convert(source, target, edge):
    args = ["/usr/bin/sips", "-s", "format", "png"]
    if edge:
        args += ["--resampleHeightWidthMax", str(edge)]
    result = subprocess.run(args + [str(source), "--out", str(target)],
                            capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise ValueError("macOS could not convert this image to a preview")


def prepare(source, app_home):
    source = Path(source).expanduser().resolve(strict=True)
    if not source.is_file():
        raise ValueError("This path is not an image file")
    stat = source.stat()
    if stat.st_size > MAX_BYTES:
        raise ValueError("Image preview supports files up to 64 MB")
    extension = source.suffix.lower().lstrip(".")
    original_width, original_height = svg_size(source) if extension == "svg" else raster_size(source)
    if original_width <= 0 or original_height <= 0 or original_width * original_height > MAX_PIXELS:
        raise ValueError("Image dimensions exceed the preview limit")
    resized = max(original_width, original_height) > PREVIEW_EDGE
    converted = extension not in NATIVE or resized or stat.st_size > MAX_RENDER_BYTES
    if extension == "svg" and stat.st_size > 1024 * 1024:
        converted = True
    stamp = f"{CACHE_VERSION}:{PREVIEW_EDGE}\0{source}\0{stat.st_mtime_ns}\0{stat.st_ctime_ns}\0{stat.st_size}"
    key = hashlib.sha256(stamp.encode()).hexdigest()
    output_extension = "png" if converted else extension
    relative = Path("data") / "md-preview-tools" / "images" / f"{key}.{output_extension}"
    target = Path(app_home) / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        fd, temporary_name = tempfile.mkstemp(prefix=key + "-", suffix=".tmp", dir=target.parent)
        os.close(fd)
        temporary = Path(temporary_name)
        try:
            if converted:
                convert(source, temporary, PREVIEW_EDGE if resized else None)
                if temporary.stat().st_size > MAX_RENDER_BYTES:
                    convert(source, temporary, max(1, int(min(1536, max(original_width, original_height)))))
            else:
                shutil.copyfile(source, temporary)
            if temporary.stat().st_size > MAX_RENDER_BYTES:
                raise ValueError("The generated preview exceeds Herdr's image size limit")
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    target.touch()
    width, height = raster_size(target) if converted else (original_width, original_height)
    resized = width < original_width or height < original_height
    count, cache_bytes = prune_cache(target.parent, target)
    return {"path": relative.as_posix(), "format": extension.upper(), "converted": converted,
            "width": width, "height": height, "originalWidth": original_width,
            "originalHeight": original_height, "resized": resized,
            "cacheFiles": count, "cacheBytes": cache_bytes}


def main():
    try:
        if len(sys.argv) != 3:
            raise ValueError("Expected an image path and the Herdr app folder")
        json.dump(prepare(sys.argv[1], sys.argv[2]), sys.stdout, separators=(",", ":"))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
