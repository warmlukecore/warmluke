"use client";

// The frame around the screens outside a project — the dashboard, the
// superadmin console, onboarding: the same dark surround and rounded page
// the app itself sits in, so leaving a project does not feel like
// leaving the product.
//
// Outside the console it is a bar across the top: the projects, and for
// an administrator one way into the console. Inside the console it is a
// sidebar, as the app's is, grouped by what each screen is about and read
// from one list (lib/console-nav), so a screen added later needs no room
// found for it in a row of tabs. On a phone the sidebar is a drawer
// behind the menu button.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft,
  LayoutGrid,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { useConsoleBase } from "@/lib/console-base";
import { CONSOLE_NAV, SEARCH_FROM } from "@/lib/console-nav";
import { SCOPED, scopeQuery, useConsoleScope } from "@/lib/console-scope";
import { ConsoleScope } from "@/components/ConsoleScope";
import { menu, menuItem, note } from "@/components/ui/controls";
import { supabase } from "@/lib/supabase-client";
import { ago } from "@/lib/when";
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
  const inConsole = !!useParams<{ gate?: string }>()?.gate;
  return inConsole && isSuperadmin ? (
    <ConsoleFrame email={email}>{children}</ConsoleFrame>
  ) : (
    <TopFrame email={email} isSuperadmin={isSuperadmin}>
      {children}
    </TopFrame>
  );
}

/** The dashboard's frame: the projects, and an administrator's way into the console. */
function TopFrame({
  email,
  isSuperadmin,
  children,
}: {
  email: string | null | undefined;
  isSuperadmin: boolean;
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
          <span className="text-sm font-semibold text-white">Warmluke</span>
        </Link>
        {tab("/dashboard", "Projects", LayoutGrid)}
        {/* The console refuses anyone else; this only decides whether its door shows. */}
        {isSuperadmin && admin && tab(admin, "Superadmin", ShieldCheck)}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ThemeToggle className="rounded-control p-1.5 text-frame-fg-muted transition-colors hover:bg-frame-raised hover:text-white" />
          <AccountMenu email={email} />
        </div>
      </header>
      <main className="flex-1 bg-canvas sm:mx-2 sm:mb-2 sm:rounded-card sm:shadow-card">{children}</main>
    </div>
  );
}

const RAIL_KEY = "abo_console_rail";

