"use client";

// Light or dark on screen: keeps the stored theme on <html> as the app
// moves between pages, and gives screens the choice and a switch for it.
// See src/lib/theme.ts.
//
// Callers: src/app/layout.tsx, src/components/PageFrame.tsx,
// src/components/AppShell.tsx, src/components/StorePreview.tsx.

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Moon, Sun } from "lucide-react";
import { THEME_CHANGED, THEME_KEY, applyTheme, storedTheme, type Theme } from "@/lib/theme";

export function ThemeSync() {
  const path = usePathname();
  useEffect(() => {
    applyTheme(path);
    // Another tab chose differently.
    const again = () => applyTheme(location.pathname);
    window.addEventListener("storage", again);
    return () => window.removeEventListener("storage", again);
  }, [path]);
  return null;
}

/** The stored theme, and a way to change it that every open screen hears. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    setTheme(storedTheme());
    const heard = () => setTheme(storedTheme());
    window.addEventListener(THEME_CHANGED, heard);
    window.addEventListener("storage", heard);
    return () => {
      window.removeEventListener(THEME_CHANGED, heard);
      window.removeEventListener("storage", heard);
    };
  }, []);
  const choose = (t: Theme) => {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // A private window may refuse; the choice then lasts this page only.
    }
    applyTheme(location.pathname);
    setTheme(t);
    window.dispatchEvent(new Event(THEME_CHANGED));
  };
  return [theme, choose];
}

/**
 * The switch between the two, as one icon: the sun offers light, the
 * moon offers dark. `className` places and colours it for the surface
 * it sits on, the dark frame or a light header.
 *
 * Given `value` and `onChange` it switches only what its owner holds:
 * the landing's glimpse of the app, which must neither read nor change
 * the app's own choice.
 */
export function ThemeToggle({
  className,
  value,
  onChange,
}: {
  className: string;
  value?: Theme;
  onChange?: (t: Theme) => void;
}) {
  const [stored, store] = useTheme();
  const theme = value ?? stored;
  const choose = onChange ?? store;
  const next: Theme = theme === "dark" ? "light" : "dark";
  const Glyph = theme === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={() => choose(next)}
      aria-label={`Switch to the ${next} theme`}
      title={`Switch to the ${next} theme`}
      className={className}
    >
      <Glyph aria-hidden size={16} strokeWidth={1.75} />
    </button>
  );
}
