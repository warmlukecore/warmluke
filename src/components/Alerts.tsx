"use client";

// What Luke noticed (0163), as rows: the worst first, each with what it
// is, the numbers behind it, and Luke to ask about it where it can
// answer. One list for the bell and the Overview, so it reads the same
// in both.
//
// Callers: src/components/AppShell.tsx (the foot of the Overview),
// src/components/ChatPanel.tsx (the bell), src/components/ProjectSettings.tsx
// (what is watched, and from when).

import { useCallback, useEffect, useState } from "react";
import { ArrowUp, BellOff, Check, X, type LucideIcon } from "lucide-react";
import { ALERTS_COMING, describeAlert, NEEDS_NAMES, wordsOf, type Alert, type AlertSetting } from "@/lib/alerts";
import { supabase } from "@/lib/supabase-client";
import { ago } from "@/lib/when";
import { button, field, fieldOf, hint, iconButton, label, note, sendButton } from "@/components/ui/controls";
import { LukeMark } from "@/components/ui/LukeMark";
import { Group } from "@/components/ui/Group";
import { Switch } from "@/components/ui/Switch";
import { Dialog } from "@/components/ui/Dialog";
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

/**
 * The foot of the Overview: what needs them, or a small line saying
 * nothing does. The bell says it first; the page is the store's.
 * Given `choose`, a builder is first asked what to watch (AlertPicker).
 */
export function AlertsPanel({
  alerts,
  choose,
  ...rest
}: Handlers & { alerts: Alert[] | null; choose?: { projectId: string; onAskLuke: (text: string) => void } }) {
  const [picking, setPicking] = useState(false);
  const picker = choose && (
    <AlertPicker projectId={choose.projectId} onAskLuke={choose.onAskLuke} busy={rest.busy} onOpen={setPicking} />
  );
  if (alerts === null) return picker ?? null;
  return (
    <div className="space-y-2">
      {alerts.length > 0 && (
        <Panel
          title="What Luke noticed"
          icon={<LukeMark size="xs" />}
          aside={alerts.length > 1 ? `${alerts.length}` : undefined}
        >
          <AlertList alerts={alerts} {...rest} />
        </Panel>
      )}
      {picker}
      {/* While the picker's line shows, it says enough. */}
      {alerts.length === 0 && !picking && (
        <p className="flex items-center gap-2 px-1 text-xs text-fg-muted">
          <BellOff aria-hidden size={13} strokeWidth={1.75} className="shrink-0 text-fg-faint" />
          <span>
            <span className="font-medium text-fg">Nothing needs you right now.</span> Luke keeps looking at your stock,
            shipping and returns.
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * What should Luke keep an eye on: asked once, of whoever builds here,
 * as one line at the foot of the Overview. Choose opens it in the
 * dialog; the cross keeps it as it is, everything ticked, and it is not
 * asked again (Settings → Alerts changes it after). What is not here yet
 * is shown as coming, not offered; anything else is said in their words
 * and Luke makes it a rule.
 */
function AlertPicker({
  projectId,
  onAskLuke,
  busy,
  onOpen,
}: {
  projectId: string;
  onAskLuke: (text: string) => void;
  busy?: boolean;
  onOpen: (open: boolean) => void;
}) {
  const [kinds, setKinds] = useState<AlertSetting[] | null>(null);
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [own, setOwn] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    supabase.rpc("abo_alert_settings", { p_project: projectId }).then(({ data }) => {
      const list = (data as AlertSetting[] | null) ?? [];
      setKinds(list);
      setOn(Object.fromEntries(list.map((k) => [k.kind, k.enabled])));
    });
  }, [projectId]);
  const open = !!kinds && kinds.length > 0 && !kinds.some((k) => k.chosen);
  useEffect(() => onOpen(open), [open, onOpen]);
  if (!open) return null;

  // Each kept as chosen, so the question is not asked again; then what
  // they wrote goes to Luke.
  const keep = async (ask?: string) => {
    setSaving(true);
    setError(null);
    let kept: AlertSetting[] | null = null;
    for (const k of kinds) {
      const { data, error: e } = await supabase.rpc("abo_set_alert_setting", {
        p_project: projectId,
        p_kind: k.kind,
        p_enabled: on[k.kind] ?? true,
        p_settings: k.settings,
      });
      if (e) {
        setSaving(false);
        setError(e.message);
        return;
      }
      kept = data as AlertSetting[];
    }
    setSaving(false);
    if (ask) onAskLuke(ask);
    setKinds(kept);
  };

  return (
    <>
      <div className="flex items-center gap-2 px-1 text-xs text-fg-muted">
        <LukeMark size="xs" />
        <p className="min-w-0 flex-1">
          Luke watches your stock, shipping and returns.
          {error && !choosing && <span className="ml-1 text-tone-critical-fg">{error}</span>}
        </p>
        <button onClick={() => setChoosing(true)} className={button("plain", "sm")}>
          Choose what
        </button>
        <button
          onClick={() => void keep()}
          disabled={saving}
          aria-label="Keep these and hide"
          title="Keep these. Change them any time in Settings → Alerts."
          className={`${iconButton} h-7 w-7`}
        >
          <X aria-hidden size={14} strokeWidth={2} />
        </button>
      </div>
      {choosing && (
        <Dialog
          title="What should Luke keep an eye on?"
          description="Luke looks at your store all day and tells you in the bell. You can change this any time in Settings → Alerts."
          onClose={() => setChoosing(false)}
          footer={
            <>
              {error && <span className="mr-auto text-xs text-tone-critical-fg">{error}</span>}
              <button onClick={() => void keep()} disabled={saving} className={`${button("primary", "sm")} ml-auto`}>
                {saving ? "Saving…" : "Watch these"}
              </button>
            </>
          }
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {kinds.map((k) => {
              const w = wordsOf(k.kind);
              return (
                <Choice
                  key={k.kind}
                  icon={w.icon}
                  name={w.name}
                  about={w.about}
                  checked={on[k.kind] ?? true}
                  onChange={(v) => setOn((p) => ({ ...p, [k.kind]: v }))}
                />
              );
            })}
            {ALERTS_COMING.map((c) => (
              <Choice key={c.name} icon={c.icon} name={c.name} about={c.about} checked={false} soon />
            ))}
          </div>
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (own.trim()) void keep(`Alert me: ${own.trim()}`);
            }}
          >
            <label htmlFor="alert-own" className={label}>
              Anything else?
            </label>
            <div className="flex items-center gap-2">
              <input
                id="alert-own"
                value={own}
                onChange={(e) => setOwn(e.target.value)}
                maxLength={300}
                placeholder="Tell me when a COD order over ₹5,000 comes in"
                className={field}
              />
              <button
                type="submit"
                disabled={!own.trim() || saving || busy}
                aria-label="Ask Luke to watch for it"
                className={sendButton}
              >
                <ArrowUp aria-hidden size={16} strokeWidth={2} />
              </button>
            </div>
            <p className={hint}>In your own words. Luke turns it into an alert and shows you before it starts.</p>
          </form>
        </Dialog>
      )}
    </>
  );
}

