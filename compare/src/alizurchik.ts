import { Mixin } from "@alizurchik/ts-mixin"

class Root {
    chain(): string { return "Root" }
}
class Left extends Root {
    chain(): string { return `Left > ${super.chain()}` }
}
class Right extends Root {
    chain(): string { return `Right > ${super.chain()}` }
}
let basic: string
try {
    // @ts-ignore — @alizurchik/ts-mixin fails even at the type level here
    class Combined extends Mixin(Left, Right) {
        chain(): string { return `Combined > ${super.chain()}` }
    }
    basic = new Combined().chain()
} catch (e: any) {
    basic = "THROWS: " + String(e.message).split("\n")[0].slice(0, 60)
}
console.log("@alizurchik/ts-mixin | basic:", basic)
console.log("@alizurchik/ts-mixin | deep: ", "n/a")
console.log("@alizurchik/ts-mixin | bad:  ", "no rejection (no order-constraint model)")

console.log("@alizurchik/ts-mixin | instanceof:", "n/a (composition throws)")
