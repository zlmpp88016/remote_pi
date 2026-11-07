/**
 * Plan/80 — browser-local visual presets.
 *
 * ## What these are NOT
 *
 * They are not pi's `theme` setting. `~/.pi/agent/settings.json` has a `theme` key
 * that selects a **terminal** theme for the TUI, and this module never writes it.
 * The Settings panel shows that value read-only precisely so the two concepts cannot
 * be confused: changing a preset here repaints *this browser* and nothing else.
 *
 * ## Why a preset is an accent overlay, not a replacement palette
 *
 * The base light/dark palettes live in `design-platform.css` behind `:root` and
 * `body[data-ds-dark-theme]`, and every colour in them was measured against DSH's
 * reference. Overriding the whole palette per preset would silently break those
 * measurements (contrast ratios, the `--dsw-alias-bg-base` chain). A preset
 * therefore sets only the ACCENT and a few surface tints, on top of whichever base
 * theme is active — so `default` is a genuine no-op and every preset stays legible
 * in both light and dark.
 */

export interface ThemePreset {
  id: string;
  label: string;
  /** One-line statement of what changes, shown under the selector. */
  detail: string;
  /** Accent applied to primary interactive affordances. */
  /** Accent used on the LIGHT canvas. */
  accent: string;
  /**
   * Accent used on the DARK canvas.
   *
   * A 500-level hue is calibrated for white; on a near-black canvas the same value
   * recedes (violet/blue) or reads as a system alert (amber). Each preset therefore
   * carries a lighter 400-level step for dark, which keeps the hue recognisable
   * while restoring the perceived weight it has in the light theme.
   */
  darkAccent?: string;
  /** True when the preset intentionally leaves the palette untouched. */
  isDefault?: boolean;
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: "default",
    label: "默认",
    detail: "参考配色，不做改动。",
    accent: "",
    isDefault: true,
  },
  {
    id: "ocean",
    label: "海洋",
    detail: "参考配色上的冷蓝色强调色。",
    accent: "#3b82f6",
    darkAccent: "#60a5fa",
  },
  {
    id: "forest",
    label: "森林",
    detail: "参考配色上的柔和绿色强调色。",
    accent: "#10b981",
    darkAccent: "#34d399",
  },
  {
    id: "amber",
    label: "琥珀",
    detail: "参考配色上的暖琥珀色强调色。",
    accent: "#f59e0b",
    darkAccent: "#fbbf24",
  },
  {
    id: "violet",
    label: "紫罗兰",
    detail: "参考配色上的紫罗兰强调色。",
    accent: "#8b5cf6",
    darkAccent: "#a78bfa",
  },
];

export const DEFAULT_PRESET_ID = "default";

/** Storage key. Prefixed so it cannot collide with anything the app already stores. */
export const THEME_PRESET_STORAGE_KEY = "remote-pi.theme-preset";

export function presetById(id: string | null | undefined): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0]!;
}

/** Reads the persisted preset, falling back to the default for an unknown value. */
export function readStoredPreset(): ThemePreset {
  try {
    const raw = window.localStorage.getItem(THEME_PRESET_STORAGE_KEY);
    return presetById(raw);
  } catch {
    /* Private mode / storage disabled: the default is a correct answer, not an
     * error worth surfacing for a cosmetic preference. */
    return presetById(DEFAULT_PRESET_ID);
  }
}

/**
 * Applies a preset to the document and persists it.
 *
 * The attribute is set even for `default`, so CSS can distinguish "no preset
 * chosen" from "default chosen" and a stale attribute from an earlier session can
 * never linger.
 */
export function applyPreset(preset: ThemePreset): void {
  const root = document.body;
  root.setAttribute("data-theme-preset", preset.id);
  if (preset.accent === "") {
    root.style.removeProperty("--dsw-preset-accent");
  } else {
    /* Pick the step calibrated for the canvas that is actually on screen. Reading
     * `data-theme` here (instead of at call time only) is what makes a preset
     * survive the light/dark switch with the right weight on each. */
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    root.style.setProperty(
      "--dsw-preset-accent",
      dark ? (preset.darkAccent ?? preset.accent) : preset.accent,
    );
  }
  try {
    window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, preset.id);
  } catch {
    /* A preference that cannot be persisted still applies for this session. */
  }
}
