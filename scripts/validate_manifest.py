#!/usr/bin/env python3
"""Small offline validation for the Fresh package manifest."""

import json
from pathlib import Path


manifest_path = Path(__file__).resolve().parents[1] / "package.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

required = {
    "name": "fresh-copilot",
    "type": "plugin",
    "license": "MIT",
}
for key, expected in required.items():
    actual = manifest.get(key)
    if actual != expected:
        raise SystemExit(f"package.json: {key!r} must be {expected!r}, got {actual!r}")

fresh = manifest.get("fresh")
if not isinstance(fresh, dict):
    raise SystemExit("package.json: fresh must be an object")
entry = fresh.get("entry")
if not isinstance(entry, str) or Path(entry).stem != manifest["name"]:
    raise SystemExit(
        "package.json: fresh.entry stem must match the package name; "
        "Fresh uses the entry stem as the runtime plugin name"
    )
if fresh.get("min_api_version") != 2:
    raise SystemExit("package.json: fresh.min_api_version must be 2")
if not (manifest_path.parent / entry).is_file():
    raise SystemExit("package.json: fresh.entry does not exist")

print("package.json: OK")
