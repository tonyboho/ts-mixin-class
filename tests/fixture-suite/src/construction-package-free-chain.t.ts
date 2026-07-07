import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { Panel } from "./construction-namespace-import-base.t.js"

// Subclassing a construction consumer declared in a PACKAGE-FREE file: `Panel`'s module
// never mentions the package (it only imports its base from a sibling module), so the
// construction-base registry's text prefilter would skip it — the registry must admit
// files whose extends chains resolve into already-collected candidates, or `Board`
// silently loses construction. The chain compounds every qualified form closed so far:
// Board -> Panel (package-free file) -> lib.Widget (namespace import) -> data.Model
// (local namespace) -> Base.

class Board extends Panel {
    public boardValue?: number = 0
}

const board = Board.new({
    boardValue : 3,
    modelId    : "b1",
    panelValue : "pv",
    tag        : "bt"
})

const t1: string = board.modelId
const t2: number | undefined = board.boardValue
const t3: string | undefined = board.panelValue

// @ts-expect-error the chain's required key survives the package-free hop.
Board.new({ boardValue: 3 })

// @ts-expect-error the subclass config rejects unknown properties.
Board.new({ modelId: "b2", missing: 1 })

it("a subclass of a consumer from a package-free file constructs through its own static new", (t: Test) => {
    t.isInstanceOf(board, Board, ".new returns the subclass instance")
    t.isInstanceOf(board, Panel, "the package-free consumer stays in the runtime chain")
    t.equal(board.modelId, "b1", "the required key from the deep chain is assigned")
    t.equal(board.panelValue, "pv", "the package-free consumer's key is assigned")
    t.equal(board.boardValue, 3, "the subclass's own config key is assigned")
    t.equal(board.tagged(), "#bt", "the mixin key from the deep chain is assigned")
})

void [ t1, t2, t3 ]
