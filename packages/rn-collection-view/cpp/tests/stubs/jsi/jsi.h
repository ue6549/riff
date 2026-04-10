/**
 * Minimal JSI stub for unit tests.
 *
 * LayoutCache and ListLayout include <jsi/jsi.h> for their installJSIBindings()
 * methods. Unit tests don't call those methods, so we only need enough to satisfy
 * the compiler. Forward-declare the required types; no implementations needed.
 */
#pragma once

namespace facebook {
namespace jsi {

class Runtime {};
class Object {};
class Array {};
class Value {};
class Function {};
class String {};

} // namespace jsi
} // namespace facebook
