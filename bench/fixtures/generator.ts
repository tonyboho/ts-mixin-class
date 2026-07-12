import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

export type BenchmarkGraphKind = "binary-tree" | "previous-window"
export type BenchmarkConstructionMode = "base" | "plain"
export type BenchmarkMemberKind = "properties"
export type BenchmarkPropertyVisibility = "implicit" | "public"

export type PreviousWindowGraphOptions = {
    dependencyWindow   : number,
    maxDependencyCount : number,
    minDependencyCount : number,
    seed               : number
}

export type BenchmarkScenario = {
    name               : string,
    size               : number,
    graph              : BenchmarkGraphKind,
    members            : BenchmarkMemberKind,
    propertyCount      : number,
    propertyVisibility : BenchmarkPropertyVisibility,
    construction       : BenchmarkConstructionMode,
    previousWindow?    : PreviousWindowGraphOptions,
    consumerLeafCount  : number,
    // Depth of a plain-class `extends` chain (`src/bases.ts`); when set, every mixin
    // extends a chain class (monotonically deeper with the mixin index, so every
    // dependency's required base is an ancestor of the dependent's own base and the
    // graph stays valid). This is the required-base resolver's heavy path: one
    // constraint per mixin in the closure, compared pairwise along the chain.
    baseChainDepth?    : number
}

export type BenchmarkFixture = {
    directory    : string,
    tsconfigFile : string,
    consumerFile : string,
    mixinFiles   : string[]
}

export type CreateBenchmarkFixtureOptions = {
    packageRoot : string,
    root        : string,
    scenario    : BenchmarkScenario
}

type SourceFile = {
    fileName : string,
    text     : string
}

export async function createBenchmarkFixture(options: CreateBenchmarkFixtureOptions): Promise<BenchmarkFixture> {
    const directory = path.join(options.root, scenarioDirectoryName(options.scenario))

    await rm(directory, { force: true, recursive: true })
    await mkdir(directory, { recursive: true })

    const sourceFiles = generateSourceFiles(options.scenario)

    await writeJson(path.join(directory, "package.json"), {
        name    : `ts-mixin-class-bench-${options.scenario.name}`,
        private : true,
        type    : "module"
    })
    await writeJson(path.join(directory, "tsconfig.json"), createTsconfig())

    for (const sourceFile of sourceFiles) {
        const fileName = path.join(directory, sourceFile.fileName)

        await mkdir(path.dirname(fileName), { recursive: true })
        await writeFile(fileName, sourceFile.text)
    }

    await linkNodeModules(options.packageRoot, directory)

    return {
        directory,
        tsconfigFile : path.join(directory, "tsconfig.json"),
        consumerFile : path.join(directory, "src", "consumer.ts"),
        mixinFiles   : Array.from({ length: options.scenario.size }, (_, index) => {
            return path.join(directory, "src", `${mixinModuleName(index)}.ts`)
        })
    }
}

export function defaultPreviousWindowGraphOptions(): PreviousWindowGraphOptions {
    return {
        dependencyWindow   : 8,
        maxDependencyCount : 3,
        minDependencyCount : 1,
        seed               : 19_871
    }
}

export function defaultCompileScenarios(
    propertyCount = 1,
    graphOptions = defaultPreviousWindowGraphOptions(),
    propertyVisibility: BenchmarkPropertyVisibility = "implicit",
    construction: BenchmarkConstructionMode = "plain"
): BenchmarkScenario[] {
    return [ 10, 30 ].map((size) => {
        return previousWindowPropertiesScenario(size, propertyCount, graphOptions, propertyVisibility, construction)
    })
}

export function defaultTsServerScenarios(
    propertyCount = 1,
    graphOptions = defaultPreviousWindowGraphOptions(),
    propertyVisibility: BenchmarkPropertyVisibility = "implicit",
    construction: BenchmarkConstructionMode = "plain"
): BenchmarkScenario[] {
    return [ 10, 30 ].map((size) => {
        return previousWindowPropertiesScenario(size, propertyCount, graphOptions, propertyVisibility, construction)
    })
}

