"use client";

// Internal ids never reach the screen.
//
// A row's id, a section's, a thread's: the app runs on them, and a
// person reads none of them. They reached the screen anyway, through
// text the app did not write itself: Luke is told each section as
// "Packing [id …]" and said it back, a validator error named the id it
// could not find, and a scan asked "which one?" of rows it described by
// their link columns, which hold ids. So what is shown passes through
// here: an id this screen knows the name of reads as that name, and any
// other is taken out, with whatever it leaves dangling.
//
// Callers: src/components/ui/Markdown.tsx, src/components/ChatPanel.tsx,
// src/components/ScanBar.tsx.

import { createContext, createElement, useContext, type ReactNode } from "react";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Whether a value is nothing but an id. */
export const isId = (v: unknown) =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());

/** Text as a person reads it: ids named where they are known, and gone where they are not. */
export function withoutIds(text: string, names?: ReadonlyMap<string, string>): string {
  if (!text || !new RegExp(UUID.source, "i").test(text)) return text;
  return (
    text
      // The way sections are spelled for the model: the name is already beside it.
      .replace(/\s*\[id [0-9a-f-]{36}\]/gi, "")
      .replace(UUID, (id) => names?.get(id.toLowerCase()) ?? "")
      // What an id taken out leaves behind: empty quotes and brackets, a
      // separator with nothing on one side, a doubled space.
      .replace(/(["“'`])\s*(["”'`])/g, "")
      .replace(/\(\s*\)|\[\s*\]/g, "")
      .replace(/\s*(?:·\s*){2,}/g, " · ")
      .replace(/^[ \t]*·[ \t]*|[ \t]*·[ \t]*$/gm, "")
      .replace(/[ \t]{2,}/g, " ")
  );
}

const Names = createContext<ReadonlyMap<string, string> | undefined>(undefined);

/** The ids this part of the screen can put a name to: its sections, by id. */
export function IdNames({ names, children }: { names: ReadonlyMap<string, string>; children: ReactNode }) {
  return createElement(Names.Provider, { value: names }, children);
}

export function useIdNames(): ReadonlyMap<string, string> | undefined {
  return useContext(Names);
}
