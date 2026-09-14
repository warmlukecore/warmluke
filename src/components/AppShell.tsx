"use client";

// ─────────────────────────────────────────────────────────────
// AppShell — the builder for ONE project. All queries run under
// the signed-in owner's RLS. A brand-new project shows a single
// big prompt; the AI's plans apply sequentially in build order.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { apiFetch, takePendingPrompt } from "@/lib/auth";
import GenericRenderer from "@/components/GenericRenderer";
import ChatPanel, { type ChatMessage, nextChatId } from "@/components/ChatPanel";
import VersionHistory from "@/components/VersionHistory";
import AutomationsPanel from "@/components/AutomationsPanel";
import { FormatProvider } from "@/lib/format";
import ProjectSettings from "@/components/ProjectSettings";
import { LinkProvider, type LinkOptions } from "@/components/LinkContext";
import { labelForRow } from "@/lib/links";
import ModuleSettings from "@/components/ModuleSettings";
import NewSection from "@/components/NewSection";
import StoreStrip from "@/components/StoreStrip";
import { isStoreTable, readStoreRows, type StoreTable } from "@/lib/store-read";
import { resizeHandleClass, useResizable } from "@/lib/useResizable";
import type {
  AssistantPlan,
  AssistantReply,
  ProjectRow,
  ModuleRow,
  RecordRow,
  UiSchema,
  UiSchemaRow,
} from "@/lib/types";

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

