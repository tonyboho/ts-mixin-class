# Precomputing C3 linearization in a mixin library: from a runtime merge to a compile-time plan

This is a self-contained study of one optimization: moving the cost of **C3 linearization**
out of a mixin library's runtime and into its compiler. It builds the necessary theory from
scratch, derives a strategy from that theory, weighs it against the alternatives, and backs
every claim with a benchmark ([`index.ts`](index.ts)) you can run yourself.

> Math renders on GitHub (KaTeX). Inline like $L[X]$, block like
> $$L[X] = X \cdot \mathrm{merge}(\dots).$$

---

## The setting

A **mixin** is a reusable bundle of behaviour that can be mixed into many classes. A *mixin
library* lets you write

```ts
@mixin class Timestamp { /* … */ }
@mixin class Audit { /* … */ }

@mixin class Document implements Timestamp, Audit { /* … */ }
```

and have `Document` end up with the members of `Timestamp` and `Audit` stacked onto it. The
interesting libraries implement this with **two stages**:

1. **Compile time** — a *transformer* (a compiler plugin) reads the `@mixin` classes and
   their `implements` clauses, and rewrites them so the types line up: it generates the
   interfaces, the declaration output, and the glue code a normal class would have.
2. **Run time** — when the program actually runs, each class is *assembled* by applying its
   mixins to a base class, one on top of another, in a specific order.

That order is the crux. When several mixins depend on each other (`A implements B`, and a
consumer pulls in both), "stack them in a specific order" is not obvious — it is exactly the
**method resolution order (MRO)** problem that languages with multiple inheritance solve.
The standard solution is the **C3 linearization** algorithm (used by Python, Raku, Solidity,
and others).

Here is the wasteful part this document attacks. The **transformer already computes the C3
order at compile time** — it has to, in order to generate correct types. But a naive runtime
*also* runs C3, from scratch, the first time each class is assembled. The same order is
computed twice: once by the compiler, then again by the runtime.

**The goal:** compute the order once, at compile time, and leave the runtime with the
cheapest possible thing to do. This is a **load-time** win — it shrinks the work done while
modules initialize, which is precisely the time-to-first-render budget that front-end
applications optimize hard. It is not a per-object cost; linearization happens once per
class, when the class is first built.

To get there we first need to understand C3 well enough to know what is safe to precompute.

---

# Part I — The theory of C3 linearization

## 1. There are two graphs, not one

It is tempting to picture mixins in a single graph with edges that sometimes point both ways
("`A` before `B` here, `B` before `A` there"). That picture is wrong, and untangling it is
the first step. There are **two distinct relations**:

### 1.1 The dependency graph (fixed, acyclic)

"`A` requires `B`" (`A implements B`) is a directed edge $A \to B$. All such edges form a
directed graph $G = (V, E)$ over the set of mixins $V$. This graph is a **DAG** — directed
and **acyclic**. A cycle ("A requires B requires A") is a separate error, caught before
linearization; from here on $G$ is acyclic.

### 1.2 The precedence order (context-dependent)

"`A` comes before `B` in the assembled chain" is a *different* relation, and it is **not**
fixed globally. If two mixins do not depend on each other — neither is an ancestor of the
other, so they are **incomparable** — then their relative order is decided **locally**, by
whoever lists them:

- a consumer that writes `implements A, B` orders $A$ before $B$;
- a consumer that writes `implements B, A` orders $B$ before $A$.

There is no contradiction: $A$ and $B$ are incomparable, and each context may order them as
it likes. The "two-way edge" intuition is really **two incomparable elements of a partial
order, ordered differently in different contexts.**

> Fixed structure = the dependency DAG. Flexible structure = the order among incomparable
> nodes, chosen per context.

## 2. What a linearization *is*

Fix a node $X$. Its **ancestors** (itself plus everything reachable in $G$) form a
**partially ordered set** (poset) under "is an ancestor of": some pairs are ordered (one
depends on the other), some are incomparable.

A **linearization** $L[X]$ is a **linear extension** of that poset — a single flat list (a
total order) that violates none of the partial-order constraints, and additionally respects
C3's rule that **local precedence is preserved** (if $X$ lists $[A, B]$ then $A$ precedes
$B$). There are usually many valid linear extensions; C3 is the rule that deterministically
picks one.

## 3. The C3 recurrence

C3 is defined recursively. For a node $X$ with direct dependencies $D_1, \dots, D_k$ (in the
order $X$ lists them):

