---
"ts-mixin-class": patch
---

A qualified base resolved through a local namespace (`class Widget extends data.Model`
where `data.Model` extends `Base`) is now a full construction base: the consumer gets the
generated `static new` factory and its `<Name>Config` alias, with the base's config keys
accumulated through the qualified chain — including subclassing such a consumer from
another file.
