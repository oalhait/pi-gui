// Preload for web pages in the side pane browser (sandboxed, isolated). It exposes nothing to
// the page; it only reports passkey requests so the browser can explain why they can't finish.
import { contextBridge, ipcRenderer } from "electron";
import {
  BROWSER_PASSKEY_CHANNEL,
  watchPasskeyRequests,
  type BrowserPasskeyEvent,
} from "./platform/browser-passkey-watch";

contextBridge.executeInMainWorld({
  func: watchPasskeyRequests,
  args: [(event: BrowserPasskeyEvent) => ipcRenderer.send(BROWSER_PASSKEY_CHANNEL, event)],
});
