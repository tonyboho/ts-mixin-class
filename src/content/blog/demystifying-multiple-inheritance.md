---
title: "Demystifying Multiple Inheritance"
description: "Extending your single-inheritance intuition to multiple inheritance — which turns out to be just as simple."
date: 2026-09-14
---

## Intro

In this post I want to show how to <span class="emphasis">adjust your intuition</span> about single
inheritance so that it extends naturally to multiple inheritance — and to
convince you that, seen through that adjusted intuition, multiple
inheritance is barely different from the single kind, and just as simple.

Inheritance is one of the most powerful ideas in the history of
programming, and the cornerstone of object-oriented programming. It is
intuitive because it mirrors the natural language we use to describe
reality: *a dog is a mammal*. But the hierarchy that single inheritance
builds is only ever a tree — and traits cannot be carried across its
branches: whatever one branch developed, no other branch can reuse. The
real world does this casually, having reinvented flight, vision and
echolocation across long-separated branches of the tree of life.

The natural extension — multiple inheritance — has existed since the late
seventies: it first appeared in Flavors, the Lisp Machine object system
that also gave us the word *mixin*. Yet it earned a <span class="emphasis">bad reputation</span> and
never made it into the newer mainstream languages: Java and JavaScript do
not have it, C# kept only the multiple inheritance of interfaces; C++ and
Python remain the exceptions. The likely reason is C++ itself. The most
influential language of that era implemented multiple inheritance in a
far-from-ideal way, and the feature’s reputation was cast from that mold —
by the time Java deliberately left it out, Gosling could dismiss it as one
of the "rarely used, poorly understood, confusing features of C++".

Yet a <span class="emphasis">simple, intuitive way of doing multiple inheritance</span> does exist:
the C3 linearization algorithm, born in the Dylan language (OOPSLA, 1996)
and serving in Python to this day. So let’s first spell out the
problem multiple inheritance is blamed for — and then look at what C3
actually does about it.

## The "diamond" problem

The central difficulty of multiple inheritance is known as the *diamond
problem*. It appears as soon as the same ancestor can be reached through
more than one path — and the paths disagree about what should happen along
the way.

Imagine JavaScript allowed multiple inheritance with the obvious syntax.
Here is the classic shape of the problem:

```js
class A {
    greet() { return "A" }
}

class B extends A {
    greet() { return "B" }
}

class C extends A {
    greet() { return "C" }
}

class D extends B, C {}
```

Both `B` and `C` inherit from `A`, and each overrides `greet` in its own
way. Then `D` inherits from both of them — and reaches `A` twice, once
through each parent. Drawn on paper, the inheritance graph forms a diamond,
which is what gives the problem its name.

<figure class="diagram">
<svg viewBox="0 0 400 305" width="400" role="img" aria-label="The classic diamond: B and C extend A, D extends B and C">
    <defs>
        <marker id="arr-d" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" style="fill:var(--muted)" />
        </marker>
    </defs>
    <g style="stroke:var(--muted);stroke-width:1.2" marker-end="url(#arr-d)">
        <line x1="131.1" y1="143.4" x2="186.7" y2="60" />
        <line x1="268.9" y1="143.4" x2="213.3" y2="60" />
        <line x1="188.9" y1="263.4" x2="133.3" y2="180" />
        <line x1="211.1" y1="263.4" x2="266.7" y2="180" />
    </g>
    <g style="font-family:var(--mono);font-size:11px;fill:var(--muted)">
        <text x="178" y="252" text-anchor="end">1</text>
        <text x="222" y="252">2</text>
    </g>
    <g style="fill:var(--bg);stroke:var(--hair)">
        <circle cx="200" cy="40"  r="20" />
        <circle cx="120" cy="160" r="20" />
        <circle cx="280" cy="160" r="20" />
        <circle cx="200" cy="280" r="20" />
    </g>
    <g style="font-family:var(--mono);font-size:15px;fill:var(--fg)" text-anchor="middle">
        <text x="200" y="40" dy=".35em">A</text>
        <text x="120" y="160" dy=".35em">B</text>
        <text x="280" y="160" dy=".35em">C</text>
        <text x="200" y="280" dy=".35em">D</text>
    </g>
