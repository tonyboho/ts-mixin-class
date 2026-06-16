import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { ContractMixin, RequiredBase, RequiredMixin, SourceClass1, SourceClass2, type PlainContract } from "./mixins.js"


class Base<T> {
    baseValue: T

    constructor(baseValue: T) {
        this.baseValue = baseValue
    }

    baseMethod(): T {
        return this.baseValue
    }

    static staticMethod(): string {
        return "staticMethod"
    }
}

class Consumer<A2> extends Base<A2> implements SourceClass1<string>, SourceClass2<A2> {
    method1(): string {

        this.value1 = "value1"

        this.value2 = "value2"

        return super.method1()
    }

    methodBase(): A2 {
        return super.baseMethod()
    }
}

class RequiredConsumerBase extends RequiredBase {
    override requiredMethod(): string {
        return "consumerBase/" + super.requiredMethod()
    }
}

class RequiredConsumer extends RequiredConsumerBase implements RequiredMixin {
    ownRequired(): string {
        return super.requiredMixinMethod()
    }
}

class ContractConsumer implements ContractMixin {
}


it("uses imported mixins with a generic consumer base", async (t: Test) => {
    const instance = new Consumer(42)
    const required = new RequiredConsumer()
    const contract = new ContractConsumer()
    const canonical1 = new SourceClass1<number>()
    const canonical2 = new SourceClass2<boolean>()
    const canonicalContract = new ContractMixin()
    const canonicalRequired = new RequiredMixin()
    const typedContract: PlainContract = contract

    t.equal(instance.value1, "value1", "Class decorated with @mixin() compiles and runs")
    t.equal(instance.value2, "value2", "Class decorated with @mixin() compiles and runs")

    t.equal(instance.baseValue, 42, "Generic base field is preserved")
    t.equal(instance.methodBase(), 42, "Generic base super method is preserved")

    t.equal(instance.method1(), "value1", "Class decorated with @mixin() compiles and runs")
    t.equal(instance.method2(), "value2", "Class decorated with @mixin() compiles and runs")
    t.equal(instance.passThrough1("typed"), "typed", "Imported generic mixin type argument is preserved")
    t.equal(instance.passThrough2(42), 42, "Imported generic consumer type argument is preserved")

    t.equal(Consumer.staticMethod1(), "staticMethod1", "Class decorated with @mixin() compiles and runs")
    t.equal(Consumer.staticMethod2(), "staticMethod2", "Class decorated with @mixin() compiles and runs")

    t.isInstanceOf(instance, SourceClass1, "Imported consumer matches the first consumed mixin")
    t.isInstanceOf(instance, SourceClass2, "Imported consumer matches the second consumed mixin")
    t.isInstanceOf(instance, Base, "Imported consumer keeps its explicit base")

    t.equal(required.requiredMixinMethod(), "consumerBase/requiredBase/requiredMixin", "Imported required-base mixin uses the concrete base")
    t.equal(required.ownRequired(), "consumerBase/requiredBase/requiredMixin", "Imported required-base mixin is available through super")
    t.equal(RequiredConsumer.staticRequired(), "staticRequired", "Imported required-base consumer keeps base statics")
    t.equal(RequiredConsumer.staticRequiredMixin(), "staticRequiredMixin", "Imported required-base consumer keeps mixin statics")
    t.isInstanceOf(required, RequiredMixin, "Imported required-base consumer matches the mixin")
    t.isInstanceOf(required, RequiredBase, "Imported required-base consumer keeps the required base")

    t.equal(contract.contractMethod(), "contract", "Consumer gets behavior from a mixin with a plain implements contract")
    t.equal(typedContract.contractMethod(), "contract", "Mixin plain implements contract is preserved on the consumer type")
    t.isInstanceOf(contract, ContractMixin, "Consumer matches the mixin with a plain implements contract")
    t.equal(canonicalContract.contractMethod(), "contract", "Canonical mixin with a plain implements contract can be instantiated")
    t.isInstanceOf(canonicalContract, ContractMixin, "Canonical mixin with a plain implements contract matches itself")

    t.equal(canonical1.passThrough1(42), 42, "Imported canonical mixin class can be instantiated")
    t.equal(canonical1.method1(), "value1", "Imported canonical mixin class methods work")
    t.isInstanceOf(canonical1, SourceClass1, "Imported canonical mixin instance matches its mixin class")
    t.equal(canonical2.passThrough2(true), true, "Second imported canonical mixin class can be instantiated")
    t.isInstanceOf(canonical2, SourceClass2, "Second imported canonical mixin instance matches its mixin class")
    t.equal(canonicalRequired.requiredMixinMethod(), "requiredBase/requiredMixin", "Imported canonical required-base mixin can be instantiated")
    t.isInstanceOf(canonicalRequired, RequiredMixin, "Imported canonical required-base mixin matches itself")
    t.isInstanceOf(canonicalRequired, RequiredBase, "Imported canonical required-base mixin inherits from the required base")
})
