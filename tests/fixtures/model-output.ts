/**
 * Model outputs used by the regression suite.
 *
 * `PROMPT_LEAKED_OUTPUT` reproduces the failure that shipped corrupted articles
 * to a live site: the model emitted a restatement of its brief plus a Markdown
 * outline before the article. Its shape is taken from the real stored content
 * of article 42dd963d ("automated unique discount codes email").
 */

/** Body long enough to clear the word-count gates. */
function paddedSections(count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return `<h2>Section ${n}: Building the Automation</h2>
<p>Automated discount codes turn a generic promotion into a personal offer, and that difference shows up directly in revenue. Every code is generated for one recipient, tied to one campaign, and expires on a schedule you control, which removes the leakage that plagues shared coupons. Teams that adopt this pattern usually start with a single flow and expand once the reporting proves the lift.</p>
<p>The operational win is just as large as the marketing one. Because the code is issued at send time, the storefront and the email stay in sync, and support stops fielding questions about coupons that no longer work. Set the expiry window deliberately: short enough to create urgency, long enough to respect how your customers actually shop.</p>
<ul>
  <li>Issue one code per recipient, never a shared one.</li>
  <li>Expire codes on a fixed window so urgency is real.</li>
  <li>Report redemption per flow, not per campaign.</li>
</ul>`;
  }).join("\n");
}

/** The same padding, written in Markdown. */
function markdownSections(count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return `## Section ${n}: Building the Automation

Automated discount codes turn a generic promotion into a personal offer, and that difference shows up directly in revenue. Every code is generated for one recipient, tied to one campaign, and expires on a schedule you control, which removes the leakage that plagues shared coupons.

The operational win is just as large as the marketing one. Because the code is issued at send time, the storefront and the email stay in sync, and support stops fielding questions about coupons that no longer work. Set the expiry window deliberately.`;
  }).join("\n\n");
}

export const CLEAN_HTML_OUTPUT = `<h1>How to Boost Conversions with Automated Unique Discount Codes</h1>
<p>Generic discount codes leak across the internet and erode your margins within hours of a send. Automated unique codes fix that at the root by issuing a single-use code to each recipient at the moment the email goes out.</p>
${paddedSections(4)}
<h2>Conclusion</h2>
<p>Start with one flow, measure redemption, and expand only once the numbers hold. The automation pays for itself the first time a shared coupon does not end up on a deal aggregator.</p>`;

export const MARKDOWN_OUTPUT = `# How to Boost Conversions with Automated Unique Discount Codes

Generic discount codes leak across the internet and erode your margins within hours of a send. Automated unique codes fix that at the root by issuing a single-use code to each recipient at the moment the email goes out.

## Why Generic Codes Fail

Shared coupons spread to aggregators, and the discount you meant for a lapsed customer ends up subsidising someone who would have paid full price. **Unique codes** remove that leakage entirely, and *personalised* expiry windows make the urgency real.

- Issue one code per recipient, never a shared one.
- Expire codes on a fixed window so urgency is real.
- Report redemption per flow, not per campaign.

1. Connect your store.
2. Pick the flow.
3. Set the expiry window.

> Redemption rate is the only number that matters here.

### Implementation Notes

Use \`generateCode()\` at send time, and read the [integration guide](https://example.com/guide) before going live.

| Flow | Redemption |
| --- | --- |
| Welcome | 12% |
| Cart | 9% |

${markdownSections(6)}

## Conclusion

Start with one flow, measure redemption, and expand only once the numbers hold.`;

/** The real-world failure: brief + outline emitted before the article. */
export const PROMPT_LEAKED_OUTPUT = `Expert SEO Content Writer.
automated unique discount codes email.
Email Marketing Automation.
Postwren (E-commerce automation: email, SMS, web push; features: drag-and-drop editor, A/B testing, dynamic products, unique discount codes).
900-1500 words.
HTML only (no Markdown, no code fences, no \`<html>\`/\`<head>\`/\`<body>\`).
One \`<h1>\`, short intro, 4-6 \`<h2>\` with \`<h3>\`, FAQ section, Conclusion with CTA. Scannable (short paragraphs, lists).
Keywords in title, intro, one \`<h2>\`, and conclusion. No keyword stuffing.
Professional, helpful. No fake stats/quotes.

    *   *Primary Keyword:* automated unique discount codes email.
    *   *Variations/Synonyms:* personalized discount codes, automated coupon emails.
    *   *Title:* How to Boost Conversions with Automated Unique Discount Codes.
    *   *Intro:* Hook the reader by mentioning the struggle of generic discounts.
    *   *H2 - The Problem with Generic Discount Codes:* Why "SAVE20" doesn't work.

${CLEAN_HTML_OUTPUT}`;

/** Output wrapped in a code fence — a formatting envelope, not content. */
export const FENCED_OUTPUT = "```html\n" + CLEAN_HTML_OUTPUT + "\n```";

export const TOO_SHORT_OUTPUT = "<h1>Tiny</h1><p>Not an article.</p>";