</svg>
<figcaption>
    The classic diamond: <code>D</code> inherits <code>A</code> through two
    paths, and each path overrides <code>greet</code> differently.
</figcaption>
</figure>

Now, what should this return?

```js
new D().greet() // "B" or "C"?
```

Both answers are defensible, and the language has no obvious grounds to
prefer one.

## The inconsistency problem

And it can get worse. The paths may not merely differ — they may outright
contradict each other about the order of the same ancestors.

We write two base classes, `X` and `Y`, each with its own version of the
same method:

```js
class X {
    greet() { return "X" }
}

class Y {
    greet() { return "Y" }
}

class A extends X, Y {}

class B extends Y, X {}

class C extends A, B {}
```

`A` and `B` combine the same two ancestors — only in the opposite order.
`A` says that `X` takes precedence over `Y`; `B` insists on the reverse.
Then `C` inherits from both of them.

Now, what should this return?

```js
new C().greet() // "X" or "Y"?
```

`C` reaches both `X` and `Y` twice, once through each parent — and its
parents give contradictory answers about which of the two wins. Any fixed
choice silently betrays one of them.

<figure class="diagram">
<svg viewBox="0 0 400 305" width="400" role="img" aria-label="Inheritance graph: A extends X then Y, B extends Y then X, C extends A and B">
    <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" style="fill:var(--muted)" />
        </marker>
    </defs>
    <g style="stroke:var(--muted);stroke-width:1.2" marker-end="url(#arr)">
        <line x1="120" y1="140" x2="120" y2="64" />
        <line x1="136" y1="148" x2="260.8" y2="54.4" />
        <line x1="280" y1="140" x2="280" y2="64" />
        <line x1="264" y1="148" x2="139.2" y2="54.4" />
        <line x1="188.9" y1="263.4" x2="132.2" y2="178.3" />
        <line x1="211.1" y1="263.4" x2="267.8" y2="178.3" />
    </g>
    <g style="font-family:var(--mono);font-size:11px;fill:var(--muted)">
        <text x="110" y="126" text-anchor="end">1</text>
        <text x="150" y="140">2</text>
        <text x="290" y="126">1</text>
        <text x="250" y="140" text-anchor="end">2</text>
    </g>
    <g style="fill:var(--bg);stroke:var(--hair)">
        <circle cx="120" cy="40"  r="20" />
        <circle cx="280" cy="40"  r="20" />
        <circle cx="120" cy="160" r="20" />
        <circle cx="280" cy="160" r="20" />
        <circle cx="200" cy="280" r="20" />
    </g>
    <g style="font-family:var(--mono);font-size:15px;fill:var(--fg)" text-anchor="middle">
        <text x="120" y="40" dy=".35em">X</text>
        <text x="280" y="40" dy=".35em">Y</text>
        <text x="120" y="160" dy=".35em">A</text>
        <text x="280" y="160" dy=".35em">B</text>
        <text x="200" y="280" dy=".35em">C</text>
    </g>
</svg>
<figcaption>
    The numbers mark the order of parents in each <code>extends</code>
    clause: <code>A</code> puts <code>X</code> first, <code>B</code> puts
    <code>Y</code> first — and <code>C</code> inherits the contradiction.
</figcaption>
</figure>

## Solution #1: C++

C++ was by far the most influential language of the multiple-inheritance
era, so its answer to the diamond problem is what shaped the reputation of
the feature as a whole.

That answer, in essence: refuse to choose, and make the programmer spell
everything out.

By default, the diamond in C++ does not even merge. `D` receives two
independent copies of `A` — one arriving through `B`, the other through
`C`. State is simply summed: every field of `A` exists in `D` twice. And
any mention of a name that is reachable through both paths is a compile
error; you have to name the path yourself:

