/**
 * The sections of the public MCP reference (`/docs/mcp`), in order: its
 * table of contents and its anchors. Registries and directories link to
 * this page, so the ids are part of its address: rename one only with a
 * redirect in mind. A plain module, so a route handler can read it.
 */
export const MCP_DOC_SECTIONS = [
  { id: "overview", title: "What it does" },
  { id: "server", title: "Server" },
  { id: "plan", title: "Plan required" },
  { id: "connect-oauth", title: "Connect with sign-in" },
  { id: "connect-key", title: "Connect with a key" },
  { id: "sites", title: "Several sites" },
  { id: "permissions", title: "Permissions" },
  { id: "prompts", title: "Prompts" },
  { id: "tools", title: "Tools" },
  { id: "limits", title: "Limits" },
  { id: "errors", title: "Errors" },
  { id: "never", title: "What GTF never does" },
  { id: "privacy", title: "Privacy and data" },
  { id: "support", title: "Support" },
] as const;
