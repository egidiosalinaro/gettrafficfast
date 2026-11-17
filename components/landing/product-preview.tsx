/**
 * The shape of the signed-in screen, drawn so a visitor can see it before
 * they have an account.
 *
 * It is a picture of the layout, not a measurement. No rate, no customer,
 * no "trending up". A number here would be an invented result.
 */
export function ProductPreview() {
  return (
    <section id="product" className="w-full max-w-[1100px] mx-auto px-5 pb-8">
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden text-left">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-semibold">Your site</span>
            <span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
              Example · not a measurement
            </span>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-md border bg-background px-2 py-1">All engines</span>
            <span className="rounded-md border bg-background px-2 py-1">All clusters</span>
            <span className="rounded-md border bg-background px-2 py-1">Last run</span>
          </div>
        </div>

        <div className="flex gap-1 border-b px-3 py-2 text-sm">
          {["Overview", "Prompts", "Sources", "Competitors"].map((label, index) => (
            <span
              key={label}
              className={
                index === 0
                  ? "rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                  : "rounded-md px-3 py-1 text-xs font-medium text-muted-foreground"
              }
            >
              {label}
            </span>
          ))}
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <PreviewStat
            label="Visibility"
            value="per engine"
            hint="A rate only after a run. Never one number averaged across engines."
          />
          <PreviewStat
            label="Prompts"
            value="yours"
            hint="The questions you wrote, or imported from your keywords."
          />
          <PreviewStat
            label="Sources"
            value="returned"
            hint="Only URLs the engine actually sent back."
          />
          <PreviewStat
            label="Competitors"
            value="seen"
            hint="Domains it cited, and competitors you already listed."
          />
        </div>

        <div className="px-4 pb-4">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-y">
                <th className="py-2 text-left font-medium">Prompt</th>
                <th className="py-2 text-left font-medium">Engine</th>
                <th className="py-2 text-left font-medium">Outcome</th>
                <th className="hidden py-2 text-left font-medium sm:table-cell">What you do next</th>
              </tr>
            </thead>
            <tbody>
              <PreviewRow
                prompt="A question a buyer would ask an assistant"
                engine="gemini"
                outcome="cited"
                next="Keep the page that was cited."
              />
              <PreviewRow
                prompt="The same question, another engine"
                engine="perplexity"
                outcome="not cited"
                next="Read who was cited. Publish or place against that."
              />
              <PreviewRow
                prompt="A prompt you have not run yet"
                engine="none yet"
                outcome="not measured"
                next="Nothing is shown as zero."
              />
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Each prompt is asked once, on the prompts you set. Not every AI
            answer, and not a rank.
          </p>
        </div>
      </div>
    </section>
  );
}

function PreviewStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function PreviewRow({
  prompt,
  engine,
  outcome,
  next,
}: {
  prompt: string;
  engine: string;
  outcome: "cited" | "not cited" | "not measured";
  next: string;
}) {
  const tone =
    outcome === "cited"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
      : "border-foreground/15 bg-muted/40 text-muted-foreground";
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-2 pr-3 font-medium">{prompt}</td>
      <td className="py-2 pr-3 text-xs">{engine}</td>
      <td className="py-2 pr-3">
        <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium ${tone}`}>
          {outcome}
        </span>
      </td>
      <td className="hidden py-2 text-xs text-muted-foreground sm:table-cell">{next}</td>
    </tr>
  );
}