$$L[X] \;=\; X \cdot \mathrm{merge}\big(L[D_1],\ L[D_2],\ \dots,\ L[D_k],\ [D_1, \dots, D_k]\big)$$

Read it as: **$X$ first, then a careful merge of (a) each dependency's full linearization and
(b) the list of direct dependencies itself.** "$\cdot$" prepends $X$. The base case: a node
with no dependencies has $L[X] = [X]$.

Because each $L[D_i]$ is computed the same way, the definition unfolds bottom-up — leaves
first, then their dependents — and each node's linearization is computed **once** and reused
(memoized).

## 4. The `merge`, step by step

The merge is the heart of C3 and the expensive part. It interleaves several input sequences
into one:

> Repeatedly find a **good head** — the first element of some input sequence that does **not**
> appear in the *tail* (anywhere after the head) of any input sequence. Emit it, remove it
> from every sequence, repeat. If no good head exists while sequences remain, **fail**.

"Good head" means "safe to place next: nothing is required to come before it." A fast
implementation keeps a `tailCounts` map — for each element, how many tails it currently sits
in — so an element is a good head exactly when its count is $0$, avoiding a rescan per
candidate.

### Worked example (no diamonds)

$A$ and $B$ have no dependencies: $L[A] = [A]$, $L[B] = [B]$. A consumer $C$ with
`implements A, B`:

$$L[C] = C \cdot \mathrm{merge}([A], [B], [A, B])$$

- Heads: $A$, $B$, $A$. Is $A$ in any tail? Only tail is $[B]$ — no. Emit $A$. Sequences:
  $[\,]$, $[B]$, $[B]$.
- Heads: $B$, $B$. Emit $B$.
- $L[C] = [C, A, B]$.

Symmetrically, $D$ with `implements B, A` gives $L[D] = [D, B, A]$. Note $A$ before $B$ in
$C$ but $B$ before $A$ in $D$ — and that is fine, because nothing forces both at once.

## 5. Monotonicity — the property everything rests on

C3's defining theorem (Barrett et al., 1996) is **monotonicity**:

> If $Y$ is an ancestor of $X$, then $L[Y]$ is a **subsequence** of $L[X]$.

A parent's linearization always appears *inside* the child's, in the same relative order
(other elements may interleave between its members, but its members never reorder). Write
this $L[Y] \sqsubseteq L[X]$. Keep it in hand: **every ancestor's order is preserved verbatim
inside the descendant's order.** The whole precompute will lean on this.

## 6. When C3 fails — and why a failure is exactly a cycle

Bring $C$ and $D$ from §4 together. Let $E$ have `implements C, D`:

$$L[E] = E \cdot \mathrm{merge}\big(\underbrace{[C, A, B]}_{L[C]},\ \underbrace{[D, B, A]}_{L[D]},\ [C, D]\big)$$

- Emit $C$ (in no tail). Sequences: $[A, B]$, $[D, B, A]$, $[D]$.
- Emit $D$. Sequences: $[A, B]$, $[B, A]$, $[\,]$.
- Heads are now $A$ and $B$.
  - $A$ is in the tail of $[B, A]$ — not good.
  - $B$ is in the tail of $[A, B]$ — not good.
- No good head, sequences remain → **C3 fails.**

$C$ insists $A \prec B$; $D$ insists $B \prec A$. Apart they coexist, but $E$ must hold both
at once, which is impossible.

> **Operational fact.** For fixed local precedence, the merge at $X$ succeeds iff the union
> of all input sequences' orders is **acyclic**; a stall is exactly a cycle in the combined
> "must come before" relation. (Whether one can always *choose* local orders to avoid every
> conflict is a harder, separate question — and the answer is no: there exist posets, the
> smallest with 10 elements, with no consistent local order at all. See Hivert & Thiéry,
> 2024.)

## 7. Diamonds are the only hard part

Why is the merge ever nontrivial? **Diamonds** — a shared ancestor reached by more than one
path.

- **No diamonds** (each ancestor reached by a unique path; the ancestor sub-DAG is a
  tree/forest): $L[X]$ is a depth-first preorder of that tree. Each dependency's block is
  **contiguous**; nothing interleaves; linearization is plain concatenation.
- **A diamond**: the shared ancestor must be delayed past *all* its paths, so it slides down
  and **slices through** one branch's block. That slicing is the only reason `merge` does
  more than concatenate.

### Worked benign diamond

$A$ (no deps), $B \to A$, $C \to A$, $D \to [B, C]$:

