---
"ts-mixin-class": patch
---

Fixed generic required bases across package boundaries: a generic mixin consumed from a
published package (declarations only) previously broke its consumers with spurious errors
(`Generic type requires 1 type argument(s)` and related fallout) whenever the consumer had
no explicit base, and a valid explicit base could fail the build. The required-base
constraint is now recovered from the published interface (which retains the type-parameter
mapping), so such consumers compile, get the most specific base selected at compile time,
and mismatches are reported with the instantiated base named — same behavior as within one
project.
