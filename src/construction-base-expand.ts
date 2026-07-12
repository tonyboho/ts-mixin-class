import type * as ts from "typescript"
import { constructionHeadType } from "./construction-brand.js"
import { fillMissedInitializersClass } from "./construction-initializers.js"
import {
    createConstructionMembers,
    positionConstructionConfigAlias
} from "./construction-config.js"
import { heritageTypeToTypeReference } from "./expand-util.js"
import { expressionToEntityName } from "./entity-name.js"
import type { CrossFileContext, ImportMap, NativeMixinDiagnostic, TransformOptions } from "./model.js"
import { generatedTextRange, preserveTextRange } from "./text-range.js"
import { cloneNode } from "./util.js"
import type { TypeScript } from "./util.js"

// Statement-level expansion of a mixin-LESS construction base class (`class Model extends
// Base`): the generated `static new` factory + `<Name>Config` alias, and the branded
// re-extend that makes a direct `new Model(...)` a type error. The third class-kind
// expansion, next to `mixin-expand.ts` (mixins) and `consumer-expand.ts` (consumers).

export function expandConstructionBaseClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    options: TransformOptions,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    nativeDiagnostics?: NativeMixinDiagnostic[],
    usedImports?: Map<string, { specifier: string, importedName: string, localName: string, typeOnly?: boolean }>
): ts.Statement[] {
    const factory      = tsInstance.factory
    const extendsType  = declaration.heritageClauses?.find((clause) => {
        return clause.token === tsInstance.SyntaxKind.ExtendsKeyword
    })?.types[0]
    const rewritten    = fillMissedInitializersClass(tsInstance, declaration, options)
    const construction = createConstructionMembers(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        undefined,
        [],
        options,
        // Anchor the generated `static new` to the END of the class body in BOTH modes.
        // `declaration.pos` (used for emit before) includes leading trivia, so it points
        // at the previous sibling's `}`; a diagnostic on the generated member (e.g. a
        // perturbed config key) then remaps onto the *previous* class, diverging from the
        // source-view position. `members.end` keeps it inside this class (parity).
        generatedTextRange(sourceFile, declaration.members.end),
        crossFile,
        baseImportMap,
        false,
        nativeDiagnostics,
        usedImports
    )

    if (construction.members.length === 0) {
        return [ rewritten ]
    }

    const updatedClass         = factory.updateClassDeclaration(
        rewritten,
        rewritten.modifiers,
        rewritten.name,
        rewritten.typeParameters,
        brandedConstructionHeritageClauses(tsInstance, declaration, rewritten, extendsType, options, construction.dropInheritedStaticNew),
        preserveTextRange(
            tsInstance,
            factory.createNodeArray([ ...rewritten.members, ...construction.members ]),
            rewritten.members
        )
    )
    const configAliasStatement = [ construction.configAlias, construction.configMeta ]
        .filter((companion): companion is ts.TypeAliasDeclaration => companion !== undefined)
        .map((companion) => positionConstructionConfigAlias(
            tsInstance,
            companion,
            // Anchor just past the closing brace, OUTSIDE the class body, so the alias
            // overlaps no sibling; both modes share that real position (stress parity).
            generatedTextRange(sourceFile, declaration.end),
            declaration
        ))

    return [ updatedClass, ...configAliasStatement ]
}

// Replaces the construction base class's `extends Base` clause with a branded cast so
// `new Model(...)` is a type error (construction goes through the generated static
// `new`). In source view this is gated to a simple identifier base (a qualified
// `ns.Base` keeps its literal, navigable heritage and is still guarded by the emitted
// `tsc` build). Non-extends clauses (`implements`) and the original positions are kept.
function brandedConstructionHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    rewritten: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    options: TransformOptions,
    dropInheritedStaticNew: boolean
): ts.NodeArray<ts.HeritageClause> | undefined {
    const heritageClauses = rewritten.heritageClauses

    if (heritageClauses === undefined ||
        extendsType === undefined ||
        declaration.name === undefined ||
        // A class with its own constructor opts into manual construction; branding the
        // base would only break its `super(...)` call (see consumer-expand's gate).
        declaration.members.some((member) => tsInstance.isConstructorDeclaration(member)) ||
        (options.sourceView && !tsInstance.isIdentifier(extendsType.expression))
    ) {
        return heritageClauses
    }

    const brandedClause = brandedConstructionBaseHeritage(
        tsInstance,
        extendsType,
        declaration.name.text,
        options,
        dropInheritedStaticNew
    )

    return preserveTextRange(
        tsInstance,
        tsInstance.factory.createNodeArray(heritageClauses.map((clause) => {
            return clause.token === tsInstance.SyntaxKind.ExtendsKeyword ? brandedClause : clause
        })),
        heritageClauses
    )
}

// Heritage for a mixin-LESS construction base class (`class Model extends Base`,
// `expandConstructionBaseClass`). These keep a literal `extends` in stock output, but
// to make `new Model(...)` a type error we re-extend the base under a single-source
// branded cast (`extends (Base as unknown as <branded construct + base statics>)`).
// Emit erases the `as` so the runtime stays `extends Base`; the cast only poisons the
// construct signature seen by the checker and downstream `.d.ts`.
//
// In source view the real base identifier is pinned over the source `extends Base`
// span (navigation + invariant #5) exactly like the navigable consumer fast path, so
// it is gated to a simple identifier base by the caller. In emit, positions do not
// matter, so the whole cast is left synthetic.
function brandedConstructionBaseHeritage(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments,
    consumerName: string,
    options: TransformOptions,
    dropInheritedStaticNew: boolean
): ts.HeritageClause {
    const factory = tsInstance.factory

    const baseExpression = cloneNode(tsInstance, extendsType.expression)
    const castType       = constructionHeadType(
        tsInstance,
        expressionToEntityName(tsInstance, extendsType.expression),
        { consumerName, branded: true, omitInheritedStaticNew: dropInheritedStaticNew },
        heritageTypeToTypeReference(tsInstance, extendsType)
    )
    const innerAs        = factory.createAsExpression(
        baseExpression,
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
    )
    const outerAs        = factory.createAsExpression(innerAs, castType)
    const extendsExpr    = factory.createExpressionWithTypeArguments(outerAs, undefined)

    if (!options.sourceView) {
        return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [ extendsExpr ])
    }

    const fullRange = extendsType

    preserveTextRange(tsInstance, baseExpression, fullRange)
    preserveTextRange(tsInstance, innerAs, fullRange)
    preserveTextRange(tsInstance, outerAs, fullRange)
    preserveTextRange(tsInstance, extendsExpr, fullRange)

    const heritageClause = factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [ extendsExpr ])

    preserveTextRange(tsInstance, heritageClause.types, fullRange)

    return preserveTextRange(tsInstance, heritageClause, fullRange)
}
