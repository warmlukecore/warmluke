// What a door says when Warmluke is invite only (0141): the sign-up page
// to somebody who came without an invite, and onboarding to an account
// the database will not let start an app. One card, so both say the same.

import Link from "next/link";
import { CenteredCard } from "@/components/CenteredCard";
import { button } from "@/components/ui/controls";

export function InviteOnly({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold tracking-tight text-fg">Warmluke is invite only for now</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
        {signedIn
          ? "Your account is ready, but starting an app needs an invite. Ask for early access and we will send you one. If you were sent an invite link, open it while signed in."
          : "Tell us about your store and we will send you an invite link. It opens a sign-up with your details already in."}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Link href="/#book" className={button("primary")}>
          Get early access
        </Link>
        {signedIn ? (
          // Somebody on a team still has the apps they were added to.
          <Link href="/dashboard" className={button("plain")}>
            My apps
          </Link>
        ) : (
          <Link href="/login" className={button("plain")}>
            I have an account
          </Link>
        )}
      </div>
    </CenteredCard>
  );
}
