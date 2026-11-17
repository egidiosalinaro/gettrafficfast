/**
 * The sections of the public docs, in order: the page's table of contents
 * (components/docs/docs-content.tsx) and the Docs list of /llms.txt
 * (app/llms.txt/route.ts). A plain module, so a route handler can read it
 * without importing the page's components.
 */
export const DOC_SECTIONS = [
  { id: "getting-started", title: "Getting started" },
  { id: "today", title: "Your day in GTF" },
  { id: "content", title: "Articles and topics" },
  { id: "growth", title: "Growth" },
  { id: "how-we-measure", title: "How we measure" },
  { id: "claude", title: "Use GTF from Claude" },
  { id: "tools", title: "The tools" },
  { id: "api", title: "API" },
  { id: "contact", title: "Contact" },
] as const;
