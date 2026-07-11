---
"ts-mixin-class": patch
---

Fixed generic required bases: a generic mixin's required base (`@mixin class M<T> extends
Base<T>`) is now resolved at the use site (`implements M<U>` or `implements M<string>`),
transitively. Previously a consumer of such a mixin without an explicit base was rejected
with spurious errors (`Cannot find name 'T'`); now it compiles, picks the most specific
base across generic inheritance chains at compile time, mismatched explicit bases are
reported in both the build and the editor naming the instantiated requirement, and
incompatible concrete instantiations are rejected with a clear compile error.
