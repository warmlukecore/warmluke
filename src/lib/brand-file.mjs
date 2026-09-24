// Which file is the logo: the one image in public/brand/, whatever it is
// called. Changing the logo is putting the new file there in place of the
// old one; nothing in the code names it.
//
// Read at build by next.config.mjs, which hands the answer to the app as
// NEXT_PUBLIC_LOGO and NEXT_PUBLIC_LOGO_BOX (see src/lib/brand.ts);
// scripts/check-brand.mjs holds the folder to one image.

import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const BRAND_DIR = "public/brand";
const IMAGE = /\.(png|svg|jpe?g|webp|avif)$/i;

/** The logo's address from the site root, e.g. "/brand/logo.png". Throws unless the folder holds exactly one image. */
export function findLogo(root) {
  const files = readdirSync(path.join(root, BRAND_DIR)).filter((f) => IMAGE.test(f));
  if (files.length !== 1) {
    throw new Error(
      `${BRAND_DIR}/ holds the logo and nothing else, but has ${files.length} images` +
        (files.length ? ` (${files.join(", ")}): keep the one to use and remove the rest.` : ": put the logo there.")
    );
  }
  return `/brand/${encodeURIComponent(files[0])}`;
}

/**
 * Where the mark sits inside the file: "left,top,width,height,fileWidth,fileHeight".
 *
 * A logo file often carries empty margin round the mark, and shown as it
 * is the mark comes out small and off the line of the words beside it.
 * Measured here with sharp (which Next brings for its image optimiser),
 * so the page can leave the margin out without anyone cropping the file.
 * Empty when sharp is not there: the logo is then shown whole.
 */
export async function measureLogo(root, src) {
  let sharp;
  try {
    const fromNext = createRequire(createRequire(path.join(root, "package.json")).resolve("next/package.json"));
    sharp = fromNext("sharp");
  } catch {
    return "";
  }
  const file = path.join(root, "public", decodeURIComponent(src));
  const [{ info }, meta] = await Promise.all([
    sharp(file).trim().toBuffer({ resolveWithObject: true }),
    sharp(file).metadata(),
  ]);
  return [Math.abs(info.trimOffsetLeft ?? 0), Math.abs(info.trimOffsetTop ?? 0), info.width, info.height, meta.width, meta.height].join(",");
}
