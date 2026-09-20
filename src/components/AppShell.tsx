"use client";

// ─────────────────────────────────────────────────────────────
// AppShell — the builder for ONE project. All queries run under
// the signed-in owner's RLS. A brand-new project shows a single
// big prompt; the AI's plans apply sequentially in build order.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchRows } from "@/lib/live";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { describePlan } from "@/lib/describe";
import { apiFetch, apiStream, takePendingPrompt } from "@/lib/auth";
import GenericRenderer, { type StatRequest, type StatResult } from "@/components/GenericRenderer";
import ChatPanel, { type ChatMessage, nextChatId } from "@/components/ChatPanel";
import { undoableFrom } from "@/lib/undo";
import { asError, engineError, fixPrompt, type FixAction } from "@/lib/errors";
import VersionHistory from "@/components/VersionHistory";
import AutomationsPanel from "@/components/AutomationsPanel";
import { FormatProvider } from "@/lib/format";
import ProjectSettings from "@/components/ProjectSettings";
import { LinkProvider, type LinkOptions } from "@/components/LinkContext";
import { labelForRow } from "@/lib/links";
import ModuleSettings from "@/components/ModuleSettings";
import NewSection from "@/components/NewSection";
import StoreStrip from "@/components/StoreStrip";
import {
  isStoreTable,
  readStoreRows,
  storeTableSchema,
  type StoreTable,
} from "@/lib/store-read";
import { resizeHandleClass, useResizable } from "@/lib/useResizable";
import type {
  AssistantPlan,
  AssistantReply,
  NextStep,
  ProjectRow,
  ModuleRow,
  RecordRow,
  TurnEvent,
  UiSchema,
  UiSchemaRow,
} from "@/lib/types";
import { TITLE_MAX } from "@/lib/types";

/**
 * Rows are fetched a page at a time. Search, filters and stats run over
 * what's loaded, so the count is also the honest limit of what those
 * numbers describe — the UI says so rather than quietly totalling a
 * subset.
 */
const RECORD_PAGE = 200;

const ICONS: Record<string, string> = {
  "shopping-cart": "🛒",
  package: "📦",
  users: "👥",
  receipt: "🧾",
  calendar: "📅",
  "clipboard-list": "📋",
  "undo-2": "↩️",
  box: "📦",
  heart: "❤️",
  wrench: "🔧",
  globe: "🌐",
  truck: "🚚",
  wallet: "👛",
  target: "🎯",
  table: "📋",
};

function Icon({ name }: { name: string }) {
  return <span className="w-5 text-center text-base">{ICONS[name] ?? "📋"}</span>;
}

/**
 * The columns a section should show, for a section whose rows are the
 * store's. Live from the store table rather than the copy saved when
 * it was created, so adding a column to the importer reaches every
 * section that already exists.
 */
function withStoreColumns(row: UiSchemaRow, sourceTable: string | null | undefined): UiSchemaRow {
  if (!isStoreTable(sourceTable)) return row;
  const sj = row.schema_json as UiSchema & { features?: unknown };
  // Computed columns are the one thing here that is not the store's,
  // and they are kept: nothing stores them, so the import this
  // refreshes from has nothing to overwrite. Taking the store's list
  // wholesale would drop the "Low / OK" column off a stock section
  // the moment it was reloaded, and the filter beside it with it.
  const computed = (sj.columns ?? []).filter((c) => c.compute);
  return {
    ...row,
    schema_json: { ...sj, columns: [...storeTableSchema(sourceTable).columns, ...computed] },
  } as UiSchemaRow;
}

/** What a build did, for whoever has to write it down. */
export type BuildOutcome = {
  applied: Array<Record<string, unknown>>;
  errors: string[];
};

