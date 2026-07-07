---
"ts-mixin-class": patch
---

The injected helper-type imports (`AnyConstructor`, `ClassStatics`, `MixinFactory`,
`RuntimeMixinClass`, ...) now ride reserved `__X__` aliases, like the value helpers always
did. A file declaring its own type under one of those names — or importing the helper from
the package itself — used to fail with TS2440/TS2300 as soon as it also declared a mixin or
consumer; the public helper names now stay free for user code.
