import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { WebhookCard, WEBHOOK_DISCONNECT_QUESTION } from "@/components/integrations/webhook-card";
import { WordPressCard, WORDPRESS_DISCONNECT_QUESTION } from "@/components/integrations/wordpress-card";
import {
  confirmTap,
  InlineConfirmView,
  OUTLINE_ANSWER,
  type ConfirmStep,
} from "@/components/ui/inline-confirm";

/**
 * Disconnecting an integration stops every scheduled article from reaching
 * the site. It used to ask through `window.confirm`, which some in-app
 * browsers block (so the tap did nothing) and which reads as an error on a
 * phone. Now it asks inline, like Regenerate on the article card: the first
 * tap swaps the button for the question, the second disconnects.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const connected = {
  id: "int-1",
  status: "connected" as const,
  last_error: null,
  last_sync_at: null,
};

const cards = [
  {
    name: "WordPress",
    file: "components/integrations/wordpress-card.tsx",
    question: WORDPRESS_DISCONNECT_QUESTION,
    render: () =>
      renderToStaticMarkup(
        <WordPressCard
          integration={{ ...connected, config: { site_url: "https://example.com", username: "editor" } }}
        />
      ),
  },
  {
    name: "Webhook",
    file: "components/integrations/webhook-card.tsx",
    question: WEBHOOK_DISCONNECT_QUESTION,
    render: () =>
      renderToStaticMarkup(
        <WebhookCard integration={{ ...connected, config: { url: "https://example.com/hook" } }} />
      ),
  },
];

describe.each(cards)("$name disconnect", ({ file, question, render }) => {
  it("shows only the Disconnect button before the first tap", () => {
    const html = render();
    expect(html).toContain("Disconnect");
    expect(html).not.toContain(question);
    expect(html).not.toContain("Cancel");
  });

  it("asks inline after the first tap, with Disconnect and Cancel at 44px on a phone", () => {
    const html = renderToStaticMarkup(
      <InlineConfirmView
        step="confirming"
        question={question}
        confirmLabel="Disconnect"
        buttonClassName={OUTLINE_ANSWER}
        trigger={() => <button type="button">Disconnect</button>}
        onTap={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).toContain(question);
    expect(html).toMatch(/Scheduled articles will stop publishing/);
    expect(html).toContain(">Disconnect<");
    expect(html).toContain(">Cancel<");
    for (const button of html.match(/<button[^>]*>/g) ?? []) expect(button).toMatch(/\bh-11\b/);
  });

  it("never opens a native dialog, and wires Disconnect through the inline confirm", () => {
    const text = source(file);
    expect(text).not.toMatch(/window\.confirm\s*\(|\bconfirm\s*\(/);
    expect(text).toContain("<InlineConfirm");
    expect(text).toContain("onConfirm={handleDisconnect}");
    expect(text).toContain("onClick={ask}");
  });
});

describe("the inline confirm", () => {
  it("disconnects on the second tap, never the first, and Cancel starts over", () => {
    const onConfirm = vi.fn();
    let step: ConfirmStep = "idle";
    const tap = () => {
      const { next, act } = confirmTap(step);
      step = next;
      if (act) onConfirm();
    };

    tap();
    expect(step).toBe("confirming");
    expect(onConfirm).not.toHaveBeenCalled();

    step = "idle"; // Cancel
    tap();
    expect(onConfirm).not.toHaveBeenCalled();

    tap();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(step).toBe("idle");
  });
});