export default function AppShell({
  projectId,
  ownerEmail,
}: {
  projectId: string;
  ownerEmail: string;
}) {
  const router = useRouter();
  // Three states, not two. `undefined` is "not asked yet"; `null` is
  // "asked, and nothing came back". Collapsing them is what let a
  // tampered id render the empty-workspace screen: RLS correctly
  // returned no rows, and the shell read that as a brand-new project
  // and said "Start building".
  const [project, setProject] = useState<ProjectRow | null | undefined>(undefined);
  // Staff are let in by the database, not by this component — but the
  // owner's tools would still render for them and then fail on save.
  // Showing a button that cannot work is its own kind of lying.
  const [userId, setUserId] = useState<string | null>(null);
  // The connected store, so a section pointed at it knows where to read
  // from. Null for a project without one, which is the common case.
  const [store, setStore] = useState<{ id: string; currency: string } | null>(null);
  // A rate, only ever used to annotate. Imported amounts are rendered
  // in the currency Shopify recorded them in; this is the rough second
  // line underneath, for a merchant who thinks in their own money.
  const [fx, setFx] = useState<{ rate: number; as_of: string | null; stale: boolean } | null>(null);
  const storeId = store?.id ?? null;
  const isOwner = !!project && !!userId && project.owner_id === userId;
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [schema, setSchema] = useState<UiSchemaRow | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const [recordTotal, setRecordTotal] = useState(0);
  const [linkOptions, setLinkOptions] = useState<LinkOptions>({});
  const [schemaHistory, setSchemaHistory] = useState<UiSchemaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  // Below lg the three panes become drawers: the phone shows one at a time.
  const [navOpen, setNavOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moduleSettingsFor, setModuleSettingsFor] = useState<ModuleRow | null>(null);
  // Which parents are open. Collapsed by default would hide a section
  // the owner just built, so they start expanded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Which parent a new section should go inside; "" means top level,
  // null means the dialog is closed.
  const [newSectionParent, setNewSectionParent] = useState<string | null | undefined>(undefined);
  // Reordering is dragged within one level only. Moving a section into
  // or out of a group is a different decision, and lives in its settings
  // where the one-level rule can be explained rather than silently
  // enforced mid-drag.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // The middle is where the owner's actual data lives; neither panel
  // may squeeze it below this.
  const MIN_MAIN = 420;
  const navWidthRef = useRef(240);
  const chatWidthRef = useRef(380);

  const nav = useResizable({
    storageKey: "abo_nav_w",
    initial: 240,
    min: 180,
    max: 420,
    edge: "left",
    liveMax: () => window.innerWidth - chatWidthRef.current - MIN_MAIN,
  });
  const chat = useResizable({
    storageKey: "abo_chat_w",
    initial: 380,
    min: 300,
    max: 640,
    edge: "right",
    liveMax: () => window.innerWidth - navWidthRef.current - MIN_MAIN,
  });
  navWidthRef.current = nav.width;
  chatWidthRef.current = chat.width;
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  // What the running turn has done so far, as the server said it.
  // Empty between turns, and while a build is being applied.
  const [chatSteps, setChatSteps] = useState<TurnEvent[]>([]);
  const chatAbort = useRef<AbortController | null>(null);
  // One thread per builder session: the server replays it so the
  // assistant remembers what it already asked.
  const [conversationId, setConversationId] = useState<string | null>(null);
  // The same id, readable the instant it is set.
  //
  // recordOutcome starts a thread when there is none, and two calls in
  // one tick both read the state — which React has not updated yet —
  // so both started one. The request line and the outcome it belongs
  // to ended up in two different threads, and the panel, showing the
  // newest, dropped the request.
  const conversationIdRef = useRef<string | null>(null);
  const rememberConversation = useCallback((id: string | null) => {
    conversationIdRef.current = id;
    setConversationId(id);
  }, []);
  const [threads, setThreads] = useState<Array<{ id: string; title: string | null; updated_at: string }>>([]);
  const [building, setBuilding] = useState(false);

  /**
   * Rebuilds the chat panel from a stored thread. Assistant turns are
   * rendered from their saved payload — the same structure the card was
   * built from originally, so a reloaded blueprint is the real thing and
   * can still be approved.
   */
  const loadThread = useCallback(
    async (id?: string, openLatest = false) => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      // Opening the app used to list the threads and leave the panel
      // empty, on the reasoning that a new visit means a new task. But
      // the last thing in that thread is usually "Built 3 changes" —
      // the receipt for what the assistant just did — and a receipt
      // that disappears on refresh reads as the build not having
      // happened. So the newest thread comes back with it.
      //
      // Without an id and without openLatest this only re-lists the
      // threads: the caller has messages on screen worth keeping.
      const qs = new URLSearchParams({ projectId });
      if (id) qs.set("id", id);
      else if (openLatest) qs.set("latest", "1");
      const res = await fetch(`/api/chat?${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        threads: Array<{ id: string; title: string | null; updated_at: string }>;
        conversationId: string | null;
        messages: Array<{ id: string; role: string; payload: Record<string, unknown> | null }>;
      };
      setThreads(json.threads ?? []);
      // Re-listing only. Replacing the panel here wiped the message the
      // caller had just put on screen — the "couldn't reach the
      // assistant" line vanished the moment it was written.
      if (!id && !openLatest) return;
      rememberConversation(json.conversationId);

      const rebuilt: ChatMessage[] = [];
      for (const m of json.messages ?? []) {
        const p = m.payload as (AssistantReply & { kind?: string; text?: string }) | null;
        if (m.role === "user") {
          rebuilt.push({
            id: m.id,
            role: "user",
            text: p?.text ?? "",
            // Kept across a reload, or the thread would claim they
            // typed it here.
            viaClient: (p as { via?: string } | null)?.via === "client",
          });
          continue;
        }
        if (!p) continue;
        // Stored payloads outlive the shape they were written in — a
        // blueprint saved before plans replaced sections has no plans,
        // and rendering it blanked the whole panel. Anything that no
        // longer matches becomes a plain line of history.
        if (p.type === "clarify" && Array.isArray(p.questions)) {
          rebuilt.push({ id: m.id, role: "assistant", text: p.message, questions: p.questions });
        } else if (p.type === "blueprint" && Array.isArray(p.blueprint?.plans)) {
          rebuilt.push({ id: m.id, role: "assistant", text: p.message, blueprint: p.blueprint });
        } else if (p.type === "plans" && Array.isArray(p.plans)) {
          // A single plan is still actionable; a batch was applied when
          // it was approved, so it is shown as history, not a live card.
          rebuilt.push(
            p.plans.length === 1
              ? { id: m.id, role: "assistant", plan: p.plans[0] }
              : { id: m.id, role: "assistant", text: p.message ?? `${p.plans.length} changes` }
          );
        } else {
          // A build that recorded what it changed can offer to put it
          // back. Read from the stored payload, so the offer survives
          // a reload — which is where it matters, because a change
          // made without anyone watching is one they find later.
          const undoSteps = (p as { undo?: Array<{ what: string }> }).undo ?? [];
          // The follow-ups offered with that build, kept the same way.
          // Only ever shown on the last message of the thread, so a
          // build that has since been put back offers nothing stale.
          const next = ((p as { next?: unknown }).next as NextStep[] | undefined)?.filter(
            (n) => typeof n?.label === "string" && typeof n?.prompt === "string"
          );
          rebuilt.push({
            id: m.id,
            role: "assistant",
            text: (p as { message?: string }).message ?? "(an earlier reply)",
            ...(undoSteps.length
              ? { undo: { messageId: m.id, what: undoSteps.map((u) => u.what) } }
              : {}),
            ...(next?.length ? { next } : {}),
          });
        }
      }
      setChatMessages(rebuilt);
    },
    [projectId]
  );

  useEffect(() => {
    loadThread(undefined, true);
  }, [loadThread]);

  /**
   * Records that a change was applied, in the thread itself.
   *
   * "Building…" and "Built" were client-only messages, so the blueprint
   * stayed the last thing in the conversation and came back offering
   * "Build these 3" after a reload — with everything already built.
   * Writing the outcome puts a row after it, which both collapses the
   * card and leaves an honest record of what happened.
   */
  /**
   * Writes "this was built" into the thread, so it is still there
   * tomorrow.
   *
   * It used to return early when there was no thread, which is exactly
   * the case that matters: a build approved through their own AI, or
   * from a request card, has no conversation behind it. The panel
   * showed a tick that vanished on the next load, and a confirmation
   * that disappears is worse than none — it teaches people not to
   * believe the screen. So a thread is started to hold it.
   */
  const recordOutcome = useCallback(
    async (
      text: string,
      role: "assistant" | "user" = "assistant",
      /** What the build applied, so the message can offer to put it back. */
      applied: unknown[] = [],
      /** What the design offered to do next, kept with the receipt. */
      next?: NextStep[]
    ): Promise<string | null> => {
      let id = conversationIdRef.current ?? conversationId;
      if (!id) {
        const { data: made } = await supabase
          .from("conversations")
          .insert({ project_id: projectId, title: text.replace(/^[^\w]+/, "").slice(0, TITLE_MAX) })
          .select("id")
          .single();
        if (!made) return null;
        id = made.id as string;
        rememberConversation(id);
      }
      const undo = role === "assistant" ? undoableFrom(applied) : [];
      // The id comes back so the bubble already on screen can offer to
      // put it back straight away. Without it the offer only appeared
      // after a reload, which is the one moment they do not need it.
      const { data: written } = await supabase
        .from("messages")
        .insert({
          conversation_id: id,
          role,
          content: text,
          // A reloaded thread reads a user turn out of payload.text and
          // an assistant turn out of payload.message. Writing only the
          // assistant shape put the request line back as an empty blue
          // bubble the next time the panel opened.
          payload:
            role === "user"
              ? { kind: "asked", text, via: "client" }
              : {
                  type: "applied",
                  message: text,
                  ...(undo.length ? { undo } : {}),
                  ...(next?.length ? { next } : {}),
                },
        })
        .select("id")
        .single();
      return (written?.id as string) ?? null;
    },
    [conversationId, projectId, rememberConversation]
  );

  /**
   * Removes a conversation and its messages.
   *
   * Threads pile up — one per thing anybody typed, several of them
   * called "hello" — and there was no way to be rid of one. Deleting
   * the row takes its messages with it; the build history lives on
   * build_requests and is untouched.
   */
  const deleteThread = useCallback(
    async (id: string) => {
      // Confirmed in the picker, a click before this one.
      await supabase.from("conversations").delete().eq("id", id);
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (id === conversationId) {
        // Through the ref too, or the next recordOutcome writes into a
        // thread that has just been deleted.
        rememberConversation(null);
        setChatMessages([]);
      }
    },
    [conversationId, rememberConversation]
  );

  const startNewThread = useCallback(() => {
    rememberConversation(null);
    setChatMessages([]);
  }, [rememberConversation]);

  // ── Data loading (RLS-scoped: only this owner's project) ──
  const loadModules = useCallback(async () => {
    const { data, error } = await supabase
      .from("modules")
      .select("*")
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true });
    if (error) {
      setLoadError(error.message);
      setLoading(false);
      return;
    }
    setLoadError(null);
    setModules(data as ModuleRow[]);
    setLoading(false);
  }, [projectId]);

  const loadModuleData = useCallback(
    async (moduleId: string, limit = RECORD_PAGE) => {
      // The module is fetched rather than looked up in state: a section
      // created a moment ago is selected before the list has reloaded,
      // and a stale closure there means source_table reads as undefined
      // and the section renders as empty.
      const [schemaRes, recordsRes, historyRes, modRes] = await Promise.all([
        supabase
          .from("ui_schemas")
          .select("*")
          .eq("module_id", moduleId)
          .order("version", { ascending: false })
          .limit(1),
        supabase
          .from("records")
          .select("*", { count: "exact" })
          .eq("module_id", moduleId)
          .order("created_at", { ascending: true })
          .limit(limit),
        supabase
          .from("ui_schemas")
          .select("*")
          .eq("module_id", moduleId)
          .order("version", { ascending: false }),
        supabase.from("modules").select("source_table").eq("id", moduleId).maybeSingle(),
      ]);
      if (schemaRes.error || recordsRes.error || historyRes.error) {
        setLoadError(
          schemaRes.error?.message ??
            recordsRes.error?.message ??
            historyRes.error?.message ??
            "Couldn't load this section."
        );
        return;
      }
      setLoadError(null);
      const loadedSchema = (schemaRes.data as UiSchemaRow[])[0] ?? null;
      loadLinkOptions(loadedSchema?.schema_json ?? null);
      // A section pointed at the store shows the store's rows. The
      // records query above still ran and found nothing, which is
      // correct — a store-backed section has no records of its own.
      const sourceTable = modRes.data?.source_table as string | null | undefined;
      // A section over the store does not own its columns — we do. The
      // saved schema is a copy taken the day it was created, so a
      // column added to the importer later never reached it: Category
      // arrived in the data and the section carried on showing four
      // fields. Features stay as saved; those are the merchant's.
      setSchema(loadedSchema ? withStoreColumns(loadedSchema, sourceTable) : null);
      // Kept so read-only and currency follow the section that actually
      // loaded, not whatever the module list happens to hold.
      setLoadedSource(sourceTable ?? null);
      if (isStoreTable(sourceTable) && storeId) {
        try {
          const { rows, total } = await readStoreRows(
            supabase,
            storeId,
            sourceTable as StoreTable,
            limit,
            undefined,
            // Cut the page in the section's own order, or "Customers by
            // total spent" is the top of the first two hundred names.
            loadedSchema?.schema_json?.features?.defaultSort ?? null
          );
          setRecords(rows as unknown as RecordRow[]);
          setRecordTotal(total);
        } catch (e) {
          setLoadError(e instanceof Error ? e.message : "Couldn't read the store.");
        }
      } else {
        setRecords(recordsRes.data as RecordRow[]);
        setRecordTotal(recordsRes.count ?? (recordsRes.data as RecordRow[]).length);
      }
      setSchemaHistory(historyRes.data as UiSchemaRow[]);
    },
    [storeId]
  );

  /**
   * Rows a link column can point at. Fetched per target section, and
   * capped: a picker is only usable up to a few hundred entries anyway,
   * and pulling an entire section to render one dropdown is wasteful.
   *
   * ponytail: fetch-all-and-cap, swap for a typeahead query if a
   * section ever outgrows the cap.
   */
  const loadLinkOptions = useCallback(async (schemaJson: UiSchema | null) => {
    const targets = [
      ...new Set(
        (schemaJson?.columns ?? [])
          .filter((c) => c.type === "link" && c.linkTo)
          .map((c) => c.linkTo as string)
      ),
    ];
    if (targets.length === 0) {
      setLinkOptions({});
      return;
    }
    const next: LinkOptions = {};
    await Promise.all(
      targets.map(async (moduleId) => {
        const [{ data: rows }, { data: schemaRows }] = await Promise.all([
          supabase.from("records").select("*").eq("module_id", moduleId).limit(500),
          supabase
            .from("ui_schemas")
            .select("*")
            .eq("module_id", moduleId)
            .order("version", { ascending: false })
            .limit(1),
        ]);
        const targetSchema = (schemaRows?.[0] as UiSchemaRow | undefined)?.schema_json ?? null;
        next[moduleId] = ((rows ?? []) as RecordRow[]).map((r) => ({
          id: r.id,
          label: labelForRow(r, targetSchema),
        }));
      })
    );
    setLinkOptions(next);
  }, []);

  const loadMoreRecords = useCallback(async () => {
    if (!selectedModuleId) return;
    await loadModuleData(selectedModuleId, records.length + RECORD_PAGE);
  }, [selectedModuleId, records.length, loadModuleData]);

  // Stat cards counted over the whole section, not the page. The
  // function evaluates the same expressions the browser would, over
  // every row, and narrows by the same search and filters.
  const sectionStats = useCallback(
    async (req: StatRequest): Promise<StatResult[]> => {
      if (!selectedModuleId) return [];
      const { data, error } = await supabase.rpc("abo_section_stats", {
        p_module: selectedModuleId,
        p_stats: req.stats,
        p_scope: req.scope,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as StatResult[];
    },
    [selectedModuleId]
  );

  useEffect(() => {
    loadModules();
  }, [loadModules]);

  // Anything built while this screen is open — by their own AI, by a
  // second tab, by a colleague — arrives here. Without it the page
  // keeps showing what it loaded on open, and looks no different from
  // one that is up to date.
  useEffect(() => {
    return watchRows(`project:${projectId}`, [
      { table: "modules", filter: `project_id=eq.${projectId}`, onChange: loadModules },
      // Rows live under the project, so this catches a seed into any
      // section; the reload only touches the one being looked at.
      {
        table: "records",
        filter: `project_id=eq.${projectId}`,
        onChange: () => {
          if (selectedModuleId) loadModuleData(selectedModuleId);
        },
      },
      ...(selectedModuleId
        ? [
            {
              // Columns and features of the open section. ui_schemas
              // has no project_id, so this narrows by module instead.
              table: "ui_schemas",
              filter: `module_id=eq.${selectedModuleId}`,
              onChange: () => loadModuleData(selectedModuleId),
            },
          ]
        : []),
    ]);
  }, [projectId, selectedModuleId, loadModules, loadModuleData]);

  // A Shopify-backed section, when they come back to this tab.
  //
  // Those rows live in products, orders, customers and inventory_levels
  // — tables the watcher above does not cover, and which realtime does
  // not publish. A webhook could land while this screen sat open and
  // the merchant went on reading yesterday's stock.
  //
  // Coming back is the moment that matters: the change was made in
  // Shopify, in another tab, and this is when they turn round to look.
  //
  // ponytail: a section left open in a tab that never loses focus
  // stays as it was. Publish the store tables to realtime if that ever
  // turns out to be how somebody works — it costs an event per webhook
  // row, which on a large catalogue is not free.
  useEffect(() => {
    if (!selectedModuleId || !isStoreTable(loadedSource)) return;
    const refresh = () => {
      if (document.visibilityState === "visible") loadModuleData(selectedModuleId);
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [selectedModuleId, loadedSource, loadModuleData]);

  // Which groups are folded is a per-project preference, so it is kept
  // per project rather than globally.
  const collapseKey = `abo_collapsed_${projectId}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(collapseKey);
      if (raw) setCollapsed(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* blocked storage — everything just starts expanded */
    }
  }, [collapseKey]);

  const toggleCollapsed = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = { ...prev, [id]: !prev[id] };
        try {
          localStorage.setItem(collapseKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [collapseKey]
  );

  // Locale and currency live on the project, so money renders as the
  // owner's country writes it rather than as the code's default.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUserId(data.session?.user.id ?? null));
  }, []);

  // What the shop's money is worth in the merchant's, fetched once the
  // two are known to differ. It no longer converts anything — it feeds
  // the "≈ ₹…" note under each amount, and a missing rate simply means
  // no note.
  //
  // This effect was once silently lost to a bad edit: the state
  // existed, the route existed, and nothing called it, so the feature
  // was dead in a way that still rendered. check-fx asserts the call
  // exists, because arithmetic passing proves nothing about wiring.
  useEffect(() => {
    const from = store?.currency;
    const to = project?.currency;
    // Nothing to annotate means nothing to fetch: no rate is asked for
    // until a merchant has actually chosen a currency of their own.
    if (!from || !to || from === to || project?.currency_set_by_user !== true) {
      setFx(null);
      return;
    }
    let live = true;
    apiFetch(`/api/fx?from=${from}&to=${to}&project=${projectId}`, null, "GET").then(
      ({ ok, data }) => {
        if (!live) return;
        setFx(
          ok && typeof data.rate === "number" && Number.isFinite(data.rate) && data.rate > 0
            ? {
                rate: data.rate,
                as_of: (data.as_of as string | null) ?? null,
                stale: data.stale === true,
              }
            : null
        );
      }
    );
    return () => {
      live = false;
    };
  }, [store?.currency, project?.currency, project?.currency_set_by_user, projectId]);

  useEffect(() => {
    supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .limit(1)
      .then(({ data }) => setProject((data?.[0] as ProjectRow) ?? null));

    // The id to read by, and the currency to render money in: a store
    // selling in USD inside a project set to INR would otherwise print
    // $2,897 as ₹2,897, which looks right and is not.
    supabase
      .from("stores")
      .select("id, currency")
      .eq("project_id", projectId)
      .eq("status", "connected")
      .maybeSingle()
      .then(({ data }) =>
        setStore(data ? { id: data.id as string, currency: data.currency as string } : null)
      );
  }, [projectId]);

  useEffect(() => {
    if (selectedModuleId) {
      loadModuleData(selectedModuleId);
    } else {
      setSchema(null);
      setRecords([]);
      setRecordTotal(0);
      setSchemaHistory([]);
    }
  }, [selectedModuleId, loadModuleData]);

  const topLevel = useMemo(() => modules.filter((m) => !m.parent_id), [modules]);
  const childrenOf = useMemo(() => {
    const map = new Map<string, ModuleRow[]>();
    for (const m of modules) {
      if (!m.parent_id) continue;
      map.set(m.parent_id, [...(map.get(m.parent_id) ?? []), m]);
    }
    return map;
  }, [modules]);

  /**
   * Drops the dragged section into the gap above `beforeId`, taking the
   * midpoint of the two sort_orders around it. Fractional orders mean a
   * reorder touches one row instead of renumbering the list.
   */
  const reorder = useCallback(
    async (draggedId: string, beforeId: string) => {
      const dragged = modules.find((m) => m.id === draggedId);
      const before = modules.find((m) => m.id === beforeId);
      if (!dragged || !before || dragged.id === before.id) return;
      // Same level only; the settings dialog handles re-parenting.
      if ((dragged.parent_id ?? null) !== (before.parent_id ?? null)) return;

      const siblings = modules
        .filter((m) => (m.parent_id ?? null) === (before.parent_id ?? null))
        .sort((a, b) => a.sort_order - b.sort_order);
      const idx = siblings.findIndex((m) => m.id === beforeId);
      const prev = siblings[idx - 1];
      const nextOrder = prev ? (prev.sort_order + before.sort_order) / 2 : before.sort_order - 1;

      setModules((cur) =>
        cur
          .map((m) => (m.id === draggedId ? { ...m, sort_order: nextOrder } : m))
          .sort((a, b) => a.sort_order - b.sort_order)
      );
      const { ok, data } = await apiFetch(
        "/api/modules",
        { id: draggedId, projectId, sort_order: nextOrder },
        "PATCH"
      );
      if (!ok || data.error) {
        setLoadError((data.error as string) ?? "Couldn't move that section.");
        loadModules();
      }
    },
    [modules, projectId, loadModules]
  );

  const selectedModule = useMemo(
    () => modules.find((m) => m.id === selectedModuleId) ?? null,
    [modules, selectedModuleId]
  );

  // ── Chat / build flow ────────────────────────────────────
  // The assistant may answer three ways: with questions, with a
  // blueprint to approve, or with plans to apply. Only the last one
  // ever touches data.
  const runPrompt = useCallback(
    async (text: string, opts?: { silent?: boolean }) => {
      if (!text.trim() || chatBusy || building) return;
      if (!opts?.silent) {
        setChatMessages((prev) => [...prev, { id: nextChatId(), role: "user", text }]);
      }
      setChatBusy(true);
      setChatSteps([]);
      const controller = new AbortController();
      chatAbort.current = controller;

      try {
        const { ok, data } = await apiStream(
          "/api/chat",
          { message: text, projectId, moduleId: selectedModuleId, conversationId },
          controller.signal,
          (step) => setChatSteps((prev) => [...prev, step as TurnEvent])
        );

        if (data.conversationId && data.conversationId !== conversationId) {
          rememberConversation(data.conversationId as string);
          // A brand-new thread needs to appear in the switcher.
          loadThread(data.conversationId as string).catch(() => {});
        }

        if (!ok || data.error) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: nextChatId(),
              role: "system",
              text: `${(data.error as string) ?? "Luke could not be reached."}`,
              error: asError((data.error as string) ?? "Luke could not be reached."),
            },
          ]);
          return;
        }

        const reply = data.reply as AssistantReply | undefined;
        if (!reply) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: nextChatId(),
              role: "system",
              text: (data.hint as string) ?? "Luke's reply failed validation.",
              error: {
                kind: "system",
                what: (data.hint as string) ?? "Luke's reply did not pass the checks.",
                why: "Nothing was changed. Asking again usually works — it is a new answer each time.",
                details: ((data.errors as string[] | undefined) ?? []).slice(0, 6),
              },
            },
          ]);
          return;
        }

        if (reply.type === "clarify") {
          setChatMessages((prev) => [
            ...prev,
            {
              id: nextChatId(),
              role: "assistant",
              text: reply.message,
              questions: reply.questions,
            },
          ]);
          return;
        }

        if (reply.type === "blueprint") {
          setChatMessages((prev) => [
            ...prev,
            {
              id: nextChatId(),
              role: "assistant",
              text: reply.message,
              blueprint: reply.blueprint,
            },
          ]);
          return;
        }

        // A question answered. Nothing to approve, nothing to build —
        // it goes into the thread as what Luke said and stops there.
        if (reply.type === "answer") {
          setChatMessages((prev) => [
            ...prev,
            { id: nextChatId(), role: "assistant", text: reply.message },
          ]);
          return;
        }

        const plans = reply.plans;

        // Every design is approved before it is built, however many
        // plans it happens to contain.
        //
        // This branch used to apply anything with more than one plan
        // straight to the live app, on the reasoning that such a reply
        // could only have come from a blueprint the owner had already
        // agreed to. Nothing checked that. The gate that let the model
        // answer with plans at all only asks whether a blueprint was
        // ever shown in the thread — shown, not accepted — so a later,
        // unrelated request returning two plans changed the app with
        // nobody having said yes to it.
        //
        // A blueprint card already shows several plans and has the
        // button that approves them, so there is nothing to build here
        // beyond handing these plans to it.
        if (plans.length > 1) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: nextChatId(),
              role: "assistant",
              text: (reply.message ?? "").trim() || "Here is what I would change.",
              blueprint: {
                summary: reply.message ?? "",
                plans,
                // The workflow and the unmet list belong to a blueprint
                // the engine wrote. This reply has neither, and the
                // card is honest about showing nothing rather than
                // inventing steps.
                workflow: [],
                next: reply.next,
              },
            },
          ]);
          return;
        }

        setChatMessages((prev) => [
          ...prev,
          { id: nextChatId(), role: "assistant", plan: plans[0] },
        ]);
      } catch (e) {
        const aborted = (e as Error)?.name === "AbortError";
        setChatMessages((prev) => [
          ...prev,
          {
            id: nextChatId(),
            role: "system",
            // A dropped connection used to fail silently: the spinner
            // stopped and nothing appeared.
            text: aborted
              ? "Stopped."
              : `⚠️ Couldn't reach Luke — ${(e as Error)?.message ?? "check your connection"}. Nothing was changed.`,
          },
        ]);
        // The turn may have been saved in the moment between the server
        // writing it and the response arriving. Re-listing the threads
        // means it shows up in the picker instead of vanishing.
        loadThread().catch(() => {});
      } finally {
        chatAbort.current = null;
        setChatBusy(false);
        setChatSteps([]);
      }
    },
    [chatBusy, building, projectId, selectedModuleId, conversationId, loadModules, loadThread]
  );

  // Apply-time validation failures are the assistant's problem, not the
  // owner's: hand the errors straight back so it produces a corrected plan
  // instead of leaving a dead end in the thread.
  const repairFailedApply = useCallback(
    async (plan: AssistantPlan, errors: string[] | undefined) => {
      await loadModules();
      const detail = (errors ?? []).map((e) => `- ${e}`).join("\n");
      setChatMessages((prev) => [
        ...prev,
        {
          id: nextChatId(),
          role: "system",
          text: "That change no longer fit the project — asking Luke to correct it…",
          errors,
        },
      ]);
      await runPrompt(
        `The plan you gave me ("${plan.explanation}") failed when I tried to apply it:\n${detail}\n\nLook at the project's current sections and give me a corrected plan that does the same job.`,
        { silent: true }
      );
    },
    [loadModules, runPrompt]
  );

  /**
   * The one short line that says what a change did.
   *
   * "Built 1 changes" gave the owner a number, and the number is the
   * least interesting part — they wanted to know what happened to
   * their app. describePlan already writes that line for the approval
   * card, from the plan itself rather than from the sentence the model
   * wrote beside it, so the receipt and the card now say the same
   * thing in the same words.
   */
  const planTitle = useCallback(
    (plan: AssistantPlan) =>
      describePlan(
        plan,
        modules,
        // Only for the section on screen: for any other one these are
        // the wrong columns, and the diff would invent fields.
        plan.targetModuleId && plan.targetModuleId === selectedModuleId
          ? (schema?.schema_json?.columns ?? undefined)
          : undefined
      ).title,
    [modules, selectedModuleId, schema]
  );

  const applyPlan = useCallback(
    async (plan: AssistantPlan, planId: string) => {
      const { ok, data } = await apiFetch("/api/apply", { projectId, plans: [plan] });
      if (!ok || !data.applied) {
        setChatMessages((prev) =>
          prev.map((m) => (m.id === planId ? { ...m, plan: undefined, text: "Couldn't apply — retrying." } : m))
        );
        await repairFailedApply(plan, data.errors as string[] | undefined);
        return;
      }
      const result = (data.results as Array<Record<string, unknown>>)?.[0] ?? {};
      let doneText: string;
      switch (plan.changeType) {
        case "NEW_MODULE":
          doneText = `✅ Module "${plan.newModule?.nav_label}" created — it's in your sidebar.`;
          setSelectedModuleId(result.moduleId as string);
          break;
        case "MODULE_DELETE":
          doneText = "🗑️ Module deleted.";
          setSelectedModuleId(null);
          break;
        case "MODULE_UPDATE":
          doneText = "✅ Navigation updated.";
          break;
        case "AUTOMATION_ADD":
          doneText = `⚡ Rule "${result.automationName as string}" is live — it runs on every change from now on.`;
          break;
        case "AUTOMATION_REMOVE":
          doneText = `Rule "${result.automationName as string}" turned off.`;
          break;
        case "RECORD_SEED":
          doneText = `✅ ${result.seeded as number} record(s) added.`;
          break;
        default:
          // Was "Applied as schema v4", which is true and tells a shop
          // owner nothing. This branch is the commonest edit of all —
          // a field added, a column moved.
          doneText = `✅ ${planTitle(plan)}.`;
      }
      setChatMessages((prev) =>
        prev.map((m) => (m.id === planId ? { ...m, plan: undefined, text: doneText } : m))
      );
      // What it applied goes with it. Without this a single-plan reply
      // from Luke — the commonest edit there is — was the one build
      // with no Put it back on it, while the same change through a
      // blueprint or the merchant's own AI had one.
      const writtenId = await recordOutcome(doneText, "assistant", [result]);
      const undo = undoableFrom([result]);
      if (writtenId && undo.length) {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === planId
              ? { ...m, undo: { messageId: writtenId, what: undo.map((u) => u.what) } }
              : m
          )
        );
      }
      loadModules();
      if (selectedModuleId && plan.targetModuleId === selectedModuleId) {
        loadModuleData(selectedModuleId);
      }
    },
    [projectId, loadModules, loadModuleData, selectedModuleId, repairFailedApply, recordOutcome, planTitle]
  );

  // ── The owner's own record writes ────────────────────────
  // Every write goes through the API so the field values are checked
  // against the live schema, and so the database automation triggers
  // fire exactly as they do for any other write.
  const writeRecord = useCallback(
    async (body: Record<string, unknown>) => {
      if (!selectedModuleId) throw new Error("No section selected.");
      const { ok, data } = await apiFetch("/api/records", {
        projectId,
        moduleId: selectedModuleId,
        ...body,
      });
      if (!ok || data.error) throw new Error((data.error as string) ?? "That didn't save.");
      // Automations may have changed other sections too, so reload both.
      await loadModuleData(selectedModuleId);
    },
    [projectId, selectedModuleId, loadModuleData]
  );

  const createRecord = useCallback(
    (data: Record<string, unknown>) => writeRecord({ action: "create", data }),
    [writeRecord]
  );

  const updateRecord = useCallback(
    (recordId: string, data: Record<string, unknown>) =>
      writeRecord({ action: "update", recordId, data }),
    [writeRecord]
  );

  const deleteRecord = useCallback(
    (recordId: string) => writeRecord({ action: "delete", recordId }),
    [writeRecord]
  );

  /**
   * Applies an approved blueprint. The plans came from the card the
   * owner just read, so what runs is exactly what they saw — there is
   * no second model turn that could produce something else.
   */
  /**
   * Applies an approved blueprint and says how it went.
   *
   * It used to answer nothing at all, whatever happened. The caller
   * that builds a request card then marked the request "built" the
   * moment this returned — after a failure just the same — so a build
   * that did not happen vanished from the queue as done. A function
   * that swallows its own outcome makes every caller guess.
   */
  const buildApproved = useCallback(
    async (
      plans: AssistantPlan[],
      requestId?: string,
      requestText?: string,
      /** What the design offered to do next; shown once the build lands. */
      next?: NextStep[]
    ): Promise<BuildOutcome> => {
      if (plans.length === 0 || building) return { applied: [], errors: [] };
      setBuilding(true);
      // What was asked for, said in the thread before what came of it.
      //
      // A design raised by their own Claude has no user turn here —
      // nobody typed anything into this box — so the thread showed a
      // row of green ticks with no question above them. Coming back a
      // day later, "New section: Packing Verification" answered a
      // question the screen had never asked.
      // Shown at once, saved by the server.
      //
      // /api/apply writes both lines into the "Changes from your AI"
      // thread, because a build started from their own Claude — or by
      // auto-build — never passes through this browser at all. Writing
      // them here as well would file the same change twice, and in a
      // different thread.
      const asked = requestText?.trim();
      if (asked) {
        const short = asked.length > 160 ? `${asked.slice(0, 157)}…` : asked;
        setChatMessages((prev) => [
          ...prev,
          { id: nextChatId(), role: "user", text: short, viaClient: true },
        ]);
      }
      setChatMessages((prev) => [
        ...prev,
        {
          id: nextChatId(),
          role: "system",
          text: `🏗️ Building ${plans.length} change${plans.length === 1 ? "" : "s"}…`,
        },
      ]);
      try {
        // requestId, when this came from a card the assistant raised:
        // the endpoint then claims it, applies it and records the
        // outcome as one sequence, the way the MCP path always has.
        const { ok, data } = await apiFetch("/api/apply", { projectId, plans, requestId });
        if (ok && data.applied) {
          const results = data.results as Array<Record<string, unknown>>;
          if (data.partial) {
            const errors = (data.errors as string[] | undefined) ?? [];
            setChatMessages((prev) => [
              ...prev,
              {
                id: nextChatId(),
                role: "system",
                text: `Built ${results.length} of ${plans.length} — the rest did not fit.`,
                error: engineError(
                  `Built ${results.length} of ${plans.length} — the rest did not fit.`,
                  errors,
                  fixPrompt({
                    what: requestText ?? "the rest of this design",
                    tried: plans.slice(results.length),
                    errors,
                    ask: `The first ${results.length} of these are built and must be left alone. Give me a corrected design for only the rest, doing the same job.`,
                  }),
                  "What was built stays. Luke can correct the rest."
                ),
              },
            ]);
          }
          // Plans apply in order, so the ones that landed are the first
          // `results.length` of them — naming all of them after a partial
          // build would claim something that did not happen.
          const titles = plans.slice(0, results.length).map(planTitle);
          const shown = titles.slice(0, 3).join(" · ");
          const rest = titles.length - 3;
          // The follow-ups the design offered are only offered when all
          // of it landed: a suggestion built on a part that did not is
          // a suggestion about something that is not there.
          const offer = !data.partial && next?.length ? next : undefined;
          // With something to offer, the offer is the invitation; the
          // sentence stays for a build that had none.
          const doneText = `✅ ${shown}${rest > 0 ? ` · and ${rest} more` : ""}.${offer ? "" : " Tell me what to change next."}`;
          const bubbleId = nextChatId();
          setChatMessages((prev) => [
            ...prev,
            { id: bubbleId, role: "assistant", text: doneText, ...(offer ? { next: offer } : {}) },
          ]);
          // Only a design of Luke's own belongs in the open thread;
          // one raised by their assistant is recorded by the server,
          // in the thread that collects those.
          if (!requestId) {
            const writtenId = await recordOutcome(doneText, "assistant", results, offer);
            // Put it back needs the row's id, not this session's, so
            // the offer is attached once the row exists.
            const undo = undoableFrom(results);
            if (writtenId && undo.length) {
              setChatMessages((prev) =>
                prev.map((m) =>
                  m.id === bubbleId
                    ? { ...m, undo: { messageId: writtenId, what: undo.map((u) => u.what) } }
                    : m
                )
              );
            }
          }
          await loadModules();
          const first = results.find((r) => r.changeType === "NEW_MODULE");
          if (first?.moduleId) setSelectedModuleId(first.moduleId as string);
          else if (selectedModuleId) await loadModuleData(selectedModuleId);
          return { applied: results, errors: (data.errors as string[]) ?? [] };
        } else {
          const errors = (data.errors as string[] | undefined) ?? [];
          setChatMessages((prev) => [
            ...prev,
            {
              id: nextChatId(),
              role: "system",
              text: "Nothing was built.",
              error: engineError(
                "Nothing was built — the design did not fit.",
                errors,
                fixPrompt({ what: requestText ?? "this design", tried: plans, errors }),
                "Your app is as it was."
              ),
            },
          ]);
        }
        return {
          applied: [],
          errors: (data.errors as string[]) ?? [
            data.already ? "Somebody is already building this." : "The build did not run.",
          ],
        };
      } finally {
        setBuilding(false);
      }
    },
    [building, projectId, loadModules, loadModuleData, selectedModuleId, recordOutcome, planTitle]
  );

  /**
   * Runs a way out of an error. Only the ones that need the shell —
   * Luke, a retry; a scan bar's own fixes never leave the scan bar.
   *
   * Luke's answer is a design, and a design waits for a yes. A "fix"
   * that applied itself would be an unreviewed change to the app,
   * which is the one thing every error here is not allowed to become.
   */
  const fixError = useCallback(
    async (action: FixAction) => {
      if (action.type === "ask_luke") {
        await loadModules();
        setChatMessages((prev) => [
          ...prev,
          { id: nextChatId(), role: "system", text: "Asking Luke to correct it…" },
        ]);
        await runPrompt(action.prompt, { silent: true });
      } else if (action.type === "retry" && selectedModuleId) {
        await loadModuleData(selectedModuleId);
      }
    },
    [loadModules, runPrompt, selectedModuleId, loadModuleData]
  );

  /**
   * Puts one build's changes back and shows the result in the thread.
   *
   * Here rather than in the panel because the section on screen has to
   * be reloaded afterwards — a schema restored under a page still
   * showing the old one is the same silence this was built to end.
   */
  const undoBuild = useCallback(
    async (messageId: string) => {
      const { ok, data } = await apiFetch("/api/undo", { projectId, messageId });
      const line = (data.message as string) ?? (data.error as string) ?? "Nothing was put back.";
      setChatMessages((prev) => [
        ...prev,
        { id: nextChatId(), role: ok ? "assistant" : "system", text: line },
      ]);
      await loadModules();
      if (selectedModuleId) await loadModuleData(selectedModuleId);
      return ok ? { message: line } : null;
    },
    [projectId, loadModules, loadModuleData, selectedModuleId]
  );

  const discardPlan = useCallback(
    (planId: string) => {
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === planId ? { ...m, plan: undefined, text: "Discarded — nothing was changed." } : m
        )
      );
      // Written down, not only crossed out on screen. A discard that
      // lived in session state alone came back as a live card on the
      // next reload, offering to build the thing they had just said no
      // to. The row after it is what retires the card.
      recordOutcome("Discarded — nothing was changed.");
    },
    [recordOutcome]
  );

  // ── First-run: consume the pending prompt from landing/signup ──
  const [bootstrapped, setBootstrapped] = useState(false);
  useEffect(() => {
    if (bootstrapped || loading) return;
    setBootstrapped(true);
    const pending = takePendingPrompt() ?? sessionStorage.getItem("abo_build_prompt");
    if (pending) {
      sessionStorage.removeItem("abo_build_prompt");
      setChatMessages((prev) => [
        ...prev,
        { id: nextChatId(), role: "user", text: pending },
      ]);
      runPrompt(pending, { silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapped, loading]);

  const isEmpty = !loading && modules.length === 0;
  const storeBacked = isStoreTable(loadedSource);

  /**
   * How money in the selected section should read.
   *
   * Decided once and used twice: the section itself, and the preview
   * Luke shows inside the chat — which renders the SAME records. A
   * store-backed section defaults to the shop's currency; an imported
   * order can override it with the currency stored on that order.
   */
  const sectionMoneyCurrency = storeBacked && store ? store.currency : project?.currency;
  // Offered only where it can be true: a store-backed section, a rate
  // on hand, and the shop's currency being the one the rate is from.
  const sectionApprox =
    storeBacked &&
    store &&
    fx &&
    // Only for a merchant who went and picked a currency. Everyone
    // else is holding the INR default they were never asked about,
    // and showing them a rupee estimate of their dollar shop is us
    // answering a question nobody put.
    project?.currency_set_by_user === true &&
    store.currency !== project?.currency
      ? { rate: fx.rate, from: store.currency, asOf: fx.as_of }
      : null;
  const recordedCurrencies =
    loadedSource === "orders"
      ? [
          ...new Set(
            records
              .map((r) => r.data?.currency)
              .filter((v): v is string => typeof v === "string" && v.length > 0)
          ),
        ].sort()
      : [];
  const hasMoneyColumns = schema?.schema_json.columns.some((c) => c.type === "currency") ?? false;

  // Nothing came back for this id, so there is nothing here for them.
  //
  // One screen for two different facts — the project does not exist,
  // and the project is somebody else's — because telling them apart is
  // how an outsider learns which ids are real. They already cannot read
  // a row either way; this stops the SCREEN from saying more than the
  // database does.
  if (project === null) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-950 px-6">
        <div className="max-w-sm text-center">
          <h1 className="font-display text-lg font-semibold text-slate-200">
            This app isn&rsquo;t available
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            It may have been deleted, or it belongs to someone who hasn&rsquo;t shared it with you.
          </p>
          <button
            onClick={() => router.replace("/dashboard")}
            className="mt-5 rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-white"
          >
            Back to your apps
          </button>
        </div>
      </div>
    );
  }

  return (
    <FormatProvider locale={project?.locale} currency={project?.currency}>
    <LinkProvider options={linkOptions}>
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Backdrop for whichever drawer is open on a small screen. */}
      {(navOpen || chatOpen) && (
        <div
          onClick={() => {
            setNavOpen(false);
            setChatOpen(false);
          }}
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
        />
      )}

      {/* ── Sidebar ── */}
      <aside
        style={{ ["--nav-w" as string]: `${nav.width}px` }}
        className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col overflow-hidden bg-slate-900 text-slate-300 lg:static lg:w-[var(--nav-w)] lg:translate-x-0 ${
          nav.dragging ? "" : "transition-transform duration-200"
        } ${navOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center gap-2.5 px-5 py-5">
          <button
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-2.5 text-left"
            title="Back to dashboard"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 text-sm font-bold text-white">
              A
            </div>
            <div className="min-w-0">
              <div className="font-display truncate text-sm font-semibold tracking-tight text-white">
                {project?.name ?? "Warmluke"}
              </div>
              <div className="max-w-[8rem] truncate text-[11px] text-slate-500">{ownerEmail}</div>
            </div>
          </button>
          {project && isOwner && (
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Project settings"
              title="Rename, currency, delete"
              className="ml-auto rounded-lg px-2 py-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              ⚙
            </button>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-2 thin-scroll-dark">
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
              Sections
            </span>
            {isOwner && (
            <button
              onClick={() => setNewSectionParent("")}
              aria-label="New section"
              title="New section"
              className="rounded px-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              +
            </button>
            )}
          </div>
          {loading && <div className="px-2 py-1 text-sm text-slate-500">Loading…</div>}
          {topLevel.map((m) => {
            const kids = childrenOf.get(m.id) ?? [];
            const isOpen = !collapsed[m.id];
            return (
              <div key={m.id}>
                <div
                  draggable
                  onDragStart={() => setDragId(m.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropTarget(null);
                  }}
                  onDragOver={(e) => {
                    const from = modules.find((x) => x.id === dragId);
                    if (!from || from.parent_id) return; // top level only
                    e.preventDefault();
                    setDropTarget(m.id);
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === m.id ? null : t))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId) reorder(dragId, m.id);
                    setDragId(null);
                    setDropTarget(null);
                  }}
                  className={`group mb-1 flex w-full items-center gap-1 rounded-lg pr-1 transition-colors ${
                    dropTarget === m.id ? "border-t-2 border-blue-500" : ""
                  } ${dragId === m.id ? "opacity-40" : ""} ${
                    m.id === selectedModuleId
                      ? "bg-slate-800 text-white shadow-sm"
                      : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
                  }`}
                >
                  {kids.length > 0 ? (
                    <button
                      onClick={() => toggleCollapsed(m.id)}
                      aria-label={isOpen ? `Collapse ${m.nav_label}` : `Expand ${m.nav_label}`}
                      className="py-2 pl-2 text-[10px] text-slate-500 transition-colors hover:text-slate-200"
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                  ) : (
                    <span className="w-[18px]" />
                  )}
                  <button
                    onClick={() => {
                      setSelectedModuleId(m.id);
                      setNavOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 py-2 text-left text-sm"
                  >
                    <Icon name={m.icon} />
                    <span className="truncate">{m.nav_label}</span>
                  </button>
                  {isOwner && (
                  <>
                  <button
                    onClick={() => setNewSectionParent(m.id)}
                    aria-label={`Add a section inside ${m.nav_label}`}
                    title="Add a section inside this one"
                    className="rounded px-1.5 py-1 text-slate-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-slate-700 hover:text-slate-200 focus:opacity-100"
                  >
                    +
                  </button>
                  <button
                    onClick={() => setModuleSettingsFor(m)}
                    aria-label={`Settings for ${m.nav_label}`}
                    title="Rename, move, delete"
                    className="rounded px-1.5 py-1 text-slate-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-slate-700 hover:text-slate-200 focus:opacity-100"
                  >
                    ⋯
                  </button>
                  </>
                  )}
                </div>

                {isOpen &&
                  kids.map((k) => (
                    <div
                      key={k.id}
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDragId(k.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropTarget(null);
                      }}
                      onDragOver={(e) => {
                        const from = modules.find((x) => x.id === dragId);
                        // Siblings under the same parent only.
                        if (!from || from.parent_id !== k.parent_id) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setDropTarget(k.id);
                      }}
                      onDragLeave={() => setDropTarget((t) => (t === k.id ? null : t))}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (dragId) reorder(dragId, k.id);
                        setDragId(null);
                        setDropTarget(null);
                      }}
                      className={`group mb-1 ml-4 flex items-center gap-1 rounded-lg border-l border-slate-800 pr-1 pl-1 transition-colors ${
                        dropTarget === k.id ? "border-t-2 border-t-blue-500" : ""
                      } ${dragId === k.id ? "opacity-40" : ""} ${
                        k.id === selectedModuleId
                          ? "bg-slate-800 text-white shadow-sm"
                          : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
                      }`}
                    >
                      <button
                        onClick={() => {
                          setSelectedModuleId(k.id);
                          setNavOpen(false);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-1.5 text-left text-[13px]"
                      >
                        <Icon name={k.icon} />
                        <span className="truncate">{k.nav_label}</span>
                      </button>
                      <button
                        onClick={() => setModuleSettingsFor(k)}
                        aria-label={`Settings for ${k.nav_label}`}
                        title="Rename, move, delete"
                        className="rounded px-1.5 py-1 text-slate-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-slate-700 hover:text-slate-200 focus:opacity-100"
                      >
                        ⋯
                      </button>
                    </div>
                  ))}
              </div>
            );
          })}
          {!loading && modules.length === 0 && (
            <div className="px-2 py-1 text-sm leading-relaxed text-slate-500">
              No sections yet — describe your app to Luke to build them.
            </div>
          )}
        </nav>

        <div className="border-t border-slate-800 px-5 py-3 text-[11px] leading-relaxed text-slate-500">
          {isOwner
            ? "Everything here was generated from your prompts — nothing hardcoded."
            : `Shared with you by the owner of ${project?.name ?? "this app"}.`}
        </div>

        <div
          onPointerDown={nav.onPointerDown}
          onDoubleClick={nav.reset}
          title="Drag to resize · double-click to reset"
          className={resizeHandleClass("left", nav.dragging)}
        />
      </aside>

      {/* ── Main area ── */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-3 sm:px-6 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              onClick={() => setNavOpen(true)}
              aria-label="Open sections"
              className="-ml-1 rounded-lg px-2 py-1.5 text-slate-500 transition-colors hover:bg-slate-100 lg:hidden"
            >
              ☰
            </button>
            <h1 className="font-display truncate text-base font-semibold tracking-tight sm:text-lg">
              {selectedModule?.nav_label ?? project?.name ?? "Your app"}
            </h1>
            {schema && (
              <span className="hidden shrink-0 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500 sm:inline">
                schema v{schema.version}
                {schema.created_by === "ai" && " · AI"}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {isOwner && (
            <button
              onClick={() => setRulesOpen(true)}
              title="Rules"
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 sm:px-3"
            >
              ⚡<span className="ml-1 hidden sm:inline">Rules</span>
            </button>
            )}
          {selectedModule && isOwner && (
            <button
              onClick={() => setHistoryOpen(true)}
              title="Version history"
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 sm:px-3"
            >
              🕘<span className="ml-1 hidden sm:inline">History</span>
            </button>
          )}
            {isOwner && (
            <button
              onClick={() => setChatOpen(true)}
              className="rounded-lg bg-gradient-to-br from-violet-500 to-blue-500 px-2.5 py-1.5 text-sm font-medium text-white shadow-sm lg:hidden"
            >
              ✦<span className="ml-1 hidden sm:inline">Luke</span>
            </button>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-3 thin-scroll sm:p-6">
          {loadError && (
            <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              Couldn&rsquo;t load your data: {loadError}
            </div>
          )}
          {/* Above the builder, because a merchant who just connected a
              store is asking about the store, not about building. */}
          <StoreStrip
            projectId={projectId}
            existingSources={modules
              .map((m) => m.source_table)
              .filter((x): x is string => !!x)}
            onSectionsCreated={loadModules}
          />

          {isEmpty ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="font-display text-3xl font-bold tracking-tight text-slate-800">
                Start building
              </div>
              <p className="mt-3 max-w-md text-sm text-slate-500">
                Describe the problem you&rsquo;re stuck on — not the software. I&rsquo;ll
                ask how you work, propose a design, and build it once you approve.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {[
                  "I lose track of which jobs are done and which are still pending",
                  "I need to know what stock I have before I promise a delivery date",
                  "My team keeps double-booking the same slot",
                ].map((s) => (
                  <button
                    key={s}
                    onClick={() => runPrompt(s)}
                    className="rounded-full border border-slate-200 px-3.5 py-1.5 text-xs text-slate-500 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : schema ? (
            // Shopify money stays in the currency Shopify recorded.
            // The provider supplies the normal shop currency; an order
            // whose own currency differs overrides it at the cell.
            <FormatProvider
              locale={project?.locale}
              currency={sectionMoneyCurrency}
              approxRate={sectionApprox}
            >
            {storeBacked && store && project?.currency && hasMoneyColumns &&
              (store.currency !== project.currency || recordedCurrencies.length > 1) && (
              <div className="mb-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
                {recordedCurrencies.length > 1 ? (
                  <>
                    Shopify recorded these orders in{" "}
                    <span className="text-slate-200">{recordedCurrencies.join(" and ")}</span>.
                    {" "}Each amount is shown in its recorded currency; currency totals are not
                    combined. Your project default is {project.currency} and applies only to sections
                    you create here.
                  </>
                ) : (
                  <>
                    Shopify amounts are shown in{" "}
                    <span className="text-slate-200">
                      {recordedCurrencies[0] ?? store.currency}
                    </span>
                    , their recorded shop currency — the figure you can look up in Shopify.
                    {sectionApprox ? (
                      <>
                        {" "}The smaller {project.currency} line under each one is a rough
                        conversion at today&rsquo;s rate
                        {fx?.as_of ? ` (${fx.as_of})` : ""}, applied to every order whatever day it
                        was placed. Use it to get a feel for the size, never to reconcile: it will
                        not match a Shopify payout, and totals built from it were never true on any
                        single day.
                      </>
                    ) : null}
                    {" "}Your project default is {project.currency} and applies to sections you
                    create here.
                  </>
                )}
              </div>
            )}
            <GenericRenderer
              schema={schema.schema_json}
              records={records}
              totalRecords={recordTotal}
              onLoadMore={records.length < recordTotal ? loadMoreRecords : undefined}
              onStats={sectionStats}
              {...(storeBacked
                ? // No write handlers at all, which is how the renderer
                  // already expresses read-only. The import owns these
                  // rows; an edit here would vanish on the next run.
                  {}
                : { onCreate: createRecord, onUpdate: updateRecord, onDelete: deleteRecord })}
            />
            </FormatProvider>
          ) : loading ? (
            <div className="text-sm text-slate-400">Loading module…</div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="font-display text-xl font-semibold text-slate-700">
                {selectedModule?.nav_label ?? "No section selected"}
              </div>
              <p className="mt-2 text-sm text-slate-500">
                {isOwner
                  ? "Pick a section from the menu, or ask Luke to build one."
                  : "Pick a section from the menu."}
              </p>
            </div>
          )}
        </div>
      </main>

      {/* ── Assistant + history ── */}
      {isOwner && (
      <FormatProvider
        locale={project?.locale}
        currency={sectionMoneyCurrency}
        approxRate={sectionApprox}
      >
      <ChatPanel
        projectId={projectId}
        autoBuild={project?.auto_build === true}
        onUndo={isOwner ? undoBuild : undefined}
        onFix={fixError}
        width={chat.width}
        dragging={chat.dragging}
        onResizeStart={chat.onPointerDown}
        onResizeReset={chat.reset}
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        modules={modules}
        selectedModuleId={selectedModuleId}
        currentSchema={schema?.schema_json ?? null}
        records={records}
        messages={chatMessages}
        busy={chatBusy || building}
        steps={chatSteps}
        canStop={chatBusy}
        threads={threads}
        conversationId={conversationId}
        onNewThread={startNewThread}
        onStop={() => chatAbort.current?.abort()}
        onPickThread={loadThread}
        onDeleteThread={deleteThread}
        onSend={runPrompt}
        onApply={applyPlan}
        onBuild={buildApproved}
        onDiscard={discardPlan}
      />
      </FormatProvider>
      )}
      {newSectionParent !== undefined && (
        <NewSection
          projectId={projectId}
          modules={modules}
          initialParentId={newSectionParent || null}
          onCreated={(m) => {
            setModules((prev) => [...prev, m]);
            setSelectedModuleId(m.id);
          }}
          onClose={() => setNewSectionParent(undefined)}
        />
      )}
      {moduleSettingsFor && (
        <ModuleSettings
          module={moduleSettingsFor}
          modules={modules}
          projectId={projectId}
          onSaved={(updated) => {
            setModules((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
          }}
          onDeleted={(id) => {
            setModules((prev) => prev.filter((m) => m.id !== id && m.parent_id !== id));
            if (selectedModuleId === id) setSelectedModuleId(null);
            loadModules();
          }}
          onClose={() => setModuleSettingsFor(null)}
        />
      )}
      {settingsOpen && project && (
        <ProjectSettings
          project={project}
          onSaved={setProject}
          onDeleted={() => router.replace("/dashboard")}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {rulesOpen && (
        <AutomationsPanel
          projectId={projectId}
          modules={modules}
          onFix={fixError}
          onClose={() => {
            setRulesOpen(false);
            // A rule may have been switched off; reflect its effects.
            if (selectedModuleId) loadModuleData(selectedModuleId);
          }}
        />
      )}
      {historyOpen && selectedModule && (
        <VersionHistory
          versions={schemaHistory}
          onRollback={(moduleId) => {
            loadModuleData(moduleId);
            loadModules();
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
    </LinkProvider>
    </FormatProvider>
  );
}
