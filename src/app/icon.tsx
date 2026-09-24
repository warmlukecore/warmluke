// The browser tab's icon, drawn from the logo in public/brand/ at build,
// so a new logo there is the new favicon too.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { LOGO } from "@/lib/brand";

export const size = { width: 256, height: 256 };
export const contentType = "image/png";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

export default async function Icon() {
  const file = decodeURIComponent(LOGO);
  const data = await readFile(path.join(process.cwd(), "public", file), "base64");
  const type = TYPES[path.extname(file).toLowerCase()] ?? "image/png";
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element -- ImageResponse draws plain elements
      <img src={`data:${type};base64,${data}`} alt="" width={256} height={256} style={{ objectFit: "contain" }} />
    ),
    size
  );
}
