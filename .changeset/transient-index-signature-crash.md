---
"ts-mixin-class": patch
---

Fixed an editor crash: a half-typed `[` inside a class body (parsed as an incomplete index
signature) could crash a build that runs the transformer while a file with nested mixin
consumers was being edited; the transform now skips the malformed subtree for that
keystroke instead.
