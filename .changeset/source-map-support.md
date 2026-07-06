---
"ts-mixin-class": patch
---

**Source map support.** A build that runs the transformer used to emit broken maps: the
coordinates were computed over the internally reprinted text, so every position below the
first generated insertion drifted — breakpoints landed on wrong lines or beyond the end of
the file, and stack traces lied. Emitted maps now compose back to the real source: user
code maps exactly (line and column, including field initializers hoisted into a generated
constructor), generated statements carry no mapping into user lines (the debugger falls
back to the raw generated output there), and a file the transform leaves untouched emits
output byte-identical to a plugin-less build. Covers `sourceMap`, `inlineSourceMap`,
`inlineSources` (embeds the original text, not the reprint), and `declarationMap`.
