---
"ts-mixin-class": patch
---

Editor navigation on the base name in an `extends` clause now works for every consumer:
go-to-definition, find-all-references, rename and quickinfo reach the real base class for
generic consumers, `Base`-construction consumers and qualified bases (`extends ns.Base`)
alike — including hover and rename inside the base's `<...>` type arguments.
