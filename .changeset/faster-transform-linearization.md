---
"ts-mixin-class": patch
---

Faster per-file transform. The compile-time C3 linearization now caches the merge of a
whole dependency list (not just each dependency's own linearization), so a class whose
order is computed several times per pass — and identical dependency lists shared across
consumers — reuse one result. The facts pass skips its whole-tree walk when the file
text proves it holds no nested or expression classes, and the import-pruning reference
walk collects only the names import management actually asks about. On the largest
transform benchmark this cuts the pass by ~28% (source view) and ~26% (emit), with no
change to emitted output.
