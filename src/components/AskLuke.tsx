"use client";

// ─────────────────────────────────────────────────────────────
// Ask Luke: the way to Luke from wherever the owner is while Luke's
// panel is shut. A pill floating over the foot of the page; what is
// typed and sent opens the panel with the message already sent, and the
// panel glyph at its end opens the panel as it stands. What their own AI
// is waiting on them for is counted on Luke's face, since the panel's
// bell is out of sight. Its own state, so typing here never redraws the
// section under it.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { ArrowUp, PanelRightOpen } from "lucide-react";
import { LukeMark } from "@/components/ui/LukeMark";
import { iconButtonRound, sendButton } from "@/components/ui/controls";

export function AskLuke({
  busy,
  waiting,
  onOpen,
  onSend,
  className = "",
}: {
  /** Luke is working on something: nothing new is sent until it is done. */
  busy: boolean;
  waiting: number;
  onOpen: () => void;
  onSend: (text: string) => void;
  className?: string;
}) {
  const [text, setText] = useState("");
  const ready = !!text.trim() && !busy;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onSend(text.trim());
        setText("");
      }}
      className={`pop flex h-12 w-full max-w-xl items-center gap-2 rounded-full bg-surface pr-1.5 pl-2 shadow-popover ${className}`}
    >
      <span className="relative flex shrink-0">
        <LukeMark state={busy ? "thinking" : "idle"} />
        {waiting > 0 && (
          <span className="absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-on-primary tabular-nums ring-2 ring-surface">
            {waiting}
          </span>
        )}
      </span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={busy ? "Luke is working…" : "Ask Luke…"}
        aria-label="Ask Luke"
        enterKeyHint="send"
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
      />
      {text.trim() && (
        <button type="submit" disabled={!ready} aria-label="Send to Luke" className={sendButton}>
          <ArrowUp aria-hidden size={16} strokeWidth={2.25} />
        </button>
      )}
      <span aria-hidden className="h-5 w-px shrink-0 bg-line" />
      <button
        type="button"
        onClick={onOpen}
        aria-label={waiting > 0 ? `Luke — ${waiting} waiting for you` : "Luke"}
        aria-expanded={false}
        title="Open Luke's panel"
        className={iconButtonRound}
      >
        <PanelRightOpen aria-hidden size={17} strokeWidth={1.75} />
      </button>
    </form>
  );
}
