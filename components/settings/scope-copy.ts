import type { ApiKeyScope } from "@/lib/api-keys";

/**
 * What each scope lets a credential do, in the words a person reads when
 * they choose: on a new API key (Settings → Claude and API) and on the consent
 * screen an app such as claude.ai sends them to (/oauth/authorize). One
 * list, so the two cannot describe the same permission differently.
 * A plain module, not a client one, so a server component can read it.
 */
export const SCOPE_COPY: ReadonlyArray<{ id: ApiKeyScope; label: string; detail: string }> = [
  { id: "read", label: "Read", detail: "See your sites, articles, keywords, replies and results." },
  { id: "write", label: "Write", detail: "Change your own data: edit drafts and keywords, schedule articles, change settings." },
  {
    id: "spend",
    label: "Spend",
    detail: "Start AI work: drafting, corrections, discovery, generating articles. Included in your plan; daily caps still apply.",
  },
  {
    id: "publish",
    label: "Publish",
    detail: "Publish an article to your site's connected destination, and post a reply on X from the X account you connected for the site, each only when you confirm it to the agent. Nothing is posted on its own.",
  },
];
