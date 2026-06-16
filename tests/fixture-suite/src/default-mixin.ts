import { mixin } from "ts-mixin-class"

@mixin()
export default class DefaultMixin {
    defaultValue: string = "default"

    defaultMethod(): string {
        return this.defaultValue
    }

    static staticDefault(): string {
        return "staticDefault"
    }
}
