---
"ts-mixin-class": patch
---

Base-less consumers now reuse a mixin's canonical application instead of each growing its
own private copy: a mixin's member decorators, static field initializers and `static {}`
blocks run once (not once per consumer), and inherited static state is shared — exactly the
semantics of a hand-written `extends`, and consistent with consumers of a mixin that has a
required base (which already shared its application). Fewer classes are created at runtime.
