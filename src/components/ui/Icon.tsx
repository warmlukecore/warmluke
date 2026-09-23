// ─────────────────────────────────────────────────────────────
// Icon — a section's icon, drawn as a line icon.
//
// Sections store an icon by name (lib/types ALLOWED_ICONS, plus the
// names the store's own sections use in lib/store-read). The names were
// always Lucide's; they used to be drawn as emoji from four separate
// maps that had drifted apart. This is the one map now, and a name it
// does not know falls back to the neutral table rather than to nothing.
// check-design-system holds that every stored name is drawn here.
// ─────────────────────────────────────────────────────────────

import {
  Banknote,
  Box,
  Calendar,
  ClipboardList,
  Globe,
  Heart,
  Layers,
  MapPin,
  Package,
  Receipt,
  ScanLine,
  ShoppingCart,
  Table,
  Target,
  Truck,
  Undo2,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export const SECTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  "shopping-cart": ShoppingCart,
  package: Package,
  users: Users,
  receipt: Receipt,
  calendar: Calendar,
  "clipboard-list": ClipboardList,
  "undo-2": Undo2,
  box: Box,
  heart: Heart,
  wrench: Wrench,
  globe: Globe,
  truck: Truck,
  wallet: Wallet,
  target: Target,
  "scan-line": ScanLine,
  table: Table,
  banknote: Banknote,
  "map-pin": MapPin,
  layers: Layers,
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const Drawn = (name && SECTION_ICONS[name]) || Table;
  return <Drawn aria-hidden size={size} strokeWidth={1.75} className={className} />;
}
