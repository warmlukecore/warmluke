"use client";

// ─────────────────────────────────────────────────────────────
// Settings → Connections: what this store connects beside Shopify
// (0204, 0214, 0215, docs/integrations/connectors.md).
//
// Every connector in lib/connectors, grouped by kind and shown by its
// own mark, with where it stands: connected (and when it last synced,
// and how many rows it brought, in its own words), needing
// the owner's attention (in the provider's own words), or not ready yet
// (and what it waits for). A login connector opens its form in place;
// the login is proved with the provider before anything is kept, and
// never comes back to this screen. Disconnecting asks once, in place.
//
// Callers: src/components/ProjectSettings.tsx.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { CONNECTORS, KINDS, connectorById, type Connector } from "@/lib/connectors";
import { apiFetch } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import { ago } from "@/lib/when";
import { Group } from "@/components/ui/Group";
import { button, field, hint, label, note } from "@/components/ui/controls";

type Connection = {
  id: string;
  provider: string;
  account_label: string | null;
  status: "connected" | "needs_attention" | "disconnected";
  last_error: string | null;
  last_synced_at: string | null;
  connected_at: string;
};

export function ConnectionsSettings({ storeId }: { storeId: string | null }) {
  const [rows, setRows] = useState<Connection[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When the list was read: "synced 5 min ago" is said against it, not against render.
  const [readAt, setReadAt] = useState(0);

  const load = useCallback(async () => {
    if (!storeId) return;
    const { data } = await supabase
      .from("store_connections")
      .select("id, provider, account_label, status, last_error, last_synced_at, connected_at")
      .eq("store_id", storeId)
      .neq("status", "disconnected");
    const live = (data ?? []) as Connection[];
    setRows(live);
    // Each connection's rows, in the list it brings (a courier's shipments, an ad account's days).
    const tallies = await Promise.all(
      live.map(async (c) => {
        const table = connectorById(c.provider)?.brings[0];
        if (!table) return [c.id, undefined] as const;
        const { count } = await supabase
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq("connection_id", c.id);
        return [c.id, count ?? 0] as const;
      })
    );
    setCounts(Object.fromEntries(tallies));
    setReadAt(Date.now());
  }, [storeId]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(method: "PATCH" | "DELETE", connectionId: string) {
    setBusy(connectionId);
    setError(null);
    const { ok, data } = await apiFetch("/api/connectors", { connectionId }, method);
    setBusy(null);
    setLeaving(null);
    if (!ok) setError((data.error as string) ?? "That did not go through.");
    await load();
  }

  if (!storeId) {
    return <div className={note.info}>Connect your Shopify store first: your other accounts connect beside it.</div>;
  }
  if (rows === null) return <div className="h-40 animate-pulse rounded-card bg-surface-hover" aria-busy />;

  const now = readAt;
  return (
    <div className="space-y-4">
      {error && <div className={note.critical}>{error}</div>}
      {KINDS.map(({ kind, title, description }) => (
        <Group key={kind} title={title} description={description}>
          <ul className="divide-y divide-line">
            {CONNECTORS.filter((c) => c.kind === kind).map((c) => {
              const mine = rows.find((r) => r.provider === c.id);
              return (
                <li key={c.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-line bg-logo-tile p-1.5">
                        {/* eslint-disable-next-line @next/next/no-img-element -- a small mark, nothing to optimise */}
                        <img src={c.logo.src} alt="" width={20} height={20} className="h-full w-full object-contain" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-fg">{c.label}</div>
                        <Standing
                          connector={c}
                          connection={mine}
                          count={mine ? counts[mine.id] : undefined}
                          now={now}
                        />
                      </div>
                    </div>
                    <Actions
                      connector={c}
                      connection={mine}
                      busy={busy === mine?.id}
                      leaving={leaving === mine?.id}
                      opened={open === c.id}
                      onOpen={() => setOpen(open === c.id ? null : c.id)}
                      onSync={() => mine && act("PATCH", mine.id)}
                      onLeave={() => setLeaving(mine?.id ?? null)}
                      onStay={() => setLeaving(null)}
                      onDisconnect={() => mine && act("DELETE", mine.id)}
                    />
                  </div>
                  {open === c.id && c.auth.kind === "login" && (
                    <LoginForm
                      connector={c}
                      storeId={storeId}
                      onDone={async () => {
                        setOpen(null);
                        await load();
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </Group>
      ))}
    </div>
  );
}

/** A coloured dot and a line of where something stands. */
const line = (dot: string, text: string) => (
  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-muted">
    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
    <span className="min-w-0">{text}</span>
  </div>
);

function Standing({
  connector,
  connection,
  count,
  now,
}: {
  connector: Connector;
  connection: Connection | undefined;
  count: number | undefined;
  now: number;
}) {
  if (connection?.status === "needs_attention") {
    return line("bg-signal-attention", `Needs you: ${connection.last_error ?? "connect it again"}`);
  }
  if (connection) {
    const synced = connection.last_synced_at
      ? `synced ${ago(connection.last_synced_at, now)}${count !== undefined ? ` · ${count.toLocaleString()} ${count === 1 ? connector.brought.one : connector.brought.many}` : ""}`
      : `connected, ${connector.brought.arriving}`;
    return line("bg-signal-success", `${connection.account_label ?? connector.label} · ${synced}`);
  }
  if (connector.ready !== true) return line("bg-fg-faint", `Coming soon: waiting on ${connector.ready.waits}`);
  return <div className="mt-0.5 text-xs text-fg-muted">{connector.gives}</div>;
}

function Actions({
  connector,
  connection,
  busy,
  leaving,
  opened,
  onOpen,
  onSync,
  onLeave,
  onStay,
  onDisconnect,
}: {
  connector: Connector;
  connection: Connection | undefined;
  busy: boolean;
  leaving: boolean;
  opened: boolean;
  onOpen: () => void;
  onSync: () => void;
  onLeave: () => void;
  onStay: () => void;
  onDisconnect: () => void;
}) {
  if (connector.ready !== true) return null;
  if (!connection || connection.status === "needs_attention") {
    return (
      <button onClick={onOpen} className={button(opened ? "plain" : "secondary", "sm")}>
        {opened ? "Cancel" : connection ? "Connect again" : "Connect"}
      </button>
    );
  }
  if (leaving) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-muted">Stop syncing? What it brought stays.</span>
        <button onClick={onStay} className={button("plain", "sm")}>
          Keep
        </button>
        <button onClick={onDisconnect} disabled={busy} className={button("critical-secondary", "sm")}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={onSync} disabled={busy} className={button("secondary", "sm")}>
        {busy ? "Asking…" : "Sync now"}
      </button>
      <button onClick={onLeave} className={button("plain", "sm")}>
        Disconnect
      </button>
    </div>
  );
}

function LoginForm({ connector, storeId, onDone }: { connector: Connector; storeId: string; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (connector.auth.kind !== "login") return null;
  const { fields, how, where } = connector.auth;
  const ready = fields.every((f) => f.optional || (values[f.key] ?? "").trim());

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch("/api/connectors", { storeId, provider: connector.id, fields: values });
    setBusy(false);
    if (!ok) {
      setError((data.error as string) ?? `${connector.label} could not be connected.`);
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={connect} className="mt-3 space-y-3 rounded-card border border-line p-4">
      <p className={`${hint} mt-0`}>
        {how}{" "}
        <a
          href={where}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-fg underline"
        >
          Open it in {connector.label}
          <ExternalLink aria-hidden size={11} strokeWidth={2} />
        </a>
      </p>
      {fields.map((f) => (
        <div key={f.key}>
          <label htmlFor={`${connector.id}-${f.key}`} className={label}>
            {f.label}
          </label>
          {f.type === "textarea" ? (
            <textarea
              id={`${connector.id}-${f.key}`}
              rows={4}
              spellCheck={false}
              autoComplete="off"
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className={`${field} font-mono text-xs`}
            />
          ) : (
            <input
              id={`${connector.id}-${f.key}`}
              type={f.type}
              autoComplete={f.type === "password" ? "new-password" : "off"}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className={field}
            />
          )}
        </div>
      ))}
      {error && <div className={note.critical}>{error}</div>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={!ready || busy} className={button("primary", "sm")}>
          {busy ? `Checking with ${connector.label}…` : `Connect ${connector.label}`}
        </button>
        <span className="text-xs text-fg-muted">Kept encrypted; never shown again.</span>
      </div>
    </form>
  );
}
