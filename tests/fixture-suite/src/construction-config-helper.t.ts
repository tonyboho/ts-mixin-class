import { Base } from "ts-mixin-class"


type Assert<T extends true> = T

type Equal<Left, Right> =
    (<T>() => T extends Left ? 1 : 2) extends
        (<T>() => T extends Right ? 1 : 2)
        ? true
        : false

class ConfigShapeModel extends Base {
    public firstName!: string = ""
    public lastName!: string = ""

    fullName(): string {
        return `${this.firstName} ${this.lastName}`.trim()
    }

    // The generated, strict `<ClassName>Config` alias is a valid `initialize` parameter
    // type for a plain construction class (the base `initialize` takes `unknown`).
    override initialize(config?: ConfigShapeModelConfig): void {
        super.initialize(config)
    }
}

// The generated alias carries exactly the public config fields (methods excluded).
type ConfigShapeModelConfigKeys = keyof ConfigShapeModelConfig
type ConfigShapeModelConfigHasExpectedKeys = Assert<Equal<
    ConfigShapeModelConfigKeys,
    "firstName" | "lastName"
>>

const configShapeOk: ConfigShapeModelConfig = {
    firstName : "Ada",
    lastName  : "Lovelace"
}

// @ts-expect-error the generated config alias excludes methods.
const configShapeRejectsMethods: ConfigShapeModelConfig = { fullName : () => "Ada Lovelace" }

// @ts-expect-error the generated config alias rejects properties that are not config fields.
const configShapeRejectsUnknown: ConfigShapeModelConfig = { age : 36 }

const created = ConfigShapeModel.new({ firstName : "Ada", lastName : "Lovelace" })

void [
    configShapeOk,
    configShapeRejectsMethods,
    configShapeRejectsUnknown,
    created
]

export type { ConfigShapeModelConfigHasExpectedKeys }
