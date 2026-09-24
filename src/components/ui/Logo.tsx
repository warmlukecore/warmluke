// The logo, cropped to its mark.
//
// Whatever empty margin the file carries is left out (where the mark sits
// is measured at build, src/lib/brand-file.mjs), so the mark is exactly
// the height it is given and sits on the line of the words beside it.
// The height comes from className; the width follows the mark's shape.
//
// On a dark surface (onDark) it is lifted a little, so the darker parts
// of the mark do not sink into the background.

import Image from "next/image";
import { LOGO, LOGO_BOX } from "@/lib/brand";

export function Logo({
  className = "h-5",
  onDark = false,
  priority = false,
}: {
  className?: string;
  onDark?: boolean;
  priority?: boolean;
}) {
  const [left, top, width, height, fileWidth, fileHeight] = LOGO_BOX.length === 6 ? LOGO_BOX : [0, 0, 1, 1, 1, 1];
  return (
    <span
      aria-hidden
      className={`relative inline-block shrink-0 overflow-hidden ${className}`}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      <span
        className="absolute"
        style={{
          width: `${(fileWidth / width) * 100}%`,
          height: `${(fileHeight / height) * 100}%`,
          left: `${(-left / width) * 100}%`,
          top: `${(-top / height) * 100}%`,
        }}
      >
        <Image
          src={LOGO}
          alt=""
          fill
          sizes="160px"
          priority={priority}
          className={`object-contain ${onDark ? "brightness-[1.5] saturate-[1.15]" : ""}`}
        />
      </span>
    </span>
  );
}
