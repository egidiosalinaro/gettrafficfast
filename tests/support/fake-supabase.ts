/**
 * A minimal in-memory stand-in for the Supabase client, covering the query
 * shapes the job worker and the workflows use. It exists so durability
 * guarantees (steps are checkpointed, completed steps are never re-run, a
 * failure schedules a retry, a yielded step resumes where it stopped) and the
 * measurement invariants (negatives stored, unmeasured stays null) can be
 * asserted without a database.
 *
 * It is a fake, not a Postgres: filters are equality-shaped, `order` sorts one
 * column, `count` counts what the filters match, and conflict handling follows
 * the `onConflict` columns it is given.
 */

type Row = Record<string, unknown>;

type Op = "eq" | "neq" | "in" | "notIn" | "is" | "gte" | "gt" | "lte" | "lt" | "ilike" | "anyEq";

interface Filter {
  column: string;
  op: Op;
  value: unknown;
}

interface Result {
  data: Row[] | Row | null;
  error: null;
  count?: number | null;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const actual = row[f.column];
    switch (f.op) {
      case "eq":
        return actual === f.value;
      case "neq":
        return actual !== f.value;
      case "in":
        return (f.value as unknown[]).includes(actual);
      case "notIn":
        return !(f.value as unknown[]).includes(actual);
      case "is":
        return actual === f.value || (f.value === null && actual === undefined);
      case "gte":
        return compare(actual, f.value) >= 0;
      case "gt":
        return compare(actual, f.value) > 0;
      case "lte":
        return compare(actual, f.value) <= 0;
      case "lt":
        return compare(actual, f.value) < 0;
      case "ilike":
        return typeof actual === "string" && likePattern(f.value as string).test(actual);
      case "anyEq":
        return (f.value as Array<{ column: string; value: string }>).some((alt) => row[alt.column] === alt.value);
    }
  });
}