/** One thing to watch, ticked or not; what is coming is shown, and cannot be ticked. */
function Choice({
  icon: Glyph,
  name,
  about,
  checked,
  onChange,
  soon,
}: {
  icon: LucideIcon;
  name: string;
  about: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
  soon?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={soon}
      onClick={() => onChange?.(!checked)}
      className={`flex items-start gap-3 rounded-control border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed ${
        checked ? "border-line-strong bg-surface-subdued" : "border-line hover:bg-surface-hover"
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-canvas ${soon ? "text-fg-faint" : "text-fg-muted"}`}
      >
        <Glyph aria-hidden size={14} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] font-medium ${soon ? "text-fg-muted" : "text-fg"}`}>{name}</span>
        <span className="block text-[11px] leading-relaxed text-fg-muted">{about}</span>
      </span>
      {soon ? (
        <span className="shrink-0 rounded-full bg-surface-hover px-1.5 py-px text-[10px] font-medium text-fg-muted">
          Coming soon
        </span>
      ) : (
        <span
          aria-hidden
          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border ${
            checked ? "border-primary bg-primary text-on-primary" : "border-line-strong bg-surface"
          }`}
        >
          {checked && <Check size={12} strokeWidth={2.5} />}
        </span>
      )}
    </button>
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
      <Group title="Coming soon" description="Luke starts on these once the data for them is read.">
        {ALERTS_COMING.map((c) => (
          <div key={c.name} className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canvas text-fg-faint">
              <c.icon aria-hidden size={15} strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-fg-muted">{c.name}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{c.about}</p>
            </div>
          </div>
        ))}
      </Group>
      <p className={hint}>
        Want to be told about something else? Ask Luke in your own words (&ldquo;tell me when a COD order over ₹5,000
        comes in&rdquo;). Each one is a rule, under Rules, where it can be turned off.
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
