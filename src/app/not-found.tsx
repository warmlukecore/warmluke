// A page that is not here: said plainly, with the two ways on.
//
// Next shows this for any address that matches no page, and for a page
// that calls notFound(). Without it, the browser got Next's bare default.

import Link from "next/link";
import { CenteredCard } from "@/components/CenteredCard";
import { button } from "@/components/ui/controls";

export default function NotFound() {
  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold text-fg">This page isn’t here</h1>
      <p className="mt-1">The link may be old, or missing a piece. Nothing you had is affected.</p>
      <div className="mt-5 flex gap-2">
        <Link href="/dashboard" className={button("primary")}>
          Go to my apps
        </Link>
        <Link href="/" className={button("secondary")}>
          Warmluke home
        </Link>
      </div>
    </CenteredCard>
  );
}
