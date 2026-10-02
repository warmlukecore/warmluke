"use client";

// The frame around the screens outside a project — the dashboard, the
// accounts screen, onboarding: the same dark surround and rounded page
// the app itself sits in, so leaving a project does not feel like
// leaving the product.

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Compass, Inbox, LayoutGrid, LogOut, MessagesSquare, ShieldCheck, ShoppingBag, UserPlus } from "lucide-react";
import { signOut } from "@/lib/auth";
import { useConsoleBase } from "@/lib/console-base";
import { menu, menuItem } from "@/components/ui/controls";
import { Logo } from "@/components/ui/Logo";
import { ThemeToggle } from "@/components/ThemeSync";

export function PageFrame({
  email,
  isSuperadmin = false,
  children,
}: {
  email: string | null | undefined;
  isSuperadmin?: boolean;
  children: ReactNode;
}) {
  const path = usePathname();
  // The console's address, which only an administrator is ever told.
  const admin = useConsoleBase(isSuperadmin);
  const tab = (href: string, text: string, Glyph: typeof LayoutGrid) => (
    <Link
      href={href}
      aria-current={path === href ? "page" : undefined}
      className={`inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] font-medium transition-colors ${
        path === href
          ? "bg-frame-raised text-white"
          : "text-frame-fg-muted hover:bg-frame-raised/60 hover:text-frame-fg"
      }`}
    >
      <Glyph aria-hidden size={15} strokeWidth={1.75} />
      <span className="hidden sm:inline">{text}</span>
    </Link>
  );

  return (
    <div className="font-ui flex min-h-dvh flex-col bg-frame text-fg">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3 sm:px-5">
        <Link href="/dashboard" className="mr-2 flex items-center gap-2.5">
          <Logo className="h-5" onDark priority />
          {/* The mark alone on a phone: with every admin tab the row is wider than one. */}
          <span className="hidden text-sm font-semibold text-white sm:inline">Warmluke</span>
        </Link>
        {/* Scrolls sideways on a phone, so the account menu is never pushed off the edge. */}
        <nav className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tab("/dashboard", "Projects", LayoutGrid)}
          {/* The screen refuses anyone else; this only decides whether the door shows. */}
          {isSuperadmin && admin && (
            <>
              {tab(admin, "Superadmin", ShieldCheck)}
              {tab(`${admin}/conversations`, "Conversations", MessagesSquare)}
              {tab(`${admin}/invites`, "Invites", UserPlus)}
              {tab(`${admin}/demos`, "Early access", Inbox)}
              {tab(`${admin}/shopify`, "Shopify apps", ShoppingBag)}
              {tab(`${admin}/tour`, "Tour", Compass)}
            </>
          )}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ThemeToggle className="rounded-control p-1.5 text-frame-fg-muted transition-colors hover:bg-frame-raised hover:text-white" />
          <AccountMenu email={email} />
        </div>
      </header>
      <main className="flex-1 bg-canvas sm:mx-2 sm:mb-2 sm:rounded-card sm:shadow-card">{children}</main>
    </div>
  );
}

/** The signed-in person's initial, and the way out. */
function AccountMenu({ email }: { email: string | null | undefined }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const initial = (email ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Your account"
        className="flex h-8 items-center gap-2 rounded-control pr-1 pl-1 text-frame-fg transition-colors hover:bg-frame-raised sm:pr-2.5"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-frame-line text-[11px] font-semibold text-white">
          {initial}
        </span>
        <span className="hidden max-w-[14rem] truncate text-[13px] sm:inline">{email}</span>
      </button>
      {open && (
        <div role="menu" className={`${menu} absolute top-full right-0 mt-1.5 w-60`}>
          <div className="truncate px-2 pt-1.5 pb-2 text-xs text-fg-muted">{email}</div>
          <div className="my-1 h-px bg-line" />
          <button role="menuitem" onClick={() => signOut(router)} className={menuItem}>
            <LogOut aria-hidden size={15} strokeWidth={1.75} className="text-fg-muted" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
