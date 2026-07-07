import type * as ts from "typescript"

import { dottedExpressionText } from "./expand-util.js"
import { linearizeDependencies } from "./linearization.js"
import { localMixinHeritageTypesFromFacts, resolveLocalMixinHeritageRef } from "./mixin-refs.js"
import {
    DependencyLinearizationError,
    mixinDiagnosticCode,
    nativeDiagnosticOn,
    type FileMixinContext,
    type TransformOptions
} from "./model.js"
import type { ClassFacts, SourceFileFacts } from "./source-file-facts.js"
import { hasModifier } from "./util.js"
import type { TypeScript } from "./util.js"

// The consumer-plane member-override guards and same-scope structural checks, on the native
// diagnostic channel: TS990008 (mixin used before its declaration — TDZ), TS990009 (namespace
// merged with a mixin class), TS990010 (member-KIND override mismatches, mirroring TS2610/11
// through the generated interface), TS990011 (PARTIAL accessor overrides). Extracted from the
// transform orchestrator; each guard takes the per-file state (facts / context / options)
// explicitly.

// Instance member kinds of a mixin/consumer class, extracted once per declaration NODE for the
// member-override guards (TS990010/TS990011) — one mixin serves many consumers, and both guards
// share one extraction. Keyed by AST node identity, so an edited file (fresh nodes) never reads
// a stale entry and old entries are GC'd with their tree.
type MixinInstanceMemberKinds = {
    accessors      : Set<string>,
    fields         : Set<string>,
    autoAccessors  : Set<string>,
    accessorHalves : Map<string, { get: boolean, set: boolean }>
}

const mixinInstanceMemberKindsCache = new WeakMap<ts.ClassDeclaration, MixinInstanceMemberKinds>()

// A class applying a local mixin DECLARED LATER IN THE SAME statement list: plain TS allows
// it (`implements` is type-only), but the expansion generates a VALUE reference to the mixin
// const, which module/block evaluation hits while still in the TDZ. TypeScript's own TS2448
// fires only on the emit plane and remaps to a misleading position (a fully-generated line
// falls back to the nearest preceding mapping — the import line), and the source-view plane
// reports nothing — so push a NATIVE diagnostic spanned on the heritage reference. A use from
// a DIFFERENT (deferred) scope — e.g. a function body applying a later top-level mixin — is
// legal at runtime (the parents differ), and an imported mixin has no declaration here.
export function pushMixinUsedBeforeDeclarationDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    context: FileMixinContext,
    classFacts: ClassFacts,
    statement: ts.Statement,
    siblings: readonly ts.Statement[]
): void {
    for (const heritageType of localMixinHeritageTypesFromFacts(tsInstance, classFacts, context)) {
        const expression    = heritageType.expression
        const referenceText = dottedExpressionText(tsInstance, expression)

        if (referenceText === undefined) {
            continue
        }

        const appliedDeclaration = resolveLocalMixinHeritageRef(tsInstance, heritageType, context)?.declaration

        if (appliedDeclaration === undefined) {
            continue
        }

        // The mixin's declaration must live in the CONSUMER's own statement list to be a TDZ
        // hazard — the declaration itself for a bare name (`implements Tagged`), or the
        // enclosing `namespace` statement for a qualified one (`implements NS.Tagger` above the
        // namespace reads `NS.Tagger` off a still-undefined `var NS`). Found by POSITION
        // containment over the sibling list, NOT a `.parent` walk: on the emit plane the
        // program-provided AST has no parent pointers (only positions survive), so the parent
        // check silently collapsed and false-fired on a DEFERRED-scope use (a top-level mixin
        // applied from a nested block — legal at runtime). A mixin in a different scope is not
        // a sibling here, so it is correctly ignored.
        const owningSibling = siblings.find((sibling) =>
            sibling.pos <= appliedDeclaration.pos && appliedDeclaration.end <= sibling.end)

        if (owningSibling === undefined || owningSibling === statement || owningSibling.pos <= statement.pos) {
            continue
        }

        context.nativeDiagnostics.push(nativeDiagnosticOn(
            tsInstance,
            sourceFile,
            expression,
            mixinDiagnosticCode.MixinUsedBeforeDeclaration,
            "Mixin used before its declaration. " +
                `Class ${classFacts.name ?? "<anonymous>"} implements ${referenceText}, ` +
                `but @mixin ${referenceText} is declared later in the same scope, so the generated ` +
                "runtime reference would run before the mixin's definition. " +
                "Declare the mixin before the class that applies it."
        ))
    }
}

