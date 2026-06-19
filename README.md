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
dependency:

```json
{
    "dependencies": {
        "ts-mixin-class": "0.0.1"
    },
    "devDependencies": {
        "ts-patch": "4.0.1"
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

Add a `prepare` script to your `package.json`:

```json
{
    "scripts": {
        "prepare": "ts-patch install"
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

For generic mixins, TypeScript cannot infer the base type after explicit mixin type
arguments in the same call. Provide both the generic type arguments of the mixin and the base constructor
type:

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
It is a good performance practice to provide an initializer expression for all of your properties, to keep the shape of your class
constant.
- An `initialize` method is called with the configuration object given to the initial static `new` constructor.
`initialize` just performs `Object.assign(this, config)`, so all configs are applied to the instance at once, in no particular order.

Override `initialize` when a class needs derived state or validation after config
assignment. Use the exported `Config<T>` helper for the argument type (see the `Limitations` section for details):

```ts
import { Base, type Config } from "ts-mixin-class/base"

class User extends Base {
    public firstName: string = ""
    public lastName: string = ""

    fullName: string = ""

    override initialize(config?: Config<this>): void {
        super.initialize(config)

        this.fullName = `${this.firstName} ${this.lastName}`.trim()
    }
}

const user = User.new({
    firstName : "Ada",
    lastName  : "Lovelace"
})
```

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


## Runtime Metadata

Mixin runtime metadata is available through exported unique symbols:

```ts
import { base, factory, requirements } from "ts-mixin-class/base"

SomeMixin[factory]
SomeMixin[requirements]
SomeMixin[base]
```

The symbols keep introspection possible without adding string-named helper fields to the
ordinary public API surface of the class.

## Limitations

These are current architectural constraints:

Mixin consumers must be named top-level class declarations. The transformer inserts
sibling declarations such as `__User$empty` and `__User$base`, then rewrites the consumer
to extend the generated base. Anonymous classes, class expressions, and nested class
declarations do not have a stable place where these helper declarations can be emitted
without changing runtime scoping or evaluation order, so they are rejected with custom
diagnostics.

Mixin class members cannot be `private`, `protected`, `#private`, or abstract. A mixin is
copied into generated inheritance positions and is also exposed structurally through
interfaces for consumers. TypeScript private/protected identity and ECMAScript private
fields are intentionally nominal and class-local, which makes them a poor fit for this
kind of composition. Use ordinary members inside mixins, or keep private state in a
non-mixin base class.

Dynamic consumer base expressions such as `extends makeBase()` are not supported yet. A
dynamic base would need to be evaluated exactly once, stored in a generated runtime
constant, represented on both the instance and static sides, and emitted correctly in
`.d.ts` files. Use a named base class for now.

Mixin class properties, methods, accessors, and method parameters need explicit TypeScript
type annotations. The transformer has to generate interface members and declaration
output before relying on inferred implementation details. In ordinary classes TypeScript
can infer public member types from initializers and method bodies, but mixins need a
stable AST-level public surface that can be copied into generated declarations.

`Config<this>` is intentionally a broader helper than the generated `new(...)` config
type. It is useful for implementing `initialize`, but it cannot see AST-only information
such as “this field was explicitly marked `public`” or whether a property came from the
generated `public-only` config list. The strict required/optional contract is enforced at
the `new(...)` call site.

A generic mixin cannot forward its own type parameter into a generic required base. A
mixin that extends a generic base with a *concrete* type argument
(`@mixin() class M extends Base<string>`) works, but forwarding the mixin's own parameter
(`@mixin() class M<T> extends Base<T>`) does not compile: the emit path reports
`TS2304: Cannot find name 'T'` (the value cast that models the mixin loses `T` from
scope), and the source view reports `TS2562: Base class expressions cannot reference class
type parameters` (the generated metadata base is `extends (<cast using T>)`, which the
language forbids for a class type parameter in a base-class expression). Use a concrete
type argument for the required base for now.

Go-to-definition, find-all-references, and quickinfo do not work on a base type name
*inside* a class heritage clause. In the IDE "source view" the transformer rewrites a
consumer's `extends Base` to `extends Consumer$base` and pins the generated reference onto
the source `Base` position, so clicking the base name in an `extends`/`implements` clause
resolves to the internal generated base instead of the real type: references and
go-to-definition come back empty and quickinfo reports `any`. The class name itself, its
type parameters, and its members navigate correctly — only the base type name in the
heritage clause is affected. Navigate from the base class's own declaration or another
usage instead.

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


## Future Work

- Support dynamic consumer base expressions while preserving evaluation order, instance
  typing, static typing, declaration emit, and runtime behavior.
- Provide an exact generated type for `initialize(config)`. Today `Config<this>` is a
  broad structural helper: it can filter methods out of the instance type, but it cannot
  know which public fields were selected by the transformer for the generated config, and
  it cannot reproduce the exact required/optional split from the
  generated `new(...)` adapter. A future design could expose a generated per-class config
  type or constructor-based helper so user overrides can write something like
  `initialize(config?: ExactConfig<typeof User>)` and get exactly the same shape as
  `User.new(...)`.

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
