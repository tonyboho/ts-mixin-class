---
"ts-mixin-class": patch
---

Qualified bases are now full construction bases. A consumer extending a class through a
local namespace (`class Widget extends data.Model` where `data.Model` extends `Base`),
through a namespace import (`import * as lib` → `extends lib.Widget`), or through a local
namespace chain that passes over an imported intermediate base, gets the generated
`static new` factory and its `<Name>Config` alias with the whole chain's config keys
accumulated — including subclassing such a consumer from another file.
