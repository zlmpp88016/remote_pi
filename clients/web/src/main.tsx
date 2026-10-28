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
import "./styles/global.css";

applyInitialRedirect();

const container = document.getElementById("root");
if (container === null) throw new Error("web: #root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
