import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

// Shared result model and table rendering for every benchmark scenario.
//
// A scenario produces a BenchReport: a titled table whose rows each carry the
// raw duration samples for one measured case (plus an optional per-step
// breakdown shown in the full table). The orchestrator renders the reports and,
// when a saved baseline is supplied, appends a delta column comparing each row's
// median against the baseline -- the "measure, change, measure, compare" loop.

export type TableMode = "compact" | "full"

export type BenchRow = {
    name       : string,
    samples    : number[],
    breakdown? : Record<string, number>
}

export type BenchReport = {
    id    : string,
    title : string,
    rows  : BenchRow[]
}

export type Baseline = {
    savedAt : string,
    reports : Record<string, Record<string, { median: number, mean: number }>>
}

type DurationStats = {
    max    : number,
    mean   : number,
    median : number,
    min    : number
}

const NAME_WIDTH = 52
const COLUMN_WIDTH = 9

export function renderReports(
    reports: BenchReport[],
    table: TableMode,
    baseline: Baseline | undefined
): string[] {
    const lines: string[] = []

    for (const report of reports) {
        lines.push("")
        lines.push(report.title)
        lines.push(...renderReport(report, table, baseline))
    }

    return lines
}

export function buildBaseline(reports: BenchReport[]): Baseline {
    const baseline: Baseline = { savedAt : new Date().toISOString(), reports : {} }

    for (const report of reports) {
        const rows: Record<string, { median: number, mean: number }> = {}

        for (const row of report.rows) {
            const stats = durationStats(row.samples)

            rows[row.name] = { mean : stats.mean, median : stats.median }
        }

        baseline.reports[report.id] = rows
    }

    return baseline
}

export async function saveBaseline(file: string, baseline: Baseline): Promise<void> {
    await mkdir(path.dirname(file), { recursive : true })
    await writeFile(file, `${JSON.stringify(baseline, null, 4)}\n`)
}

export async function loadBaseline(file: string): Promise<Baseline> {
    return JSON.parse(await readFile(file, "utf8")) as Baseline
}

function renderReport(report: BenchReport, table: TableMode, baseline: Baseline | undefined): string[] {
    const baselineRows = baseline?.reports[report.id]
    const breakdownKeys = table === "full" ? collectBreakdownKeys(report) : []
    const lines = [ renderHeader(table, breakdownKeys, baselineRows !== undefined) ]

    for (const row of report.rows) {
        lines.push(renderRow(row, table, breakdownKeys, baselineRows?.[row.name]?.median))
    }

    return lines
}

function renderHeader(table: TableMode, breakdownKeys: string[], withDelta: boolean): string {
    const columns = table === "compact"
        ? [ "median" ]
        : [ "min", "median", "mean", "max", ...breakdownKeys, "samples" ]

    return [
        "name".padEnd(NAME_WIDTH),
        ...columns.map((column) => column.padStart(COLUMN_WIDTH)),
        ...(withDelta ? [ "Δ base".padStart(COLUMN_WIDTH) ] : [])
    ].join(" ")
}

function renderRow(
    row: BenchRow,
    table: TableMode,
    breakdownKeys: string[],
    baselineMedian: number | undefined
): string {
    const stats = durationStats(row.samples)
    const cells = table === "compact"
        ? [ formatMs(stats.median) ]
        : [
            formatMs(stats.min),
            formatMs(stats.median),
            formatMs(stats.mean),
            formatMs(stats.max),
            ...breakdownKeys.map((key) => row.breakdown?.[key] === undefined ? "-" : formatMs(row.breakdown[key]!)),
            String(row.samples.length)
        ]

    return [
        row.name.padEnd(NAME_WIDTH),
        ...cells.map((cell) => cell.padStart(COLUMN_WIDTH)),
        ...(baselineMedian === undefined ? [] : [ formatDelta(stats.median, baselineMedian).padStart(COLUMN_WIDTH) ])
    ].join(" ")
}

function collectBreakdownKeys(report: BenchReport): string[] {
    const keys: string[] = []

    for (const row of report.rows) {
        for (const key of Object.keys(row.breakdown ?? {})) {
            if (!keys.includes(key)) {
                keys.push(key)
            }
        }
    }

    return keys
}

export function durationStats(values: number[]): DurationStats {
    const sorted = [ ...values ].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!

    return {
        max  : sorted.at(-1)!,
        mean : mean(sorted),
        min  : sorted[0]!,
        median
    }
}

export function mean(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length
}

function formatMs(value: number): string {
    return `${value.toFixed(value < 10 ? 3 : 1)}ms`
}

function formatDelta(current: number, base: number): string {
    if (base === 0) {
        return "n/a"
    }

    const percent = ((current - base) / base) * 100
    const sign = percent > 0 ? "+" : ""

    return `${sign}${percent.toFixed(1)}%`
}