$$L[A] = [A],\quad L[B] = [B, A],\quad L[C] = [C, A],\quad L[D] = D \cdot \mathrm{merge}([B, A], [C, A], [B, C])$$

- Emit $B$. → $[A]$, $[C, A]$, $[C]$.
- $A$ is in the tail of $[C, A]$ — skip. Emit $C$. → $[A]$, $[A]$, $[\,]$.
- Emit $A$.
- $L[D] = [D, B, C, A]$.

$A$ was pulled to the end, *past* both $B$ and $C$: $B$'s natural block $[B, A]$ got **cut**.
That cut is the interleaving, and it happens only because $A$ is a diamond tip. (§11 turns
exactly this list into a *plan*.)

---

# Part II — Precomputing the order

## 8. Why precomputing is safe

When a mixin is applied, its factory receives a base that **already has all of the mixin's
dependencies applied**, and the body is just `class extends base { … }`. So the linearized
**order** is the only thing that determines the result; given the right order, the assembly
is mechanical. Precomputing the order therefore cannot change behaviour — `instanceof`,
chain reuse, base checks all stay identical. The only thing that changes is *where the order
comes from*.

## 9. The fundamental trade-off

A naive runtime stores linearization **distributed**: each module references only its
**direct** dependencies (which it imports anyway), and the runtime walks the dependency graph
one hop at a time, reassembling the order on the fly. That on-the-fly reassembly *is* the
runtime merge.

To precompute a **flat** order, the flattening module must name **all transitive** mixins —
but a module imports only its direct dependencies. This is the wall:

> You can have "no transitive imports" **or** "no runtime merge", but not both — unless the
> values are already co-located.

Within a single **module** everything is co-located, so precompute is free. Across **files
and packages**, something must give. Three strategies pay the price differently:

- **(A) flat value list** — emit each node's full linearization as a literal list of mixin
  values, and inject `import`s for every transitive mixin. Zero runtime order work, but
  invasive import surgery and emit that grows with the flat lists.
- **(B) merge plan** — emit a compact *recipe* that rebuilds the order at runtime from the
  direct dependencies' own (stored) linearizations. No new imports.
- **(C) id + registry** — give each mixin a stable id, register it in a global table, and
  emit each node's linearization as a list of ids resolved through the table. No new imports,
  but it raises the question of *what the id is* (Part IV).

Parts III and IV develop B and C; A is mentioned for completeness but its import surgery and
emit blow-up rule it out early.

---

# Part III — Approach B: the merge plan

## 10. The encoding

The compiler runs C3 once (it does anyway) and emits, per node, a **plan** that rebuilds
$L[X]$ from its **direct dependencies'** linearizations as a list of **contiguous slices**:

$$P_X = \big[(s_1, o_1, \ell_1),\ (s_2, o_2, \ell_2),\ \dots\big]$$

Each triple means "take $\ell_j$ elements starting at offset $o_j$ from source $s_j$," where
the sources are the merge inputs: $\mathrm{sources}(X) = [\,L[D_1], \dots, L[D_k],\ [D_1,
\dots, D_k]\,]$. Replay is

$$L[X] \;=\; X \cdot \bigoplus_j\ L[D_{s_j}]\big[o_j : o_j + \ell_j\big]$$

— prepend $X$, concatenate the slices. **No merge, no good-head search, no map: just array
index reads.**

## 11. Deriving the plan (compile time)

Given $L[X]$, attribute each output element to one source and coalesce adjacent same-source
runs:
хорошо за коммить и тогда давай реализуй вариант б то есть у нас должен пройти возможно добавь побольше тестов сначала перед тем как реализовывать на вот этот на детекцию диамантов можно какой-то нетривиальный диамант за detect
1. Keep a cursor per source, all at $0$.
2. Walk $L[X]$ (after $X$). For each element $e$:
   - **pick** the first source whose cursor points at $e$;
   - extend the previous slice if it is the same source at a contiguous offset, else start a
     new slice $(s, \text{cursor}_s, 1)$;
   - **advance every** source whose cursor points at $e$ (a diamond tip sits at several
     cursors at once).

A source whose cursor points at $e$ always exists: by monotonicity (§5) everything before
$e$ in that source already appeared earlier, so its cursor sits exactly on $e$.

### Worked derivation (the §7 diamond)

$L[D] = [D, B, C, A]$; sources $s_0 = [B, A]$, $s_1 = [C, A]$, $s_2 = [B, C]$; merged tail
$[B, C, A]$:

