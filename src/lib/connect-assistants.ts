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
  /** Something to paste: the address, a command, a config. */
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

export const ASSISTANTS: readonly Assistant[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    logo: "/logos/openai.svg",
    plan: "Plus, Pro, Business or Enterprise",
    steps: (address) => [
      { text: "Open Apps in the sidebar, then Advanced settings, and turn on Developer mode." },
      {
        text: "Back in Apps, choose Create app. Name it Warmluke and paste this as the MCP server URL:",
        copy: address,
      },
      { text: "Set Authentication to OAuth, tick “I understand and want to continue”, and choose Create." },
      { text: "Sign in to Warmluke when it asks, and allow it." },
    ],
  },
  {
    id: "claude",
    name: "Claude",
    logo: "/logos/claude.svg",
    plan: "Any plan; on Team and Enterprise an owner adds it first",
    steps: (address) => [
      { text: "Open Customize, then Connectors, choose + and Add custom connector." },
      { text: "Paste this address and choose Add:", copy: address },
      { text: "Choose Connect, sign in to Warmluke, and allow it." },
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    logo: "/logos/claude.svg",
    steps: (address) => [
      { text: "In a terminal, run:", copy: `claude mcp add --transport http warmluke ${address}` },
      { text: "Then in Claude Code, run /mcp, choose warmluke, and sign in." },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    steps: (address) => [
      {
        text: "Open Cursor Settings, then MCP, and add this server to mcp.json:",
        copy: JSON.stringify({ mcpServers: { warmluke: { url: address } } }, null, 2),
      },
      { text: "Sign in to Warmluke when it asks, and allow it." },
    ],
  },
  {
    id: "vscode",
    name: "VS Code",
    steps: (address) => [
      { text: "Run “MCP: Add Server…” from the Command Palette, choose HTTP, and paste:", copy: address },
      { text: "Name it warmluke, then sign in when it asks." },
    ],
  },
  {
    id: "any",
    name: "Any other assistant",
    steps: (address) => [
      {
        text: "Any assistant that connects to remote MCP servers with a sign-in (OAuth) can use this address:",
        copy: address,
      },
      { text: "Sign in to Warmluke when it asks, and allow it." },
    ],
  },
];
