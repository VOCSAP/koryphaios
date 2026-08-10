#!/usr/bin/env python3
"""Independent structural verifier for icon.icns: re-parses the TOC from
raw bytes (does not reuse make-icns.py's own logic) and checks magic,
declared total length vs actual file size, and each entry's OSType/length/
PNG signature. This is the icns equivalent of `magick identify` on the ico.
"""
import struct
import sys
from pathlib import Path

path = Path(__file__).parent / "icon.icns"
data = path.read_bytes()

if data[:4] != b"icns":
    print("FAIL: bad magic", file=sys.stderr)
    sys.exit(1)

declared_total = struct.unpack(">I", data[4:8])[0]
actual_total = len(data)
print(f"magic=icns declared_total={declared_total} actual_file_size={actual_total} match={declared_total == actual_total}")

offset = 8
ok = True
while offset < len(data):
    if offset + 8 > len(data):
        print(f"FAIL: truncated entry header at offset {offset}", file=sys.stderr)
        ok = False
        break
    ostype = data[offset:offset + 4].decode("ascii", errors="replace")
    entry_len = struct.unpack(">I", data[offset + 4:offset + 8])[0]
    payload = data[offset + 8:offset + entry_len]
    is_png = payload[:8] == b"\x89PNG\r\n\x1a\n"
    w, h = struct.unpack(">II", payload[16:24]) if is_png and len(payload) >= 24 else (None, None)
    print(f"  entry {ostype}: declared_len={entry_len} payload_bytes={len(payload)} png_sig_ok={is_png} pixel_size={w}x{h}")
    if not is_png:
        ok = False
    offset += entry_len

sys.exit(0 if ok and declared_total == actual_total else 1)
