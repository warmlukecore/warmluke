"use client";

// ─────────────────────────────────────────────────────────────
// Proving a person is at the keyboard, with Cloudflare Turnstile.
//
// Supabase Auth checks the token on sign-up, sign-in and the reset
// email once CAPTCHA is switched on for the project; the early-access
// form checks it on the server (src/app/actions.ts). Without
// NEXT_PUBLIC_TURNSTILE_SITE_KEY there is no widget and no token, which
// is what a project with CAPTCHA off expects (the check project).
//
// Invisible unless Cloudflare wants a click. A token is good for one
// attempt, so every take() puts a fresh widget in its place.
//
// Callers: login, signup, forgot, start/[token], Landing's DemoForm.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type Turnstile = {
  render: (el: HTMLElement, o: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;
function script(): Promise<Turnstile> {
  loading ??= new Promise((ok, fail) => {
    if (window.turnstile) return ok(window.turnstile);
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.addEventListener("load", () => (window.turnstile ? ok(window.turnstile) : fail(new Error("turnstile"))));
    s.addEventListener("error", () => {
      loading = null;
      fail(new Error("turnstile"));
    });
    document.head.appendChild(s);
  });
  return loading;
}

/** "" means Cloudflare could not be reached: the attempt goes ahead and is refused with a reason. */
function Box({ onToken }: { onToken: (t: string | null) => void }) {
  const el = useRef<HTMLDivElement>(null);
  // Off the page until Cloudflare asks for a click: the widget always
  // leaves its hidden field in here, which would hold a gap open in the form.
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let id: string | null = null;
    let gone = false;
    script()
      .then((t) => {
        if (gone || !el.current) return;
        id = t.render(el.current, {
          sitekey: SITE_KEY,
          appearance: "interaction-only",
          // "flexible" is never narrower than 300px, wider than a phone's card.
          size: (el.current.parentElement?.clientWidth ?? 0) < 300 ? "compact" : "flexible",
          theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(""),
          "before-interactive-callback": () => setAsking(true),
        });
      })
      .catch(() => onToken(""));
    return () => {
      gone = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [onToken]);
  return <div ref={el} className={asking ? "" : "hidden"} />;
}

export function useCaptcha() {
  const [round, setRound] = useState(0);
  const token = useRef<string | null>(null);
  const waiting = useRef<((t: string) => void)[]>([]);
  const got = useCallback((t: string | null) => {
    token.current = t;
    if (t !== null) for (const w of waiting.current.splice(0)) w(t);
  }, []);
  const renew = useCallback(() => {
    token.current = null;
    setRound((r) => r + 1);
  }, []);
  return {
    box: SITE_KEY ? <Box key={round} onToken={got} /> : null,
    /** One attempt's token, waiting for it if the widget is still deciding; undefined when CAPTCHA is off. */
    take: async (): Promise<string | undefined> => {
      if (!SITE_KEY) return undefined;
      const t = token.current ?? (await new Promise<string>((ok) => waiting.current.push(ok)));
      renew();
      return t;
    },
    /** For a form that posts the widget's own hidden field: a new widget after each answer. */
    renew,
  };
}
