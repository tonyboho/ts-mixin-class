---
"ts-mixin-class": patch
---

A batch of edge-case fixes driven by new coverage:

- Construction configs now support EXOTIC keys: numeric (`public 0!`), string-literal
  (`public "dash-name"!`), computed const-string and unique-symbol keys (`public [key]!` —
  typed through `typeof key`, same-file consumers), and class index signatures (the config
  object's bag keys stay value-constrained). Requiredness and value types are preserved.
- A published (`.d.ts`) mixin's construction config is now recovered from its generated
  `"new"(props?: <Name>Config)` member instead of the interface, so a settable accessor's
  key keeps the SETTER's wider write type through the package boundary and non-config
  interface members no longer read as required keys.
- The manual `.mix(Base)` of a published construction mixin now keeps the factual base's
  own `.new` contract (config keys and return type) instead of widening to the package
  `Base`.
- The program-local manual `.mix` ban (TS990012) now also catches namespace-qualified
  (`lib.Logger.mix(...)`) and parenthesized (`(Logger).mix(...)`) applications.
- Static-member collision diagnostics now detect and name symbol-keyed statics
  (`static [shared]`).
- A namespace-qualified generic construction mixin (`implements NS.Boxed<string>`)
  substitutes its type parameter into the consumer's config.