```cpp
struct A { int hp = 100; const char* greet() { return "A"; } };

struct B : A { const char* greet() { return "B"; } };
struct C : A { const char* greet() { return "C"; } };

struct D : B, C {};

D d;
d.greet();      // error: ambiguous — B::greet or C::greet?
d.B::greet();   // "B" — the path is chosen explicitly
d.hp;           // error: ambiguous — which of the two hp?
d.B::hp = 50;   // this copy…
d.C::hp = 25;   // …and that one are independent
```

If you want the diamond to actually merge — a single shared `A` — you must
ask for it explicitly, with *virtual inheritance*: `struct B : virtual A`.
The request has to be written in the intermediate classes, which means the
diamond must be anticipated ahead of time, at a point where `D` does not
exist yet. With a virtual base there is one `A` subobject, constructed by
the most derived class; and if both `B` and `C` override `greet`, the
compiler requires `D` to provide its own override — otherwise the program
is rejected for having no unique final overrider.

So the C++ solution is <span class="emphasis">honest, but entirely manual.</span> The language never
picks a winner: at every ambiguity it hands the question back to the
programmer — qualified calls for behavior, duplicated fields for state,
an opt-in keyword to merge the diamond, a mandatory override to settle
conflicts. It works, but it no longer feels like inheritance: the simple
"is-a" intuition dissolves into <span class="emphasis">bookkeeping of subobjects and paths</span>. Much
of the fear of multiple inheritance is, at bottom, fear of this machinery.

## Solution #2: Java and C#

The next generation of mainstream languages — Java, and C# after it —
answered the diamond problem by cutting away half of inheritance. A class
may extend only one class, but may implement any number of interfaces:
multiple inheritance survives for *behavior*, while multiple inheritance
of *state* is banned outright. An interface cannot hold fields, so the
diamond of data — the part C++ handles with duplicated subobjects and
virtual bases — simply cannot be formed.

For a long time interfaces carried no implementation either, so there was
nothing left to conflict. But once Java 8 allowed interfaces to provide
default method bodies, the old question came right back:

```java
interface X {
    default String greet() { return "X"; }
}

interface Y {
    default String greet() { return "Y"; }
}

class C implements X, Y {
    // does not compile without this override:
    public String greet() {
        return X.super.greet();  // the path, spelled out again
    }
}
```

When two inherited defaults collide, the class does not compile until it
overrides the method itself — and inside that override it names the winner
explicitly, `X.super.greet()`. C# 8 adopted default interface methods with
the same rule.

So the second solution is: prohibit inheriting state, and resolve behavior
conflicts <span class="emphasis">by hand</span>. It is safer than C++ — there are no duplicated fields
to corrupt — but the shape of the answer is familiar: once again the
language refuses to decide, and once again we are doing the bookkeeping of
paths ourselves.

## Solution #3: Linearization

The third solution rests on one simple idea. For every class, compute a
*linear* list of all its superclasses — walking the inheritance graph in
depth, so that every ancestor, direct or distant, lands in the list exactly
once. <span class="emphasis">Then simply assume that the class was formed by single inheritance
along this unrolled chain.</span>

That single assumption buys back everything at once. Method lookup walks the
list and takes the first match. `super` no longer means "my parent in the
graph" — it means "the next class in the list". The diamond dissolves,
because no ancestor can appear in the chain twice. Applied to our classic
diamond:

```js
linearization(D)  // [D, B, C, A]

new D().greet()   // D has no greet, B does — "B"
```

There is no ambiguity left to argue about — and nothing to spell out at
the call site either. All that remains is one honest question: how exactly
should the chain be built?

