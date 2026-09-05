import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import Spinner from "@excalidraw/excalidraw/components/Spinner";
import {
  TrashIcon,
  downloadIcon,
  file,
  pencilIcon,
  searchIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useCallback, useEffect, useRef, useState } from "react";

import * as RemoteScenes from "../data/RemoteScenes";

import "./DrawingsDialog.scss";

import type { SceneMeta } from "../data/RemoteScenes";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? "" : "s"} ago`;

/** "just now" / "3 hours ago", falling back to a date once it's over a week. */
const formatUpdatedAt = (timestamp: number) => {
  const elapsed = Date.now() - timestamp;

  if (elapsed < MINUTE) {
    return "just now";
  }
  if (elapsed < HOUR) {
    return plural(Math.floor(elapsed / MINUTE), "minute");
  }
  if (elapsed < DAY) {
    return plural(Math.floor(elapsed / HOUR), "hour");
  }
  if (elapsed < 7 * DAY) {
    return plural(Math.floor(elapsed / DAY), "day");
  }
  return new Date(timestamp).toLocaleDateString();
};

const DrawingRow = ({
  scene,
  isCurrent,
  onOpen,
  onRename,
  onDelete,
}: {
  scene: SceneMeta;
  isCurrent: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(scene.name);

  const commitRename = () => {
    setIsRenaming(false);
    const name = draftName.trim();
    if (name && name !== scene.name) {
      onRename(name);
    } else {
      setDraftName(scene.name);
    }
  };

  if (isRenaming) {
    return (
      <div className="DrawingsDialog__row DrawingsDialog__row--renaming">
        <div className="DrawingsDialog__row__icon">{file}</div>
        <TextField
          value={draftName}
          onChange={setDraftName}
          selectOnRender
          fullWidth
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitRename();
            } else if (event.key === "Escape") {
              setDraftName(scene.name);
              setIsRenaming(false);
            }
          }}
        />
        <FilledButton
          variant="outlined"
          color="primary"
          label="Save name"
          onClick={commitRename}
        >
          Save
        </FilledButton>
      </div>
    );
  }

  return (
    <div className="DrawingsDialog__row">
      <button
        type="button"
        className="DrawingsDialog__row__open"
        onClick={onOpen}
      >
        <div className="DrawingsDialog__row__icon">{file}</div>
        <div className="DrawingsDialog__row__text">
          <div className="DrawingsDialog__row__name">
            {scene.name}
            {isCurrent && (
              <span className="DrawingsDialog__row__badge">current</span>
            )}
          </div>
          <div className="DrawingsDialog__row__meta">
            {formatUpdatedAt(scene.updatedAt)} ·{" "}
            {scene.elementCount === 1
              ? "1 element"
              : `${scene.elementCount} elements`}
          </div>
        </div>
      </button>
      <div className="DrawingsDialog__row__actions">
        <FilledButton
          variant="icon"
          color="muted"
          icon={pencilIcon}
          label="Rename"
          onClick={() => {
            setDraftName(scene.name);
            setIsRenaming(true);
          }}
        />
        <a
          className="DrawingsDialog__row__download"
          href={RemoteScenes.getDownloadUrl(scene.id)}
          download
          aria-label="Download"
          title="Download"
        >
          {downloadIcon}
        </a>
        <FilledButton
          variant="icon"
          color="danger"
          icon={TrashIcon}
          label="Delete"
          onClick={onDelete}
        />
      </div>
    </div>
  );
};

export const DrawingsDialog = ({ onClose }: { onClose: () => void }) => {
  const [scenes, setScenes] = useState<SceneMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const currentSceneId = useRef(RemoteScenes.getCurrentSceneId()).current;

  const refresh = useCallback(async () => {
    try {
      setScenes(await RemoteScenes.listScenes());
      setError(null);
    } catch (err: any) {
      setError("Couldn't reach the drawing store.");
    }
  }, []);

  useEffect(() => {
    // Flush first so the drawing you're in shows its latest name and count.
    RemoteScenes.flushSave();
    refresh();
  }, [refresh]);

  const query = filter.trim().toLowerCase();
  const visible = scenes?.filter((scene) =>
    query ? scene.name.toLowerCase().includes(query) : true,
  );

  return (
    <Dialog onCloseRequest={onClose} title="All drawings" size="regular">
      <div className="DrawingsDialog">
        <div className="DrawingsDialog__search">
          <TextField
            value={filter}
            onChange={setFilter}
            placeholder="Filter drawings…"
            icon={searchIcon}
            fullWidth
            selectOnRender
          />
        </div>

        {error && <div className="DrawingsDialog__empty">{error}</div>}

        {!error && !visible && (
          <div className="DrawingsDialog__empty">
            <Spinner />
          </div>
        )}

        {!error && visible?.length === 0 && (
          <div className="DrawingsDialog__empty">
            {scenes?.length
              ? "No drawings match that filter."
              : "No drawings yet."}
          </div>
        )}

        {!error && !!visible?.length && (
          <div className="DrawingsDialog__list">
            {visible.map((scene) => (
              <DrawingRow
                key={scene.id}
                scene={scene}
                isCurrent={scene.id === currentSceneId}
                onOpen={() => {
                  if (scene.id !== currentSceneId) {
                    RemoteScenes.openScene(scene.id);
                  }
                  onClose();
                }}
                onRename={async (name) => {
                  await RemoteScenes.renameScene(scene.id, name);
                  refresh();
                }}
                onDelete={async () => {
                  await RemoteScenes.deleteScene(scene.id);
                  if (scene.id === currentSceneId) {
                    // The drawing under us is gone; land on a fresh one.
                    RemoteScenes.openNewScene();
                    return;
                  }
                  refresh();
                }}
              />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
};
