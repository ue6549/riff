/**
 * Shim ShadowNodes.h — overrides the codegen-generated version.
 *
 * The codegen generates RNCollectionViewContainerShadowNode as a simple
 * ConcreteViewShadowNode<..., StateData> with no layout() override and empty
 * state. Our custom ShadowNodes have layout() overrides that compute positions
 * and rich state types (CollectionViewContainerState, CollectionSubContainerState).
 *
 * This shim maps the codegen type names (RNCollectionViewContainerShadowNode etc.)
 * to our custom types. Because our include path has higher priority than the
 * codegen-generated path, autolinking_registerProviders picks up our custom
 * ShadowNodes when it includes <react/renderer/components/RiffSpec/ShadowNodes.h>.
 */

#pragma once

// Our custom ShadowNodes with layout() override and rich state
#include "CollectionViewContainerShadowNode.h"
#include "CollectionSubContainerShadowNode.h"

// Codegen-generated props and event emitters (unchanged)
#include <react/renderer/components/RiffSpec/Props.h>
#include <react/renderer/components/RiffSpec/EventEmitters.h>

// Standard types for non-custom components
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/core/StateData.h>
#include <jsi/jsi.h>

namespace facebook::react {

// ── Custom ShadowNodes: alias codegen names → our custom types ──────────────

// The codegen would generate these as simple ConcreteViewShadowNode<..., StateData>.
// We override them to use our custom classes with layout() and rich state.
using RNCollectionViewContainerShadowNode = CollectionViewContainerShadowNode;
using RNCollectionSubContainerShadowNode = CollectionSubContainerShadowNode;

// ── Non-custom ShadowNodes: standard codegen types ──────────────────────────

JSI_EXPORT extern const char RNMeasuredCellComponentName[];

using RNMeasuredCellShadowNode = ConcreteViewShadowNode<
    RNMeasuredCellComponentName,
    RNMeasuredCellProps,
    RNMeasuredCellEventEmitter,
    StateData>;

JSI_EXPORT extern const char RNOrthogonalSectionViewComponentName[];

using RNOrthogonalSectionViewShadowNode = ConcreteViewShadowNode<
    RNOrthogonalSectionViewComponentName,
    RNOrthogonalSectionViewProps,
    RNOrthogonalSectionViewEventEmitter,
    StateData>;

JSI_EXPORT extern const char RNScrollCoordinatedViewComponentName[];

using RNScrollCoordinatedViewShadowNode = ConcreteViewShadowNode<
    RNScrollCoordinatedViewComponentName,
    RNScrollCoordinatedViewProps,
    RNScrollCoordinatedViewEventEmitter,
    StateData>;

} // namespace facebook::react
