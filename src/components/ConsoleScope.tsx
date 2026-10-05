"use client";

// The console's scope bar (0184): whose numbers a report shows. Every
// account, one account (found by its business or its email), or one app
// of it. Written into the address (lib/console-scope.ts), so the sidebar
// keeps it from screen to screen and a refresh or a link shows the same.
//
// Callers: components/PageFrame.tsx, above each screen that narrows.

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { Select, type SelectOption } from "@/components/ui/Select";
import { scopeQuery, useConsoleScope } from "@/lib/console-scope";

/**
 * Every account, as the picker offers them: asked once a visit and shared by
 * every screen, not again on each one.
 * ponytail: the whole list in the browser; a search asked of the server
 * (abo_admin_accounts with a query) once there are thousands of accounts.
 */
let accountList: Promise<SelectOption[]> | null = null;
const allAccounts = () =>
  (accountList ??= Promise.resolve(supabase.rpc("abo_admin_accounts")).then(({ data, error }) => {
    if (error) accountList = null;
    return ((data ?? []) as Array<{ user_id: string; email: string; business_name?: string | null }>).map((a) => ({
      value: a.user_id,
      label: a.business_name ? `${a.business_name} · ${a.email}` : a.email,
    }));
  }));

export function ConsoleScope() {
  const scope = useConsoleScope();
  const router = useRouter();
  const path = usePathname();
  const [accounts, setAccounts] = useState<SelectOption[]>([]);
  const [apps, setApps] = useState<SelectOption[]>([]);

  useEffect(() => {
    void allAccounts().then(setAccounts);
  }, []);
  useEffect(() => {
    if (!scope.account) return setApps([]);
    supabase.rpc("abo_admin_account", { p_user: scope.account }).then(({ data }) =>
      setApps(
        ((data as { projects?: Array<{ id: string; name: string }> } | null)?.projects ?? []).map((p) => ({
          value: p.id,
          label: p.name,
        }))
      )
    );
  }, [scope.account]);

  const go = (account: string | null, app: string | null) => router.replace(`${path}${scopeQuery({ account, app })}`);
  const find = async (q: string) => {
    const w = q.trim().toLowerCase();
    return (w ? accounts.filter((a) => a.label.toLowerCase().includes(w)) : accounts).slice(0, 50);
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-4 pt-4 sm:px-8 sm:pt-6">
      <span className="text-xs font-medium text-fg-muted">Showing</span>
      <div className="w-72 max-w-full">
        <Select
          label="Account"
          value={scope.account ?? ""}
          options={accounts.slice(0, 50)}
          search={find}
          chosenLabel={accounts.find((a) => a.value === scope.account)?.label}
          empty="Every account"
          onChange={(v) => go(v || null, null)}
        />
      </div>
      {scope.account && apps.length > 1 && (
        <div className="w-56 max-w-full">
          <Select
            label="App"
            value={scope.app ?? ""}
            options={apps}
            empty="All their apps"
            onChange={(v) => go(scope.account, v || null)}
          />
        </div>
      )}
    </div>
  );
}
