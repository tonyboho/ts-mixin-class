import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

class UserBase {
    prefix: string

    constructor(prefix: string) {
        this.prefix = prefix
    }

    static baseStatic(): string {
        return "baseStatic"
    }
}

@mixin()
class Named {
    static mixinStatic(): string {
        return "mixinStatic"
    }

    name: string = "Ada"

    label(): string {
        return this.name
    }
}

@mixin()
class StoredValue<T> {
    value: T | undefined

    getValue(): T | undefined {
        return this.value
    }
}

class ManualUser extends Named.mix(UserBase) {
    read(): string {
        return `${this.prefix}/${this.label()}`
    }
}

class ManualStringValue extends StoredValue.mix<string, typeof UserBase>(UserBase) {
}

const user = new ManualUser("user")
const generic = new ManualStringValue("generic")

generic.value = "value"

const t1: string = user.prefix
const t2: string = user.label()
const t3: string = user.read()
const t4: string = ManualUser.baseStatic()
const t5: string = ManualUser.mixinStatic()
const t6: string | undefined = generic.getValue()

// @ts-expect-error ManualUser keeps the base constructor signature.
new ManualUser(1)

// @ts-expect-error Generic manual mix application keeps the explicit mixin type argument.
generic.value = 1

generic.value = "value"

// @ts-expect-error Generic mix applications must include the base type when mixin type arguments are explicit.
StoredValue.mix<string>(UserBase)

it("manual mix property application", async (t: Test) => {
    t.equal(user.prefix, "user", "Manual mix application keeps base constructor fields")
    t.equal(user.label(), "Ada", "Manual mix application adds mixin methods")
    t.equal(user.read(), "user/Ada", "Manual mix application can be extended by a consumer class")
    t.equal(ManualUser.baseStatic(), "baseStatic", "Manual mix application keeps base statics")
    t.equal(ManualUser.mixinStatic(), "mixinStatic", "Manual mix application keeps mixin statics")
    t.isInstanceOf(user, UserBase, "Manual mix instance matches the base")
    t.isInstanceOf(user, Named, "Manual mix instance matches the mixin")
    t.equal(generic.getValue(), "value", "Generic manual mix application keeps mixin fields")
    t.isInstanceOf(generic, UserBase, "Generic manual mix instance matches the base")
    t.isInstanceOf(generic, StoredValue, "Generic manual mix instance matches the mixin")
})

void [ t1, t2, t3, t4, t5, t6 ]