| element | at cursor of | pick | slice | cursors after |
|---|---|---|---|---|
| $B$ | $s_0[0], s_2[0]$ | $s_0$ | new $(0, 0, 1)$ | $s_0{:}1,\ s_2{:}1$ |
| $C$ | $s_1[0], s_2[1]$ | $s_1$ | new $(1, 0, 1)$ | $s_1{:}1,\ s_2{:}2$ |
| $A$ | $s_0[1], s_1[1]$ | $s_0$ | new $(0, 1, 1)$ | $s_0{:}2,\ s_1{:}2$ |

$$P_D = [(0,0,1),\ (1,0,1),\ (0,1,1)]$$

Replay: $[D] + s_0[0{:}1] + s_1[0{:}1] + s_0[1{:}2] = [D, B, C, A]$. ✓ Three slices for a
diamond; a chain is a single slice. The plan is derived by **instrumenting the C3 merge the
compiler already runs** — logging each emitted element's source — so it adds almost nothing.

## 12. Why it is correct

By monotonicity each $L[D_i] \sqsubseteq L[X]$ — its elements appear in $L[X]$ in the same
relative order. So any maximal run of consecutive $L[X]$ elements from a single source is a
**contiguous** slice of that source, and $L[X]$ partitions into such slices. Replay
reproduces it exactly. (The benchmark asserts `replay == C3` for every node before timing, so
this is checked, not merely argued.)

## 13. Replay is $O(n)$ index reads

```ts
const result = [X]
for (const [src, offset, length] of plan) {
  const source = sources[src]
  for (let i = 0; i < length; i++) result.push(source[offset + i])
}
```

With $S$ slices and $n = |L[X]|$ this is $S$ outer steps and $n$ reads — one linear pass into
one array, each per-element op an array index read, the cheapest there is.

## 14. Why B works across files and packages — without imports

This is B's decisive property. Replay touches **only direct dependencies'** arrays
($\mathrm{sources}(X)$ lists $L[D_i]$ for direct $D_i$, plus the direct-deps list); it never
indexes a transitive node directly. Transitive ancestors enter $L[X]$ *only* as elements
**copied out of a direct dependency's stored array**.

Map that onto real modules (array elements are mixin **values** now, not integers):

- `c.ts`: defines `C`, with `C.linearization = [C]`.
- `a.ts` imports `C`; replay builds `A.linearization = [A, C]`. The array `a.ts` holds carries
  a **reference to the value `C`**.
- `user.ts` imports **only `A`** (not `C`); replay reads `A.linearization`, slices it → pulls
  out `[A, C]` as **value references** → builds `User.linearization = [User, A, C]`.

`user.ts` never imported `C`, yet now holds a reference to it — pulled out of
`A.linearization`. **Transitive values ride upward inside the stored arrays.** So B needs no
injected imports and no global registry: a dependency's linearization array *is* the channel
that carries transitive values across module and package boundaries. The only requirement is
load order — a dependency must build its array before a dependent reads it — which module
evaluation already guarantees (dependencies evaluate first). Composition that the compiler
cannot see (e.g. mixins combined dynamically at runtime) simply falls back to runtime C3.

---

# Part IV — Approach C and the identity problem

Approach C is appealing for its simplicity: give each mixin an id, register it in a global
`Map`/array, emit each node's linearization as a **flat list of ids**, and resolve ids →
values at runtime. No bottom-up assembly, no slice plan — just a flat lookup. The catch is
entirely in **what the id is**, and that turns out to decide everything.

## 15. The id must be assigned somewhere, and stay stable

