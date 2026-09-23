// Luke's mark: a line icon on a soft gradient disc, crisp at any size —
// in place of a text character that each platform drew differently.

import { Sparkles } from "lucide-react";

const SIZES = {
  sm: { box: "h-7 w-7", icon: 14 },
  lg: { box: "h-12 w-12", icon: 22 },
} as const;

export function LukeMark({ size = "sm" }: { size?: keyof typeof SIZES }) {
  const s = SIZES[size];
  return (
    <span
      aria-hidden
      className={`${s.box} inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 via-indigo-500 to-sky-500 text-white shadow-sm ring-1 ring-black/5`}
    >
      <Sparkles size={s.icon} strokeWidth={2} />
    </span>
  );
}
