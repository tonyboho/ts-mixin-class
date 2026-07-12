import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, typecheckText } from "./util.js"

// The pure-type config COMPOSITION (epic decision 1, same-file stage): a construction
// class's config alias references its contributors' own `<Name>Config` aliases instead of
// re-spelling their accumulated keys — each level spells only its own keys (the tree
// form). Per pre-probe 2 the Omit subtraction is OVERLAP-GATED: it appears only where a
// nearer layer actually redeclares a deeper layer's key (spelled as a literal union the
// transform computed — never `keyof`, whose Exclude would distribute over the whole
// accumulated union and reintroduce the quadratic), and the re-require appears only where
// the overlap drops a deeper REQUIRED key behind an optional nearer redeclaration
// (§7.28's monotonicity, restored via `Required<Pick<…>>` on the winning layer).

it("a consumer's config references the local construction mixin's alias instead of re-spelling its keys", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Sortable extends Base {
            public order!: number
        }

        export class Widget extends Base implements Sortable {
            public label!: string
        }
    `)))

    t.match(printed, 'Pick<Widget, "label"> & SortableConfig', "own keys spelled, the mixin rides as its alias")
    t.notMatch(printed, 'Pick<Widget, "label" | "order">', "the mixin's keys are not re-flattened into the consumer's Pick")
    t.notMatch(printed, "Omit<SortableConfig", "no key overlap — no Omit (the overlap gate)")

    const messages = typecheckText(printed).join("\n")

    t.is(messages, "", `the composed shape typechecks clean:\n${messages}`)
})

it("a subclass's config references the parent construction class's alias (the tree, not re-flattening)", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        export class Root extends Base {
            public a!: string
        }

        export class Branch extends Root {
            public b!: number
        }

        export class Leaf extends Branch {
            public c!: boolean
        }
    `)))

    t.match(printed, 'Pick<Branch, "b"> & RootConfig', "the middle level spells only its own key plus the parent alias")
    t.match(printed, 'Pick<Leaf, "c"> & BranchConfig', "the leaf references the middle alias — one level, not the whole chain")
    t.notMatch(printed, 'Pick<Leaf, "c" | "b" | "a">', "no accumulated re-flattening at the leaf")

    const messages = typecheckText(`${printed}
        const leaf = Leaf.new({ a: "x", b: 1, c: true })
        void leaf

        function typeOnlyChecks(): void {
            // @ts-expect-error the whole chain's keys stay required through the tree
            Leaf.new({ c: true })
        }
        void typeOnlyChecks
    `).join("\n")

    t.is(messages, "", `chain construction through the tree typechecks:\n${messages}`)
})

it("a key overlap gates in an Omit with a spelled literal subtraction; a FULLY overlapped alias drops", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Titled extends Base {
            public title: string = ""
            public width: number = 0
        }

        @mixin()
        export class Shadowed extends Base {
            public body: string = ""
        }

        export class Card extends Base implements Titled, Shadowed {
            public title: "big" | "small" = "small"
            public body: string = ""
        }
    `)))

    t.match(printed, 'Omit<TitledConfig, "title">', "the overlapped key is subtracted from the deeper alias by literal")
    t.notMatch(printed, "Omit<ShadowedConfig", "an alias whose keys are ALL overridden contributes nothing — dropped, not Omit-ed")
    t.notMatch(printed, "& ShadowedConfig", "the fully-overlapped alias does not ride bare either")

    const messages = typecheckText(`${printed}
        const card = Card.new({ title: "big", body: "text" })
        void card

        function typeOnlyChecks(): void {
            // @ts-expect-error the NEAREST declaration's narrower type governs (§7.29)
            Card.new({ title: "medium" })
        }
        void typeOnlyChecks
    `).join("\n")

    t.is(messages, "", `nearest-first through the composed shape typechecks:\n${messages}`)
})

it("a deeper REQUIRED key stays required behind an optional nearer redeclaration (§7.28 re-require)", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Strict extends Base {
            public shared!: string
        }

        export class Relaxed extends Base implements Strict {
            public shared: string = ""
        }
    `)))

    const messages = typecheckText(`${printed}
        const relaxed = Relaxed.new({ shared: "x" })
        void relaxed

        function typeOnlyChecks(): void {
            // @ts-expect-error requiredness is MONOTONIC: the mixin's ! keeps the key required
            Relaxed.new({})
        }
        void typeOnlyChecks
    `).join("\n")

    t.is(messages, "", `monotonic requiredness through the composed shape typechecks:\n${messages}`)
})

