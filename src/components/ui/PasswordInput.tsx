"use client";

// A password field that can be shown. Most people who get a password
// wrong typed it wrong, and seeing it is quicker than a reset email.

import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { field } from "@/components/ui/controls";

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={shown ? "text" : "password"} className={`${field} pr-10`} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-control text-fg-faint transition-colors hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        {shown ? <EyeOff aria-hidden size={15} strokeWidth={1.75} /> : <Eye aria-hidden size={15} strokeWidth={1.75} />}
      </button>
    </div>
  );
}
