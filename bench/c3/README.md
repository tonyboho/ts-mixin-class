# Precomputing C3 linearization: from runtime merge to a compile-time replay plan

This folder is both a benchmark ([`index.ts`](index.ts)) and the write-up of the
idea it measures. It is meant to be read top to bottom: it builds the theory from
the ground up, then shows the strategy it leads to (**approach B**, a *merge plan*),
then backs every claim with the numbers the benchmark produces.

> Math renders on GitHub (KaTeX). Inline like $L[X]$, block like
> $$L[X] = X \cdot \mathrm{merge}(\dots).$$

---

## 0. The problem in one paragraph

A mixin class is applied to a base by walking a **linearization** — the order in
which mixins stack onto each other (the same notion as Python's MRO, *method
resolution order*). Today that order is computed **at runtime**, once per class,
the first time the class is built, by running the **C3** algorithm. The compiler
*already* computes the exact same order at compile time (it needs it for the
generated types). So the runtime is redoing work the compiler already did. This
document is about moving that work to compile time and leaving the runtime with
the cheapest possible thing to do.

The two runtime sites that run C3 today:

```
// per mixin, when it is defined:
export const Foo = defineMixinClass("Foo", factory, [A, B], Base)
//                                                  ^^^^^^ merges A,B,… into Foo's order

// per consumer class, in its heritage:
class User extends mixinChain(Base, A, B) { }
//                            ^^^^^^^^^^^^ merges A,B,… into User's order
```

Both happen **once per class at module load**, not per instance. So this is a
*load-time* (time-to-first-render) cost, not a steady-state one.

---

# Part I — Theory

## 1. There are two graphs, not one

The first confusion to clear up: when people say "A extends B here but B extends A
there," it sounds like edges point both ways. They do not. There are **two
different relations**, and only one of them is a graph in the usual sense.

### 1.1 The dependency graph (fixed, acyclic)

"`A` requires `B`" (`A implements B`) is a directed edge $A \to B$. Collect all of
them and you get a directed graph $G = (V, E)$ where $V$ is the set of mixins.

This graph is a **DAG** — directed and **acyclic**. A cycle here ("A requires B
requires A") is a separate, earlier error; by the time we linearize, $G$ is
guaranteed acyclic.

### 1.2 The precedence order (context-dependent)

"`A` comes before `B` in the chain" is a *different* relation, and it is **not**
fixed globally. For two mixins that do not depend on each other (neither is an
ancestor of the other — they are *incomparable*), their relative order is decided
**locally**, by whoever lists them. So:

- consumer $C$ writes `implements A, B` → in $C$'s chain, $A$ before $B$;
- consumer $D$ writes `implements B, A` → in $D$'s chain, $B$ before $A$.

No contradiction. $A$ and $B$ are incomparable; each context is free to order them.
The "two-way edge" intuition is really **two incomparable elements of a partial
order being ordered differently by different contexts.**

> **Takeaway.** Fixed structure = the dependency DAG. Flexible structure = the
> order among incomparable nodes, chosen per context.

## 2. What a linearization *is*

Take a node $X$. Its **ancestors** (itself + everything reachable in $G$) form a
**partially ordered set** (poset): the order is "is an ancestor of." Some pairs are
ordered (one depends on the other); some are incomparable.

A **linearization** $L[X]$ is a **linear extension** of that poset — a single total
order (a flat list) that does not contradict any of the partial-order constraints,
plus C3's extra rule that **local precedence is preserved** (if $X$ lists $[A, B]$
then $A$ precedes $B$).

So $L[X]$ is one specific flat list chosen out of the many possible linear
extensions. C3 is the rule that picks *which* one.

## 3. The C3 recurrence, step by step

C3 is defined recursively. For a node $X$ with direct dependencies
$D_1, D_2, \dots, D_k$ (in the order $X$ lists them):

$$L[X] \;=\; X \cdot \mathrm{merge}\big(L[D_1],\; L[D_2],\; \dots,\; L[D_k],\; [D_1, D_2, \dots, D_k]\big)$$

