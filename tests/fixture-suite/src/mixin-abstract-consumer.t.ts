import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §2 boundary: an ABSTRACT consumer (`abstract class Task implements Loggable`) — a realistic
// "base class for further subclassing" shape. The transform must keep the consumer abstract
// (its own `abstract` method stays required of subclasses, and `new Task()` is rejected) while
// still injecting the mixin's members, which the abstract class can use in a concrete method.
// A concrete subclass then carries the mixin members and satisfies the abstract contract.
@mixin()
class Loggable {
    log: string[] = []

    record(message: string): void {
        this.log.push(message)
    }
}

abstract class Task implements Loggable {
    abstract run(): string

    execute(): string {
        const result = this.run()

        this.record(result)

        return result
    }
}

class PrintTask extends Task {
    run(): string {
        return "printed"
    }
}

// Type-only negative check (never executed): the consumer stays abstract.
function typeOnlyChecks(): void {
    // @ts-expect-error an abstract consumer cannot be instantiated directly.
    new Task()
}
void typeOnlyChecks

const task = new PrintTask()

const out: string = task.execute()

it("mixin abstract consumer", async (t: Test) => {
    t.equal(out, "printed", "the abstract consumer's concrete method runs through the subclass")
    t.isDeeply(task.log, [ "printed" ], "the mixin member is usable from the abstract consumer and present on the subclass")
    t.isInstanceOf(task, Loggable, "the concrete subclass of an abstract consumer matches the mixin")
})

void out
