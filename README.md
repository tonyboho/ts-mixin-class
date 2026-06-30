# ts-mixin-class

`ts-mixin-class` adds practical multiple inheritance to TypeScript classes.

You write normal classes, mark reusable inheritance units with `@mixin()`, and list
the mixins from a consumer class in `implements`. The transformer turns that into a
linear runtime inheritance chain before TypeScript checks and emits the program.

The inheritance order is resolved with C3 linearization, the same method-resolution
order algorithm used by Python. That gives predictable `super` calls, deduplicates
diamond-shaped dependencies, and rejects incompatible ordering requirements.

The C3 linearization is precomputed at compile time, so zero runtime overhead is added.

```ts
import { mixin } from "ts-mixin-class"

@mixin()
class Named {
    name: string = "Ada"

    label(): string {
        return this.name
    }
}

@mixin()
class Timestamped {
    createdAt: Date = new Date()

    age(): number {
        return Date.now() - this.createdAt.getTime()
    }
}

class User implements Named, Timestamped {
    describe(): string {
        return `${super.label()} / ${super.age()}ms`
    }
}

const user = new User()

user.label()
user.age()
user instanceof Named
user instanceof Timestamped
```

## Setup

Include `ts-mixin-class` as a regular dependency and `ts-patch` as a dev
dependency in your `package.json`. Also add a `prepare` script:

```json
{
    "dependencies": {
        "ts-mixin-class": "0.0.7"
    },
    "devDependencies": {
        "ts-patch": "4.0.1"
    },
    "scripts": {
        "prepare": "ts-patch install"
    }
}
```

Include `ts-mixin-class` as a compiler plugin in `tsconfig.json`:

```json
{
    "compilerOptions": {
        "plugins": [
            {
                "transform": "ts-mixin-class",
                "transformProgram": true
            },
            {
                "name": "ts-mixin-class/language-service-plugin"
            }
        ]
    }
}
```

Run `prepare` once so `ts-patch` patches your local TypeScript:

```shell
pnpm run prepare
```

## Linearization

When mixins depend on other mixins, `ts-mixin-class` uses C3 linearization to build
one runtime inheritance chain. C3 keeps local ordering intact, deduplicates shared
dependencies, and makes `super` calls follow the same order everywhere.

```ts
import { mixin } from "ts-mixin-class"

@mixin()
class Root {
    print(): string {
        return "Root"
    }
}

@mixin()
class Left implements Root {
    print(): string {
        return `Left > ${super.print()}`
    }
}

@mixin()
class Right implements Root {
    print(): string {
        return `Right > ${super.print()}`
    }
}

class Combined implements Left, Right {
    print(): string {
        return `Combined > ${super.print()}`
    }
}

new Combined().print()
// "Combined > Left > Right > Root"
```

The order is computed once at compile time and emitted as a compact plan, so at runtime the
chain can be assembled by replaying that plan rather than running the full C3 algorithm. Two
compile-time flags (implemented as environment variables) control this:

- `TS_MIXIN_VERIFY_LINEARIZATION` (on by default) — emits an extra-safety mode that re-checks
  every replayed order against C3 at runtime and throws on a mismatch. Recommended during
  development; set it to `0` when building for production to drop the check.
- `TS_MIXIN_DISABLE_LINEARIZATION_PLAN` — set it to `1` to emit code that ignores the plan and
  runs C3 at runtime instead. An escape hatch: if you ever hit a mismatch between the replayed
  order and C3 (please report it as a bug), rebuild with this set to fall back to C3.

## Required bases

A mixin can declare a required consumer base with `extends`:

```ts
class ModelBase {
    id: string = ""
}

@mixin()
class Persisted extends ModelBase {
    save(): string {
        return this.id
    }
}

class DomainModel extends ModelBase {
    collection: string = "users"
}

class UserModel extends DomainModel implements Persisted {
}
```

For a mixin class, `extends ModelBase` means “this mixin can only be applied to
`ModelBase` or one of its descendants”. It does not permanently lock the consumers of the mixin to that
exact runtime base. Both typecheck and runtime enforce this requirement.

## Mixin classes are classes

Mixin classes are still regular classes. You can instantiate them directly, access their
static members, and use them with `instanceof`:

```ts
const named = new Named()

named.label()
named instanceof Named
```

For a mixin with the base class requirement, the standalone mixin class is built on its canonical required
base:

```ts
class ModelBase {
}

@mixin()
class Persisted extends ModelBase {
}

const persisted = new Persisted()

persisted instanceof ModelBase
persisted instanceof Persisted
```

## Manual application

Mixin classes can also be applied manually. This is useful when a library publishes
classes created with this transformer, but the consuming project does not run the
transformer itself:

