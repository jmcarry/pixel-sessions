"""Read a bounded prefix of a regular file for Pixel Sessions."""
import codecs
import json
import os
import stat
import sys

TEXT_BYTES = 256 * 1024
HEX_BYTES = 512


def decode_text(data, complete):
    encoding = "utf-8-sig"
    if data.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        encoding = "utf-32"
    elif data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    try:
        text = codecs.getincrementaldecoder(encoding)().decode(data, final=complete)
    except UnicodeError:
        return None
    if any(ord(char) < 32 and char not in "\t\n\r\f" for char in text):
        return None
    return text


def hex_preview(data):
    rows = []
    for offset in range(0, len(data), 16):
        row = data[offset:offset + 16]
        ascii_text = "".join(chr(byte) if 32 <= byte < 127 else "." for byte in row)
        rows.append(f"{offset:08x}  {row.hex(' '):47}  |{ascii_text}|")
    return "\n".join(rows)


def preview(path):
    if not stat.S_ISREG(os.stat(path).st_mode):
        return {"kind": "error", "message": "Only regular files can be previewed."}
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            return {"kind": "error", "message": "Only regular files can be previewed."}
        data = stream.read(TEXT_BYTES + 1)
    text = decode_text(data[:TEXT_BYTES], len(data) <= TEXT_BYTES)
    if text is not None:
        return {"kind": "text", "text": text, "size": info.st_size, "truncated": len(data) > TEXT_BYTES}
    return {"kind": "binary", "hex": hex_preview(data[:HEX_BYTES]), "size": info.st_size,
            "truncated": len(data) > HEX_BYTES}


if __name__ == "__main__":
    try:
        result = preview(sys.argv[1])
    except FileNotFoundError:
        result = {"kind": "error", "message": "This file is no longer available."}
    except PermissionError:
        result = {"kind": "error", "message": "Permission denied while reading this file."}
    except OSError as error:
        result = {"kind": "error", "message": error.strerror or "Cannot read this file."}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8") + b"\n")