Read it as: **$X$ first, then a careful merge of (a) each dependency's full
linearization and (b) the list of direct dependencies itself.** The "$\cdot$" is
"prepend $X$ to the front."

The base case: a node with no dependencies has $L[X] = [X]$.

Because each $L[D_i]$ is computed the same way from *its* dependencies, the
definition unfolds bottom-up: leaves first, then nodes that depend on them, and so
on. Each node's linearization is computed **once** and reused (memoized).

## 4. The `merge`, step by step

The merge is the heart of C3 and the expensive part. It takes several input
sequences and produces one. The rule:

> Repeatedly find a **good head** — the first element of some input sequence that
> does **not** appear in the *tail* (anywhere after the head) of any input
> sequence. Emit it, remove it from every sequence, repeat. If no good head exists
> but sequences remain, **fail**.

"Good head" means "safe to put next: nothing is required to come before it."

To find good heads fast, our implementation ([`../../src/c3-linearization.ts`](../../src/c3-linearization.ts))
keeps a `tailCounts` map: for each element, how many times it currently sits in a
tail. An element is a good head iff its tail count is $0$. That avoids rescanning
all tails for every candidate.

### Worked example (no diamonds yet)

$A$ and $B$ have no dependencies, so $L[A] = [A]$, $L[B] = [B]$. Consumer
$C$ does `implements A, B`:

$$L[C] = C \cdot \mathrm{merge}([A], [B], [A, B])$$

