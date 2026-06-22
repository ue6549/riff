/**
 * RiffComponentRegistration.cpp — Custom component descriptor registration and
 * TurboModule wiring for Android.
 *
 * TurboModule wiring
 * ------------------
 * The codegen generates NativeCollectionViewModuleSpecJSI (a JavaTurboModule) with
 * only ping() in its methodMap_. JS calls nativeMod.createLayoutCache etc., which
 * are custom JSI bindings installed by CollectionViewModule::get().
 *
 * On Android, the autolinking's autolinking_ModuleProvider expects a JavaTurboModule.
 * We can't return a pure C++ TurboModule from that path — the manager wraps it as a
 * Java-backed module and the JSI get() never fires.
 *
 * Fix: AndroidRiffModule subclasses NativeCollectionViewModuleSpecJSI (JavaTurboModule)
 * and overrides get() to delegate to CollectionViewModule::get(). JS gets ping() from
 * the Java method map and all other properties (createLayoutCache, layoutCache, etc.)
 * from the C++ module's JSI bindings.
 *
 * Component descriptor registration
 * ----------------------------------
 * Registers our custom ShadowNodes (with layout() override and rich state types)
 * instead of the codegen defaults for RNCollectionViewContainer and
 * RNCollectionSubContainer.
 */

#include "CollectionViewModule.h"
#include "CollectionViewContainerShadowNode.h"
#include "CollectionViewContainerComponentDescriptor.h"
#include "CollectionSubContainerShadowNode.h"
#include "CollectionSubContainerComponentDescriptor.h"

#include <react/renderer/components/RiffSpec/Props.h>
#include <react/renderer/components/RiffSpec/EventEmitters.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/core/StateData.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

// Generated JavaTurboModule base class for RiffModule.
#include <RiffSpec.h>
#include <ReactCommon/JavaTurboModule.h>

// Codegen-generated component descriptors for non-custom components.
#include <react/renderer/components/RiffSpec/ShadowNodes.h>
#include <react/renderer/components/RiffSpec/ComponentDescriptors.h>

namespace facebook::react {

// ── AndroidRiffModule — JavaTurboModule + C++ JSI bindings ───────────────────
//
// Subclasses the codegen-generated NativeCollectionViewModuleSpecJSI to override
// get() and inject CollectionViewModule's JSI properties (createLayoutCache,
// layoutCache, listLayout, etc.) into the module object that JS holds.

// All property names handled by CollectionViewModule::get().
// These must be listed here so that the JavaTurboModule binding loop calls
// get() for each of them — only properties in getPropertyNames() are installed.
static const std::vector<const char*> kCppModuleProperties = {
  "ping",
  "layoutCacheId", "layoutCache", "listLayout", "windowController",
  "metrics", "signpost", "diffEngine", "memory",
  "masonryLayout", "gridLayout", "flowLayout", "compositionalLayout",
  "createLayoutCache", "destroyLayoutCache",
  "layoutCacheById", "getListLayoutById", "getMasonryLayoutById",
  "getGridLayoutById", "getFlowLayoutById", "getCompositionalLayoutById",
  "scrollTo", "scrollToKey", "scrollToIndexPath", "scrollToSection", "scrollToEnd",
};

class AndroidRiffModule final : public NativeCollectionViewModuleSpecJSI {
public:
  AndroidRiffModule(const JavaTurboModule::InitParams &params)
      : NativeCollectionViewModuleSpecJSI(params)
      , _cppModule(std::make_shared<CollectionViewModule>(params.jsInvoker)) {}

  // Return all C++ property names so the binding loop installs each one.
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
    std::vector<jsi::PropNameID> names;
    names.reserve(kCppModuleProperties.size());
    for (const char* n : kCppModuleProperties) {
      names.push_back(jsi::PropNameID::forAscii(rt, n));
    }
    return names;
  }

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
    auto result = _cppModule->get(rt, name);
    if (!result.isUndefined()) return result;
    return NativeCollectionViewModuleSpecJSI::get(rt, name);
  }

private:
  std::shared_ptr<CollectionViewModule> _cppModule;
};

// ── Component descriptor registration ───────────────────────────────────────

void RiffSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry) {
  registry->add(concreteComponentDescriptorProvider<CollectionViewContainerComponentDescriptor>());
  registry->add(concreteComponentDescriptorProvider<CollectionSubContainerComponentDescriptor>());
  registry->add(concreteComponentDescriptorProvider<RNMeasuredCellComponentDescriptor>());
  registry->add(concreteComponentDescriptorProvider<RNOrthogonalSectionViewComponentDescriptor>());
  registry->add(concreteComponentDescriptorProvider<RNScrollCoordinatedViewComponentDescriptor>());
}

} // namespace facebook::react
