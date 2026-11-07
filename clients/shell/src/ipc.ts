/**
 * Desktop IPC channel constants and bridge interface.
 * Kept strictly minimal: only desktop frame capabilities that
 * cannot be achieved from a standard web origin are exposed.
 */

export const DESKTOP_IPC = {
  openExternal: "remote-pi:open-external",
  getPlatform: "remote-pi:get-platform",
  getVersion: "remote-pi:get-version",
  openUserDataLog: "remote-pi:open-user-data-log",
} as const;

export type DesktopIpc = typeof DESKTOP_IPC;

export interface RemotePiBridge {
  openExternal(url: string): Promise<void>;
  getPlatform(): Promise<string>;
  getVersion(): Promise<string>;
  openUserDataLog(): Promise<string>;
}

declare global {
  interface Window {
    remotePi?: RemotePiBridge;
  }
}