// A namespace MERGED with a `@mixin` class (the static-helper pattern): plain TS allows the
// class+namespace merge, but the transformer rewrites the mixin class into a `const`, and a
// namespace cannot merge with a variable — the merge silently loses the namespace exports
// from the mixin's value type. A namespace whose body is TYPE-ONLY keeps working (qualified
// type access needs no value merge), so only an INSTANTIATED one is diagnosed.
function isTypeOnlyModuleBody(tsInstance: TypeScript, body: ts.ModuleDeclaration["body"]): boolean {
    if (body === undefined) {
        return true
    }

    if (tsInstance.isModuleBlock(body)) {
        return body.statements.every((inner) =>
            tsInstance.isInterfaceDeclaration(inner) ||
            tsInstance.isTypeAliasDeclaration(inner) ||
            tsInstance.isModuleDeclaration(inner) && isTypeOnlyModuleBody(tsInstance, inner.body))
    }

    return tsInstance.isModuleDeclaration(body) && isTypeOnlyModuleBody(tsInstance, body.body)
}

// A prescan over each statement LIST (merging is same-scope only, and namespaces live at
// the top level or in module blocks) — statement `parent` pointers are not reliable in the
// emit path, so the list itself is walked instead.
export function pushMixinNamespaceMergeDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    facts: SourceFileFacts,
    context: FileMixinContext,
    statements: readonly ts.Statement[]
): void {
    for (const statement of statements) {
        if (tsInstance.isModuleDeclaration(statement) &&
            statement.body !== undefined && tsInstance.isModuleBlock(statement.body)
        ) {
            pushMixinNamespaceMergeDiagnostics(tsInstance, sourceFile, facts, context, statement.body.statements)
        }

        if (!tsInstance.isClassDeclaration(statement)) {
            continue
        }

        const classFacts = facts.classesByDeclaration.get(statement)

        if (classFacts?.hasMixinDecorator !== true || classFacts.name === undefined) {
            continue
        }

        for (const sibling of statements) {
            if (!tsInstance.isModuleDeclaration(sibling) ||
                !tsInstance.isIdentifier(sibling.name) ||
                sibling.name.text !== classFacts.name ||
                isTypeOnlyModuleBody(tsInstance, sibling.body)
            ) {
                continue
            }

            context.nativeDiagnostics.push(nativeDiagnosticOn(
                tsInstance,
                sourceFile,
                sibling.name,
                mixinDiagnosticCode.MixinNamespaceMerge,
                `Namespace ${classFacts.name} merges with mixin class ${classFacts.name}, ` +
                    "which is not supported: the transformer rewrites the mixin class into a const, and a " +
                    "namespace cannot merge with it. Declare the helpers as static members of the mixin class instead."
            ))
        }
    }
}

