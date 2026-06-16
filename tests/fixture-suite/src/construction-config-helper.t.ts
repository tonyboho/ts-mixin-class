import { Base, type Config } from "ts-mixin-class"


type Assert<T extends true> = T

type Equal<Left, Right> =
    (<T>() => T extends Left ? 1 : 2) extends
        (<T>() => T extends Right ? 1 : 2)
        ? true
        : false

class ConfigShapeModel extends Base {
    public firstName: string = ""
    public lastName: string = ""

    fullName(): string {
        return `${this.firstName} ${this.lastName}`.trim()
    }

    override initialize(config?: Config<this>): void {
        super.initialize(config)
    }
}

type ConfigShapeModelConfig = Config<ConfigShapeModel>
type ConfigShapeModelConfigKeys = keyof ConfigShapeModelConfig
type ConfigShapeModelConfigHasExpectedKeys = Assert<Equal<
    ConfigShapeModelConfigKeys,
    "firstName" | "lastName"
>>

const configShapeOk: ConfigShapeModelConfig = {
    firstName : "Ada",
    lastName  : "Lovelace"
}

// @ts-expect-error Config helper excludes methods from the config object.
const configShapeRejectsMethods: ConfigShapeModelConfig = { fullName : () => "Ada Lovelace" }

// @ts-expect-error Config helper rejects properties that are not on the instance data shape.
const configShapeRejectsUnknown: ConfigShapeModelConfig = { age : 36 }

void [
    configShapeOk,
    configShapeRejectsMethods,
    configShapeRejectsUnknown
]
