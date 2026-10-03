"use client";

// What Luke noticed (0163), as rows: the worst first, each with what it
// is, the numbers behind it, and Luke to ask about it where it can
// answer. One list for the bell and the Overview, so it reads the same
// in both.
//
// Callers: src/components/AppShell.tsx (the Overview's card),
// src/components/ChatPanel.tsx (the bell), src/components/ProjectSettings.tsx
// (what is watched, and from when).

import { useCallback, useEffect, useState } from "react";
import { BellOff, X } from "lucide-react";
import { describeAlert, NEEDS_NAMES, wordsOf, type Alert, type AlertSetting } from "@/lib/alerts";
import { supabase } from "@/lib/supabase-client";
import { ago } from "@/lib/when";
import { button, card, fieldOf, hint, iconButton, note } from "@/components/ui/controls";
import { LukeMark } from "@/components/ui/LukeMark";
import { Group } from "@/components/ui/Group";
import { Switch } from "@/components/ui/Switch";
import { Panel } from "@/components/Overview";

type Handlers = {
  now: number;
  /** Ask Luke about it, or open what Luke said; left out where Luke is not theirs to ask. */
  onAsk?: (a: Alert) => void;
  onDismiss: (a: Alert) => void;
  /** Luke is answering something already. */
  busy?: boolean;
};

const TILE = {
  critical: "bg-tone-critical text-tone-critical-fg",
  attention: "bg-tone-attention text-tone-attention-fg",
};
const DOT = { critical: "bg-signal-critical", attention: "bg-signal-attention" };

export function AlertList({
  alerts,
  now,
  onAsk,
  onDismiss,
  busy,
  dense,
}: Handlers & { alerts: Alert[]; dense?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {alerts.map((a) => {
        const { icon: Glyph, title, detail, ask } = describeAlert(a);
        const asked = a.conversation_id !== null;
        return (
          <li key={a.id} className={`flex items-start gap-3 ${dense ? "px-2 py-2.5" : "px-4 py-3"}`}>
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${TILE[a.severity]}`}>
              <Glyph aria-hidden size={15} strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug font-medium text-fg">
                {!a.read && (
                  <span
                    role="img"
                    aria-label="New"
                    className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${DOT[a.severity]}`}
                  />
                )}
                {title}
              </p>
              {detail && <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-fg-muted">{detail}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {onAsk && (ask || asked) && (
                  <button onClick={() => onAsk(a)} disabled={busy && !asked} className={button("secondary", "sm")}>
                    <LukeMark size="xs" />
                    {asked ? "See what Luke said" : "Ask Luke"}
                  </button>
                )}
                <span className="text-[11px] text-fg-faint">since {ago(a.opened_at, now)}</span>
              </div>
            </div>
            <button
              onClick={() => onDismiss(a)}
              aria-label={`Put away: ${title}`}
              title="Put away until it gets worse"
              className={`${iconButton} -mt-1 -mr-1`}
            >
              <X aria-hidden size={14} strokeWidth={2} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The Overview's card: what needs them, or a line saying nothing does. */
export function AlertsPanel({ alerts, ...rest }: Handlers & { alerts: Alert[] | null }) {
  if (alerts === null) return null;
  if (alerts.length === 0) {
    return (
      <div className={`${card} flex items-center gap-3 px-4 py-3`}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canvas text-fg-faint">
          <BellOff aria-hidden size={15} strokeWidth={1.75} />
        </span>
        <p className="text-[13px] text-fg-muted">
          <span className="font-medium text-fg">Nothing needs you right now.</span> Luke keeps looking at your stock,
          shipping and returns.
        </p>
      </div>
    );
  }
  return (
    <Panel
      title="What Luke noticed"
      icon={<LukeMark size="xs" />}
      aside={alerts.length > 1 ? `${alerts.length}` : undefined}
    >
      <AlertList alerts={alerts} {...rest} />
    </Panel>
  );
}

/**
 * What Luke watches in a project, each kind on or off with its numbers,
 * and which are still waiting for the store's data. A change is kept at
 * once and the store looked at again, as Store and People act at once.
 */
export function AlertSettings({ projectId }: { projectId: string }) {
  const [kinds, setKinds] = useState<AlertSetting[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.rpc("abo_alert_settings", { p_project: projectId }).then(({ data, error: e }) => {
      if (e) setError(e.message);
      else setKinds((data as AlertSetting[] | null) ?? []);
    });
  }, [projectId]);

  const save = useCallback(
    async (k: AlertSetting, enabled: boolean, settings: Record<string, number>) => {
      setSaving(k.kind);
      setError(null);
      const { data, error: e } = await supabase.rpc("abo_set_alert_setting", {
        p_project: projectId,
        p_kind: k.kind,
        p_enabled: enabled,
        p_settings: settings,
      });
      setSaving(null);
      if (e) setError(e.message);
      else setKinds((data as AlertSetting[] | null) ?? []);
    },
    [projectId]
  );

  if (!kinds) {
    return error ? (
      <div className={note.critical}>{error}</div>
    ) : (
      <div className="space-y-2" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-14 rounded-card" />
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {error && <div className={note.critical}>{error}</div>}
      <Group
        title="What Luke watches"
        description="Luke looks at your store every quarter of an hour, and soon after anything changes. What it finds is in the bell and on the Overview."
      >
        {kinds.map((k) => {
          const w = wordsOf(k.kind);
          const Glyph = w.icon;
          const waiting = k.needs.filter(Boolean).map((n) => NEEDS_NAMES[n] ?? n);
          return (
            <div key={k.kind} className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canvas text-fg-muted">
                <Glyph aria-hidden size={15} strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-fg">{w.name}</div>
                    {w.about && <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{w.about}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-fg-muted">
                      {saving === k.kind ? "Saving…" : k.enabled ? "On" : "Off"}
                    </span>
                    <Switch
                      checked={k.enabled}
                      disabled={saving !== null}
                      onChange={(on) => save(k, on, k.settings)}
                      label={w.name}
                    />
                  </div>
                </div>
                {k.enabled && w.settings.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {w.settings.map((s) => (
                      <NumberLine
                        key={s.key}
                        before={s.before}
                        after={s.after}
                        value={k.settings[s.key] ?? k.defaults[s.key]}
                        disabled={saving !== null}
                        onCommit={(v) => save(k, true, { ...k.settings, [s.key]: v })}
                      />
                    ))}
                  </div>
                )}
                {!k.ready && <p className={hint}>Starts once your {waiting.join(" and ")} have finished coming in.</p>}
              </div>
            </div>
          );
        })}
      </Group>
      <p className={hint}>
        Conversion and marketing alerts join these once Warmluke reads your store&rsquo;s visits and your ads.
      </p>
    </div>
  );
}

/** One setting as a sentence with its number in it, kept when the field is left. */
function NumberLine({
  before,
  after,
  value,
  disabled,
  onCommit,
}: {
  before: string;
  after: string;
  value: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [was, setWas] = useState(value);
  // Read back after a save: the field shows what was kept.
  if (was !== value) {
    setWas(value);
    setText(String(value));
  }
  const commit = () => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n) || n < 0 || n > 10000) setText(String(value));
    else if (n !== value) onCommit(n);
  };
  return (
    <label className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
      {before}
      <input
        type="number"
        inputMode="decimal"
        min={0}
        max={10000}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className={`${fieldOf("sm")} w-16 tabular-nums`}
      />
      {after}
    </label>
  );
}
