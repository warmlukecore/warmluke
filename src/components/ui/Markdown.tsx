"use client";

// What Luke says, as the Markdown it writes it in: short headings,
// bullets, steps and bold, in the panel's own type and tokens.
//
// Raw HTML is dropped, never rendered. Tables, images and code blocks
// are unwrapped to their text: the panel is too narrow for a table, an
// image would call out of the app, and Luke is told to write none of
// them. A reply still arriving is read as it arrives, so a "**" or a
// list half written closes itself instead of flashing as symbols.
//
// A single line break is a line break, as it is in any chat; replies
// written before Markdown used them, and "•" for their bullets.

import remarkBreaks from "remark-breaks";
import { defaultRemarkPlugins, Streamdown, type Components, type ExtraProps } from "streamdown";

/** Every level the same small heading: a part of a reply, not a page title. */
const heading = ({ children }: React.ComponentProps<"h3"> & ExtraProps) => (
  <h3 className="text-[13px] font-semibold text-fg">{children}</h3>
);

const components: Components = {
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
  p: ({ children }) => <p className="text-[13px] leading-relaxed text-fg">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-4 marker:text-fg-faint">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-4 marker:text-fg-faint">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 text-[13px] leading-relaxed text-fg">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-fg underline underline-offset-2 transition-colors hover:text-fg-muted"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-line pl-3 text-fg-muted">{children}</blockquote>
  ),
  hr: () => <hr className="border-line" />,
  inlineCode: ({ children }) => (
    <code className="rounded bg-surface-subdued px-1 py-px text-[12px] text-fg">{children}</code>
  ),
};

const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

/** Bullets as the older replies wrote them, read as the list they were. */
const asMarkdown = (text: string) => text.replace(/^([ \t]*)•[ \t]+/gm, "$1- ");

export function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      caret={streaming ? "block" : undefined}
      parseIncompleteMarkdown
      skipHtml
      disallowedElements={["img", "table", "pre", "iframe", "input"]}
      unwrapDisallowed
      controls={false}
      linkSafety={{ enabled: false }}
      remarkPlugins={remarkPlugins}
      components={components}
      className="space-y-2 break-words"
    >
      {asMarkdown(children)}
    </Streamdown>
  );
}
