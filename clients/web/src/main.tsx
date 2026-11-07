/**
 * Browser entry.
 *
 * Order matters: `applyInitialRedirect()` runs BEFORE the first render, so a
 * bookmarked legacy URL has already had its address bar rewritten by the time
 * `App` reads `location.pathname`. Applying it inside the component would mean
 * rendering the not-found view for one frame and then redirecting — visible as a
 * flash.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app-shell";
import { applyInitialRedirect } from "./router";
import { applyPreset, readStoredPreset } from "./lib/theme-presets";
import { applyMode, readStoredMode } from "./lib/theme-mode";
import "./styles/global.css";

applyInitialRedirect();

/*
 * Both appearance settings are applied before the first render, for the same reason
 * as the redirect above: doing it inside a component paints the wrong palette for one
 * frame and then repaints, which reads as a flicker. A dark-mode user would get a
 * white flash on every load.
 *
 * MODE first (it selects the palette), then PRESET (it adds an accent on top).
 */
applyMode(readStoredMode());
applyPreset(readStoredPreset());

const container = document.getElementById("root");
if (container === null) throw new Error("web: #root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