// Instance member KINDS of a mixin class: accessor names vs data-field names (including
// constructor parameter properties). Used to mirror TypeScript's own TS2610/TS2611
// kind-mismatch override guards, which the generated interface cannot carry (the checker
// only applies them when the base member is declared in a CLASS). `accessorHalves` carries
// WHICH halves each accessor name declares (an auto-accessor is a full pair) for the
// partial-override guard (TS990011). Memoized per declaration NODE (module-level WeakMap):
// one mixin serves many consumers, and the two override guards share one extraction — an
// edited file gets fresh AST nodes, so entries never go stale.
function mixinInstanceMemberKinds(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): MixinInstanceMemberKinds {
    const cached = mixinInstanceMemberKindsCache.get(declaration)

    if (cached !== undefined) {
        return cached
    }

    const accessors      = new Set<string>()
    const fields         = new Set<string>()
    const autoAccessors  = new Set<string>()
    const accessorHalves = new Map<string, { get: boolean, set: boolean }>()

    const addHalf = (name: string, half: "get" | "set"): void => {
        const halves = accessorHalves.get(name) ?? { get: false, set: false }

        halves[half] = true

        accessorHalves.set(name, halves)
    }

    for (const member of declaration.members) {
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword)) {
            continue
        }

        if (tsInstance.isConstructorDeclaration(member)) {
            for (const parameter of member.parameters) {
                if (tsInstance.isParameterPropertyDeclaration(parameter, member) &&
                    tsInstance.isIdentifier(parameter.name)
                ) {
                    fields.add(parameter.name.text)
                }
            }
            continue
        }

        if (member.name === undefined || tsInstance.isPrivateIdentifier(member.name)) {
            continue
        }

        const name = tsInstance.isIdentifier(member.name) || tsInstance.isStringLiteral(member.name)
            ? member.name.text
            : undefined

        if (name === undefined) {
            continue
        }

        if (tsInstance.isGetAccessorDeclaration(member)) {
            accessors.add(name)
            addHalf(name, "get")
        } else if (tsInstance.isSetAccessorDeclaration(member)) {
            accessors.add(name)
            addHalf(name, "set")
        } else if (tsInstance.isPropertyDeclaration(member)) {
            // An AUTO-ACCESSOR (`accessor x`) is syntactically a PropertyDeclaration but at
            // runtime a get/set pair on the prototype — classify by the RUNTIME kind.
            if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.AccessorKeyword)) {
                autoAccessors.add(name)
                addHalf(name, "get")
                addHalf(name, "set")
            } else {
                fields.add(name)
            }
        }
    }

    const kinds: MixinInstanceMemberKinds = { accessors, fields, autoAccessors, accessorHalves }

    mixinInstanceMemberKindsCache.set(declaration, kinds)

    return kinds
}

// The DIRECTLY applied mixin layers of a class, nearest-first: its own `implements` list
// (first-listed = nearest — §2.6), continued through a LOCAL `extends` chain of consumers
// (a base consumer's mixins are deeper layers). A ref without a program-local declaration
// (a `.d.ts` mixin) cannot be inspected — skipped. Shared by the member-override guards
// (TS990010 kind mismatches, TS990011 partial accessor overrides).
function collectAppliedMixinRefs(
    tsInstance: TypeScript,
    facts: SourceFileFacts,
    context: FileMixinContext,
    classFacts: ClassFacts
): { name: string, key: string, declaration: ts.ClassDeclaration }[] {
    const appliedRefs: { name: string, key: string, declaration: ts.ClassDeclaration }[] = []
    const seen                                                                           = new Set<string>()
    let cursor: ClassFacts | undefined                                                   = classFacts

    while (cursor !== undefined) {
        for (const heritageType of localMixinHeritageTypesFromFacts(tsInstance, cursor, context)) {
            const expression = heritageType.expression as ts.Identifier
            const ref        = resolveLocalMixinHeritageRef(tsInstance, heritageType, context)

            if (ref?.declaration !== undefined && !seen.has(expression.text)) {
                seen.add(expression.text)
                appliedRefs.push({ name: expression.text, key: ref.key, declaration: ref.declaration })
            }
        }

        const baseExpression: ts.Expression | undefined = cursor.extendsType?.expression

        cursor = undefined

        if (baseExpression !== undefined && tsInstance.isIdentifier(baseExpression) &&
            !seen.has("extends:" + baseExpression.text)
        ) {
            seen.add("extends:" + baseExpression.text)
            cursor = facts.classesByName.get(baseExpression.text)
        }
    }

    return appliedRefs
}

