# -*- coding: utf-8 -*-
"""把一组文件打成 zip。调用方传绝对路径和 zip 内名字，脚本不推导任何本机目录。"""
import json
import os
import sys
import zipfile

sys.stdin.reconfigure(encoding="utf-8") if hasattr(sys.stdin, "reconfigure") else None
payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
output = payload.get("output")
files = payload.get("files") if isinstance(payload.get("files"), list) else []
manifest = payload.get("manifest")
if not output:
    raise SystemExit("output missing")
folder = os.path.dirname(output)
if folder:
    os.makedirs(folder, exist_ok=True)
count = 0
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for item in files:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "")
        name = str(item.get("name") or "").strip()
        if not path or not os.path.isfile(path) or not name:
            continue
        name = name.replace("\\", "/").lstrip("/")
        if name.startswith("../") or "/../" in name:
            continue
        z.write(path, arcname=name)
        count += 1
    if manifest is not None:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
sys.stdout.buffer.write(json.dumps({
    "ok": True, "path": output, "count": count, "bytes": os.path.getsize(output),
}, ensure_ascii=False).encode("utf-8"))
