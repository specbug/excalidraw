"""Scene store for the self-hosted Excalidraw at draw.sixeleven.in.

No database. Every drawing is a real `.excalidraw` file under DATA_DIR/scenes,
so the drawings directory stays browsable in Finder and `rclone sync`-able to
R2 by backupd. Pasted-image blobs live separately under DATA_DIR/files, keyed by
Excalidraw's own content-hash FileId, so a 2 MB screenshot is uploaded once
rather than on every autosave tick.

DATA_DIR/meta holds a tiny sidecar per scene so listing does not have to parse
every scene file. Sidecars are derived data and are rebuilt on miss.
"""

import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
SCENES_DIR = DATA_DIR / "scenes"
FILES_DIR = DATA_DIR / "files"
META_DIR = DATA_DIR / "meta"

# Excalidraw scene ids are minted client-side; file ids are its content hashes.
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

app = FastAPI(title="draw", docs_url="/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _startup() -> None:
    for d in (SCENES_DIR, FILES_DIR, META_DIR):
        d.mkdir(parents=True, exist_ok=True)


_startup()


def _check_id(value: str) -> str:
    """Reject anything that could escape the data directory."""
    if not ID_RE.match(value):
        raise HTTPException(status_code=400, detail="invalid id")
    return value


def _write_atomic(path: Path, payload: Any) -> None:
    """Write JSON via a temp file + rename, so a crash mid-save can't truncate a
    drawing.

    The temp name must be *unique per write*, not derived from the destination.
    FastAPI runs these sync endpoints in a threadpool, so a `list_scenes`
    rebuilding a sidecar races a concurrent `put_scene` writing the same one.
    With a shared `<name>.tmp`, whichever renamed first consumed the temp and
    the loser's `os.replace` raised FileNotFoundError, 500ing the listing.

    The leading dot also keeps temps out of `glob("*.excalidraw")`.
    """
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _scene_path(scene_id: str) -> Path:
    return SCENES_DIR / f"{scene_id}.excalidraw"


def _meta_path(scene_id: str) -> Path:
    return META_DIR / f"{scene_id}.json"


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _derive_meta(scene_id: str, scene: dict) -> dict:
    elements = [e for e in scene.get("elements") or [] if not e.get("isDeleted")]
    return {
        "id": scene_id,
        "name": scene.get("name")
        or (scene.get("appState") or {}).get("name")
        or "Untitled",
        "updatedAt": int(_scene_path(scene_id).stat().st_mtime * 1000),
        "elementCount": len(elements),
    }


def _meta_for(scene_id: str) -> dict | None:
    """Sidecar if present and fresh, else rebuild it from the scene file."""
    scene_path = _scene_path(scene_id)
    if not scene_path.exists():
        return None
    meta_path = _meta_path(scene_id)
    mtime_ms = int(scene_path.stat().st_mtime * 1000)
    if meta_path.exists():
        try:
            meta = _read_json(meta_path)
            if meta.get("updatedAt") == mtime_ms:
                return meta
        except (json.JSONDecodeError, OSError):
            pass
    try:
        meta = _derive_meta(scene_id, _read_json(scene_path))
    except (json.JSONDecodeError, OSError):
        return None
    try:
        _write_atomic(meta_path, meta)
    except OSError:
        # The sidecar is only a listing cache. Failing to refresh it must never
        # take down the listing itself.
        pass
    return meta


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/scenes")
def list_scenes() -> list[dict]:
    out = []
    for path in SCENES_DIR.glob("*.excalidraw"):
        meta = _meta_for(path.stem)
        if meta:
            out.append(meta)
    out.sort(key=lambda m: m["updatedAt"], reverse=True)
    return out


@app.get("/api/scenes/{scene_id}")
def get_scene(scene_id: str) -> dict:
    path = _scene_path(_check_id(scene_id))
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    return _read_json(path)


class ScenePut(BaseModel):
    name: str | None = None
    elements: list[dict] = []
    appState: dict = {}


@app.put("/api/scenes/{scene_id}")
def put_scene(scene_id: str, body: ScenePut) -> dict:
    _check_id(scene_id)
    app_state = dict(body.appState)
    name = body.name or app_state.get("name") or "Untitled"
    app_state["name"] = name
    scene = {
        "type": "excalidraw",
        "version": 2,
        "source": "https://draw.sixeleven.in",
        "name": name,
        "elements": body.elements,
        "appState": app_state,
        # Image blobs live in /files and are inlined on download. Keeping this
        # empty is what stops every autosave from re-uploading pasted images.
        "files": {},
    }
    _write_atomic(_scene_path(scene_id), scene)
    meta = _derive_meta(scene_id, scene)
    _write_atomic(_meta_path(scene_id), meta)
    return meta


class ScenePatch(BaseModel):
    name: str


@app.patch("/api/scenes/{scene_id}")
def rename_scene(scene_id: str, body: ScenePatch) -> dict:
    path = _scene_path(_check_id(scene_id))
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    scene = _read_json(path)
    name = body.name.strip() or "Untitled"
    scene["name"] = name
    scene.setdefault("appState", {})["name"] = name
    _write_atomic(path, scene)
    meta = _derive_meta(scene_id, scene)
    _write_atomic(_meta_path(scene_id), meta)
    return meta


@app.delete("/api/scenes/{scene_id}")
def delete_scene(scene_id: str) -> dict:
    path = _scene_path(_check_id(scene_id))
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    path.unlink()
    _meta_path(scene_id).unlink(missing_ok=True)
    # Blobs are content-addressed and shared between scenes, so they are left
    # alone here. Orphans are cheap; deleting one still referenced is not.
    return {"deleted": scene_id}


@app.get("/api/scenes/{scene_id}/download")
def download_scene(scene_id: str) -> Response:
    """A portable .excalidraw: same scene with its image blobs inlined."""
    path = _scene_path(_check_id(scene_id))
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    scene = _read_json(path)
    files: dict[str, Any] = {}
    for element in scene.get("elements") or []:
        file_id = element.get("fileId")
        if not file_id or file_id in files or not ID_RE.match(str(file_id)):
            continue
        blob_path = FILES_DIR / f"{file_id}.json"
        if blob_path.exists():
            files[file_id] = _read_json(blob_path)
    scene["files"] = files
    name = scene.get("name") or scene_id
    safe = re.sub(r'[^\w \-.]', "_", name).strip() or scene_id
    return Response(
        content=json.dumps(scene),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{safe}.excalidraw"'
        },
    )


@app.get("/api/files/{file_id}")
def get_file(file_id: str) -> dict:
    path = FILES_DIR / f"{_check_id(file_id)}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    return _read_json(path)


@app.put("/api/files/{file_id}")
def put_file(file_id: str, body: dict) -> dict:
    path = FILES_DIR / f"{_check_id(file_id)}.json"
    # Content-addressed, so an existing blob is by definition the same bytes.
    if not path.exists():
        body.setdefault("id", file_id)
        body.setdefault("created", int(time.time() * 1000))
        _write_atomic(path, body)
    return {"id": file_id}
