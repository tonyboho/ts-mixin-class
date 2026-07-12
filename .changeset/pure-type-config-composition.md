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

Contributors without a referenceable alias — non-construction mixins, named re-export
barrels, transitive generic dependencies, namespace members, nested declarations — keep
the previous flattened route, which remains fully supported.

A provably EMPTY contributor (no config keys, no index signatures) contributes nothing
instead of its alias: its own alias is the exact-empty shape, which must never join a
composition, and a required-config subclass of such a parent no longer trips the
static-side `new` compatibility check.
