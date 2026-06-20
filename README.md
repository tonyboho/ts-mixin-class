# ts-mixin-class

`ts-mixin-class` adds practical multiple inheritance to TypeScript classes.

You write normal classes, mark reusable inheritance units with `@mixin()`, and list
the mixins from a consumer class in `implements`. The transformer turns that into a
linear runtime inheritance chain before TypeScript checks and emits the program.

The inheritance order is resolved with C3 linearization, the same method-resolution
order algorithm used by Python. That gives predictable `super` calls, deduplicates
diamond-shaped dependencies, and rejects incompatible ordering requirements.

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
        "ts-mixin-class": "0.0.1"
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

## Mixin Classes Are Classes

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

## Manual Application

Mixin classes can also be applied manually. This is useful when a library publishes
classes created with this transformer, but the consuming project does not run the
transformer itself:

```ts
import { Named } from 'library_providing_a_mixin'

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
type as last type argument:

```ts
@mixin()
class StoredValue<T> {
}

class StringBox extends StoredValue.mix<string, typeof UserBase>(UserBase) {
}
```

## Generics

Generics are fully supported for mixins, consumers, `super`, and the resulting instance
type.

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

## Instantiation

Constructor signatures for mixins are generally not composable, because JavaScript, unlike Python, does not have named arguments, only positional ones.

Instead, mixins use a cooperative initialization pattern, similar in spirit to Python's
[`super()` cooperative multiple inheritance](https://docs.python.org/3/library/functions.html#super).
To opt in to this mechanism, extend the provided `Base` class, which provides a static method `new` as a constructor for every derived class.

This static constructor accepts a single object argument - a config for the instance. A type for this argument is derived as a combination of
all properties of the class with the `public` modifier. Properties without the `public` modifier are not included in the config type
and cannot be provided for instantiation.

Properties with `?` are marked as optional in the config type; all other properties are required.

```ts
import { Base } from "ts-mixin-class/base"

class Model extends Base {
    // required in the config
    public id: string = ""

    // optional in the config
    public name?: string = ""
}

const model = Model.new({ id : "42" })
```

The instantiation flow is as follows:
- Instantiation starts as: `const instance = MixinClass.new({ ... })`
- A native JS constructor is called without arguments. It will assign the property initializer expressions to all properties.
It is a good performance practice to provide an initializer expression for all of your properties, to keep the shape of your class constant.
- An `initialize` method is called with the configuration object given to the initial static `new` constructor.
`initialize` just performs `Object.assign(this, config)`, so all configs are applied to the instance at once, in no particular order.

Override `initialize` when a class needs derived state or validation after config
assignment. Type the argument with the generated `<ClassName>Config` alias (see
[The generated config type alias](#the-generated-config-type-alias)):

```ts
import { Base } from "ts-mixin-class/base"

class User extends Base {
    public firstName: string = ""
    public lastName: string = ""

    fullName: string = ""

    override initialize(config: UserConfig): void {
        super.initialize(config)

        this.fullName = `${this.firstName} ${this.lastName}`.trim()
    }
}

const user = User.new({
    firstName : "Ada",
    lastName  : "Lovelace"
})
```

Because construction goes through the static `new` factory, calling the constructor
directly with `new` is disabled for classes that extend `Base` (directly or
transitively). It is a compile-time-only guard - the construct signature is branded so
that a direct call reports a descriptive type error pointing back to the static factory:

```ts
const ok  = User.new({ firstName : "Ada", lastName : "Lovelace" })

// Error: Use `User.new({ ... })` to construct - direct `new User(...)` is disabled;
// construction runs through the generated static `new` factory.
const bad = new User({ firstName : "Ada" })
```

A class that extends `Base` must not declare its own constructor: construction always
runs through `.new` and the cooperative `initialize` pattern. If you need a custom
constructor, do not extend `Base` - use a plain mixin consumer (manual construction)
instead.

### Instantiation with generics

Consumer classes with generics can also use static `new` constructor. It keeps
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

const inferred = ConfiguredBox.new({
    value   : "Ada",
    touched : true
})

const numericValue: number = explicit.value
const stringValue: string = inferred.value
```

### The generated config type alias

