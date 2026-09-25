// The logo, wherever it is shown. Its address is whatever file sits in
// public/brand/, found at build by next.config.mjs (src/lib/brand-file.mjs),
// so a new logo is a new file there and no change here.

export const LOGO = process.env.NEXT_PUBLIC_LOGO as string;

/**
 * Where the mark sits in the file, measured at build: the mark's left,
 * top, width and height, then the file's width and height. Empty when it
 * could not be measured, and the logo is shown whole.
 */
export const LOGO_BOX: number[] = (process.env.NEXT_PUBLIC_LOGO_BOX ?? "").split(",").filter(Boolean).map(Number);
