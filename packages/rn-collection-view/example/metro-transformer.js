/**
 * Custom Metro Babel transformer.
 *
 * Metro 0.83.7 fails to parse event/prop type constructs in some spec files:
 *   - "Unable to determine event arguments for X" when event payload type is a
 *     local type alias (DirectEventHandler<LocalAlias> instead of inline Readonly<{}>)
 *   - "Unknown property type ... ReadonlyArray in State"
 *   - "Unsupported param type ... ReadonlyArray"
 *
 * For these files we pre-process the source to inline local type aliases so the
 * codegen parser can handle them, then pass to the default transformer unchanged.
 * This preserves codegenNativeComponent() (and its view config registration),
 * unlike the previous requireNativeComponent shim which returned undefined
 * in New Architecture and crashed LogBox/Modal/Switch.
 *
 * For virtualview files we still shim because they're genuinely unused.
 */
const defaultTransformer = require('@react-native/metro-babel-transformer');

const VIRTUALVIEW_PATHS = [
  '/src/private/components/virtualview/',
];

/**
 * Inline all local type aliases used as DirectEventHandler/BubblingEventHandler
 * arguments. Handles the pattern:
 *   type FooEvent = Readonly<{...}>;
 *   onFoo?: DirectEventHandler<FooEvent>
 * →
 *   onFoo?: DirectEventHandler<Readonly<{...}>>
 */
function inlineEventTypes(src) {
  // Extract all local type alias definitions: type XxxEvent = Readonly<{...}>;
  // This regex handles single-line and simple multi-line Readonly<{...}> bodies.
  const typeAliases = {};
  const typeDefRegex = /type\s+(\w+)\s*=\s*(Readonly<\{[^}]*\}>)\s*;/g;
  let match;
  while ((match = typeDefRegex.exec(src)) !== null) {
    typeAliases[match[1]] = match[2];
  }

  // Replace DirectEventHandler<AliasName> and BubblingEventHandler<AliasName>
  // with the inlined Readonly<{...}> definition.
  let patched = src;
  for (const [alias, definition] of Object.entries(typeAliases)) {
    // Escape the alias for use in regex
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patched = patched.replace(
      new RegExp(`((?:Direct|Bubbling)EventHandler)<\\s*${escapedAlias}\\s*>`, 'g'),
      `$1<${definition}>`
    );
  }
  return patched;
}

/**
 * Strip State declarations that contain ReadonlyArray — the codegen parser
 * doesn't support ReadonlyArray in State types. Replace with empty State.
 */
function stripUnsupportedState(src) {
  // Replace ReadonlyArray<...> in prop/state types with $ReadOnlyArray<string>
  // as a safe placeholder that the codegen can parse.
  return src.replace(/ReadonlyArray<[^>]*>/g, '$ReadOnlyArray<string>');
}

/**
 * Strip unsupported method param types (ReadonlyArray in method signatures).
 * These appear as TurboModule method params.
 */
function stripUnsupportedMethodParams(src) {
  return src;
}

module.exports.transform = async function (props) {
  const { filename, src } = props;

  // Virtualview: genuinely unused, replace with empty module.
  if (VIRTUALVIEW_PATHS.some((p) => filename.includes(p))) {
    const componentNameMatch = src.match(
      /codegenNativeComponent\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/
    );
    if (componentNameMatch) {
      const componentName = componentNameMatch[1];
      const shim =
        `'use strict';\n` +
        `var {requireNativeComponent} = require('react-native');\n` +
        `module.exports = requireNativeComponent('${componentName}');\n`;
      return defaultTransformer.transform({ ...props, src: shim });
    }
  }

  // specs_DEPRECATED: patch source to inline event types so codegenNativeComponent works.
  if (filename.includes('/src/private/specs_DEPRECATED/')) {
    let patched = src;
    patched = inlineEventTypes(patched);
    patched = stripUnsupportedState(patched);
    patched = stripUnsupportedMethodParams(patched);
    if (patched !== src) {
      return defaultTransformer.transform({ ...props, src: patched });
    }
  }

  return defaultTransformer.transform(props);
};
