// Google Analytics on the public landing page (9 Oct), on the visitor's
// yes only (lib/consent), the same yes Meta's Pixel waits for. Google's
// own tag, loaded by hand rather than pasted into the page: pasted, it
// runs on every visit before anyone is asked. Never in the app.
import { measureAllowed } from "@/lib/consent";

type Gtag = (...args: unknown[]) => void;
type GaWindow = Window & { dataLayer?: unknown[]; gtag?: Gtag } & Record<string, unknown>;

/** The visitor's choice, as it changes: a yes starts the tag (or lets it send again), a no stops it. */
export function followAnalyticsChoice(): void {
  const id = process.env.NEXT_PUBLIC_GA_ID;
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return;
  const win = window as unknown as GaWindow;
  const allowed = measureAllowed();
  // Google's own switch for one property: true and the tag sends nothing.
  win[`ga-disable-${id}`] = !allowed;
  if (win.gtag) {
    win.gtag("consent", "update", { analytics_storage: allowed ? "granted" : "denied" });
    return;
  }
  if (!allowed) return;
  const layer = (win.dataLayer ??= []);
  win.gtag = function gtag() {
    // The tag reads the arguments object itself, not an array of it.
    // oxlint-disable-next-line prefer-rest-params
    layer.push(arguments);
  };
  win.gtag("js", new Date());
  win.gtag("config", id);
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(script);
}
