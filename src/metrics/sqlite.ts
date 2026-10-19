// SQLite storage for daily metric totals, in the same database as auth/ but in its own tables.

import type { DatabaseSync } from "node:sqlite";
import type { ActiveMark, DailyCount, MetricsStore } from "./model.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metric_counts (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (day, name, label)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metric_active (
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  PRIMARY KEY (day, subject)
) WITHOUT ROWID;
`;

type Row = Record<string, unknown>;

export class SqliteMetricsStore implements MetricsStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  write(counts: DailyCount[], active: ActiveMark[]): void {
    if (counts.length === 0 && active.length === 0) return;
    const add = this.db.prepare(
      "INSERT INTO metric_counts (day, name, label, value) VALUES (?, ?, ?, ?) ON CONFLICT (day, name, label) DO UPDATE SET value = value + excluded.value",
    );
    const mark = this.db.prepare("INSERT OR IGNORE INTO metric_active (day, subject) VALUES (?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const c of counts) add.run(c.day, c.name, c.label, c.value);
      for (const a of active) mark.run(a.day, a.subject);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  counts(sinceDay: string): DailyCount[] {
    const rows = this.db.prepare("SELECT day, name, label, value FROM metric_counts WHERE day >= ?").all(sinceDay) as Row[];
    return rows.map((row) => ({ day: row.day as string, name: row.name as string, label: row.label as string, value: row.value as number }));
  }

  activePerDay(sinceDay: string): { day: string; count: number }[] {
    const rows = this.db.prepare("SELECT day, COUNT(*) AS n FROM metric_active WHERE day >= ? GROUP BY day").all(sinceDay) as Row[];
    return rows.map((row) => ({ day: row.day as string, count: row.n as number }));
  }

  activeSince(sinceDay: string): number {
    const row = this.db.prepare("SELECT COUNT(DISTINCT subject) AS n FROM metric_active WHERE day >= ?").get(sinceDay) as Row;
    return row.n as number;
  }

  prune(countsBefore: string, activeBefore: string): void {
    this.db.prepare("DELETE FROM metric_counts WHERE day < ?").run(countsBefore);
    this.db.prepare("DELETE FROM metric_active WHERE day < ?").run(activeBefore);
  }
}