export function defaultEditScenarios(
    propertyCount = 1,
    graphOptions = defaultPreviousWindowGraphOptions(),
    propertyVisibility: BenchmarkPropertyVisibility = "implicit",
    construction: BenchmarkConstructionMode = "plain"
): BenchmarkScenario[] {
    return [ 10, 30 ].map((size) => {
        return previousWindowPropertiesScenario(size, propertyCount, graphOptions, propertyVisibility, construction)
    })
}

export function previousWindowPropertiesScenario(
    size: number,
    propertyCount: number,
    graphOptions = defaultPreviousWindowGraphOptions(),
    propertyVisibility: BenchmarkPropertyVisibility = "implicit",
    construction: BenchmarkConstructionMode = "plain"
): BenchmarkScenario {
    return {
        name : [
            "previous-window",
            size,
            `${propertyVisibility}-properties`,
            `${propertyCount}-props`,
            construction === "plain" ? undefined : `${construction}-construction`,
            `${graphOptions.minDependencyCount}-${graphOptions.maxDependencyCount}-deps`,
            `${graphOptions.dependencyWindow}-window`
        ].filter((part) => part !== undefined).join("-"),
        size,
        graph             : "previous-window",
        members           : "properties",
        propertyCount,
        propertyVisibility,
        construction,
        previousWindow    : graphOptions,
        consumerLeafCount : Math.min(8, Math.max(1, Math.ceil(size / 32)))
    }
}

// The previous-window corpus with every mixin extending a class from one deep
// `extends` chain — measures the required-base resolver over the same graph shape.
export function requiredBaseChainScenario(
    size: number,
    propertyCount: number,
    graphOptions = defaultPreviousWindowGraphOptions(),
    propertyVisibility: BenchmarkPropertyVisibility = "implicit",
    construction: BenchmarkConstructionMode = "plain"
): BenchmarkScenario {
    const base  = previousWindowPropertiesScenario(size, propertyCount, graphOptions, propertyVisibility, construction)
    const depth = defaultBaseChainDepth(size)

    return {
        ...base,
        name           : `${base.name}-base-chain-${depth}`,
        baseChainDepth : depth
    }
}

export function defaultBaseChainDepth(size: number): number {
    return Math.max(4, Math.round(size / 4))
}

export function binaryTreePropertiesScenario(
    size: number,
    propertyCount: number,
    propertyVisibility: BenchmarkPropertyVisibility = "implicit",
    construction: BenchmarkConstructionMode = "plain"
): BenchmarkScenario {
    return {
        name : [
            "binary-tree",
            size,
            `${propertyVisibility}-properties`,
            `${propertyCount}-props`,
            construction === "plain" ? undefined : `${construction}-construction`
        ].filter((part) => part !== undefined).join("-"),
        size,
        graph             : "binary-tree",
        members           : "properties",
        propertyCount,
        propertyVisibility,
        construction,
        consumerLeafCount : Math.min(8, Math.max(1, Math.ceil(size / 32)))
    }
}

export function scenarioDirectoryName(scenario: BenchmarkScenario): string {
    return scenario.name.replaceAll(/[^a-zA-Z0-9_.-]/g, "-")
}

function generateSourceFiles(scenario: BenchmarkScenario): SourceFile[] {
    if (scenario.size < 1) {
        throw new Error(`Benchmark scenario ${scenario.name} must contain at least one mixin`)
    }

    if (scenario.graph !== "binary-tree" && scenario.graph !== "previous-window") {
        throw new Error(`Unsupported benchmark graph: ${scenario.graph}`)
    }

    if (scenario.members !== "properties") {
        throw new Error(`Unsupported benchmark member kind: ${scenario.members}`)
    }

    if (scenario.propertyCount < 1) {
        throw new Error(`Benchmark scenario ${scenario.name} must contain at least one property per mixin`)
    }

    return [
        ...(scenario.baseChainDepth === undefined
            ? []
            : [ { fileName: "src/bases.ts", text: baseChainSource(scenario.baseChainDepth, scenario.construction) } ]),
        ...Array.from({ length: scenario.size }, (_, index) => {
            return {
                fileName : `src/${mixinModuleName(index)}.ts`,
                text     : mixinSource(scenario, index)
            }
        }),
        {
            fileName : "src/consumer.ts",
            text     : consumerSource(scenario)
        }
    ]
}

