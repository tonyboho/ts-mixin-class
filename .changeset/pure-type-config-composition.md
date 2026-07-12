---
"ts-mixin-class": patch
---

Config transport as PURE TYPE composition (the tree form). A construction class's
`<Name>Config` alias now REFERENCES its contributors' own config aliases instead of
re-spelling their accumulated keys: each level spells only its own keys, local
contributors join by name, and imported ones through a generated type-only import
(`import type { XConfig as __X$config } from "…"`). Key precedence (nearest declaration
wins) and monotonic requiredness are enforced with overlap-gated `Omit` /
`Required<Pick<…>>` steps — emitted only where a nearer layer actually redeclares a
deeper key.

What this changes for users:

- COMPUTED (const-string / unique-symbol) config keys now carry across source files AND
  package boundaries with their identity, value types and requiredness intact — the
  previous "computed keys are deliberately omitted cross-file" rule is gone.
- GENERIC published contributors instantiate at the use site (`implements Boxed<string>`
  over a `.d.ts` package yields `BoxedConfig<string>` in the downstream config) — the
  generic exotic-keys gap is closed.
- The published `.d.ts` shape changed wholesale (pre-1.0, no compatibility layer): the
  `NonNullable<Parameters<…>>` value-route carrier is gone, downstream key inventories
  are read from the `<Name>ConfigMeta` companion, and configs of packages built with
  older versions degrade gracefully (typing still rides their exported config aliases).

RE-EXPORT BARRELS carry construction now. Subclassing a construction base imported
through a barrel (a source `export *` / named / aliased re-export, or a declaration
package's entry-point barrel) previously lost construction silently — the subclass kept
the parent's `.new`; a `.d.ts` mixin re-exported through a package barrel was not
recognized at all. Both registries now resolve barrel imports to the declaring entry.
The alias route rides barrels too, when the barrel provably forwards the `<Name>Config`
companion (an `export *` chain always does; a named barrel only if it lists the alias
un-renamed) — the generated type-only import then uses the consumer's own barrel
specifier, so computed keys keep their identity and requiredness even when the declaring
module is not addressable through the package's `exports`.

Contributors without a referenceable alias — non-construction mixins, named re-export
barrels that forward only the class value, transitive generic dependencies, namespace
members, nested declarations — keep the previous flattened route, which remains fully
supported.

A provably EMPTY contributor (no config keys, no index signatures) contributes nothing
instead of its alias: its own alias is the exact-empty shape, which must never join a
composition, and a required-config subclass of such a parent no longer trips the
static-side `new` compatibility check.

The `<Name>ConfigMeta` companion is compositional too — inventory a class cannot
respell (an upstream package's computed keys, index kinds) references the
contributor's own meta instead of silently vanishing, so the published inventory stays
exact across any number of package generations. Second-generation packages (built on
top of another construction package, never mentioning the transformer themselves) are
now recognized as construction bases.
