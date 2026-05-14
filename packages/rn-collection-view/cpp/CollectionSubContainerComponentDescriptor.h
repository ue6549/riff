#pragma once

/**
 * CollectionSubContainerComponentDescriptor — factory for our custom
 * sub-container ShadowNode.
 *
 * Overrides the codegen-generated descriptor so Fabric creates our
 * CollectionSubContainerShadowNode (with layout() override and rich
 * ChildVisualState) instead of the default ConcreteViewShadowNode.
 */

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include "CollectionSubContainerShadowNode.h"

namespace facebook::react {

using CollectionSubContainerComponentDescriptor =
    ConcreteComponentDescriptor<CollectionSubContainerShadowNode>;

} // namespace facebook::react
