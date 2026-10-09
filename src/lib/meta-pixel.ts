import { measureAllowed } from "@/lib/consent";

type Pixel = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push?: Pixel;
  loaded?: boolean;
  version?: string;
};
type MetaWindow = Window & { fbq?: Pixel; _fbq?: Pixel };

/** Only once the visitor said yes (lib/consent): never asked is not a yes. */
export function metaTrackingAllowed(): boolean {
  return measureAllowed();
}

/**
 * The visitor's choice, as it changes: a yes starts the Pixel (or lets a
 * started one send again), a no stops one already running from sending.
 */
export function followMeasureChoice(): void {
  const pixel = (window as MetaWindow).fbq;
  if (!metaTrackingAllowed()) pixel?.("consent", "revoke");
  else if (pixel) pixel("consent", "grant");
  else initMetaPixel();
}

/** Landing page only; never run on a merchant's app or customer records. */
export function initMetaPixel(): void {
  const id = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!id || !/^\d+$/.test(id) || !metaTrackingAllowed()) return;
  const win = window as MetaWindow;
  if (win.fbq) return;
  const pixel: Pixel = Object.assign(
    (...args: unknown[]) => {
      if (pixel.callMethod) pixel.callMethod(...args);
      else pixel.queue.push(args);
    },
    { queue: [] as unknown[][] }
  );
  pixel.push = pixel;
  pixel.loaded = true;
  pixel.version = "2.0";
  win.fbq = pixel;
  // Meta's documented bootstrap alias.
  // eslint-disable-next-line no-underscore-dangle
  win._fbq = pixel;
  // Only explicit PageView and successful Lead events, no automatic form scanning.
  pixel("set", "autoConfig", false, id);
  pixel("init", id);
  pixel("track", "PageView");
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://connect.facebook.net/en_US/fbevents.js";
  document.head.appendChild(script);
}

const sent = new Set<string>();
export function trackMetaLead(eventId: string): void {
  if (!metaTrackingAllowed() || sent.has(eventId)) return;
  initMetaPixel();
  const pixel = (window as MetaWindow).fbq;
  if (!pixel) return;
  pixel("track", "Lead", {}, { eventID: eventId });
  sent.add(eventId);
}