For the consumer's emitted id-list to refer to the same mixins the runtime registers, the id
must be **persistent** (the same across recompilations) and, for cross-package use,
**portable** (the same when computed independently by different packages' compilers). Two
ways to assign it:

- **Sequential integers** assigned during the compiler pass (0, 1, 2, …). Compact (1–2
  bytes), but **not persistent**: add or reorder a mixin and every later id shifts; compile a
  different package and the same mixin gets a different number. This only works within a
  *single* compilation, where consumer and mixins are numbered by the same run. Across
  packages it collides.
- **A content hash of a stable name** — $\text{id} = \mathrm{hash}(\text{package : module :
  export})$. Not "assigned" so much as *computed*: a pure function of the mixin's identity, so
  the mixin's own package and any consuming package independently arrive at the **same** id
  with no coordination. Persistent by construction. The costs: the name must be canonicalized
  **identically** on both sides (re-exports, barrels, subpaths can diverge), version skew is
  ambiguous (same name across two versions hashes the same), and it is not compact.

### How big is a portable id?

A random UUID is **128 bits = 16 bytes** of irreducible entropy; you cannot encode it below
16 bytes without losing uniqueness (as text it is 36 bytes; packed into UTF-8 source via BMP
code points it is *worse*, ~24 bytes). But a full UUID is overkill: a hash truncated to the
uniqueness you actually need — ~48–64 bits, i.e. **6–8 bytes** — is collision-safe for
millions of mixins and still a pure function of the name. So a portable id is ~6–8 bytes, not
1, and not 16.

### Pick two of three

| | sequential int | name hash | lockfile of assigned ids |
|---|---|---|---|
| **compact** (1–2 bytes) | ✓ | ✗ (6–8 bytes) | ✓ |
| **portable** (cross-package) | ✗ | ✓ | ✓ (with a namespace) |
| **coordination-free** (no managed artifact) | ✓ | ✓ | ✗ |

- compact + coordination-free = sequential ints → **not portable**;
- portable + coordination-free = name hash → **not compact**;
- compact + portable = a committed lockfile mapping names to ids → **a managed artifact**.

You cannot have all three. **The realistic cross-package id is therefore a string hash/UUID**,
which means the registry is a `Map` keyed by a ~36-character string — string hashing on every
lookup.

## 16. The contrast with B

B never assigns an id. It refers to mixins by their **value** (direct dependencies, already
imported) and reads their stored arrays; the identity is the object reference itself, which
is intrinsically stable. The entire identity problem of Part IV — assignment, persistence,
canonicalization, version skew, registry singleton — is a cost **only C pays**.

---

# Part V — Complexity

## 17. Symbols

| symbol | meaning |
|---|---|
| $n = \lvert L[X]\rvert$ | one node's linearization length = its transitive ancestors $+1$ |
| $k$ | a node's number of **direct** dependencies (merge inputs) |
| $N$ | total nodes (mixins + consumers) |
| $S$ | slices in a node's plan |

## 18. Where the $N^2$ lives

Two separate $N^2$ contributions, kept apart:

1. **Order computation** (running C3 / good-head search), with a factor of $k$: worst case
   $O(k \cdot N^2)$.
2. **Materialization** (building the array $L[X]$ for every node, since dependents slice from
   it): $O(N^2)$.

The $N^2$ itself is $\sum_X \lvert L[X]\rvert$; the worst case is a deep chain
$A_1 \to \dots \to A_N$ with $\lvert L[A_i]\rvert = N - i + 1$, summing to $N(N+1)/2$.

| | order computation $O(k N^2)$ | materialization $O(N^2)$ |
|---|---|---|
| naive runtime C3 | **run time** | run time (fused into the merge) |
| approach B | **compile time** (derivation) | **run time** (cheap replay copy) |

The heavy, $k$-weighted quadratic moves from run time to compile time; what stays at B's run
time is the lighter $O(N^2)$ materialization — index reads, no merge, no map, no $k$ factor —
and even that the compiler has largely paid for already (it computes the linearizations for
its types regardless).

## 19. Constant time is impossible — linear is the floor

A reconstruction must at least emit its output, and $\lvert L[X]\rvert = n$, so nothing can
rebuild a linearization in less than $O(n)$. "Constant time at runtime" is ruled out;
**linear is optimal**, and replay achieves it with the smallest per-element constant.

---

# Part VI — The benchmark

[`index.ts`](index.ts) compares the **runtime** strategies on abstract dependency graphs
(nodes are plain integers — no mixin machinery), using the real C3 merge for the baseline:

- **C3** — the naive runtime: bottom-up, each node merges its direct dependencies'
  linearizations.
- **B replay** — approach B: bottom-up, each node replays its precomputed slice plan.
- **C-array** — approach C with a dense **integer** registry (`registry[id]`): the
  non-persistent, single-package id. Included as C's *best case*.
- **C-uuid** — approach C with a `Map` keyed by a 36-char **string** id: the realistic,
  cross-package-persistent id.

`derive` (B's compile-time plan derivation) is timed separately. Every strategy asserts it
reproduces the C3 result exactly before timing. Graphs are generated **C3-consistent by
construction** (a node drops its smallest dependency until its merge succeeds), since a
descending local order alone does not guarantee consistency — C3 emits the *leftmost* good
head, so deep dependency windows can still conflict.

## 20. Results

`pnpm run bench:c3` (default `window=24 deps=1-4`, medians of 7 samples, ms):

```
nodes      avg|L|   avg slices         C3     B replay      C-array       C-uuid       derive
64           11.1          1.7    0.100ms      0.018ms      0.013ms      0.022ms      0.025ms
256          47.1          2.4    1.575ms      0.036ms      0.021ms      0.265ms      1.297ms
1024        186.9          2.5     19.3ms      0.685ms      0.542ms      4.604ms      3.121ms
```

Dense graphs (`window=128 deps=6-16`) tell the same story and keep `avg slices` ≈ 2:

```
nodes      avg|L|   avg slices         C3     B replay      C-array       C-uuid       derive
64           26.1          2.2    0.391ms      0.034ms      0.003ms      0.038ms      0.080ms
256          56.1          2.2    1.791ms      0.040ms      0.017ms      0.426ms      0.477ms
1024        133.7          2.2     13.4ms      0.514ms      0.375ms      3.497ms      3.950ms
```

## 21. Reading the numbers

- **Every precompute crushes the naive C3.** At 1024 nodes, B is ~28× faster than runtime C3
  (19.3 → 0.685 ms); even the slow C-uuid is ~4× faster. The order computation really is the
  cost, and removing it from run time pays off.
- **C-array is the fastest — and unshippable.** It edges out B by ~20–40% (0.542 vs 0.685 at
  1024), because a flat resolve over a precomputed list beats expanding a slice plan and needs
  no bottom-up pass. But C-array *is* the dense-integer registry, i.e. the non-persistent,
  single-package id from §15. Its speed cannot be shipped across packages.
- **C-uuid — the realistic C — is ~7× slower than B** (4.604 vs 0.685 at 1024) and degrades
  with scale (≈ B at 64 nodes, 6.7× B at 1024), because every element costs a string-keyed
  `Map.get`.
- **Plans stay tiny** (`avg slices` ≈ 2 even when dense). Only *consistent* hierarchies exist
  (inconsistent ones are compile errors), and consistent hierarchies linearize almost
  contiguously, so B's emitted plan is compact — $O(\text{deps})$, not $O(n)$. C's emitted
  flat id-list, by contrast, is $n$ ids per node (`avg|L|` ≈ 187 at 1024).
- **B's compile-time `derive` is cheap** (~3 ms at 1024) and sits on top of linearizations the
  compiler computes anyway.
- **Absolute times are modest.** Even 1024 mixins (a very large application) cost the naive C3
  only ~15–20 ms; below a few hundred, sub-millisecond. The ratios are large, but the
  absolute load-time win matters mainly at hundreds-to-thousands of mixins — which is exactly
  where a saved first-render millisecond is worth having.

## 22. The verdict

```
speed:        C-array  <  B  <<  C-uuid  <<<  C3
shippable:     ✗ (ids)    ✓      ✓ (id tax)     (this is the baseline)
```

The only strategy faster than B (C-array) cannot be shipped, because its speed depends on
non-persistent sequential ids. The only shippable form of C (C-uuid) is several times slower
than B and carries the entire identity apparatus — hashing, name canonicalization, version
skew, a single shared registry. B sits in the sweet spot: within ~25% of the unshippable best
case, several times faster than the realistic alternative, with a compact emit, and — because
it carries transitive values inside the dependency arrays — correct across packages while
needing **no id at all**.

**Conclusion: precompute the order as a per-node merge plan (approach B).** It moves the
$O(k N^2)$ merge to compile time, leaves the runtime an $O(n)$ array-copy, and sidesteps the
identity problem that sinks the only faster alternative.

---

## Reproduce

```bash
pnpm run bench:c3                                       # default run
TS_MIXIN_C3_WINDOW=128 TS_MIXIN_C3_DEP_MAX=16 \
  node dist/bench/c3/index.js                           # after one build, tune knobs
```

Knobs (env): `TS_MIXIN_C3_SIZES`, `TS_MIXIN_C3_WINDOW`, `TS_MIXIN_C3_DEP_MIN`,
`TS_MIXIN_C3_DEP_MAX`, `TS_MIXIN_C3_SAMPLES`, `TS_MIXIN_C3_WARMUPS`, `TS_MIXIN_C3_SEED`.

## References

- K. Barrett, B. Cassels, P. Haahr, D. Moon, K. Playford, P. Withington. *A Monotonic
  Superclass Linearization for Dylan.* OOPSLA 1996. (Defines C3; proves monotonicity.)
- F. Hivert, N. Thiéry. *Controlling the C3 super class linearization algorithm for large
  hierarchies of classes.* arXiv:2401.12740, 2024. (Posets with no consistent local order.)
