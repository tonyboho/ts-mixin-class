# Tests as specification

## Thesis

Tests are not "checking the code." Tests are the **specification**, written in an executable,
self-checking form. The code implements behavior; the tests **define** which behavior counts as
correct in the first place. In that sense tests are, in a way, more important than the code
itself: the code can be rewritten from scratch, and if the test set is complete, the new
implementation will be equivalent to the old one. The converse does not hold — from code without
tests you cannot recover which parts of its behavior were *intended* and which are accidents of
the current implementation.

## A specification without tests hangs in the air

If the requirements live only in someone's head, in commit messages, or in comments, they are
**not pinned down**. They cannot be tracked, cannot be frozen, cannot be verified as still
holding. Any edit can quietly violate them, and no one will know until it breaks for a user. A
test moves a requirement from "implied" to "fixed": while the test is green the requirement
holds; the moment it goes red the requirement has been violated — explicitly and immediately.

## The space of behaviors is multidimensional — we carve a figure in it

The set of possible inputs and scenarios is a space with many dimensions: modes (emit /
source-view), forms of inheritance (`extends Base` / `extends <class>` / `implements` /
`extends <mixin>`), generics, required vs. optional fields, the number of merged mixins,
dependency chains, name collisions, cross-file cases, and so on. Correct behavior is a **figure**
in that space: the set of points where the system must behave in a specific way.

The job of tests is to **trace the contour of that figure** with enough points that its shape
cannot be deformed unnoticed. The more dimensions we cover, and the wider we range along each
one, the more precisely the shape is pinned down. From there the shape is **held by the code** —
but it is the tests that tell the code which shape to hold.

Hence the stance: make coverage **as broad, full, and wide as possible** — not one happy point,
but the boundary (a required field really is required; an unknown field really is rejected; a
conflict that *should* surface does surface). The boundary is more informative than the center:
it catches the regressions that an "almost-right" implementation slips through.

## Analogy: reconstructing a function from points

Imagine an unknown function with an unknown graph that you need to reproduce. The only way to do
it is by **sampling**: take a point — learn the function's value there — plot the point; take the
next one — plot the next. Each test is one such sample: "at this point of the input space the
system is required to behave like this." From one or two points you cannot guess the shape. But
once there are many samples, spread across the whole interesting range, the points merge into a
**graph** — the figure emerges, and it becomes clear what function this is.

The specification *is* that reconstructed graph. The tests are the points on it. The larger and
wider the set of samples — especially where the function "bends," at boundaries and special
cases — the more precise and stable the reproduced shape, and the fewer ways there are to quietly
swap it for a different curve that happened to pass through the same few points.

## Every failure that the spec says must pass is a new test

This is the main operational rule. When a case turns up that **the spec requires to work** but
doesn't (or the reverse — must fail but passes), that is not merely "a bug to fix." It is a
**hole in the pinned-down specification**: a point of the space the contour did not cover. Fixing
the code is not enough — without a test the same hole stays open and will regress tomorrow. So
the rule is strict: **every such case gets a test, and that test stays forever.** A fix without a
test is a fix left hanging in the air.

## A test must probe the same plane the bug lives in

A lesson from this work worth singling out: **a test catches a regression only if it probes the
same dimension where things can break.** There was a bug where `tsc` (emit) was clean while the
editor (source-view) showed an error. An emit transform test would have passed even with the bug
— it guarded nothing. Only a test through tsserver/source-view could catch it. The takeaway: the
dimension of verification must match the dimension of risk. Coverage "in general" is not enough —
you need coverage of the **right plane**.

And second: a throwaway probe that confirmed something and was discarded does **not** pin down
the spec. If a check matters, it becomes a permanent test, not a remnant in the terminal history.

## Tests as executable assertions

A good test does not just "run without errors" — it **asserts**. A `@ts-expect-error` next to a
knowingly-wrong call is an assertion that "an error is required here"; if there is no error, the
directive becomes unused and goes red itself. This turns a negative requirement ("this must not
compile") into something just as pinned-down as a positive one. The specification is also about
what the system must **not** do.

## Conclusion

Write a test for every behavior the specification treats as required — both positive and
negative. Cover the boundaries, not just the center. Match the plane of verification to the plane
of risk. Turn every meaningful failure into a permanent test. Then the specification stops
hanging in the air — it becomes a shape the code is obliged to hold, and one that cannot be
broken silently.
