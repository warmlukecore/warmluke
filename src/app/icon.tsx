// The browser tab's icon, drawn from the logo in public/brand/ at build,
// so a new logo there is the new favicon too. Cropped to the mark, the
// same way the page shows it (LOGO_BOX), and centred with a little room.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { LOGO, LOGO_BOX } from "@/lib/brand";

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
  const [left, top, width, height, fileWidth, fileHeight] = LOGO_BOX.length === 6 ? LOGO_BOX : [0, 0, 1, 1, 1, 1];
  // The mark as large as fits in 232 of the 256, with the file scaled to match.
  const scale = LOGO_BOX.length === 6 ? Math.min(232 / width, 232 / height) : 256;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse draws plain elements */}
        <img
          src={`data:${type};base64,${data}`}
          alt=""
          width={fileWidth * scale}
          height={fileHeight * scale}
          style={{
            position: "absolute",
            left: (256 - width * scale) / 2 - left * scale,
            top: (256 - height * scale) / 2 - top * scale,
          }}
        />
      </div>
    ),
    size
  );
}
