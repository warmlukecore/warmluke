"use client";

// Luke test (0202, 10 Oct) — TEMPORARY: goes once the first meeting is
// tested, with the migration's column and functions.
//
// For an account an administrator let in (the console's "Luke test"):
// opening it starts their first meeting over and opens their app, where
// Luke speaks first, full screen, as a new owner meets him. The database
// decides who may; this page only asks.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CenteredCard } from "@/components/CenteredCard";
import { requireUser } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";

export default function LukeConvo() {
  const router = useRouter();
  const started = useRef(false);
  const [said, setSaid] = useState("Setting up a fresh first meeting with Luke…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      // A one-time link minted from a terminal (#token_hash=…), for a local
      // server: its sign-in can't pass production's CAPTCHA, the link needs none.
      const once = new URLSearchParams(window.location.hash.slice(1)).get("token_hash");
      if (once) {
        window.history.replaceState(null, "", "/luke-convo");
        const { error } = await supabase.auth.verifyOtp({ token_hash: once, type: "magiclink" });
        if (error) {
          setSaid("That sign-in link is used or expired. Ask for a new one.");
          return;
        }
      }
      if (!(await requireUser(router))) return;
      const { data, error } = await supabase.rpc("abo_meet_luke_again");
      if (error || typeof data !== "string") {
        setSaid(error?.message ?? "Couldn’t start the meeting again.");
        return;
      }
      router.replace(`/app/${data}`);
    })();
  }, [router]);

  return (
    <CenteredCard>
      <p role="status">{said}</p>
    </CenteredCard>
  );
}