export default function AppShell({
  projectId,
  ownerEmail,
}: {
  projectId: string;
  ownerEmail: string;
}) {
  const router = useRouter();
  const [project, setProject] = useState<ProjectRow | null>(null);
  // Staff are let in by the database, not by this component — but the
  // owner's tools would still render for them and then fail on save.
  // Showing a button that cannot work is its own kind of lying.
  const [userId, setUserId] = useState<string | null>(null);
  // The connected store, so a section pointed at it knows where to read
  // from. Null for a project without one, which is the common case.
  const [storeId, setStoreId] = useState<string | null>(null);
  const isOwner = !!project && !!userId && project.owner_id === userId;
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [schema, setSchema] = useState<UiSchemaRow | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
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
  const chatAbort = useRef<AbortController | null>(null);
  // One thread per builder session: the server replays it so the
  // assistant remembers what it already asked.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Array<{ id: string; title: string | null; updated_at: string }>>([]);
  const [building, setBuilding] = useState(false);

  /**
   * Rebuilds the chat panel from a stored thread. Assistant turns are
   * rendered from their saved payload — the same structure the card was
   * built from originally, so a reloaded blueprint is the real thing and
   * can still be approved.
   */
  const loadThread = useCallback(
    async (id?: string) => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      // No id = list the threads and leave the panel empty. Opening the
      // app usually means a new task, and dropping someone into an old
      // conversation about sections that may not exist any more reads as
      // a bug. The picker is one click away.
      const qs = new URLSearchParams({ projectId });
      if (id) qs.set("id", id);
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
      setConversationId(json.conversationId);

      const rebuilt: ChatMessage[] = [];
      for (const m of json.messages ?? []) {
        const p = m.payload as (AssistantReply & { kind?: string; text?: string }) | null;
        if (m.role === "user") {
          rebuilt.push({ id: m.id, role: "user", text: p?.text ?? "" });
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
          rebuilt.push({
            id: m.id,
            role: "assistant",
            text: (p as { message?: string }).message ?? "(an earlier reply)",
          });
        }
      }
      setChatMessages(rebuilt);
    },
    [projectId]
  );

  useEffect(() => {
    loadThread();
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
  const recordOutcome = useCallback(
    async (text: string) => {
      if (!conversationId) return;
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: text,
        payload: { type: "applied", message: text },
      });
    },
    [conversationId]
  );

  const startNewThread = useCallback(() => {
    setConversationId(null);
    setChatMessages([]);
  }, []);

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
      const [schemaRes, recordsRes, historyRes] = await Promise.all([
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
      setSchema(loadedSchema);
      loadLinkOptions(loadedSchema?.schema_json ?? null);
      // A section pointed at the store shows the store's rows. The
      // records query above still ran and found nothing, which is
      // correct — a store-backed section has no records of its own.
      const mod = modules.find((m) => m.id === moduleId);
      if (isStoreTable(mod?.source_table) && storeId) {
        try {
          const { rows, total } = await readStoreRows(
            supabase,
            storeId,
            mod!.source_table as StoreTable,
            limit
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
    [modules, storeId]
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

  useEffect(() => {
    loadModules();
  }, [loadModules]);

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

  useEffect(() => {
    supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .limit(1)
      .then(({ data }) => setProject((data?.[0] as ProjectRow) ?? null));

    // Only the id: everything a store-backed section needs to read is
    // keyed by it, and the strip already shows the rest.
    supabase
      .from("stores")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "connected")
      .maybeSingle()
      .then(({ data }) => setStoreId((data?.id as string) ?? null));
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
      const controller = new AbortController();
      chatAbort.current = controller;

      try {
        const { ok, data } = await apiFetch(
          "/api/chat",
          { message: text, projectId, moduleId: selectedModuleId, conversationId },
          "POST",
          controller.signal
        );

        if (data.conversationId && data.conversationId !== conversationId) {
          setConversationId(data.conversationId as string);
          // A brand-new thread needs to appear in the switcher.
          loadThread(data.conversationId as string).catch(() => {});
        }

        if (!ok || data.error) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: nextChatId(),
              role: "system",
              text: `⚠️ ${(data.error as string) ?? "The assistant could not be reached."}`,
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
              text: (data.hint as string) ?? "The assistant's reply failed validation.",
              errors: data.errors as string[] | undefined,
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

        const plans = reply.plans;

        // Multiple plans: the owner already approved the blueprint these
        // came from, so apply them in build order. A single plan is an
        // ad-hoc edit and still gets its own preview card.
        if (plans.length > 1) {
          setBuilding(true);
          setChatMessages((prev) => [
            ...prev,
            {
              id: nextChatId(),
              role: "system",
              text: `🏗️ Building ${plans.length} changes… applying in order.`,
            },
          ]);
          const { ok: applyOk, data: applyData } = await apiFetch("/api/apply", {
            projectId,
            plans,
          });
          setBuilding(false);

          if (applyOk && applyData.applied) {
            const created = (applyData.results as Array<Record<string, unknown>>)
              .filter((r) => r.changeType === "NEW_MODULE")
              .map((r) => r.navLabel as string);
            setChatMessages((prev) => [
              ...prev,
              {
                id: nextChatId(),
                role: "assistant",
                plan: plans[0],
                text: `✅ Built: ${created.join(", ") || `${plans.length} changes`}. Open a section on the left — then just tell me what to change.`,
              },
            ]);
            await loadModules();
            // Auto-select the first created module.
            const firstModule = (applyData.results as Array<Record<string, unknown>>).find(
              (r) => r.changeType === "NEW_MODULE"
            );
            if (firstModule?.moduleId) setSelectedModuleId(firstModule.moduleId as string);
          } else {
            setChatMessages((prev) => [
              ...prev,
              {
                id: nextChatId(),
                role: "system",
                text: "⚠️ The build hit a validation error partway — nothing more was applied.",
                errors: applyData.errors as string[] | undefined,
              },
            ]);
          }
          return;
        }

        // Single plan → preview card.
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
              : `⚠️ Couldn't reach the assistant — ${(e as Error)?.message ?? "check your connection"}. Nothing was changed.`,
          },
        ]);
        // The turn may have been saved in the moment between the server
        // writing it and the response arriving. Re-listing the threads
        // means it shows up in the picker instead of vanishing.
        loadThread().catch(() => {});
      } finally {
        chatAbort.current = null;
        setChatBusy(false);
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
          text: "That change no longer fit the project — asking the assistant to correct it…",
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
          doneText = `✅ Applied as schema v${result.version as number}.`;
      }
      setChatMessages((prev) =>
        prev.map((m) => (m.id === planId ? { ...m, plan: undefined, text: doneText } : m))
      );
      recordOutcome(doneText);
      loadModules();
      if (selectedModuleId && plan.targetModuleId === selectedModuleId) {
        loadModuleData(selectedModuleId);
      }
    },
    [projectId, loadModules, loadModuleData, selectedModuleId, repairFailedApply, recordOutcome]
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
  const buildApproved = useCallback(
    async (plans: AssistantPlan[]) => {
      if (plans.length === 0 || building) return;
      setBuilding(true);
      setChatMessages((prev) => [
        ...prev,
        {
          id: nextChatId(),
          role: "system",
          text: `🏗️ Building ${plans.length} change${plans.length === 1 ? "" : "s"}…`,
        },
      ]);
      try {
        const { ok, data } = await apiFetch("/api/apply", { projectId, plans });
        if (ok && data.applied) {
          const results = data.results as Array<Record<string, unknown>>;
          if (data.partial) {
            setChatMessages((prev) => [
              ...prev,
              {
                id: nextChatId(),
                role: "system",
                text: `⚠️ Built ${results.length} of ${plans.length} — the rest stopped on an error.`,
                errors: data.errors as string[] | undefined,
              },
            ]);
          }
          const created = results
            .filter((r) => r.changeType === "NEW_MODULE")
            .map((r) => r.navLabel as string);
          const doneText = `✅ Built${created.length ? `: ${created.join(", ")}` : ` ${results.length} changes`}. Tell me what to change next.`;
          setChatMessages((prev) => [
            ...prev,
            { id: nextChatId(), role: "assistant", text: doneText },
          ]);
          await recordOutcome(doneText);
          await loadModules();
          const first = results.find((r) => r.changeType === "NEW_MODULE");
          if (first?.moduleId) setSelectedModuleId(first.moduleId as string);
          else if (selectedModuleId) await loadModuleData(selectedModuleId);
        } else {
          setChatMessages((prev) => [
            ...prev,
            {
              id: nextChatId(),
              role: "system",
              text: "⚠️ The build stopped partway — nothing further was applied.",
              errors: data.errors as string[] | undefined,
            },
          ]);
        }
      } finally {
        setBuilding(false);
      }
    },
    [building, projectId, loadModules, loadModuleData, selectedModuleId, recordOutcome]
  );

  const discardPlan = useCallback((planId: string) => {
    setChatMessages((prev) =>
      prev.map((m) =>
        m.id === planId ? { ...m, plan: undefined, text: "Discarded — nothing was changed." } : m
      )
    );
  }, []);

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
  const storeBacked = isStoreTable(selectedModule?.source_table);

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
              No sections yet — describe your app to the assistant to build them.
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
              ✦<span className="ml-1 hidden sm:inline">Assistant</span>
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
          <StoreStrip projectId={projectId} />

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
            <GenericRenderer
              schema={schema.schema_json}
              records={records}
              totalRecords={recordTotal}
              onLoadMore={records.length < recordTotal ? loadMoreRecords : undefined}
              {...(storeBacked
                ? // No write handlers at all, which is how the renderer
                  // already expresses read-only. The import owns these
                  // rows; an edit here would vanish on the next run.
                  {}
                : { onCreate: createRecord, onUpdate: updateRecord, onDelete: deleteRecord })}
            />
          ) : loading ? (
            <div className="text-sm text-slate-400">Loading module…</div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="font-display text-xl font-semibold text-slate-700">
                {selectedModule?.nav_label ?? "No section selected"}
              </div>
              <p className="mt-2 text-sm text-slate-500">
                {isOwner
                  ? "Pick a section from the menu, or ask the assistant to build one."
                  : "Pick a section from the menu."}
              </p>
            </div>
          )}
        </div>
      </main>

      {/* ── Assistant + history ── */}
      {isOwner && (
      <ChatPanel
        projectId={projectId}
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
        canStop={chatBusy}
        threads={threads}
        conversationId={conversationId}
        onNewThread={startNewThread}
        onStop={() => chatAbort.current?.abort()}
        onPickThread={loadThread}
        onSend={runPrompt}
        onApply={applyPlan}
        onBuild={buildApproved}
        onDiscard={discardPlan}
      />
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
