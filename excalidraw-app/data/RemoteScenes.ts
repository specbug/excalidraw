/**
 * This file deals with saving data state (appState, elements, images) to the
 * self-hosted scene store behind `/api`, so that drawings live on the server
 * rather than only in this browser.
 *
 * Notes:
 *
 * - Upstream Excalidraw keeps exactly one scene, under fixed localStorage keys
 *   (see `./LocalData`). Here each drawing gets an id, carried in the URL as
 *   `#d=<id>`, and the store keeps one `.excalidraw` file per drawing.
 * - `./LocalData` is deliberately left running underneath as a crash buffer and
 *   as the fast path for image blobs (IndexedDB is content-addressed and shared
 *   across drawings). This module is additive.
 * - Image blobs are uploaded once, to `/api/files/:fileId`, and are *not*
 *   embedded in the scene file — otherwise every autosave tick would re-upload
 *   every pasted screenshot.
 */

import { debounce, getDateTime } from "@excalidraw/common";
import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import { getNonDeletedElements } from "@excalidraw/element";

import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

/** Debounce for server saves. Longer than localStorage's 300ms — this one
 * crosses the network, and `flushSave()` covers blur/unload. */
export const SAVE_TO_SERVER_TIMEOUT = 2000;

const API_ROOT = "/api";

/** Matches the id validation on the server. */
const SCENE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type SceneMeta = {
  id: string;
  name: string;
  updatedAt: number;
  elementCount: number;
};

export type RemoteScene = {
  name?: string;
  elements?: readonly ExcalidrawElement[];
  appState?: Partial<AppState>;
};

const json = async (response: Response) => {
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
};

// -----------------------------------------------------------------------------
// current drawing
// -----------------------------------------------------------------------------

let currentSceneId: string | null = null;

/** The drawing id in the URL hash, if the URL names one. */
export const getSceneIdFromHash = (): string | null => {
  const match = window.location.hash.match(/^#d=([A-Za-z0-9_-]{1,64})$/);
  return match ? match[1] : null;
};

export const getCurrentSceneId = () => currentSceneId;

export const setCurrentSceneId = (sceneId: string | null) => {
  currentSceneId = sceneId;
};

/**
 * Deliberately not `randomId()` from @excalidraw/common: that one returns a
 * counter (`id0`, `id1`, …) under test, and minting a scene id at boot would
 * shift every element id in the snapshot suites.
 */
export const newSceneId = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

/** Same shape as Excalidraw's own default export filename. */
export const defaultSceneName = () =>
  `${t("labels.untitled")}-${getDateTime()}`;

/**
 * Point the browser at a drawing. Writes the hash, which is what makes the
 * drawing linkable and what `initializeScene` reads back on load.
 */
export const openScene = (sceneId: string) => {
  if (!SCENE_ID_RE.test(sceneId)) {
    return;
  }
  // The pending save carries its own scene id, so flushing here lands it on the
  // drawing being left rather than dropping it.
  flushSave();
  window.location.hash = `d=${sceneId}`;
};

/** Leave the current drawing so the root URL mints a fresh, blank one. */
export const openNewScene = () => {
  flushSave();
  window.location.href = window.location.origin;
};

// -----------------------------------------------------------------------------
// scenes
// -----------------------------------------------------------------------------

export const loadScene = async (
  sceneId: string,
): Promise<RemoteScene | null> => {
  try {
    const response = await fetch(`${API_ROOT}/scenes/${sceneId}`);
    if (response.status === 404) {
      // A link to a drawing that no longer exists, or a freshly minted id that
      // hasn't been saved yet. Either way: start blank under that id.
      return null;
    }
    return await json(response);
  } catch (error: any) {
    console.error("failed to load scene", error);
    return null;
  }
};

export const listScenes = async (): Promise<SceneMeta[]> =>
  json(await fetch(`${API_ROOT}/scenes`));

export const renameScene = async (
  sceneId: string,
  name: string,
): Promise<SceneMeta> =>
  json(
    await fetch(`${API_ROOT}/scenes/${sceneId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );

export const deleteScene = async (sceneId: string): Promise<void> => {
  if (sceneId === currentSceneId) {
    // Drop the pending autosave and stop taking new ones. Without this, the
    // `flushSave()` on the way to a fresh drawing would PUT the drawing we just
    // deleted straight back onto disk.
    _save.cancel();
    currentSceneId = null;
  }
  await json(
    await fetch(`${API_ROOT}/scenes/${sceneId}`, { method: "DELETE" }),
  );
};

export const getDownloadUrl = (sceneId: string) =>
  `${API_ROOT}/scenes/${sceneId}/download`;

// -----------------------------------------------------------------------------
// files
// -----------------------------------------------------------------------------

/** Blobs already known to the server this session — content-addressed, so a
 * successful upload is permanent and never needs repeating. */
const uploadedFileIds = new Set<FileId>();

const uploadFiles = async (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
) => {
  const referenced = new Set<string>();
  for (const element of elements) {
    const fileId = (element as { fileId?: FileId }).fileId;
    if (fileId && !element.isDeleted) {
      referenced.add(fileId);
    }
  }

  await Promise.all(
    [...referenced].map(async (fileId) => {
      const file = files[fileId as FileId];
      if (!file || uploadedFileIds.has(fileId as FileId)) {
        return;
      }
      try {
        await json(
          await fetch(`${API_ROOT}/files/${fileId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(file),
          }),
        );
        uploadedFileIds.add(fileId as FileId);
      } catch (error: any) {
        console.error("failed to upload file", fileId, error);
      }
    }),
  );
};

/** Fetch blobs this browser's IndexedDB doesn't have (another device, or a
 * blob that `clearObsoleteFiles` GC'd). */
export const getFiles = async (
  ids: readonly FileId[],
): Promise<{
  loadedFiles: BinaryFileData[];
  erroredFiles: Map<FileId, true>;
}> => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    ids.map(async (id) => {
      try {
        loadedFiles.push(await json(await fetch(`${API_ROOT}/files/${id}`)));
      } catch (error: any) {
        erroredFiles.set(id, true);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

// -----------------------------------------------------------------------------
// saving
// -----------------------------------------------------------------------------

const _save = debounce(
  async (
    sceneId: string,
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    try {
      await fetch(`${API_ROOT}/scenes/${sceneId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: appState.name || defaultSceneName(),
          elements: getNonDeletedElements(elements),
          appState: clearAppStateForLocalStorage(appState),
        }),
      });
      await uploadFiles(elements, files);
    } catch (error: any) {
      console.error("failed to save scene", error);
    }
  },
  SAVE_TO_SERVER_TIMEOUT,
);

/** True while there is no drawing to save into, or the tab is hidden — mirrors
 * `LocalData.isSavePaused()`. */
export const isSavePaused = () => !currentSceneId || document.hidden;

export const save = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) => {
  if (isSavePaused()) {
    return;
  }
  _save(currentSceneId!, elements, appState, files);
};

export const flushSave = () => {
  _save.flush();
};
