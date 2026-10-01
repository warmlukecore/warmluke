// How a merchant connects the assistant they already use: ChatGPT,
// Claude, and any other that speaks MCP. One list, drawn by the panel
// ("Use your own AI"), so a new assistant is a new entry, not new UI.
//
// Every one of them connects the same way underneath: this app's MCP
// address, and a sign-in (OAuth 2.1 with the client registering itself,
// which ChatGPT requires and Claude uses). Only where the buttons are
// differs; menus move, so the last entry is the rule any client follows.

export type ConnectStep = {
  text: string;
  /** Something to paste that is not the address shown above the list: a command, a config. */
  copy?: string;
};

export type Assistant = {
  id: string;
  name: string;
  logo?: string;
  /** Who can, when not everyone can. */
  plan?: string;
  steps: (address: string) => ConnectStep[];
};

// The address sits once, above the list, with its own copy button;
// a step says where to paste it rather than printing it again.
export const ASSISTANTS: readonly Assistant[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    logo: "/logos/openai.svg",
    plan: "Plus, Pro, Business or Enterprise",
    steps: () => [
      { text: "Apps → Advanced settings: turn on Developer mode." },
      { text: "Apps → Create app. Name it Warmluke and paste the address as the MCP server URL." },
      { text: "Authentication: OAuth. Confirm, then Create." },
      { text: "Sign in to Warmluke and allow it." },
    ],
  },
  {
    id: "claude",
    name: "Claude",
    logo: "/logos/claude.svg",
    plan: "Team and Enterprise: an owner adds it first",
    steps: () => [
      { text: "Customize → Connectors → + → Add custom connector." },
      { text: "Paste the address, then Add." },
      { text: "Connect, sign in to Warmluke and allow it." },
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    logo: "/logos/claude.svg",
    steps: (address) => [
      { text: "In a terminal:", copy: `claude mcp add --transport http warmluke ${address}` },
      { text: "Then /mcp → warmluke → sign in." },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    logo: "/logos/cursor.svg",
    steps: (address) => [
      {
        text: "Settings → MCP. Add to mcp.json:",
        copy: JSON.stringify({ mcpServers: { warmluke: { url: address } } }),
      },
      { text: "Sign in to Warmluke when asked." },
    ],
  },
  {
    id: "vscode",
    name: "VS Code",
    logo: "/logos/vscode.svg",
    steps: () => [
      { text: "Command Palette → MCP: Add Server… → HTTP. Paste the address." },
      { text: "Name it warmluke and sign in when asked." },
    ],
  },
  {
    id: "any",
    name: "Other",
    steps: () => [
      { text: "Any client that supports remote MCP with OAuth: add the address as a server." },
      { text: "Sign in to Warmluke when asked." },
    ],
  },
];