```ts
import { Named } from "library_providing_a_mixin"

class UserBase {
    name: string = "Ada"
}

class User extends Named.mix(UserBase) {
}

const user = new User()

user.name
user.label()
user instanceof Named
user instanceof UserBase
```

For mixins with generics, TypeScript cannot infer the base type after explicit mixin type
arguments in the same call. Provide both the generic type arguments of the mixin and the base constructor
type as the last type argument:

```ts
@mixin()
class StoredValue<T> {
}

class StringBox extends StoredValue.mix<string, typeof UserBase>(UserBase) {
}
```

## Generics

Generics are fully supported:

```ts
@mixin()
class StoredValue<T> {
    value: T | undefined

    getValue(): T | undefined {
        return this.value
    }
}

@mixin()
class ValueLabel<T> implements StoredValue<T> {
    label(): string {
        return String(super.getValue())
    }
}

class Box<T> implements ValueLabel<T>, StoredValue<T> {
    constructor(value: T) {
        this.value = value
    }
}

const box = new Box<number>(42)

const value: number | undefined = box.getValue()
const label: string = box.label()
```

## Cooperative initialization

Constructor signatures for mixins are generally not composable, because JavaScript, unlike Python, does not have named arguments, only positional ones.

Instead, mixins introduce a "cooperative initialization" pattern, similar in spirit to Python's
[`super()` cooperative multiple inheritance](https://docs.python.org/3/library/functions.html#super).
To opt in to this mechanism, extend the provided `Base` class (directly or transitively, via a consumed mixin).
This mechanism is fully optional and you don't need it to use this library.

Cooperative initialization provides a static method `new` as a constructor.

```ts
import { Base } from "ts-mixin-class/base"

class Model extends Base {}

const model = Model.new()
```

After opting in, calling the native constructor of the class directly with `new` will generate a type error. It is a compile-time-only guard — a descriptive type error points back to the static factory:

```ts
// Error: Use `Model.new({ ... })` to construct - direct `new Model(...)` is disabled;
// construction runs through the generated static `new` factory.
new Model()
```

### Config of the class

The static `new` constructor accepts a single object argument - a config for the instance.

A type for this argument is derived as a combination of all properties of the class with the `public` modifier. Properties without the `public` modifier are not included in the config type and cannot be provided for instantiation. A property marked with `!` is required in the config type; every other public property is optional. Unlike the standard TypeScript rule, a `!` property may still carry an initializer — it is applied during the native constructor call and lets the JS engine settle on a stable "shape" for the property.

The config type is created as a phantom declaration using your class name plus a `Config` suffix. It is exported if your class itself is
exported. You can use this type normally in the code.

```ts
import { Base } from "ts-mixin-class/base"

class Model extends Base {
    // required in the config, initializer is ok
    public id!: string = ""

    // optional in the config
    public name: string = ""

    // optional in the config - does not have "!"
    // "?" does not have any special meaning for configs
    public type?: string = ""

    // not in the config
    kind: string = ""
}

// the argument of the constructor has `ModelConfig` type
const model = Model.new({ id : "42" })

// class config is a regular (though phantom) type
const cfg: ModelConfig = { id : "35", name : "He-Man" }

// @ts-expect-error - unknown config name
Model.new({ id : "42", nope : "nope" })

// @ts-expect-error - missing required `id` config
Model.new({ name : "He-Man" })
```

If a property consists of a getter and a setter with different types, the config will contain the setter's type, since that is what
the assignment code path actually accepts.

If a property is marked as `readonly` (along with `public`), it is still included in the config, while remaining non-writable
in the rest of the code.

### Instantiation flow

- Instantiation starts as: `MixinClass.new({ ... })`
- A native JS constructor is called without arguments. It assigns the property initializer expressions to all properties. It is good practice to provide an initializer for every property — see [Stable object shapes](#stable-object-shapes-filling-missing-initializers) for details.
- An `initialize` method is called with the configuration object given to the initial static `new` constructor.
`initialize` just performs `Object.assign(this, config)`, so all configs are applied to the instance at once, in no particular order.

### Initialize method

Override the `initialize` method when a class needs derived state or validation before/after config assignment.

```ts
import { Base } from "ts-mixin-class/base"

class User extends Base {
    public firstName: string = ""
    public lastName: string = ""

    fullName: string = ""

    override initialize(config: UserConfig): void {
        // potential early validation - properties are not initialized yet
        super.initialize(config)

        // properties have been initialized - can access them via `this`
        this.fullName = `${this.firstName} ${this.lastName}`.trim()
    }
}

const user = User.new({
    firstName : "Ada",
    lastName  : "Lovelace"
})
```

### Instantiation with generics

Mixin classes and consumers with generics can also use the static `new` constructor. It keeps
generic parameters from the class declaration. The type can be written explicitly or inferred from the config
object:

```ts
@mixin()
class BoxFlags {
    public touched: boolean = false
}

class ConfiguredBox<T> extends Base implements BoxFlags {
    public value!: T
}

const explicit = ConfiguredBox.new<number>({
    value   : 1,
    touched : true
})
const numericValue: number = explicit.value

const inferred = ConfiguredBox.new({
    value   : "Ada",
    touched : true
})
const stringValue: string = inferred.value
```


### Stable object shapes (filling missing initializers)

In V8, property access on an object can be JIT-optimized only if the object's "shape" stays
constant (no properties are added or removed). It is therefore important to provide an
initializer for every property in the class.

To avoid the boilerplate, this transformer can do it automatically for classes that extend
`Base`, directly or transitively. The behavior is controlled by the `fillMissedInitializersWith`
option, which can be set to `"undefined"` (the default), `"null"`, or `"nothing"` to disable
filling.

```json
{
    "compilerOptions": {
        "plugins": [
            {
                "transform": "ts-mixin-class",
                "transformProgram": true,
                "fillMissedInitializersWith": "undefined"
            }
        ]
    }
}
```


## Limitations

A few things the library does not support yet.

- **Mixin members can't be `private`, `protected`, `#private`, or `abstract`.** Mixins are
  shared between classes by their structure, and these modifiers are tied to one specific
  class, so they don't compose. Use ordinary members, or keep private state in a non-mixin
  base class.

- **Mixin members need explicit type annotations** — on properties, methods, accessors, and
  method parameters. The library needs to know a mixin's public shape up front, where
  TypeScript would otherwise infer it.

- **Mixin consumers and `@mixin`es must be named class declarations**, at the top level or
  nested in a function or block. Anonymous classes and class expressions are rejected — the
  library has nowhere stable to attach the helpers it generates. A nested class is a local: it
  can't be exported.

- **A consumer's base can't be a dynamic expression** such as `extends makeBase()`. Use a
  named base class for now.

- **Editor navigation on the base name in an `extends` clause is limited.** Go-to-definition,
  find-all-references, and quickinfo on the base name work for a plain `extends Base`, but not
  for a generic consumer, a `Base`-construction consumer, or a qualified base
  (`extends ns.Base`) — there the base name doesn't resolve. Everything else (the class name,
  its type parameters, its members) navigates normally; navigate from the base class's own
  declaration instead.


## Technical notes

`ts-mixin-class` is a `ts-patch` ProgramTransformer: it rewrites your source files before
TypeScript typechecks and emits them.

At a high level:

- Each `@mixin()` class expands into an interface (its type surface), a runtime factory,
  and a canonical runtime value built from that factory.
- Each consumer expands through a generated intermediate base class wired up with
  `mixinChain(...)`.
- Declaration merging hands the consumer the instance types of the mixins it uses.
- The runtime helpers handle C3 linearization, canonical mixin reuse, required-base
  checks, and `instanceof` (`Symbol.hasInstance`).

For example, two mixins and a consumer that uses them:

```ts
@mixin()
class Named {
    name: string = ""

    label(): string {
        return this.name
    }
}

@mixin()
class Timestamped {
    createdAt: Date = new Date()

    age(): number {
        return Date.now() - this.createdAt.getTime()
    }
}

class User implements Named, Timestamped {
    describe(): string {
        return `${super.label()} / ${super.age()}ms`
    }
}
```

expand, conceptually, into:

```ts
// Each @mixin() class becomes an interface (its type surface), a runtime factory,
// and a canonical value built from that factory.
interface Named {
    name: string
    label(): string
}

const __Named$mixin = (base: AnyConstructor) => class extends base {
    name: string = ""

    label(): string {
        return this.name
    }
}

const Named = defineMixinClass("Named", __Named$mixin)

interface Timestamped {
    createdAt: Date
    age(): number
}

const __Timestamped$mixin = (base: AnyConstructor) => class extends base {
    createdAt: Date = new Date()

    age(): number {
        return Date.now() - this.createdAt.getTime()
    }
}

const Timestamped = defineMixinClass("Timestamped", __Timestamped$mixin)

// The consumer gets an intermediate base that chains the mixins in C3 order, plus a
// merged interface that hands it their instance types.
interface __User$base extends Named, Timestamped {
}

class __User$empty {
}

class __User$base extends (
    mixinChain(__User$empty, Named, Timestamped) as unknown as
        typeof __User$empty &
        ClassStatics<typeof Named> &
        ClassStatics<typeof Timestamped>
) {
}

class User extends __User$base implements Named, Timestamped {
    describe(): string {
        return `${super.label()} / ${super.age()}ms`
    }
}
```

The overhead is small. Most of what the transformer adds lives at the type level — the
interfaces, casts, and merges above — and is erased before any JavaScript runs. At runtime
the only added work is composing the mixins into a single inheritance chain via C3
linearization; from there your classes behave like ordinary classes.


## License

MIT License
