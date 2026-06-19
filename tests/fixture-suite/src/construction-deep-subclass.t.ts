import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base, mixin } from "ts-mixin-class"

// Deep construction subclassing: a construction class can extend another
// construction class (not just `Base` directly), and the generated `.new(...)`
// config must aggregate every inherited public field - along the whole `extends`
// chain AND from the mixins each intermediate base consumes, transitively through
// mixin-to-mixin dependencies. Reading only the immediate base's own fields drops
// inherited config and breaks the static-side `new` along the chain (TS2417).
// Direct `new X()` stays disabled at every depth.

class RootModel extends Base {
    public id: string = ""
}

@mixin()
class AuditMixin {
    public auditedBy: string = ""
}

// A mixin that depends on another mixin: a consumer of `TimestampMixin` must also
// pull in `AuditMixin`'s config transitively.
@mixin()
class TimestampMixin implements AuditMixin {
    public createdAt: number = 0
}

// A construction *consumer* (extends a `Base` descendant + consumes a mixin), used
// here as an intermediate base for the subclasses below. It consumes only
// `TimestampMixin`, but its config must still include `AuditMixin.auditedBy`.
class UserModel extends RootModel implements TimestampMixin {
    public name: string = ""
}

// One level past the consumer: must see `id` (extends chain through RootModel),
// `createdAt` + `auditedBy` (UserModel's mixin and its transitive dependency),
// `name` (UserModel's own), and its own `role`.
class AdminModel extends UserModel {
    public role: string = ""
}

// Two levels past the consumer: adds `scope` on top of everything above.
class SuperAdminModel extends AdminModel {
    public scope: string = ""
}

// @ts-expect-error direct `new` stays disabled on a transitive construction subclass.
const badAdmin = new AdminModel()
// @ts-expect-error direct `new` stays disabled at a deeper transitive level.
const badSuper = new SuperAdminModel()

const admin = AdminModel.new({
    id        : "a1",
    name      : "Ada",
    createdAt : 1,
    auditedBy : "system",
    role      : "root"
})

const superAdmin = SuperAdminModel.new({
    id        : "s1",
    name      : "Grace",
    createdAt : 2,
    auditedBy : "system",
    role      : "owner",
    scope     : "global"
})

const t1: string = admin.id
const t2: string = admin.name
const t3: number = admin.createdAt
const t4: string = admin.role
const t5: string = superAdmin.scope
const t6: string = admin.auditedBy

// @ts-expect-error the aggregated config still requires the inherited `id` field.
AdminModel.new({ name : "x", createdAt : 0, auditedBy : "s", role : "y" })

// @ts-expect-error the aggregated config still requires the base mixin's `createdAt`.
AdminModel.new({ id : "x", name : "y", auditedBy : "s", role : "z" })

// @ts-expect-error the aggregated config still requires the transitive mixin's `auditedBy`.
AdminModel.new({ id : "x", name : "y", createdAt : 0, role : "z" })

// @ts-expect-error the aggregated config still rejects unknown properties.
AdminModel.new({ id : "x", name : "y", createdAt : 0, auditedBy : "s", role : "z", missing : true })

it("aggregates inherited config for deep construction subclasses and keeps the new guard", async (t: Test) => {
    t.isInstanceOf(admin, AdminModel, "Subclass .new returns its own instance")
    t.isInstanceOf(admin, UserModel, "Subclass keeps the intermediate construction consumer")
    t.isInstanceOf(admin, RootModel, "Subclass keeps the root construction base")
    t.isInstanceOf(admin, Base, "Subclass keeps the package Base")
    t.isInstanceOf(admin, TimestampMixin, "Subclass keeps the intermediate base's consumed mixin")
    t.isInstanceOf(admin, AuditMixin, "Subclass keeps the transitive mixin dependency")

    t.equal(admin.id, "a1", "Inherited extends-chain config field is assigned")
    t.equal(admin.createdAt, 1, "Inherited base-mixin config field is assigned")
    t.equal(admin.auditedBy, "system", "Inherited transitive-mixin config field is assigned")
    t.equal(admin.name, "Ada", "Inherited base-own config field is assigned")
    t.equal(admin.role, "root", "Own config field is assigned")

    t.equal(superAdmin.id, "s1", "Two-level subclass aggregates the root field")
    t.equal(superAdmin.createdAt, 2, "Two-level subclass aggregates the base-mixin field")
    t.equal(superAdmin.auditedBy, "system", "Two-level subclass aggregates the transitive-mixin field")
    t.equal(superAdmin.name, "Grace", "Two-level subclass aggregates the mid field")
    t.equal(superAdmin.role, "owner", "Two-level subclass aggregates the parent field")
    t.equal(superAdmin.scope, "global", "Two-level subclass assigns its own field")

    // The brand is compile-time only; the runtime objects still built above.
    t.true(Object.hasOwn(badAdmin, "role"), "Compile-time-only guard still builds a runtime instance")
    t.true(Object.hasOwn(badSuper, "scope"), "Compile-time-only guard still builds a deeper runtime instance")
})

void [ t1, t2, t3, t4, t5, t6, badAdmin, badSuper ]