/** The console's frame: its screens down the side, grouped; a drawer on a phone. */
function ConsoleFrame({ email, children }: { email: string | null | undefined; children: ReactNode }) {
  const gate = useParams<{ gate: string }>().gate;
  const base = `/${gate}`;
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  // Folded to a rail of icons on a wide screen, as the app's sidebar folds,
  // for the screens that want the width (the accounts table). Kept per browser.
  const [rail, setRail] = useState(false);
  useEffect(() => {
    try {
      setRail(localStorage.getItem(RAIL_KEY) === "1");
    } catch {
      /* a private window: it starts open */
    }
  }, []);
  const fold = () => {
    setRail(!rail);
    try {
      if (rail) localStorage.removeItem(RAIL_KEY);
      else localStorage.setItem(RAIL_KEY, "1");
    } catch {
      /* kept until the page closes */
    }
  };
  /** Hidden on the rail, and only there: a phone's drawer always has its words. */
  const word = rail ? "lg:hidden" : "";

  const all = CONSOLE_NAV.flatMap((g) => g.screens);
  const hrefOf = (to: string) => (to ? `${base}/${to}` : base);
  // The scope chosen (0184) goes with the links to every screen that narrows to it.
  const scope = useConsoleScope();
  const linkOf = (to: string) => `${hrefOf(to)}${SCOPED.has(to) ? scopeQuery(scope) : ""}`;
  // The screen on show: its own address, or one under it (a conversation opened).
  const here = (to: string) => (to ? path === hrefOf(to) || path.startsWith(`${hrefOf(to)}/`) : path === base);
  const current = all.find((s) => here(s.to));

  const groups = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (!q) return CONSOLE_NAV;
    return CONSOLE_NAV.map((g) => ({
      ...g,
      screens: g.screens.filter((s) => `${s.label} ${s.about} ${g.title}`.toLowerCase().includes(q)),
    })).filter((g) => g.screens.length > 0);
  }, [find]);

  // The drawer closes on Escape, as every overlay here does.
  useEffect(() => {
    if (!open) return;
    const shut = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", shut);
    return () => document.removeEventListener("keydown", shut);
  }, [open]);

  return (
    <div className="font-ui flex min-h-dvh bg-frame text-fg">
      {open && <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-30 bg-black/45 lg:hidden" />}
      <aside
        aria-label="Superadmin"
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col bg-frame text-frame-fg transition-transform duration-200 motion-reduce:transition-none lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0 ${rail ? "lg:w-16" : "lg:w-56"} ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className={`flex items-center gap-2.5 px-4 pt-4 pb-3 ${rail ? "lg:flex-col lg:gap-3 lg:px-0" : ""}`}>
          <Link
            href={base}
            onClick={() => setOpen(false)}
            className={`flex min-w-0 flex-1 items-center gap-2.5 ${rail ? "lg:flex-none" : ""}`}
          >
            <Logo className="h-5" onDark priority />
            <span className={`min-w-0 ${word}`}>
              <span className="block truncate text-sm font-semibold text-white">Warmluke</span>
              <span className="block text-[11px] text-frame-fg-muted">Superadmin</span>
            </span>
          </Link>
          <button
            type="button"
            onClick={fold}
            aria-label={rail ? "Expand the sidebar" : "Collapse the sidebar"}
            title={rail ? "Expand the sidebar" : "Collapse the sidebar"}
            className="hidden rounded-control p-1.5 text-frame-fg-muted transition-colors hover:bg-frame-raised hover:text-white lg:inline-flex"
          >
            {rail ? (
              <PanelLeftOpen aria-hidden size={16} strokeWidth={1.75} />
            ) : (
              <PanelLeftClose aria-hidden size={16} strokeWidth={1.75} />
            )}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close the menu"
            className="rounded-control p-1.5 text-frame-fg-muted transition-colors hover:bg-frame-raised hover:text-white lg:hidden"
          >
            <X aria-hidden size={16} strokeWidth={1.75} />
          </button>
        </div>

        {all.length >= SEARCH_FROM && (
          <div className={`px-3 pb-2 ${word}`}>
            <label className="flex h-8 items-center gap-2 rounded-control bg-frame-raised px-2.5 text-[13px] text-frame-fg-muted focus-within:text-frame-fg">
              <Search aria-hidden size={14} strokeWidth={1.75} />
              <input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="Find a screen"
                aria-label="Find a screen"
                className="min-w-0 flex-1 bg-transparent text-frame-fg outline-none placeholder:text-frame-fg-muted"
              />
            </label>
          </div>
        )}

        <nav
          aria-label="Console screens"
          className={`thin-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3 ${rail ? "lg:px-2" : ""}`}
        >
          {groups.map((g) => (
            <div key={g.title}>
              <div className={`px-2 pt-4 pb-1.5 text-xs font-medium text-frame-fg-muted first:pt-1 ${word}`}>
                {g.title}
              </div>
              {rail && <div aria-hidden className="mx-2 my-2 hidden h-px bg-frame-line first:hidden lg:block" />}
              {g.screens.map((s) => {
                const on = here(s.to);
                return (
                  <Link
                    key={s.to}
                    href={linkOf(s.to)}
                    title={rail ? s.label : s.about}
                    aria-label={rail ? s.label : undefined}
                    aria-current={on ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={`mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                      rail ? "lg:h-10 lg:justify-center lg:px-0" : ""
                    } ${on ? "bg-frame-raised text-white" : "text-frame-fg hover:bg-frame-raised/60 hover:text-white"}`}
                  >
                    <s.icon aria-hidden size={16} strokeWidth={1.75} className="shrink-0" />
                    <span className={`truncate ${word}`}>{s.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
          {groups.length === 0 && <p className="px-2 py-2 text-[13px] text-frame-fg-muted">No screen matches that.</p>}
        </nav>

        <div className={`border-t border-frame-line px-3 py-3 ${rail ? "lg:px-2" : ""}`}>
          <Link
            href="/dashboard"
            title="Back to projects"
            aria-label={rail ? "Back to projects" : undefined}
            className={`mb-2 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-frame-fg-muted transition-colors hover:bg-frame-raised/60 hover:text-white ${
              rail ? "lg:justify-center lg:px-0" : ""
            }`}
          >
            <ArrowLeft aria-hidden size={15} strokeWidth={1.75} />
            <span className={word}>Back to projects</span>
          </Link>
          <div className={`flex items-center gap-1 ${rail ? "lg:flex-col" : ""}`}>
            <div className={`min-w-0 flex-1 ${rail ? "lg:flex-none" : ""}`}>
              <AccountMenu email={email} up wide={!rail} bare={rail} />
            </div>
            <ThemeToggle className="rounded-control p-1.5 text-frame-fg-muted transition-colors hover:bg-frame-raised hover:text-white" />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* A phone has no room for the sidebar: the screen's name, and the menu behind a button. */}
        <header className="flex h-14 shrink-0 items-center gap-2 px-3 lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open the menu"
            aria-expanded={open}
            className="rounded-control p-1.5 text-frame-fg transition-colors hover:bg-frame-raised hover:text-white"
          >
            <Menu aria-hidden size={18} strokeWidth={1.75} />
          </button>
          <span className="truncate text-sm font-medium text-white">{current?.label ?? "Superadmin"}</span>
        </header>
        <main className="min-w-0 flex-1 bg-canvas sm:mx-2 sm:mb-2 sm:rounded-card sm:shadow-card lg:mt-2 lg:ml-0 lg:rounded-pane">
          <LukeHealth />
          {/* Whose numbers this screen shows (0184): on the screens that narrow to an account. */}
          {current && SCOPED.has(current.to) && <ConsoleScope />}
          {children}
        </main>
      </div>
    </div>
  );
}

/** The signed-in person's initial, and the way out. */
function AccountMenu({
  email,
  up = false,
  wide = false,
  bare = false,
}: {
  email: string | null | undefined;
  /** Opens above, for a menu at the foot of a sidebar. */
  up?: boolean;
  /** As wide as where it sits, the email beside the initial on every screen. */
  wide?: boolean;
  /** The initial alone, for the folded rail: its email is in its menu. */
  bare?: boolean;
}) {
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
        className={`flex h-8 items-center gap-2 rounded-control pr-1 pl-1 text-frame-fg transition-colors hover:bg-frame-raised sm:pr-2.5 ${
          wide ? "w-full" : ""
        }`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-frame-line text-[11px] font-semibold text-white">
          {initial}
        </span>
        <span
          className={`min-w-0 truncate text-[13px] ${wide ? "" : "hidden max-w-[14rem] sm:inline"} ${bare ? "lg:hidden" : ""}`}
        >
          {email}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className={`${menu} absolute w-60 ${up ? "bottom-full left-0 mb-1.5" : "top-full right-0 mt-1.5"}`}
        >
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

/** What each failure means for whoever reads the console, and what to do about it. */
const PAUSED: Record<string, string> = {
  billing: "The model account is out of credit. Top it up at console.anthropic.com → Billing, and turn on auto-reload.",
  auth: "The model key was refused. Check ANTHROPIC_API_KEY in Vercel.",
  busy: "The model is overloaded. It usually passes in minutes.",
  down: "The model cannot be reached.",
};

/**
 * Whether Luke is failing for merchants right now (0165), on every console
 * screen: on 3 October the account ran out for an hour, and a merchant
 * found out first. Read once a screen; gone once an answer comes through.
 */
function LukeHealth() {
  const [h, setH] = useState<{
    failing: boolean;
    kind: string | null;
    since: string | null;
    turns: number;
    projects: number;
    at: number;
  } | null>(null);
  useEffect(() => {
    supabase
      .rpc("abo_admin_luke_health")
      .then(({ data }) => setH(data ? { ...(data as NonNullable<typeof h>), at: Date.now() } : null));
  }, []);
  if (!h?.failing) return null;
  return (
    <div role="alert" className={`${note.critical} m-4 mb-0 flex items-start gap-2 text-[13px] sm:m-6 sm:mb-0`}>
      <TriangleAlert aria-hidden size={15} strokeWidth={2} className="mt-0.5 shrink-0" />
      <div>
        <span className="font-medium">
          Luke is failing for merchants: {h.turns} {h.turns === 1 ? "turn" : "turns"} in {h.projects}{" "}
          {h.projects === 1 ? "app" : "apps"} since {ago(h.since, h.at)}.
        </span>{" "}
        {PAUSED[h.kind ?? ""] ?? "The model did not answer."}
      </div>
    </div>
  );
}