- Heads: $A$ (seq 1), $B$ (seq 2), $A$ (seq 3). Is $A$ a good head? $A$ is in no
  tail (seq 3's tail is $[B]$). Emit $A$. Sequences become $[\,]$, $[B]$, $[B]$.
- Heads: $B$, $B$. $B$ is in no tail. Emit $B$.
- Result: $L[C] = [C, A, B]$.

Symmetrically $D$ with `implements B, A` gives $L[D] = [D, B, A]$. Note $A$ before
$B$ in $C$, $B$ before $A$ in $D$ — **and that is fine**, because (so far) nothing
forces both at once.

## 5. Monotonicity — the one property that makes everything work

C3's defining theorem (Barrett et al., 1996) is **monotonicity**:

> If $Y$ is an ancestor of $X$, then $L[Y]$ is a **subsequence** of $L[X]$.

In words: a parent's linearization always appears *inside* the child's, in the same
relative order (possibly with other elements interleaved between its members, but
never reordered). Write it $L[Y] \sqsubseteq L[X]$.

This is the property the entire precompute rests on, so keep it in hand: **every
ancestor's order is preserved verbatim inside the descendant's order.**

## 6. When C3 fails — and why it is exactly a cycle

Now bring $C$ and $D$ from §4 together. Let $E$ do `implements C, D`:

$$L[E] = E \cdot \mathrm{merge}\big(\underbrace{[C, A, B]}_{L[C]},\; \underbrace{[D, B, A]}_{L[D]},\; [C, D]\big)$$

Step through it:

- Emit $C$ (good: not in any tail). Sequences: $[A, B]$, $[D, B, A]$, $[D]$.
- Emit $D$ (good). Sequences: $[A, B]$, $[B, A]$, $[\,]$.
- Now heads are $A$ and $B$.
  - $A$? It is in the **tail** of $[B, A]$. Not good.
  - $B$? It is in the **tail** of $[A, B]$. Not good.
- No good head, sequences remain → **C3 fails** (`C3LinearizationError`).

This is precisely the "conflict only when $C$ and $D$ meet inside another mixin"
you would expect: $C$ insists $A \prec B$, $D$ insists $B \prec A$; alone they
coexist, but $E$ must hold both at once, which is impossible.

> **Proposition (operational).** For fixed local precedence, the merge at $X$
> succeeds iff the union of all input sequences' orders is **acyclic**; a stall is
> exactly a cycle in that "must come before" relation. (The harder question — can
> one *choose* local orders to avoid all conflict — is *not* always solvable: there
> exist posets, smallest with 10 elements, admitting no consistent local order at
> all. See Hivert & Thiéry, 2024.)

## 7. Diamonds are the only hard part

Why is the merge ever nontrivial? **Diamonds** — a shared ancestor reached by more
than one path.

- **No diamonds** (each ancestor reached by a unique path — the ancestor sub-DAG is
  a tree/forest): $L[X]$ is just a depth-first preorder of that tree. Each
  dependency's block appears **contiguously**; nothing interleaves. Linearization
  is a plain concatenation.
- **A diamond**: the shared ancestor must be delayed past *all* its paths, so it
  slides down and **slices through** the block of one of the branches. That slicing
  is the only reason `merge` does more than concatenate.

### Worked benign diamond

$A$ (no deps), $B \to A$, $C \to A$, $D \to [B, C]$.

$$L[A] = [A],\quad L[B] = [B, A],\quad L[C] = [C, A]$$
$$L[D] = D \cdot \mathrm{merge}([B, A], [C, A], [B, C])$$

- Emit $B$ (good). → $[A]$, $[C, A]$, $[C]$.
- $A$? in tail of $[C, A]$ → not good. Emit $C$ (good). → $[A]$, $[A]$, $[\,]$.
- Emit $A$.
- $L[D] = [D, B, C, A]$.

See how $A$ got pulled to the end, *past* both $B$ and $C$: $B$'s natural block
$[B, A]$ was **cut** — $A$ no longer sits right after $B$. That cut is the
interleaving, and it happens only because $A$ is a diamond tip. Remember this list;
§9 turns exactly this into a *plan*.

---

# Part II — The idea: precompute the order

## 8. Why precomputing is safe

When a mixin is applied, its factory receives a base that **already has all of the
mixin's dependencies applied** (`mixinFactory(canonicalBase)` in the runtime). The
factory body is just `class extends base { … }`. So the linearized **order** is the
only thing that matters; given the right order, application is mechanical. Nothing
about *how* mixins are applied changes — only *where the order comes from*. That is
why this optimization cannot alter behavior: `instanceof`, chain reuse, base
checks, marker publication all stay byte-for-byte; we only stop recomputing the
order.

## 9. The fundamental trade-off

Here is the wall every design hits. Today's runtime stores linearization
**distributed**: each module references only its **direct** dependencies (which it
imports anyway), and the runtime walks the metadata graph one hop at a time. That
is *why* there is a runtime merge — the order is reassembled on the fly.

To precompute a **flat** order, the flattening module must name **all transitive**
mixins — but a module imports only its direct dependencies. So:

> You can have "no transitive imports" **or** "no runtime merge", but not both —
> unless the values are already co-located.

Within a single **module**, everything is co-located, so precompute is free. Across
**files**, you must pay somehow. That gives three strategies:

| | transitive imports | runtime cost | global state | cross-package | emit size |
|---|---|---|---|---|---|
| **(A)** flat value list | **injected** | $0$ (literal) | no | safe | $O(N^2)$ ids |
| **(B)** merge plan (this doc) | **none** | $O(n)$ index reads | **no** | **safe** | compact |
| **(C)** integer id + registry | none | $O(n)$ map lookups | **yes** | **collides** | compact |

(A) emits the whole flat list as values, so it must `import` every transitive
mixin. (C) gives each mixin an integer id and a global `Map<id, ctor>`; the consumer
emits a list of numbers (no imports) and resolves them through the registry — but
ids collide across independently compiled packages, and it relies on a mutable
global. **(B) is the subject of the rest of this document**: it needs neither
imports nor a registry, and we will see exactly why.

---

# Part III — Approach B: the merge plan

## 10. The encoding

Idea: the compiler runs C3 once (it does this anyway) and emits, per node, a
**plan** describing how to rebuild $L[X]$ from its **direct dependencies'**
linearizations — as a list of **contiguous slices**:

$$P_X = \big[(s_1, o_1, \ell_1),\ (s_2, o_2, \ell_2),\ \dots\big]$$

Each triple means "take $\ell_j$ elements starting at offset $o_j$ from source
$s_j$," where the sources are exactly the merge inputs:
$\mathrm{sources}(X) = [\,L[D_1], \dots, L[D_k],\ [D_1, \dots, D_k]\,]$.

Replay is then:

$$L[X] \;=\; X \cdot \bigoplus_j\ L[D_{s_j}]\big[o_j : o_j + \ell_j\big]$$

— prepend $X$, then concatenate the slices. **No merge, no good-head search, no
map: just array index reads.**

## 11. Deriving the plan (compile time)

Given the C3 result $L[X]$ already computed, attribute each output element to one
source and coalesce adjacent same-source runs:

1. Keep a cursor per source, all at $0$.
2. Walk $L[X]$ (after $X$). For each element $e$:
   - **pick** the first source whose cursor points at $e$;
   - if it continues the previous slice (same source, contiguous offset), extend
     that slice; otherwise start a new slice $(s, \text{cursor}_s, 1)$;
   - **advance every** source whose cursor points at $e$ (a diamond tip is at the
     cursor of several sources at once — all must move past it).

A source whose cursor points at $e$ always exists (by monotonicity, §5: everything
before $e$ in that source already appeared earlier in $L[X]$, so its cursor sits
exactly on $e$).

### Worked derivation (the §7 diamond)

$L[D] = [D, B, C, A]$, sources $s_0 = [B, A]$, $s_1 = [C, A]$, $s_2 = [B, C]$,
merged tail $[B, C, A]$:

| element | at cursor of | pick | slice action | cursors after |
|---|---|---|---|---|
| $B$ | $s_0[0], s_2[0]$ | $s_0$ | new $(0, 0, 1)$ | $s_0{:}1,\ s_2{:}1$ |
| $C$ | $s_1[0], s_2[1]$ | $s_1$ | new $(1, 0, 1)$ | $s_1{:}1,\ s_2{:}2$ |
| $A$ | $s_0[1], s_1[1]$ | $s_0$ | new $(0, 1, 1)$ | $s_0{:}2,\ s_1{:}2$ |

$$P_D = [(0,0,1),\ (1,0,1),\ (0,1,1)]$$

Replay: $[D] + s_0[0{:}1] + s_1[0{:}1] + s_0[1{:}2] = [D, B, C, A]$. ✓ Three slices
for a diamond; a chain would be a single slice.

## 12. Why it is correct

By monotonicity, each $L[D_i] \sqsubseteq L[X]$ — its elements appear in $L[X]$ in
the **same relative order**. Therefore any maximal run of consecutive $L[X]$
elements drawn from a single source is a **contiguous** slice of that source. So
$L[X]$ always partitions into such slices, and replay reproduces it exactly. The
benchmark asserts `replay == C3` for every node before timing, so this is checked,
not just argued.

## 13. Replay is $O(n)$ index reads

Building one node:

```ts
const result = [X]
for (const [src, offset, length] of plan) {
  const source = sources[src]
  for (let i = 0; i < length; i++) result.push(source[offset + i])
}
```

If $S$ is the number of slices and $n = |L[X]|$, this is $S$ outer iterations and
$n$ element reads total — **one linear pass into one array**, not $n$ structural
`splice` calls. Each per-element op is an array index read (`source[offset + i]`),
the cheapest operation there is.

## 14. Why B works cross-file — without imports

This is the crucial property. Replay touches **only direct dependencies'** arrays
(`sources(X)` lists $L[D_i]$ for direct $D_i$, plus the direct-deps list). It never
indexes a transitive node directly. Transitive ancestors enter $L[X]$ *only* as
elements **copied out of a direct dependency's stored array**.

Map that onto real modules (the array elements are now mixin **constructors**, not
ints):

- `c.ts`: `export const C = defineMixinClass(…)`, with `C.linearization = [C]`.
- `a.ts` imports `C`: `A.linearization` is built by replay → `[A, C]`. The array
  `a.ts` holds contains a **reference to the value `C`**.
- `user.ts` imports **only `A`** (not `C`): replay reads `A.linearization` (via the
  imported `A`), slices it → pulls out `[A, C]` as **value references** → builds
  `User.linearization = [User, A, C]`.

`user.ts` never imported `C`, yet now holds a reference to `C`'s constructor — it
pulled it out of `A.linearization`. **Transitive values ride upward inside the
stored arrays.** That is why (B) needs no phantom imports (A) and no global
registry (C): a dependency's linearization array *is* the channel that carries
transitive values. The only requirement is load order — a dependency must
materialize its array before a dependent reads it — which ES module evaluation
already guarantees (dependencies evaluate first). The manual `.mix(…)` path, which
the compiler cannot see, keeps using runtime C3.

---

# Part IV — Complexity

## 15. The symbols

| symbol | meaning |
|---|---|
| $n = \lvert L[X]\rvert$ | length of one node's linearization = its transitive ancestors $+1$ |
| $k$ | number of **direct** dependencies of a node (merge inputs) |
| $N$ | total number of nodes (mixins + consumers) in the package |
| $S$ | number of slices in a node's plan |

## 16. Where the $N^2$ lives

There are two separate $N^2$ contributions; keep them apart.

1. **Order computation** (running C3 / searching for good heads), with a factor of
   $k$: $O(k \cdot N^2)$ in the worst case.
2. **Materialization** (actually building/copying the array $L[X]$ for every node,
   because dependents slice from it): $O(N^2)$.

The $N^2$ itself is $\sum_X \lvert L[X]\rvert$. Worst case is a deep chain
$A_1 \to A_2 \to \dots \to A_N$ where $\lvert L[A_i]\rvert = N - i + 1$, so

$$\sum_{i=1}^{N} (N - i + 1) = \frac{N(N+1)}{2} = O(N^2).$$

Now place each strategy:

| | order computation $O(k N^2)$ | materialization $O(N^2)$ |
|---|---|---|
| **C3 (today)** | **runtime** | runtime (fused into the merge) |
| **B (plan)** | **compile time** (derivation) | **runtime** (cheap replay copy) |

So the heavy, $k$-weighted quadratic moves from **runtime** (C3) to **compile time**
(B). What stays at B's runtime is only the lighter $O(N^2)$ materialization — index
reads, no merge, no map, no $k$ factor. And the compiler already computes these
linearizations for its generated types, so B's compile-time cost is largely already
paid; deriving the plan on top is cheap.

## 17. Constant time is impossible — linear is the floor

A reconstruction must at least *emit* its output, and $\lvert L[X]\rvert = n$. So no
representation can rebuild a linearization in less than $O(n)$. "Constant time at
runtime" is ruled out by information theory; **linear is optimal**, and that is what
replay achieves — with the smallest possible per-element constant.

---

# Part V — The benchmark

[`index.ts`](index.ts) compares the two **runtime** strategies on abstract
dependency graphs (nodes are plain integers — no `@mixin`, no transformer, no
`tsc`), using the **real** `mergeC3Linearizations` for the C3 side:

- **C3** — what the runtime does today: bottom-up, each node merges its direct
  dependencies' linearizations.
- **replay** — approach B: bottom-up, each node replays its precomputed slice plan.

Plan derivation is compile-time work and is timed **separately** (`derive`). Both
strategies build every node and the bench asserts they produce identical results
before timing.

Graphs are generated **C3-consistent by construction**: a node draws a few
dependencies from a window, and the smallest dependency is dropped until its merge
succeeds (descending local order alone is *not* enough — C3 emits the *leftmost*
good head, so deep windows can still conflict; see the back-off in
`buildConsistentGraph`).

## 18. Results

`pnpm run bench:c3` (default `window=24 deps=1-4`, medians of 7 samples):

```
nodes      avg|L|     totalΣ   avg slices       C3     replay   speedup    derive
64           11.1        713          1.7   0.129ms    0.016ms    7.94x    0.080ms
256          47.1      12049          2.4   1.622ms    0.054ms   29.98x    1.398ms
1024        186.9     191419          2.5    18.4ms    0.707ms   26.04x    2.964ms
```

Denser graphs (`window=128 deps=6-16`) barely change `avg slices`:

```
nodes      avg|L|     totalΣ   avg slices       C3     replay   speedup    derive
64           26.1       1671          2.2   0.331ms    0.034ms    9.86x    0.085ms
256          56.1      14350          2.2   1.882ms    0.036ms   52.59x    0.509ms
1024        133.7     136880          2.2   13.6ms     0.528ms   25.73x    2.491ms
```

## 19. Reading the numbers

- **`speedup` 8–50×.** Replay beats runtime C3 by roughly the per-element constant:
  index read vs good-head search + `tailCounts` map. The factor grows with size.
- **`avg slices` ≈ 2, even when dense.** This is the strong result. Only
  *consistent* hierarchies exist (inconsistent ones are compile errors), and
  consistent hierarchies linearize **almost contiguously** — the surviving diamonds
  are few. So plans stay tiny → **emit is compact** ($\sim O(\text{deps})$, not
  $O(n)$). The feared (B) emit blow-up does not materialize.
- **`totalΣ` $\approx N^2$.** $\Sigma\lvert L[X]\rvert$ grows $\sim 16\times$ per
  $4\times$ nodes — the materialization $N^2$ of §16, shared by *both* strategies.
  Replay just walks it with a far smaller constant.
- **Absolute times are modest.** Even at $1024$ nodes (a very large app) C3 is
  $\sim 15\text{–}18$ ms; at $256$, $\sim 2$ ms; below that, sub-millisecond. So the
  *ratio* is large but the *absolute* load-time win matters only at hundreds-to-
  thousands of mixins — exactly where shaving a first-render millisecond is worth
  it.
- **`derive` is cheap** ($\sim 0.5\text{–}3$ ms) and sits on top of linearizations
  the compiler computes anyway.

## 20. Conclusion

The benchmark confirms the theory: approach B turns a runtime $O(k N^2)$ merge into
a compile-time derivation plus a runtime $O(N^2)$ **index-read** replay — an
$8\text{–}50\times$ constant-factor win on the linearization step, with **compact**
plans and **no** phantom imports or global registry, and it composes correctly
**cross-file** because transitive values ride inside dependencies' stored arrays.
The honest caveat: the win is **load-time** and modest in absolute terms until the
mixin graph is large; the deeper value is making the **compiler the single source of
truth** for the order, instead of two implementations (compile-time and runtime)
that must agree.

---

## Reproduce

```bash
pnpm run bench:c3                                  # default run
TS_MIXIN_C3_WINDOW=128 TS_MIXIN_C3_DEP_MAX=16 \
  node dist/bench/c3/index.js                      # after one build, tune knobs
```

Knobs (env): `TS_MIXIN_C3_SIZES`, `TS_MIXIN_C3_WINDOW`, `TS_MIXIN_C3_DEP_MIN`,
`TS_MIXIN_C3_DEP_MAX`, `TS_MIXIN_C3_SAMPLES`, `TS_MIXIN_C3_WARMUPS`,
`TS_MIXIN_C3_SEED`.

## References

- K. Barrett, B. Cassels, P. Haahr, D. Moon, K. Playford, P. Withington.
  *A Monotonic Superclass Linearization for Dylan.* OOPSLA 1996. (Defines C3 and
  proves monotonicity.)
- F. Hivert, N. Thiéry. *Controlling the C3 super class linearization algorithm for
  large hierarchies of classes.* arXiv:2401.12740, 2024. (Posets with no consistent
  local order; production use in SageMath.)
- Runtime C3 implementation: [`../../src/c3-linearization.ts`](../../src/c3-linearization.ts).
- Compile-time linearization: [`../../src/linearization.ts`](../../src/linearization.ts).
