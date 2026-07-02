import { Base, mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// The stress-corpus plane of the pass-7/8 member-shape pins: OVERLOADED constructors on a
// consumer and on a mixin (§2.18), a consumer's own PRIVATE surface (§2.19), a static helper
// calling the generated `.new` from inside the class body (§7.21), and the `override`
// modifier on mixin-member overrides (§2.23 — legal in the default config).

@mixin()
class Greeter {
    greet(): string {
        return "hi"
    }
}

class Pair implements Greeter {
    a: number
    b: number

    constructor(a: number)
    constructor(a: number, b: number)
    constructor(a: number, b: number = a * 10) {
        this.a = a
        this.b = b
    }
}

@mixin()
class Stamped {
    stamp: string = ""

    constructor(seed?: string)
    constructor(seed: string, extra: number)
    constructor(seed: string = "s", extra: number = 0) {
        this.stamp = `${seed}:${extra}`
    }
}

class Doc implements Stamped {
}

class Vault implements Greeter {
    #secret: string = "s3cr3t"

    private note: string = "n"

    protected level: number = 1

    reveal(): string {
        return `${this.#secret}/${this.note}/${this.level}/${this.greet()}`
    }
}

class Only implements Greeter {
    private static stored: Only | undefined

    private constructor() {
    }

    static instance(): Only {
        Only.stored ??= new Only()

        return Only.stored
    }
}

class Job extends Base {
    public name: string = ""

    static make(name: string): Job {
        return Job.new({ name })
    }
}

class Overrider implements Greeter {
    override greet(): string {
        return super.greet() + "!"
    }
}

@mixin()
class LoudGreeter implements Greeter {
    override greet(): string {
        return super.greet().toUpperCase()
    }
}

class Speaker implements LoudGreeter {
}

it("overloaded constructors on a consumer and on a mixin", (t: Test) => {
    t.equal(new Pair(2).b, 20, "the consumer's single-argument overload applies the default")
    t.equal(new Pair(2, 3).b, 3, "the two-argument overload passes through")
    t.equal(new Doc().stamp, "s:0", "the mixin's overloaded constructor runs through the chain")
})

it("a consumer's own private surface", (t: Test) => {
    t.equal(new Vault().reveal(), "s3cr3t/n/1/hi", "#private, private and protected members work")
    t.is(Only.instance(), Only.instance(), "a private constructor + static factory stays a singleton")
})

it("a static helper calling the generated .new from inside the class body", (t: Test) => {
    t.equal(Job.make("j").name, "j", "the helper builds through the generated factory")
})

it("the override modifier on mixin-member overrides (default config)", (t: Test) => {
    t.equal(new Overrider().greet(), "hi!", "a consumer override marked `override` chains through super")
    t.equal(new Speaker().greet(), "HI", "a mixin marked `override` over its dependency does too")
})
