---
"ts-mixin-class": patch
---

Config companion-type groundwork (first installment of the pure-type config transport):

- The `<ClassName>Config` and `<ClassName>ConfigMeta` names are RESERVED next to every
  construction class: a colliding top-level user declaration or import is a native
  TS990015 in both planes (rename it). The previous silent `ModelConfig_` underscore
  fallback is gone — the companion name is always derivable from the class name.
- Default-exported construction classes and mixins are BANNED (native TS990016, both
  planes): a default export keeps the generated `<Name>Config` companion module-local,
  so nothing downstream could reference it by name. Use a named export. Default-exported
  NON-construction mixins are unaffected. (This reverses the short-lived default-exported
  construction-base support through declarations.)
- Every EXPORTED construction class additionally emits an exported `<ClassName>ConfigMeta`
  alias of literal construction facts (`requiresArgument`, `requiredKeys`, `keys`,
  `indexKinds`) into declaration output — an internal, emit-plane-only companion for
  downstream tooling; source view does not carry it.
