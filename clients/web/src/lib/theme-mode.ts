/**
 * Plan/81 — light / dark / follow-system appearance.
 *
 * ## Why this file exists separately from `theme-presets`
 *
 * The two are different axes and must not be conflated:
 *
 * - **Mode** (`light` | `dark` | `system`) decides WHICH palette is active. The dark
 *   palette already existed in `design-platform.css` behind
 *   `:root[data-theme="dark"]` — 39 token overrides — but **nothing ever set that
 *   attribute**, so the dark theme was dead code and every user got light.
 * - **Preset** (plan/80) supplies an ACCENT on top of whichever palette is active.
 *
 * So: mode = palette, preset = accent. A dark canvas with the Ocean accent is a
 * valid combination, and so is light + Ocean.
 *
 * ## Why `system` is a first-class value rather than a resolved boolean
 *
 * Storing the resolved value would freeze the user's choice at the moment they
 * picked "follow system": flipping the OS theme afterwards would do nothing until
 * they visited Settings again. Persisting the INTENT and re-resolving on every
 * change is what makes the setting actually behave like its label.
 */

export type ThemeMode = "light" | "dark" | "system";
/** The concrete palette in effect. `system` resolves to one of these. */
export type ResolvedMode = "light" | "dark";

export const THEME_MODE_STORAGE_KEY = "remote-pi.theme-mode";
export const DEFAULT_THEME_MODE: ThemeMode = "system";

export const THEME_MODES: readonly { id: ThemeMode; label: string; detail: string }[] = [
  { id: "light", label: "浅色", detail: "始终使用浅色配色。" },
  { id: "dark", label: "深色", detail: "始终使用深色配色。" },
  { id: "system", label: "跟随系统", detail: "跟随本设备的外观设置。" },
];

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark" || v === "system";
}

/** Reads the persisted INTENT (not the resolved palette). */
export function readStoredMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return isThemeMode(raw) ? raw : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

/** The OS/browser preference. Treated as an input, never as an error. */
export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function resolveMode(mode: ThemeMode): ResolvedMode {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return systemPrefersDark() ? "dark" : "light";
}

/**
 * Applies the resolved palette to `:root`.
 *
 * The attribute is ALWAYS set, even for `light`: `design-platform.css` keys its dark
 * block off `:root[data-theme="dark"]`, and setting `data-theme="light"` explicitly
 * makes the current state readable from the DOM (and assertable in a browser test)
 * instead of being inferred from the absence of an attribute.
 */
export function applyMode(mode: ThemeMode): ResolvedMode {
  const resolved = resolveMode(mode);
  document.documentElement.setAttribute("data-theme", resolved);
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    /* A preference that cannot be persisted still applies for this session. */
  }
  return resolved;
}

/**
 * Subscribes to OS appearance changes and re-applies while the stored intent is
 * `system`. Returns an unsubscribe function.
 *
 * Returns a no-op when `mode` is explicit: a user who chose "always dark" must not
 * have the OS flip it underneath them.
 */
export function watchSystemMode(getMode: () => ThemeMode, onChange: () => void): () => void {
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (getMode() === "system") onChange();
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  } catch {
    return () => undefined;
  }
}
