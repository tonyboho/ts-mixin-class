import { readFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertSuccessfulCommand, packageRoot, runPnpm } from "./util.js"

const fixtureSuiteDirectory = path.join(packageRoot, "tests", "declaration-fixture-suite")
const libraryFixtureDirectory = path.join(packageRoot, "tests", "fixture-suite")
const installResult         = await runPnpm(fixtureSuiteDirectory, "install")

it("builds and runs the declaration fixture suite", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install declaration fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(libraryFixtureDirectory, "run", "clean:standard"),
        "Clean fixture suite library package standard build output"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(libraryFixtureDirectory, "run", "build:standard"),
        "Build fixture suite library package"
    )

    const mixinsDeclaration = await readFile(
        path.join(libraryFixtureDirectory, "dist", "standard", "mixins.d.ts"),
        "utf8"
    )
    const defaultMixinDeclaration = await readFile(
        path.join(libraryFixtureDirectory, "dist", "standard", "default-mixin.d.ts"),
        "utf8"
    )

    t.match(mixinsDeclaration, "export declare const __SourceClass1$mixin", "Named mixin factory is exported for downstream generated imports")
    t.match(mixinsDeclaration, "export declare const SourceClass1", "Named mixin runtime value is exported")

    // Lock both value-cast forms in the emitted declarations: non-generic mixins
    // use the factored MixinClassValue alias (with the required base as the third
    // argument when present); generic mixins keep the inline constructor cast.
    t.match(
        mixinsDeclaration,
        "export declare const ContractMixin: MixinClassValue<ContractMixin, typeof __ContractMixin$mixin> & RuntimeMixinClass;",
        "Non-generic mixin value uses the factored MixinClassValue alias"
    )
    t.match(
        mixinsDeclaration,
        "export declare const RequiredMixin: MixinClassValue<RequiredMixin, typeof __RequiredMixin$mixin, RequiredBase> & RuntimeMixinClass<RequiredBase>;",
        "Non-generic required-base mixin keeps the required base in MixinClassValue and RuntimeMixinClass"
    )
    t.match(
        mixinsDeclaration,
        "export declare const SourceClass1: (new <A1>(...args: any[]) => SourceClass1<A1>) &",
        "Generic mixin keeps the inline constructor cast"
    )
    t.notMatch(
        mixinsDeclaration,
        "SourceClass1: MixinClassValue",
        "Generic mixin is not collapsed into the MixinClassValue alias"
    )
    t.match(defaultMixinDeclaration, "export declare const __DefaultMixin$mixin", "Default mixin factory is exported for downstream generated imports")
    t.match(defaultMixinDeclaration, "declare const DefaultMixin", "Default mixin runtime value is declared")
    t.match(defaultMixinDeclaration, "export default DefaultMixin", "Default mixin declaration preserves default export shape")
    t.notMatch(defaultMixinDeclaration, "export declare const DefaultMixin", "Default mixin value is not accidentally exported as a named value")

    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build"),
        "Build declaration fixture consumer"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "test"),
        "Run declaration fixture consumer"
    )
})
