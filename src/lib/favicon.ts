"use client";

// The tab, when something is waiting for them.
//
// A merchant does not sit on this screen. Their assistant proposes a
// change from inside Claude, or a build finishes half-done, and the
// only places that said so were the bell and a toast — both inside a
// tab they are not looking at. This is the same fact Slack puts on its
// icon: there is something here for you.
//
// It used to draw its own mark: a blue rounded square with a white W,
// because there was no icon file to borrow and a canvas was smaller
// than a build step. There is one now — the real logo, at
// src/app/icon.png, which Next puts in the head of every page — so
// the drawn one is gone. Two marks for one product is the kind of
// thing nobody files a bug about and everybody notices.
//
// So this borrows whatever icon the page already has and adds the dot
// to it. Nothing here knows the path: it reads the href out of the
// head, which is the one Next generated, hash and all.
//
// Callers: src/components/ChatPanel.tsx.

/** The red used for anything unread, here and in the bell. */
const DOT = "#ef4444";

/** The icon the page loaded with, so putting it back is exact. */
let original: string | null = null;
/** The same mark with the dot, drawn once. */
let dotted: string | null = null;
/** What the last call asked for, so a slow draw cannot land too late. */
let wanted = false;

/**
 * The page's own icon with a dot punched into the corner.
 *
 * Asynchronous, because the icon is a file and not a rectangle any
 * more. The image is same-origin, so the canvas is not tainted and
 * can be read back.
 */
function drawDot(src: string, then: (href: string) => void): void {
  const img = new Image();
  img.onload = () => {
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, size, size);

    // Punched out first, so the dot reads as a dot at sixteen pixels
    // instead of smearing into whatever is behind it.
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(size - 9, 9, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    ctx.fillStyle = DOT;
    ctx.beginPath();
    ctx.arc(size - 9, 9, 7, 0, Math.PI * 2);
    ctx.fill();

    then(canvas.toDataURL("image/png"));
  };
  // A tab icon is not worth handling. The title already said it.
  img.onerror = () => {};
  img.src = src;
}

/**
 * Says whether anything is waiting, on the tab itself.
 *
 * The count goes in the title as well as the icon. A dynamic favicon is
 * a browser's choice to honour — Safari in particular does as it likes
 * — and the title is read by every one of them, so the half that always
 * works carries the number.
 */
export function showWaiting(count: number): void {
  if (typeof document === "undefined") return;

  const base = document.title.replace(/^\(\d+\)\s*/, "");
  document.title = count > 0 ? `(${count}) ${base}` : base;

  try {
    wanted = count > 0;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    // No icon in the head means nothing to borrow and nothing to put
    // back. The title carries it alone, which it was always going to
    // have to do in the browsers that ignore this.
    if (!link) return;
    original = original ?? link.href;

    if (!wanted) {
      link.href = original;
      return;
    }
    if (dotted) {
      link.href = dotted;
      return;
    }
    drawDot(original, (href) => {
      dotted = href;
      // It may have been read in the time the icon took to load.
      if (!wanted) return;
      const now = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (now) now.href = href;
    });
  } catch {
    // A tab icon is not worth an exception. The title already said it.
  }
}
