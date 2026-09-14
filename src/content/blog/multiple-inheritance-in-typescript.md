---
title: "Multiple inheritance in TypeScript, without the mixin pattern"
description: "Why ts-mixin-class uses the implements keyword and C3 linearization instead of the classic function-returning-a-class mixin pattern."
date: 2026-09-14
---

TypeScript officially answers the multiple inheritance question with the
[mixin pattern](https://www.typescriptlang.org/docs/handbook/mixins.html):
a function that takes a base class and returns a new class extending it.
It works, but the price is real — wrapper functions everywhere, lost
declaration merging, awkward `super` behavior, and types that get harder
to read with every layer.

`ts-mixin-class` takes a different route. You write normal classes and
combine them with the native `implements` keyword:

```ts
import { mixin } from "ts-mixin-class"

@mixin()
class Named {
    name: string = "Ada"

    label(): string {
        return this.name
    }
}

@mixin()
class Timestamped {
    createdAt: Date = new Date()

    age(): number {
        return Date.now() - this.createdAt.getTime()
    }
}

class User implements Named, Timestamped {
    describe(): string {
        return `${super.label()} / ${super.age()}ms`
    }
}
```

`User` instances get the fields and methods of both mixins, `instanceof`
works for each of them, and `super` calls follow a predictable order.

The order comes from C3 linearization — the same method-resolution-order
algorithm Python uses. It deduplicates diamond-shaped dependencies and
rejects genuinely incompatible orderings at compile time, instead of
silently picking one.

The linearization is precomputed by a build that runs the transformer,
so there is no runtime cost: no proxies, no per-call lookups, just a
regular prototype chain.

This blog will cover the design decisions behind the project: how the
transformer keeps the compiler, the language server, and the emitted
JavaScript in agreement, and what it takes to test that.

To try it without installing anything, there is a
[StackBlitz playground](https://stackblitz.com/~/github.com/tonyboho/ts-mixin-class-example?file=src/basic.ts).