For every construction class the transformer also emits an **exported, named type alias**
for its `.new(...)` configuration. The name is the class name plus `Config`
(`Model` -> `ModelConfig`), and the alias carries the **same type parameters** as the
class (`Box<T>` -> `BoxConfig<T>`). The generated `static new` references it, so a failing
`.new(...)` call reads the alias name instead of a verbose inline `Pick<...>` union:

```ts
class Model extends Base {
    public id: string = ""
    public role: string = ""
}
// Generated: export type ModelConfig = Pick<Model, "id" | "role">

// Error: Argument of type '{ id: string }' is not assignable to parameter of type
// 'ModelConfig'. Property 'role' is missing ... but required in type 'ModelConfig'.
Model.new({ id : "a" })
```

When the class is exported the alias is too (see [Export tracks the class; import the
config separately](#export-tracks-the-class-import-the-config-separately) below), so you
can reuse it for your own factory helpers and annotations (it tracks the class type
parameters):

```ts
function makeModel(config: ModelConfig): Model {
    return Model.new(config)
}

const draft: ModelConfig = { id : "a", role : "admin" }
```

Use `<ClassName>Config` for the `initialize` override argument, at `.new(...)` call
sites, in factory parameters, and in annotations — everywhere you want the strict config
shape. The base `Base.initialize(props?: unknown)` is deliberately typed `unknown` so a
subclass can override it with the stricter alias:

```ts
class User extends Base {
    public id: string = ""

    override initialize(config: UserConfig): void {
        super.initialize(config)
    }
}
```

Type the parameter **required** (`config: UserConfig`), not `config?: UserConfig`:
`initialize` is always invoked with a config argument. The value can only be `undefined`
when the class has no required fields (so `User.new()` is valid with no argument); type it
`config: UserConfig | undefined` and handle the `undefined` case there.

This works for `@mixin` classes too. A mixin may override `initialize` with its own
`<MixinName>Config`, including through a mixin dependency chain. A consumer applying
several such mixins would otherwise see a `Base` + mixins interface merge with
non-identical `initialize` signatures (TS2320); the generated consumer base interface
re-declares the `Base.initialize` protocol member to resolve that, so the mixins keep
their strict overrides.

If the `<ClassName>Config` name is already declared or imported in the same file, the
generated alias is suffixed with `_` (`ModelConfig_`) so it never collides with your own
type.

#### Export tracks the class; import the config separately

The alias's `export` mirrors the class's own: an exported class (or `@mixin`) gets
`export type <Name>Config`; a module-local class gets a non-exported alias, so an internal
class does not leak its config. Because the alias is a **separate named export**, importing
the class binds only the class — the `<Name>Config` name does **not** come with it.

You do **not** need the config to construct. `.new({ ... })` on an imported class resolves
its argument type through the class's static signature, and a failing `.new(...)` still
names `<Name>Config` in the error:

```ts
import { Model } from "./model"

const m = Model.new({ id : "a", role : "admin" })   // no ModelConfig import needed
```

You only need the config when you want to **name the type yourself** — to annotate a
variable, a factory parameter, or a subclass's `initialize` argument in another file. Then
import it explicitly alongside the class (or derive it from the class, without a second
import):

```ts
import { Model, type ModelConfig } from "./model"

const draft: ModelConfig = { id : "a", role : "admin" }

function makeModel(config: ModelConfig): Model {
    return Model.new(config)
}

// Or, without importing the name — derive it from the class:
type ModelConfigDerived = Parameters<typeof Model.new>[0]
```

(The `initialize(config: <Name>Config)` examples above work without an import only because
they sit in the **same file** as the class, where the generated alias is a local sibling.)

### Initializing required properties

Required `public` properties sometimes need their own runtime slot before a real value
is known. For example, a class may want to keep object shapes stable but cannot use a
neutral value like `0` or `""`.

The `allowUndefinedForRequiredProperties` transformer option (disabled by default) allows this pattern for
required public configuration properties:

```json
{
    "compilerOptions": {
        "plugins": [
            {
                "transform": "ts-mixin-class",
                "transformProgram": true,
                "allowUndefinedForRequiredProperties": true
            }
        ]
    }
}
```

With that option enabled, the transformer accepts:

```ts
class User extends Base {
    public id: string = undefined
}

const user = User.new({ id : "42" })

const id: string = user.id
```

The property type is still `string`; it is not widened to `string | undefined`. Internally
the initializer is treated like `undefined!`, so the runtime value is `undefined` while
the declared property type remains strict.


## Limitations

These are current architectural constraints:

Mixin class members cannot be `private`, `protected`, `#private`, or abstract. A mixin is
copied into generated inheritance positions and is also exposed structurally through
interfaces for consumers. TypeScript private/protected identity and ECMAScript private
fields are intentionally nominal and class-local, which makes them a poor fit for this
kind of composition. Use ordinary members inside mixins, or keep private state in a
non-mixin base class.

Mixin class properties, methods, accessors, and method parameters need explicit TypeScript
type annotations. The transformer has to generate interface members and declaration
output before relying on inferred implementation details. In ordinary classes TypeScript
can infer public member types from initializers and method bodies, but mixins need a
stable AST-level public surface that can be copied into generated declarations.

Mixin consumers must be named top-level class declarations. The transformer inserts
sibling declarations such as `__User$empty` and `__User$base`, then rewrites the consumer
to extend the generated base. Anonymous classes, class expressions, and nested class
declarations do not have a stable place where these helper declarations can be emitted
without changing runtime scoping or evaluation order, so they are rejected with custom
diagnostics.

Dynamic consumer base expressions such as `extends makeBase()` are not supported yet. A
dynamic base would need to be evaluated exactly once, stored in a generated runtime
constant, represented on both the instance and static sides, and emitted correctly in
`.d.ts` files. Use a named base class for now.

Go-to-definition, find-all-references, and quickinfo on a base type name *inside* a class
heritage clause work for a **non-generic** consumer that does not use construction and
extends a plain (unqualified) base name (`extends Base` / `extends Base implements Mixin`):
the transformer keeps the real base on its source position, so navigation reaches the real
type. They still do **not** work for a **generic** consumer (`class Consumer<T> extends
Base`), a **construction-base** consumer, or a **qualified base** (`extends ns.Base`): in the
IDE "source view" the transformer rewrites those to `extends Consumer$base` and pins the
generated reference onto the source `Base` position, so clicking the base name resolves to
the internal generated base instead of the real type — references and go-to-definition come
back empty and quickinfo reports `any`. The class name itself, its type parameters, and its
members navigate correctly in every case. For the affected consumers, navigate from the base
class's own declaration or another usage instead.

When a mixin does not satisfy its `implements` contract, the editor (and `tsc --noEmit`)
reports the error twice — once on the mixin declaration and once at each *use site* where
the contract is expected — while `tsc` (a normal emit build) reports it only on the mixin
declaration. Both fail the build on the same root cause; the difference is only that the
editor additionally flags the consumer use sites. This is because the emit path models a
mixin's public surface as a generated `interface X extends Contract`, which *inherits* the
contract's members, so a value typed as `X` looks like it satisfies the contract at a
consumer even when the runtime body does not — but the body itself is still checked at the
declaration (`class extends base implements Contract`), so a missing or mismatched member
never compiles. In short: `tsc` never passes a contract violation silently; it just points
at the declaration rather than also at every consumer.


## Technical Notes

The package is a `ts-patch` ProgramTransformer. It transforms source files before
TypeScript typechecks and emits them.

At a high level:

- `@mixin()` classes expand into an interface, a runtime factory, and a canonical runtime
  value.
- Consumers expand through a generated intermediate base class and `mixinChain(...)`.
- Declaration merging provides the instance type of consumed mixins.
- The runtime helper handles C3 linearization, canonical mixin reuse, required-base
  checks, and `Symbol.hasInstance`.

For example, each mixin class is split into a type surface and a runtime factory:

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
```

becomes conceptually:

```ts
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
```

A consumer then gets an intermediate base with declaration merging:

```ts
class User implements Named, Timestamped {
    read(): string {
        return `${super.label()} / ${super.age()}ms`
    }
}
```

becomes conceptually:

```ts
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
    read(): string {
        return `${super.label()} / ${super.age()}ms`
    }
}
```

The transformer has two source-file modes:

- Emit builds print and reparse the transformed file.
- IDE/tsserver mode keeps the original source text and overlays a transformed AST with
  preserved source ranges, so editor navigation still points at the user-written code.


## License

MIT License