// Mirrors plain TypeScript's TS2610/TS2611: overriding an ACCESSOR with an instance FIELD
// (or a field with an accessor) is rejected for ordinary class bases, unconditionally —
// but the checker only fires those when the base member is declared in a class, and a
// mixin's members reach the consumer through the generated INTERFACE, where accessor-ness
// does not count. Re-created here on the native channel, covering:
// - the class's OWN members against every applied mixin (incl. transitively through a
//   LOCAL `extends` chain of consumers),
// - mixin-vs-mixin overlaps in one `implements` list (the FIRST-listed mixin is the
//   nearest layer — §2.6 — so it is the overriding side).
// A ref without a program-local declaration (a `.d.ts` mixin) cannot be inspected — skipped.
export function pushMixinMemberKindOverrideDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    facts: SourceFileFacts,
    context: FileMixinContext,
    options: TransformOptions,
    classFacts: ClassFacts,
    statement: ts.Statement
): void {
    // Declared-kind mismatches exist ONLY under DEFINE semantics (useDefineForClassFields),
    // where a field becomes an own property that buries a prototype accessor. Under SET
    // semantics both directions are sound: a "field" over an accessor is just an initializing
    // assignment through the setter (the accessor stays on the prototype), and a deeper
    // field's constructor assignment fires an overriding accessor's setter. Deliberate
    // deviation from plain TS2610/TS2611, which reject unconditionally.
    //
    // The ONE exception is an AUTO-ACCESSOR (`accessor x`) overriding a deeper FIELD: its
    // backing storage is a private slot installed only after super() returns, so under set
    // semantics the deeper field's constructor assignment fires the generated setter BEFORE
    // the slot exists — a guaranteed TypeError at construction time. That direction is
    // rejected under BOTH semantics.
    const defineSemantics = options.useDefineForClassFields
    const appliedRefs     = collectAppliedMixinRefs(tsInstance, facts, context, classFacts)

    if (appliedRefs.length === 0) {
        return
    }

    const kindsOf   = appliedRefs.map((ref) => mixinInstanceMemberKinds(tsInstance, ref.declaration))
    const className = classFacts.name ?? "<anonymous>"

    const push = (node: ts.Node, message: string): void => {
        context.nativeDiagnostics.push(nativeDiagnosticOn(
            tsInstance,
            sourceFile,
            node,
            mixinDiagnosticCode.MixinMemberKindOverride,
            message
        ))
    }

    // The class's OWN members against every applied mixin.
    for (const member of (tsInstance.isClassDeclaration(statement) ? statement.members : [])) {
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) ||
            member.name === undefined ||
            !(tsInstance.isIdentifier(member.name) || tsInstance.isStringLiteral(member.name))
        ) {
            continue
        }

        const name = member.name.text

        const isAutoAccessor = tsInstance.isPropertyDeclaration(member) &&
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.AccessorKeyword)
        const isField        = tsInstance.isPropertyDeclaration(member) && !isAutoAccessor
        const isAccessor     = tsInstance.isGetAccessorDeclaration(member) ||
            tsInstance.isSetAccessorDeclaration(member)

        for (const [ index, ref ] of appliedRefs.entries()) {
            if (defineSemantics && isField &&
                (kindsOf[index].accessors.has(name) || kindsOf[index].autoAccessors.has(name))
            ) {
                push(member.name, `Invalid mixin member override. '${name}' is defined as an accessor ` +
                    `in mixin ${ref.name}, but is overridden in ${className} as an instance property. ` +
                    "An instance field would bury the mixin's accessor; declare a get/set pair instead.")
            }

            if (defineSemantics && isAccessor && kindsOf[index].fields.has(name)) {
                push(member.name, `Invalid mixin member override. '${name}' is defined as a property ` +
                    `in mixin ${ref.name}, but is overridden in ${className} as an accessor. ` +
                    "The mixin's field initializer would bury the accessor; declare a field instead.")
            }

            if (isAutoAccessor && kindsOf[index].fields.has(name)) {
                push(member.name, `Invalid mixin member override. '${name}' is defined as a property ` +
                    `in mixin ${ref.name}, but is overridden in ${className} as an auto-accessor ` +
                    "('accessor'). The mixin's field would bury the accessor under define semantics, " +
                    "and under set semantics its constructor assignment fires the generated setter " +
                    "before the auto-accessor's private backing storage is installed — a TypeError at " +
                    "construction time. Declare a field or a get/set pair over a public backing field instead.")
            }
        }
    }

    // Mixin-vs-mixin overlaps: the FIRST-listed mixin is the nearest (overriding) layer.
    for (let near = 0; near < appliedRefs.length; near++) {
        for (let deep = near + 1; deep < appliedRefs.length; deep++) {
            if (defineSemantics) {
                for (const name of kindsOf[near].fields) {
                    if (kindsOf[deep].accessors.has(name) || kindsOf[deep].autoAccessors.has(name)) {
                        push(statement, `Invalid mixin member override. '${name}' is defined as an accessor ` +
                            `in mixin ${appliedRefs[deep].name}, but mixin ${appliedRefs[near].name} (a nearer ` +
                            `layer of ${className}) re-declares it as an instance property, which would bury the accessor.`)
                    }
                }

                for (const name of kindsOf[near].accessors) {
                    if (kindsOf[deep].fields.has(name)) {
                        push(statement, `Invalid mixin member override. '${name}' is defined as a property ` +
                            `in mixin ${appliedRefs[deep].name}, but mixin ${appliedRefs[near].name} (a nearer ` +
                            `layer of ${className}) re-declares it as an accessor, which the deeper field ` +
                            "initializer would bury at construction time.")
                    }
                }
            }

            // A nearer AUTO-ACCESSOR over a deeper field: rejected under BOTH semantics
            // (see the function comment — the private backing slot does not exist yet when
            // the deeper field's constructor assignment fires the generated setter).
            for (const name of kindsOf[near].autoAccessors) {
                if (kindsOf[deep].fields.has(name)) {
                    push(statement, `Invalid mixin member override. '${name}' is defined as a property ` +
                        `in mixin ${appliedRefs[deep].name}, but mixin ${appliedRefs[near].name} (a nearer ` +
                        `layer of ${className}) re-declares it as an auto-accessor ('accessor'), whose ` +
                        "private backing storage is not installed yet when the deeper field's constructor " +
                        "assignment fires the generated setter — a TypeError at construction time.")
                }
            }
        }
    }
}

