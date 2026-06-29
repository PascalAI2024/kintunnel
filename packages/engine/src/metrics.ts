/**
 * In-process Prometheus-compatible metrics registry.
 *
 * No external `prom-client` dependency — the text exposition format is
 * small and stable. Counters, gauges, and histograms all live in memory
 * inside a single `MetricsRegistry`. The `/metrics` HTTP handler renders
 * the snapshot on demand; callers never need to await a scrape.
 *
 * Conventions enforced here:
 * - Counters carry a `_total` suffix (e.g. `peers_total`).
 * - Histograms carry a `_seconds` / `_bytes` suffix (e.g. `reconcile_duration_seconds`).
 * - Gauges have no suffix constraint but conventionally use `_seconds` for time.
 * - The `+Inf` histogram bucket is appended automatically.
 */

export interface Counter {
  /** Unlabeled increment. */
  inc(by?: number): void;
  /** Labeled increment. The label keys must match the registered labelNames. */
  inc(labels: Record<string, string>, by?: number): void;
  /** Unlabeled decrement (allowed for derived counters like `peers_active`). */
  dec(by?: number): void;
  /** Labeled decrement. */
  dec(labels: Record<string, string>, by?: number): void;
  /** Unlabeled read. Returns 0 if never incremented. */
  get(): number;
  /** Labeled read. Returns 0 if that label combination was never observed. */
  get(labels: Record<string, string>): number;
  /** Zero out every bucket — used at scrape time for derived counters. */
  reset(): void;
}

export interface Gauge {
  set(value: number): void;
  get(): number;
  reset(): void;
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  /** Cumulative counts per registered bucket boundary, ascending. */
  buckets: number[];
}

export interface Histogram {
  observe(value: number): void;
  snapshot(): HistogramSnapshot;
  reset(): void;
}

interface CounterEntry {
  kind: "counter";
  name: string;
  help: string;
  labelNames: string[];
  /** JSON-encoded sorted label map → current value. Empty string = no labels. */
  buckets: Map<string, number>;
}

interface GaugeEntry {
  kind: "gauge";
  name: string;
  help: string;
  value: number;
}

interface HistogramEntry {
  kind: "histogram";
  name: string;
  help: string;
  /** Bucket upper bounds in ascending order (excluding +Inf). */
  boundaries: number[];
  /** counts[i] = observations whose value <= boundaries[i] (for i < boundaries.length) */
  counts: number[];
  /** Total observations — also the +Inf bucket count. */
  total: number;
  sum: number;
}

type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;

export interface MetricsRegistry {
  counter(name: string, help: string, labelNames?: string[]): Counter;
  gauge(name: string, help: string, labelNames?: string[]): Gauge;
  histogram(name: string, help: string, buckets: number[], labelNames?: string[]): Histogram;
  /** Render all registered metrics in Prometheus text exposition format. */
  render(): string;
}

export function createMetricsRegistry(): MetricsRegistry {
  const metrics: MetricEntry[] = [];
  const byName = new Map<string, MetricEntry>();

  function getOrCreateCounter(name: string, help: string, labelNames: string[]): CounterEntry {
    const existing = byName.get(name);
    if (existing) {
      if (existing.kind !== "counter") {
        throw new Error(`Metric ${name} already registered as ${existing.kind}`);
      }
      return existing;
    }
    const entry: CounterEntry = {
      kind: "counter",
      name,
      help,
      labelNames: labelNames.slice(),
      buckets: new Map()
    };
    metrics.push(entry);
    byName.set(name, entry);
    return entry;
  }

  function getOrCreateGauge(name: string, help: string): GaugeEntry {
    const existing = byName.get(name);
    if (existing) {
      if (existing.kind !== "gauge") {
        throw new Error(`Metric ${name} already registered as ${existing.kind}`);
      }
      return existing;
    }
    const entry: GaugeEntry = { kind: "gauge", name, help, value: 0 };
    metrics.push(entry);
    byName.set(name, entry);
    return entry;
  }

  function getOrCreateHistogram(name: string, help: string, buckets: number[]): HistogramEntry {
    const existing = byName.get(name);
    if (existing) {
      if (existing.kind !== "histogram") {
        throw new Error(`Metric ${name} already registered as ${existing.kind}`);
      }
      return existing;
    }
    const sorted = buckets.slice().sort((a, b) => a - b);
    const entry: HistogramEntry = {
      kind: "histogram",
      name,
      help,
      boundaries: sorted,
      counts: sorted.map(() => 0),
      total: 0,
      sum: 0
    };
    metrics.push(entry);
    byName.set(name, entry);
    return entry;
  }

  return {
    counter(name: string, help: string, labelNames: string[] = []): Counter {
      const entry = getOrCreateCounter(name, help, labelNames);
      return wrapCounter(entry);
    },
    gauge(name: string, help: string, _labelNames: string[] = []): Gauge {
      const entry = getOrCreateGauge(name, help);
      return wrapGauge(entry);
    },
    histogram(name: string, help: string, buckets: number[], _labelNames: string[] = []): Histogram {
      const entry = getOrCreateHistogram(name, help, buckets);
      return wrapHistogram(entry);
    },
    render(): string {
      const sections: string[] = [];
      for (const metric of metrics) {
        const section = renderMetric(metric);
        if (section.length > 0) sections.push(section);
      }
      // Blank line between metrics, single trailing newline. Spec calls for
      // "blank line at end" — we emit the inter-metric separator between every
      // pair and end with one newline so Prometheus parsers accept it.
      return sections.length === 0 ? "" : sections.join("\n\n") + "\n";
    }
  };
}