function baseChainSource(depth: number, construction: BenchmarkConstructionMode): string {
    // In construction mode the whole chain derives the construction Base, so the
    // consumers stay construction-enabled while satisfying the required bases.
    const rootExtends = construction === "base" ? " extends Base" : ""
    const rootImport  = construction === "base" ? `import { Base } from "ts-mixin-class/base"\n\n` : ""

    return rootImport + Array.from({ length: depth }, (_, index) => {
        const extendsClause = index === 0 ? rootExtends : ` extends ${baseClassName(index - 1)}`

        return `export class ${baseClassName(index)}${extendsClause} {
    baseValue${index}: number = ${index}
}
`
    }).join("\n")
}

// Monotonic with the mixin index: dependencies (always earlier mixins) sit at the
// same depth or shallower, so each mixin's own base satisfies every dependency's
// required base and the corpus compiles without required-base diagnostics.
function mixinBaseIndex(scenario: BenchmarkScenario, index: number): number {
    const depth = scenario.baseChainDepth ?? 0

    return Math.min(depth - 1, Math.floor(index * depth / scenario.size))
}

function mixinSource(scenario: BenchmarkScenario, index: number): string {
    const dependencyIndexes = mixinDependencyIndexes(scenario, index)
    const baseName          = scenario.baseChainDepth === undefined
        ? undefined
        : baseClassName(mixinBaseIndex(scenario, index))
    const imports           = [
        `import { mixin } from "ts-mixin-class"`,
        ...(baseName === undefined ? [] : [ `import { ${baseName} } from "./bases.js"` ]),
        ...dependencyIndexes.map((dependencyIndex) => {
            return `import { ${mixinClassName(dependencyIndex)} } from "./${mixinModuleName(dependencyIndex)}.js"`
        })
    ]
    const extendsClause     = baseName === undefined ? "" : ` extends ${baseName}`
    const implementsClause  = dependencyIndexes.length === 0
        ? ""
        : ` implements ${dependencyIndexes.map((dependencyIndex) => mixinClassName(dependencyIndex)).join(", ")}`
    const visibility        = scenario.propertyVisibility === "public" ? "public " : ""
    const properties        = Array.from({ length: scenario.propertyCount }, (_, propertyIndex) => {
        return `    ${visibility}value${index}_${propertyIndex}: number = ${index * 1000 + propertyIndex}`
    })

    return `${imports.join("\n")}

@mixin()
export class ${mixinClassName(index)}${extendsClause}${implementsClause} {
${properties.join("\n")}
}
`
}

function mixinDependencyIndexes(scenario: BenchmarkScenario, index: number): number[] {
    if (index === 0) {
        return []
    }

    if (scenario.graph === "binary-tree") {
        return [ Math.floor((index - 1) / 2) ]
    }

    const options         = scenario.previousWindow ?? defaultPreviousWindowGraphOptions()
    const firstCandidate  = Math.max(0, index - options.dependencyWindow)
    const candidates      = Array.from({ length: index - firstCandidate }, (_, offset) => firstCandidate + offset).reverse()
    const random          = createSeededRandom(options.seed + index * 9973)
    const minCount        = Math.min(options.minDependencyCount, candidates.length)
    const maxCount        = Math.min(Math.max(options.maxDependencyCount, minCount), candidates.length)
    const dependencyCount = minCount + Math.floor(random() * (maxCount - minCount + 1))

    return candidates.slice(0, dependencyCount)
}

function createSeededRandom(seed: number): () => number {
    let state = seed >>> 0

    return () => {
        state += 0x6D2B79F5

        let value = state

        value  = Math.imul(value ^ value >>> 15, value | 1)
        value ^= value + Math.imul(value ^ value >>> 7, value | 61)

        return ((value ^ value >>> 14) >>> 0) / 4294967296
    }
}

