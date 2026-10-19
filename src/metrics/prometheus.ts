// A minimal Prometheus registry and text exposition (format 0.0.4): counters, one histogram,
// and gauges computed at scrape time. Small enough not to be worth a dependency.

export type Labels = Record<string, string>;

export interface Gauge {
  name: string;
  help: string;
  values: { labels?: Labels; value: number }[];
}

interface Family {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  samples(): string[];
}

export class Counter implements Family {
  readonly type = "counter";
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = formatLabels(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  samples(): string[] {
    return [...this.values].map(([labels, value]) => `${this.name}${labels} ${value}`);
  }
}

export class Histogram implements Family {
  readonly type = "histogram";
  private readonly series = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly bounds: number[],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = formatLabels(labels);
    let series = this.series.get(key);
    if (!series) this.series.set(key, (series = { labels, buckets: this.bounds.map(() => 0), sum: 0, count: 0 }));
    this.bounds.forEach((bound, i) => value <= bound && series.buckets[i]++);
    series.sum += value;
    series.count++;
  }

  samples(): string[] {
    return [...this.series.values()].flatMap(({ labels, buckets, sum, count }) => [
      ...this.bounds.map((bound, i) => `${this.name}_bucket${formatLabels({ ...labels, le: String(bound) })} ${buckets[i]}`),
      `${this.name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${count}`,
      `${this.name}_sum${formatLabels(labels)} ${sum}`,
      `${this.name}_count${formatLabels(labels)} ${count}`,
    ]);
  }
}

export function render(families: (Counter | Histogram)[], gauges: Gauge[]): string {
  const all: Family[] = [
    ...families,
    ...gauges.map((g): Family => ({ ...g, type: "gauge", samples: () => g.values.map((v) => `${g.name}${formatLabels(v.labels ?? {})} ${v.value}`) })),
  ];
  return all.map((f) => [`# HELP ${f.name} ${f.help}`, `# TYPE ${f.name} ${f.type}`, ...f.samples()].join("\n")).join("\n") + "\n";
}

function formatLabels(labels: Labels): string {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);
  return pairs.length ? `{${pairs.join(",")}}` : "";
}