function wrapCounter(entry: CounterEntry): Counter {
  function delta(arg1: number | Record<string, string> | undefined, arg2: number | undefined, sign: 1 | -1): void {
    let labels: Record<string, string> = {};
    let by = 1;
    if (typeof arg1 === "number") {
      by = arg1;
    } else if (arg1 && typeof arg1 === "object") {
      labels = arg1;
      by = arg2 ?? 1;
    }
    const key = serializeLabels(labels);
    entry.buckets.set(key, (entry.buckets.get(key) ?? 0) + sign * by);
  }
  function inc(arg1?: number | Record<string, string>, arg2?: number): void {
    delta(arg1, arg2, 1);
  }
  function dec(arg1?: number | Record<string, string>, arg2?: number): void {
    delta(arg1, arg2, -1);
  }
  function get(arg?: Record<string, string>): number {
    const key = arg ? serializeLabels(arg) : "";
    return entry.buckets.get(key) ?? 0;
  }
  return {
    inc,
    dec,
    get,
    reset(): void {
      entry.buckets.clear();
    }
  };
}

function wrapGauge(entry: GaugeEntry): Gauge {
  return {
    set(value: number): void {
      entry.value = value;
    },
    get(): number {
      return entry.value;
    },
    reset(): void {
      entry.value = 0;
    }
  };
}

function wrapHistogram(entry: HistogramEntry): Histogram {
  return {
    observe(value: number): void {
      for (let i = 0; i < entry.boundaries.length; i += 1) {
        if (value <= entry.boundaries[i]) {
          entry.counts[i] += 1;
        }
      }
      entry.total += 1;
      entry.sum += value;
    },
    snapshot(): HistogramSnapshot {
      return {
        count: entry.total,
        sum: entry.sum,
        buckets: entry.counts.slice()
      };
    },
    reset(): void {
      for (let i = 0; i < entry.counts.length; i += 1) {
        entry.counts[i] = 0;
      }
      entry.total = 0;
      entry.sum = 0;
    }
  };
}

function renderMetric(metric: MetricEntry): string {
  const header = [
    `# HELP ${metric.name} ${escapeHelp(metric.help)}`,
    `# TYPE ${metric.name} ${metric.kind}`
  ];

  if (metric.kind === "counter") {
    if (metric.buckets.size === 0) {
      header.push(`${metric.name} 0`);
    } else {
      // Sort label keys so output is deterministic.
      const keys = Array.from(metric.buckets.keys()).sort();
      for (const key of keys) {
        const value = metric.buckets.get(key) ?? 0;
        if (key === "") {
          header.push(`${metric.name} ${value}`);
        } else {
          header.push(`${metric.name}{${key}} ${value}`);
        }
      }
    }
  } else if (metric.kind === "gauge") {
    header.push(`${metric.name} ${metric.value}`);
  } else {
    // Histogram: emit bucket lines (each as a cumulative count) plus _sum and _count.
    for (let i = 0; i < metric.boundaries.length; i += 1) {
      header.push(
        `${metric.name}_bucket{le="${formatBucketBound(metric.boundaries[i])}"} ${metric.counts[i]}`
      );
    }
    header.push(`${metric.name}_bucket{le="+Inf"} ${metric.total}`);
    header.push(`${metric.name}_sum ${formatFloat(metric.sum)}`);
    header.push(`${metric.name}_count ${metric.total}`);
  }

  return header.join("\n");
}

function serializeLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(",");
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatBucketBound(bound: number): string {
  // Numbers like 0.1, 0.5, 1, 10 render naturally. Avoid scientific notation
  // for common reconcile timings by relying on JS toString for finite values.
  if (!Number.isFinite(bound)) return bound > 0 ? "+Inf" : "-Inf";
  return bound.toString();
}

function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  return value.toString();
}