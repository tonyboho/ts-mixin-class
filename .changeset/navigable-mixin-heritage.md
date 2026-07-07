---
"ts-mixin-class": patch
---

Editor navigation now also works on a `@mixin` class's own `extends` clause:
go-to-definition, find-all-references, rename and quickinfo on the required-base name
(`@mixin class Tagged extends RequiredBase`) reach the real base class, generic mixins
with generic bases (`@mixin class Keeper<T> extends Store<T>`) included. Together with
the consumer-side coverage, base-name navigation now works in every well-typed heritage
clause with an explicit base.
