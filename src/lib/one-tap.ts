// Whether this deployment can connect a store in one tap. Asked of the
// server — which knows the app's client id and any listing — once per
// page load, and shared by everything that offers to connect a store.

let answer: Promise<boolean> | null = null;

export function canOneTap(): Promise<boolean> {
  answer ??= fetch("/api/shopify/start?check=1")
    .then((r) => (r.ok ? r.json() : { oneTap: false }))
    .then((d: { oneTap?: unknown }) => d.oneTap === true)
    .catch(() => false);
  return answer;
}
