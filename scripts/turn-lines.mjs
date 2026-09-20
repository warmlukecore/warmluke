// Reads a chat turn the way the route now answers it: lines of JSON,
// each step as it happened, the reply last — or a single JSON body,
// when the route refused before it started. Either way the caller
// gets { status, steps, data }, with `data` being what the route used
// to return whole.
//
// Shared by every check that talks to POST /api/chat, so the shape of
// the stream is known in one place.

export async function readTurn(res) {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("x-ndjson")) {
    return { status: res.status, steps: [], data: await res.json().catch(() => ({})) };
  }
  const steps = [];
  let data = null;
  for (const raw of (await res.text()).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if ("step" in obj) steps.push(obj);
    else data = obj;
  }
  return { status: res.status, steps, data: data ?? { error: "the stream ended without its last line" } };
}
