/**
 * Shim ComponentDescriptors.h — overrides the codegen-generated version.
 *
 * Uses the ShadowNode types from our shim ShadowNodes.h (which maps the
 * codegen names to our custom ShadowNodes), so all component descriptors
 * reference the correct ShadowNode types with layout() overrides and rich state.
 */

#pragma once

#include <react/renderer/components/RiffSpec/ShadowNodes.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

// Our custom descriptors (use our custom ShadowNodes)
#include "CollectionViewContainerComponentDescriptor.h"
#include "CollectionSubContainerComponentDescriptor.h"

namespace facebook::react {

// These use our custom ShadowNodes (via the shim ShadowNodes.h aliases)
using RNCollectionViewContainerComponentDescriptor =
    ConcreteComponentDescriptor<RNCollectionViewContainerShadowNode>;
using RNCollectionSubContainerComponentDescriptor =
    ConcreteComponentDescriptor<RNCollectionSubContainerShadowNode>;

// Standard codegen descriptors
using RNMeasuredCellComponentDescriptor =
    ConcreteComponentDescriptor<RNMeasuredCellShadowNode>;
using RNOrthogonalSectionViewComponentDescriptor =
    ConcreteComponentDescriptor<RNOrthogonalSectionViewShadowNode>;
using RNScrollCoordinatedViewComponentDescriptor =
    ConcreteComponentDescriptor<RNScrollCoordinatedViewShadowNode>;

void RiffSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);

} // namespace facebook::react
