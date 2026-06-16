import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { C3LinearizationError, mergeC3Linearizations } from "../src/c3-linearization.js"

it("merges empty C3 sequences", async (t: Test) => {
    t.expect(mergeC3Linearizations<string>([])).toEqual([])
    t.expect(mergeC3Linearizations([ [], [] ])).toEqual([])
})

it("merges a diamond dependency graph in C3 order", async (t: Test) => {
    const result = mergeC3Linearizations([
        [ "B", "A" ],
        [ "C", "A" ],
        [ "B", "C" ]
    ])

    t.expect(result).toEqual([ "B", "C", "A" ])
})

it("deduplicates repeated entries inside input sequences", async (t: Test) => {
    const result = mergeC3Linearizations([
        [ "B", "A", "A" ],
        [ "A" ],
        [ "B", "A" ]
    ])

    t.expect(result).toEqual([ "B", "A" ])
})

it("throws with pending sequences when C3 order is inconsistent", async (t: Test) => {
    try {
        mergeC3Linearizations([
            [ "A", "B" ],
            [ "B", "A" ]
        ])

        t.fail("Expected C3 merge to reject inconsistent order")
    }
    catch (error) {
        t.isInstanceOf(error, C3LinearizationError, "Throws a C3-specific error")
        t.expect((error as C3LinearizationError<string>).pendingSequences).toEqual([
            [ "A", "B" ],
            [ "B", "A" ]
        ])
    }
})
