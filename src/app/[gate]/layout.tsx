// The superadmin console answers on one address only (lib/console-path):
// any other first segment that reaches here — /admin once the secret one
// is set, or any guess — is the site's ordinary page that does not exist.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { consoleSegment } from "@/lib/console-path";

// Never listed or followed, wherever its address turns up.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ConsoleGate({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ gate: string }>;
}) {
  const { gate } = await params;
  if (gate !== consoleSegment()) notFound();
  return children;
}
