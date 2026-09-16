"use client";

// The tab, when something is waiting for them.
//
// A merchant does not sit on this screen. Their assistant proposes a
// change from inside Claude, or a build finishes half-done, and the
// only places that said so were the bell and a toast — both inside a
// tab they are not looking at. This is the same fact Slack puts on its
// icon: there is something here for you.
//
// Drawn rather than shipped as files. Two states need two images, the
// mark is a letter on a square, and a canvas is smaller than the build
// step that would produce the PNGs.
//
// Callers: src/components/ChatPanel.tsx.

/** The blue the app uses for anything the owner can act on. */
const MARK = "#2563eb";
const DOT = "#ef4444";

let plain: string | null = null;
let dotted: string | null = null;

function draw(withDot: boolean): string {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = MARK;
  // A rounded square, because a bare one reads as a broken image at
  // sixteen pixels.
  const r = 7;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 20px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("W", size / 2, size / 2 + 1);

  if (withDot) {
    // Punched out of the corner first, so the dot reads as a dot at
    // favicon size instead of smearing into the blue behind it.
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(size - 9, 9, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    ctx.fillStyle = DOT;
    ctx.beginPath();
    ctx.arc(size - 9, 9, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas.toDataURL("image/png");
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
    if (count > 0) {
      dotted = dotted ?? draw(true);
    } else {
      plain = plain ?? draw(false);
    }
    const href = count > 0 ? dotted : plain;
    if (!href) return;

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = href;
  } catch {
    // A tab icon is not worth an exception. The title already said it.
  }
}