/** A SQL LIKE pattern (`%` any run, `_` one character) as a case-insensitive regex. */
function likePattern(pattern: string): RegExp {
  const body = pattern
    .split("")
    .map((ch) => (ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "is");
}

let sequence = 0;
function newId(): string {
  sequence += 1;
  return `fake-${sequence.toString().padStart(4, "0")}`;
}

export class FakeSupabase {
  readonly tables: Record<string, Row[]>;
  readonly calls: string[] = [];

  constructor(seed: Record<string, Row[]> = {}) {
    this.tables = { jobs: [], job_steps: [], articles: [], agent_runs: [], ...seed };
  }

  private rows(table: string): Row[] {
    if (!this.tables[table]) this.tables[table] = [];
    return this.tables[table];
  }

  from(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "update" | "insert" | "upsert" | "delete" = "select";
    let payload: Row | Row[] = {};
    let returning = false;
    let head = false;
    let counting = false;
    let ordering: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    let offset = 0;
    let conflict: string[] | null = null;
    let ignoreDuplicates = false;

    const shape = (rows: Row[]): Row[] => {
      let out = rows;
      if (ordering) {
        const { column, ascending } = ordering;
        out = [...out].sort((a, b) => compare(a[column], b[column]) * (ascending ? 1 : -1));
      }
      if (offset > 0) out = out.slice(offset);
      if (limit !== null) out = out.slice(0, limit);
      return out;
    };

    const execute = (): Result => {
      this.calls.push(`${mode}:${table}`);
      const rows = this.rows(table);

      switch (mode) {
        case "select": {
          const found = shape(rows.filter((r) => matches(r, filters)));
          return {
            data: head ? null : found,
            error: null,
            count: counting ? rows.filter((r) => matches(r, filters)).length : null,
          };
        }
        case "update": {
          const touched: Row[] = [];
          for (const row of rows) {
            if (matches(row, filters)) {
              Object.assign(row, payload as Row);
              touched.push(row);
            }
          }
          return { data: returning ? touched : null, error: null, count: touched.length };
        }
        case "insert": {
          const values = (Array.isArray(payload) ? payload : [payload]).map((v) => ({
            id: newId(),
            ...v,
          }));
          rows.push(...values);
          return { data: returning ? values : null, error: null };
        }
        case "upsert": {
          const values = Array.isArray(payload) ? payload : [payload];
          const keys = conflict ?? ["job_id", "step"];
          const touched: Row[] = [];
          for (const value of values) {
            const existing = rows.find((r) => keys.every((k) => r[k] === value[k]));
            if (existing) {
              if (!ignoreDuplicates) Object.assign(existing, value);
              if (!ignoreDuplicates) touched.push(existing);
            } else {
              const inserted = { id: newId(), ...value };
              rows.push(inserted);
              touched.push(inserted);
            }
          }
          return { data: returning ? touched : null, error: null };
        }
        default: {
          const before = rows.length;
          this.tables[table] = rows.filter((r) => !matches(r, filters));
          return { data: null, error: null, count: before - this.tables[table].length };
        }
      }
    };

    const single = () => {
      const result = execute();
      const list = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
      // A select that returns one row is what the callers mean; for writes,
      // the first touched row.
      return Promise.resolve({ data: list[0] ?? null, error: null });
    };

    const builder = {
      select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
        if (mode === "select") {
          head = Boolean(options?.head);
          counting = Boolean(options?.count);
        } else {
          returning = true;
        }
        return builder;
      },
      update: (values: Row) => ((mode = "update"), (payload = values), builder),
      insert: (values: Row | Row[]) => ((mode = "insert"), (payload = values), builder),
      upsert: (
        values: Row | Row[],
        options?: { onConflict?: string; ignoreDuplicates?: boolean }
      ) => {
        mode = "upsert";
        payload = values;
        conflict = options?.onConflict ? options.onConflict.split(",").map((c) => c.trim()) : null;
        ignoreDuplicates = Boolean(options?.ignoreDuplicates);
        return builder;
      },
      delete: (options?: { count?: string }) => {
        mode = "delete";
        counting = Boolean(options?.count);
        return builder;
      },
      eq: (column: string, value: unknown) => (filters.push({ column, op: "eq", value }), builder),
      neq: (column: string, value: unknown) => (filters.push({ column, op: "neq", value }), builder),
      in: (column: string, value: unknown[]) =>
        (filters.push({ column, op: "in", value }), builder),
      is: (column: string, value: unknown) => (filters.push({ column, op: "is", value }), builder),
      gte: (column: string, value: unknown) => (filters.push({ column, op: "gte", value }), builder),
      gt: (column: string, value: unknown) => (filters.push({ column, op: "gt", value }), builder),
      lte: (column: string, value: unknown) => (filters.push({ column, op: "lte", value }), builder),
      lt: (column: string, value: unknown) => (filters.push({ column, op: "lt", value }), builder),
      ilike: (column: string, value: string) => (filters.push({ column, op: "ilike", value }), builder),
      // `not(column, "in", "(a,b)")` filters, as PostgREST does. Any other
      // negation (`not(column, "is", null)`) still matches everything.
      not: (column: string, op: string, value: unknown) => {
        if (op === "in" && typeof value === "string") {
          const list = value
            .replace(/^\(|\)$/g, "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
          filters.push({ column, op: "notIn", value: list });
        }
        return builder;
      },
      // `or("a.eq.x,b.eq.y")`: equality alternatives only, as the callers use it.
      or: (expression: string) => {
        const alternatives = expression.split(",").map((part) => {
          const [column, , ...rest] = part.trim().split(".");
          return { column, value: rest.join(".") };
        });
        filters.push({ column: "", op: "anyEq", value: alternatives });
        return builder;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        // Only the first order() is honoured; enough for the callers here.
        if (!ordering) ordering = { column, ascending: options?.ascending ?? true };
        return builder;
      },
      limit: (n: number) => ((limit = n), builder),
      // `range(from, to)`, inclusive, as PostgREST pages.
      range: (from: number, to: number) => ((offset = from), (limit = to - from + 1), builder),
      maybeSingle: single,
      single,
      then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve()
          .then(() => execute())
          .then(resolve, reject),
    };

    return builder as never;
  }

  rpc() {
    return Promise.resolve({ data: [], error: null });
  }

  readonly auth = {
    admin: {
      getUserById: () => Promise.resolve({ data: { user: { email: null } }, error: null }),
    },
  };

  step(jobId: string, name: string): Row | undefined {
    return this.tables.job_steps.find((s) => s.job_id === jobId && s.step === name);
  }

  job(jobId: string): Row | undefined {
    return this.tables.jobs.find((j) => j.id === jobId);
  }
}
