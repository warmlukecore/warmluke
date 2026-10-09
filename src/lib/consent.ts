// ─────────────────────────────────────────────────────────────
// Whether this visitor let us measure our ads and visits (9 Oct).
//
// Asked once, on the public landing page, and kept in this browser.
// Anything but a yes is a no: a visitor who never answered is not
// measured, and Do Not Track or Global Privacy Control is a no already
// given, so it is never asked. Meta's Pixel and its Lead read this
// now; Google Analytics will read the same choice.
// ─────────────────────────────────────────────────────────────

const KEY = "wl_measure";
/** Said on window when the choice changes, so what waits on it can follow. */
const EVENT = "wl:measure";
type Choice = "yes" | "no";
// Where the choice lives when the browser refuses storage: this page only.
let kept: Choice | null = null;

/** The browser has already said no. */
export function browserSaysNo(): boolean {
  return (
    navigator.doNotTrack === "1" || !!(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl
  );
}

function choice(): Choice | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "yes" || v === "no") return v;
  } catch {
    /* storage refused */
  }
  return kept;
}

/** A yes, a no, or (null) the question asked again. */
export function chooseMeasure(next: Choice | null): void {
  kept = next;
  try {
    if (next) localStorage.setItem(KEY, next);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage refused: kept for this page */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function measureAllowed(): boolean {
  return !browserSaysNo() && choice() === "yes";
}

/** Still to be asked: nothing answered, and the browser has not said no. */
export function measureUnasked(): boolean {
  return !browserSaysNo() && choice() === null;
}

/** For useSyncExternalStore: told whenever the choice changes. */
export function onMeasureChange(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
