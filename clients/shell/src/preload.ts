/**
 * Electron preload — runs in an isolated world with a narrow, explicit API.
 *
 * TWO RULES, both learned the hard way:
 *
 * 1. **No relative imports.** A sandboxed preload is loaded by Electron's own
 *    CommonJS loader with a restricted `require`. Pulling in a sibling module
 *    (`./ipc.js`) resolves against a path that the build renames to `.cjs`, and
 *    the failure is SILENT: the window loads normally, `window.remotePi` is
 *    simply never defined. The channel strings are duplicated here on purpose;
 *    `src/ipc.ts` is the source of truth for the main process and its type is
 *    structurally checked against this object below.
 *
 * 2. **`contextBridge` only.** `ipcRenderer` itself is never exposed — that
 *    would hand the renderer an arbitrary IPC surface and defeat
 *    `contextIsolation`.
 *
 * Deliberately NOT here: `pickDirectory` / `pickFiles`. The Files panel browses
 * the **remote** daemon's filesystem (`server/src/daemon/fs_nav.ts` resolves
 * paths with `node:os.homedir()`), so a native local file picker would produce a
 * local absolute path and hand it to a different machine. `<input type=file>` is
 * the correct mechanism for chat attachments.
 */
import { contextBridge, ipcRenderer } from "electron";

const CHANNELS = {
  openExternal: "remote-pi:open-external",
  getPlatform: "remote-pi:get-platform",
  getVersion: "remote-pi:get-version",
  openUserDataLog: "remote-pi:open-user-data-log",
} as const;

const bridge = {
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.openExternal, url),
  getPlatform: (): Promise<string> => ipcRenderer.invoke(CHANNELS.getPlatform),
  getVersion: (): Promise<string> => ipcRenderer.invoke(CHANNELS.getVersion),
  openUserDataLog: (): Promise<string> =>
    ipcRenderer.invoke(CHANNELS.openUserDataLog),
};

contextBridge.exposeInMainWorld("remotePi", bridge);
