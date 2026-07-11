---
"ts-mixin-class": patch
---

Fixed required-base selection: the effective base class of a consumer is now the most
specific one among all required bases of its mixins, transitively. Previously the first
base found was used, so composing mixins whose required bases inherit from each other
could pick the wrong base; genuinely incompatible required bases are now rejected with
a clear compile error.