function consumerSource(scenario: BenchmarkScenario): string {
    const leafIndexes = consumerLeafIndexes(scenario.size, scenario.consumerLeafCount)
    // In construction mode the consumer must extend a Base-derived class; with a required-base
    // chain in play the deepest chain class (itself Base-derived) satisfies every mixin.
    const constructionBase = scenario.baseChainDepth === undefined
        ? { name: "Base", importLine: `import { Base } from "ts-mixin-class/base"` }
        : { name: baseClassName(scenario.baseChainDepth - 1), importLine: `import { ${baseClassName(scenario.baseChainDepth - 1)} } from "./bases.js"` }
    const imports          = [
        ...(scenario.construction === "base" ? [ constructionBase.importLine ] : []),
        ...leafIndexes.map((index) => {
            return `import { ${mixinClassName(index)} } from "./${mixinModuleName(index)}.js"`
        })
    ]
    const implementsClause = leafIndexes.map((index) => mixinClassName(index)).join(", ")
    const extendsClause    = scenario.construction === "base" ? ` extends ${constructionBase.name}` : ""
    const checks           = leafIndexes.flatMap((index) => {
        return Array.from({ length: scenario.propertyCount }, (_, propertyIndex) => {
            return `consumer.value${index}_${propertyIndex}`
        })
    })
    // Construction classes ban direct `new` (the generated brand parameter), so the
    // construction corpus instantiates through the generated static `.new` instead.
    const instantiation = scenario.construction === "base"
        ? constructionSource(scenario, leafIndexes)
        : "const consumer = new Consumer()"

    return `${imports.join("\n")}

export class Consumer${extendsClause} implements ${implementsClause} {
}

${instantiation}

${checks.map((check) => `void ${check}`).join("\n")}
`
}

function constructionSource(scenario: BenchmarkScenario, leafIndexes: number[]): string {
    const configProperties = scenario.propertyVisibility === "public"
        ? [ ...mixinDependencyClosure(scenario, leafIndexes) ].flatMap((index) => {
            return Array.from({ length: scenario.propertyCount }, (_, propertyIndex) => {
                return `    value${index}_${propertyIndex}: ${index * 1000 + propertyIndex}`
            })
        })
        : []

    return `const consumer = Consumer.new({
${configProperties.join(",\n")}
})`
}

function mixinDependencyClosure(scenario: BenchmarkScenario, roots: number[]): number[] {
    const visited = new Set<number>()
    const visit   = (index: number): void => {
        if (visited.has(index)) {
            return
        }

        visited.add(index)

        for (const dependency of mixinDependencyIndexes(scenario, index)) {
            visit(dependency)
        }
    }

    for (const root of roots) {
        visit(root)
    }

    return [ ...visited ].sort((left, right) => left - right)
}

function consumerLeafIndexes(size: number, count: number): number[] {
    const firstLeaf = Math.floor(size / 2)
    const leaves    = Array.from({ length: size - firstLeaf }, (_, offset) => firstLeaf + offset)

    return leaves.slice(-Math.min(count, leaves.length)).reverse()
}

function mixinClassName(index: number): string {
    return `Mixin${index}`
}

function baseClassName(index: number): string {
    return `Base${index}`
}

function mixinModuleName(index: number): string {
    return `mixin-${String(index).padStart(4, "0")}`
}

function createTsconfig(): unknown {
    return {
        compilerOptions : {
            target                  : "ES2022",
            module                  : "NodeNext",
            moduleResolution        : "NodeNext",
            lib                     : [ "ES2022" ],
            useDefineForClassFields : false,
            skipLibCheck            : true,
            strict                  : true,
            rootDir                 : "src",
            outDir                  : "dist",
            plugins                 : [
                {
                    transform        : "ts-mixin-class",
                    transformProgram : true
                }
            ]
        },
        include : [ "src/**/*.ts" ]
    }
}

async function linkNodeModules(packageRoot: string, directory: string): Promise<void> {
    const nodeModules = path.join(directory, "node_modules")

    await mkdir(nodeModules, { recursive: true })
    await symlink(packageRoot, path.join(nodeModules, "ts-mixin-class"), "dir")
    await symlink(path.join(packageRoot, "node_modules", "typescript"), path.join(nodeModules, "typescript"), "dir")
}

async function writeJson(fileName: string, value: unknown): Promise<void> {
    await writeFile(fileName, `${JSON.stringify(value, null, 4)}\n`)
}