it("a NON-construction mixin's keys keep the flattened route (no alias exists to reference)", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Plain {
            public tag: string = ""
        }

        export class Holder extends Base implements Plain {
            public own!: number
        }
    `)))

    t.notMatch(printed, "PlainConfig", "a non-construction mixin has no config alias")
    t.match(printed, '"own"', "the consumer's own key is spelled")
    t.match(printed, '"tag"', "the plain mixin's key is flattened into the consumer's config as before")

    const messages = typecheckText(`${printed}
        const holder = Holder.new({ own: 1, tag: "t" })
        void holder
    `).join("\n")

    t.is(messages, "", `the mixed composed/flattened shape typechecks:\n${messages}`)
})

it("a generic local mixin rides as its instantiated alias", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Boxed<T> extends Base {
            public value!: T
        }

        export class NumberBox extends Base implements Boxed<number> {
            public label: string = ""
        }
    `)))

    t.match(printed, "BoxedConfig<number>", "the use-site instantiation rides the alias reference natively")

    const messages = typecheckText(`${printed}
        const box = NumberBox.new({ value: 42 })
        void box

        function typeOnlyChecks(): void {
            // @ts-expect-error T is instantiated to number at the use site
            NumberBox.new({ value: "wrong" })
        }
        void typeOnlyChecks
    `).join("\n")

    t.is(messages, "", `generic instantiation through the alias reference typechecks:\n${messages}`)
})

it("an EMPTY contributor's alias is dropped from the composed config — the exact-empty idiom must not poison the tree", async (t: Test) => {
    // An empty construction class's own alias is the EXACT-EMPTY idiom
    // (`Partial<Record<PropertyKey, never>>`, §7.25) — its index signatures type every key
    // `undefined`, so referencing it as a composition LAYER would swallow every other
    // layer's keys in the flatten. A provably empty layer must contribute nothing instead.
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Tagged extends Base {
        }

        export class Marker extends Base {
        }

        export class Stamp extends Marker {
        }

        export class Sheet extends Stamp implements Tagged {
            public label!: string
        }
    `)))

    t.notMatch(printed, "& StampConfig", "an empty parent alias does not ride the composed config")
    t.notMatch(printed, "& TaggedConfig", "an empty mixin alias does not ride the composed config")

    const messages = typecheckText(`${printed}
        const sheet = Sheet.new({ label: "x" })
        void sheet

        function typeOnlyChecks(): void {
            // @ts-expect-error unknown keys are still rejected
            Sheet.new({ label: "x", junk: 1 })
        }
        void typeOnlyChecks
    `).join("\n")

    t.is(messages, "", `construction over empty contributors typechecks:\n${messages}`)
})

it("an empty MIDDLE parent is NOT dropped — its alias still routes the keyed grandparent", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        export class Keyed extends Base {
            public k!: string
        }

        export class Mid extends Keyed {
        }

        export class Tip extends Mid {
            public c!: number
        }
    `)))

    t.match(printed, "& MidConfig", "the keyless middle still rides as its alias — its chain is not empty")

    const messages = typecheckText(`${printed}
        const tip = Tip.new({ k: "x", c: 1 })
        void tip

        function typeOnlyChecks(): void {
            // @ts-expect-error the grandparent's required key rides the middle alias
            Tip.new({ c: 1 })
        }
        void typeOnlyChecks
    `).join("\n")

    t.is(messages, "", `the chain through a keyless middle typechecks:\n${messages}`)
})

it("an index-signature-only contributor is NOT dropped — empty of keys is not empty of cargo", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        export class Baggy extends Base {
            [bag: string]: number | Base["initialize"] | undefined
        }

        export class Load extends Baggy {
            public own!: number
        }
    `)))

    t.match(printed, "& BaggyConfig", "the index-signature carrier stays referenced")

    const messages = typecheckText(`${printed}
        const load = Load.new({ own: 1, extra: 2 })
        void load

        function typeOnlyChecks(): void {
            // @ts-expect-error bag keys stay constrained by the index signature's value type
            Load.new({ own: 1, extra: "wrong" })
        }
        void typeOnlyChecks
    `).join("\n")

    t.is(messages, "", `the index-signature cargo survives composition:\n${messages}`)
})
