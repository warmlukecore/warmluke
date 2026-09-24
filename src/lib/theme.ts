// ─────────────────────────────────────────────────────────────
// Light or dark, for the app.
//
// The theme is the product's tokens and nothing else: globals.css gives
// every one of them a night value under [data-theme="dark"], and the
// screens, built from tokens only, follow. The pages a visitor is sold
// on keep their own palette and stay light whatever was chosen here.
//
// The choice is kept in this browser. It is put on <html> by a line of
// script that runs before the first paint (THEME_SCRIPT, in the root
// layout), so a dark app does not flash white on every load, and kept
// right on each client-side move by ThemeSync.
//
// No React here: the root layout is a server component and reads the
// script as a string. The hook lives in src/components/ThemeSync.tsx.
// ─────────────────────────────────────────────────────────────

export type Theme = "light" | "dark";

export const THEME_KEY = "wl-theme";
export const THEME_CHANGED = "wl-theme-change";
/** Pages that are not the app, which keep the landing's own light palette. */
export const MARKETING_PATHS = ["/", "/privacy", "/terms"];

/** Run before React, from the root layout: the same key and the same paths as below. */
export const THEME_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==="dark"&&${JSON.stringify(
  MARKETING_PATHS
)}.indexOf(location.pathname)<0)document.documentElement.dataset.theme="dark"}catch(e){}`;

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Puts the stored theme on the page, or takes it off a page that is not the app. */
export function applyTheme(path: string) {
  const dark = storedTheme() === "dark" && !MARKETING_PATHS.includes(path);
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
}
