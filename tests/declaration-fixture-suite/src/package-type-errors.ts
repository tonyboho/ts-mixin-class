import { RequiredMixin } from "ts-mixin-class-fixture-suite/mixins"

class DeclarationUnrelatedRequiredBase {
}

// @ts-expect-error RequiredMixin requires a RequiredBase-compatible consumer base.
class DeclarationBadRequiredConsumer extends DeclarationUnrelatedRequiredBase implements RequiredMixin {
}

void DeclarationBadRequiredConsumer
