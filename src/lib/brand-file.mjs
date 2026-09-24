// Which file is the logo: the one image in public/brand/, whatever it is
// called. Changing the logo is putting the new file there in place of the
// old one; nothing in the code names it.
//
// Read at build by next.config.mjs, which hands the answer to the app as
// NEXT_PUBLIC_LOGO (see src/lib/brand.ts); scripts/check-brand.mjs holds
// the folder to one image.

import { readdirSync } from "node:fs";
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