The idea itself is old — older than C++. It first appeared in Flavors, the
Lisp Machine object system from the late seventies, and matured in CLOS,
the Common Lisp Object System. Several attempts were made at the
chain-building algorithm over the years — Flavors, CLOS, and early Python
each had their own — but all of them suffered from various defects: in
tangled hierarchies they could reorder ancestors in surprising ways,
contradict the order written in an `extends` clause, or silently change
the ordering between a class and its subclass. Reliable in the simple
cases, they could not be trusted in the hard ones.

That is, until the <span class="emphasis">C3 algorithm</span> was invented — the one that finally does
it cleanly.

## C3: preserving monotonicity

I am not going to describe the C3 algorithm itself — how the chain is
assembled is a technical detail, and it is well covered elsewhere. What we
are after is the <span class="emphasis">intuition</span> behind it: and, better yet, an intuition built
directly on top of the one we already have about single inheritance.

The core idea of C3 is preserving *monotonicity*. Every class, at the point
of its declaration, lists its parents — and that list is a promise: these
ancestors will follow each other in this relative order in the final chain.
C3 treats every such promise, made by every class in the hierarchy, as
binding. <span class="emphasis">In the chain it builds for a particular class, the mutual order
of any two ancestors never contradicts the order established by the
declarations in that class’s own ancestry.</span>

However, the chains of unrelated classes are
independent: two hierarchies that never meet are free to order the same
ancestors differently.

Sometimes keeping every promise at once is simply impossible — that is
exactly our second example, where `A` declares `X, Y` and `B` declares
`Y, X`. C3 does not pick a side quietly: it refuses the hierarchy with a
compile-time error. What it cannot do cleanly, it does not do at all.

Now the main part — the intuition. In single inheritance, when we write a
method and call `super.greet()`, we rely on a firm expectation: the method
of that <span class="emphasis">specific superclass</span> we extend will be called. Under C3, the
expectation needs one adjustment, and only one: `super.greet()` will call
the method of that superclass — <span class="emphasis">or of one of its descendants</span>. Which one,
we do not know in advance.

Look at what happens in our classic diamond once every method politely
chains its `super`:

```js
class A {
    greet() { return "A" }
}

class B extends A {
    greet() { return "B > " + super.greet() }
}

class C extends A {
    greet() { return "C > " + super.greet() }
}

class D extends B, C {}

new B().greet() // "B > A"         — super is A itself
new D().greet() // "B > C > A"    — super of B is now C, a descendant of A
```

Taken on its own, `B` sits right on top of `A`, and its `super` is `A`.
But inside `D`, the chain is `[D, B, C, A]` — and `C`, another descendant
of `A`, has been spliced in between. `B` did not change; what changed is
who stands behind it in the chain. And note that the mutual order of `B`
and `A` is still the same — `B` still comes before `A`; `C` merely stepped
in between them. That is monotonicity at work.

Note that this is not some exotic new dispatch rule — it is the
linearization idea carried to its logical end. <span class="emphasis">No multiple inheritance</span>
ever actually happens: there is only a <span class="emphasis">chain of single inheritances</span>, and
your class does not get to know its exact place in every chain it will
ever join. You write your class against an <span class="emphasis">unknown direct superclass</span>; C3 reserves the
right to slot other descendants of that superclass between you and it.

And that is the only adjustment of intuition that switching to multiple
inheritance requires: `super` means "the next one behind me", rather than
"my direct parent". Relax this single expectation — and the whole feature
unfolds from the intuition you already had.

## Multiple inheritance in TypeScript

If you want to try multiple inheritance in TypeScript, you can do it
today, with [ts-mixin-class](https://github.com/tonyboho/ts-mixin-class).
This module implements multiple inheritance in TypeScript using the native
`implements` keyword. You can
[try it on StackBlitz](https://stackblitz.com/~/github.com/tonyboho/ts-mixin-class-example?file=src/basic.ts)
without installing anything.

I hope this post has convinced you that multiple inheritance is a powerful
mechanism for modeling the relations of the real world — and that it is
just as simple as single inheritance. And I hope one day it will appear in
TypeScript natively.