// PARTIAL accessor overrides across the mixin chain (TS990011). JS prototype shadowing is
// per-NAME, not per-half: a nearer accessor descriptor replaces the deeper one ENTIRELY, so
// an override declaring FEWER halves than the overridden accessor silently kills the missing
// half at runtime (a dead setter → strict-mode TypeError on write; a dead getter → undefined
// reads) while the merged type still looks whole. Rule: an override's half-set must be a
// SUPERSET of the overridden one — extending is legal, narrowing is an error. Unlike the
// kind guard above, the hazard does not depend on define/set semantics, so it is
// unconditional. Scope: MIXIN layers only (the class's own members against every mixin layer
// of its LINEARIZED chain — transitive dependencies included — plus mixin-vs-mixin overlaps
// in the directly listed refs); an override of the class's own `extends` base is ordinary
// class inheritance, which plain TypeScript deliberately leaves unchecked.
export function pushPartialAccessorOverrideDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    facts: SourceFileFacts,
    context: FileMixinContext,
    classFacts: ClassFacts,
    statement: ts.Statement
): void {
    const directRefs = collectAppliedMixinRefs(tsInstance, facts, context, classFacts)

    if (directRefs.length === 0) {
        return
    }

    const className = classFacts.name ?? "<anonymous>"

    const push = (node: ts.Node, message: string): void => {
        context.nativeDiagnostics.push(nativeDiagnosticOn(
            tsInstance,
            sourceFile,
            node,
            mixinDiagnosticCode.MixinPartialAccessorOverride,
            message
        ))
    }

    const shapeOf = (
        kinds: ReturnType<typeof mixinInstanceMemberKinds>,
        name: string,
        halves: { get: boolean, set: boolean }
    ): string => {
        if (kinds.autoAccessors.has(name)) {
            return "an auto-accessor ('accessor')"
        }

        return halves.get && halves.set ? "a get/set pair" : halves.get ? "a get accessor" : "a set accessor"
    }

    const missingHalfOf = (near: { get: boolean, set: boolean }, deep: { get: boolean, set: boolean }): string | undefined => {
        return deep.get && !near.get ? "get" : deep.set && !near.set ? "set" : undefined
    }

    // The class's OWN accessor declarations (get/set siblings merged into one half-set per
    // name; an auto-accessor is a full pair and can never narrow, so it is not collected).
    const ownHalves = new Map<string, { node: ts.Node, get: boolean, set: boolean }>()

    for (const member of (tsInstance.isClassDeclaration(statement) ? statement.members : [])) {
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) ||
            member.name === undefined ||
            !(tsInstance.isIdentifier(member.name) || tsInstance.isStringLiteral(member.name))
        ) {
            continue
        }

        const isGet = tsInstance.isGetAccessorDeclaration(member)
        const isSet = tsInstance.isSetAccessorDeclaration(member)

        if (!isGet && !isSet) {
            continue
        }

        const name  = member.name.text
        const entry = ownHalves.get(name) ?? { node: member.name, get: false, set: false }

        // eslint-disable-next-line align-assignments/align-assignments -- false positive on `||=`
        entry.get ||= isGet
        entry.set ||= isSet

        ownHalves.set(name, entry)
    }

    if (ownHalves.size > 0) {
        // The class's own members are checked against the FULL linearized chain (a
        // transitive dependency is a runtime layer like any other). Linearized only when
        // the class actually declares accessors — the common accessor-less class skips the
        // C3 merge entirely. On a linearization conflict fall back to the direct refs — the
        // conflict has its own diagnostic (TS990007).
        let chainRefs: { name: string, declaration: ts.ClassDeclaration }[]

        try {
            chainRefs = linearizeDependencies(directRefs.map((ref) => ref.key), context)
                .filter((ref) => ref.declaration !== undefined)
                .map((ref) => ({ name: ref.className, declaration: ref.declaration as ts.ClassDeclaration }))
        } catch (error) {
            if (!(error instanceof DependencyLinearizationError)) {
                throw error
            }
            chainRefs = directRefs
        }

        for (const ref of chainRefs) {
            const kinds = mixinInstanceMemberKinds(tsInstance, ref.declaration)

            for (const [ name, own ] of ownHalves) {
                const deep = kinds.accessorHalves.get(name)

                if (deep === undefined) {
                    continue
                }

                const missing = missingHalfOf(own, deep)

                if (missing !== undefined) {
                    push(own.node, `Invalid mixin member override. '${name}' is declared as ` +
                        `${shapeOf(kinds, name, deep)} in mixin ${ref.name}, but ${className} overrides only ` +
                        `${own.get ? "the getter" : "the setter"}. JS prototype shadowing replaces an accessor ` +
                        `per NAME, not per half, so the mixin's ${missing} accessor would silently disappear ` +
                        `at runtime. Declare the missing ${missing} accessor as well.`)
                }
            }
        }
    }

    // Mixin-vs-mixin overlaps among the DIRECTLY listed refs (first-listed = nearest). A
    // narrowing that lives in a mixin's own declaration (a mixin over its dependency) is
    // reported there by the own-members check above, so transitive pairs are not re-walked.
    for (let near = 0; near < directRefs.length; near++) {
        const nearKinds = mixinInstanceMemberKinds(tsInstance, directRefs[near].declaration)

        if (nearKinds.accessorHalves.size === 0) {
            continue
        }

        for (let deep = near + 1; deep < directRefs.length; deep++) {
            const deepKinds = mixinInstanceMemberKinds(tsInstance, directRefs[deep].declaration)

            for (const [ name, nearHalves ] of nearKinds.accessorHalves) {
                const deepHalves = deepKinds.accessorHalves.get(name)

                if (deepHalves === undefined) {
                    continue
                }

                const missing = missingHalfOf(nearHalves, deepHalves)

                if (missing !== undefined) {
                    push(statement, `Invalid mixin member override. '${name}' is declared as ` +
                        `${shapeOf(deepKinds, name, deepHalves)} in mixin ${directRefs[deep].name}, but mixin ` +
                        `${directRefs[near].name} (a nearer layer of ${className}) re-declares it as ` +
                        `${shapeOf(nearKinds, name, nearHalves)} — the ${missing} accessor of ` +
                        `${directRefs[deep].name} would silently disappear at runtime for every ${className} ` +
                        `instance. Declare the missing ${missing} accessor in ${directRefs[near].name}.`)
                }
            }
        }
    }
}
