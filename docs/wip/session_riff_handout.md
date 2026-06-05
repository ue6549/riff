# Riff — Engineers Handout

A companion to the sneak-peek slide deck (`session_riff_sneak_peek.md`). The slides plant the headline; this handout fills in the depth. Each section corresponds to a slide block and assumes you've read the slides first.

This file currently contains **Blocks A–D** (the foundations). Blocks R1–R7 (Riff-specific material) live in the slide deck at sufficient depth and will be added here when they need more breathing room.

---

# Part 1 — Foundations

## Block A — JS engine fundamentals

### A.1 What an engine actually does

A JavaScript "engine" is a C++ program (Hermes, V8, JavaScriptCore) that takes a `.js` source file and turns it into something the CPU can execute. There's no JS-native CPU; everything is interpretation or translation.

**The V8 pipeline** (used by Chrome, Node, and recent React Native if Hermes is disabled):

```
source.js
  ↓ parser
AST (abstract syntax tree)
  ↓ bytecode generator
Ignition       ─ interpreter (no machine code; bytecode dispatched in a hot switch)
   │             collects type feedback in inline-cache slots
   │  (warm functions promoted)
Sparkplug      ─ baseline JIT (real machine code, no optimisation — one fixed inline
   │             sequence per bytecode op; ~10% of the gap from Ignition to TurboFan,
   │             from skipping bytecode dispatch overhead)
   │  (hotter functions promoted)
Maglev         ─ mid-tier optimising JIT (some speculation, faster to compile than TurboFan)
   │
   │  (very hot functions promoted)
TurboFan       ─ top-tier optimising JIT (aggressive type speculation, deopt fallback)
```

All four tiers can exist for the same function simultaneously — the runtime promotes "hot" frames upward based on call counts and feedback collected by lower tiers. TurboFan makes *assumptions* — "this variable is always a number", "this object always has shape S" — and emits code that's blazing fast as long as the assumptions hold. When an assumption is violated, TurboFan's machine code is **deoptimised**: it gets discarded and execution falls back to Sparkplug (or Ignition if Sparkplug also lacks code for it). The function may later be re-optimised with different speculations.

**Sparkplug isn't "interpretation faster" — it's real machine code with no optimisation.** Easy to confuse with the interpreter because the bytecode is the same; what's different is that Sparkplug inlines the per-op machine sequences directly into a compiled function, so there's no fetch-decode-dispatch loop. Same observable behaviour, less overhead per op.

#### What "JIT" means precisely

JIT = **compilation to native CPU machine code at runtime**, with the compiler embedded in the runtime. Two distinguishing properties: (1) *when* — at runtime, not build time; (2) *what it produces* — real machine code the CPU executes directly, not bytecode an interpreter dispatches. Drop either property and it's something else:

| Compile when? | Compile to what? | Name | Example |
|---|---|---|---|
| Build time | Native code | AOT | C++, Rust, Swift |
| Build time | Bytecode | AOT-to-bytecode | Hermes `.hbc`, Java `.class` |
| **Runtime** | **Native code** | **JIT** | V8 Sparkplug / Maglev / TurboFan, JVM HotSpot |
| Never (just executes input) | — | Interpreter | Hermes runtime, CPython |

So "Sparkplug is JIT" = it takes bytecode at runtime and emits real CPU instructions. "Hermes does JIT because it has bytecode" mixes steps: Hermes does AOT-to-bytecode at build time, then *interprets* at runtime; it never produces machine code from your JS on device. Having bytecode is not JIT — compiling that bytecode to machine code at runtime is.

**The Hermes pipeline** (RN's default since ~2020):

```
source.js
  ↓ parser  (build-time, on the developer's machine)
HBC (Hermes Bytecode)        ←── shipped pre-compiled inside the app bundle
  ↓ on app launch
HBC bytecode loaded directly
  ↓
Hermes interpreter executes
```

Hermes is **AOT (ahead-of-time)** for parsing and bytecode generation — your `.js` source is compiled to `.hbc` by Metro before the app ships. On device, there is **no parsing cost at startup** (which on a cold-start budget matters more than steady-state JIT speed). Hermes does not run a TurboFan-equivalent optimising JIT; it accepts a steady-state performance ceiling lower than V8's hot loops in exchange for several other properties.

#### Why doesn't Hermes have JIT? "It can just fall back to bytecode in the worst case…"

The intuitive argument: V8's deopt path falls back to lower tiers, so adding JIT is "free downside" — at worst you're back to interpretation. The flaw is that the cost of having JIT is paid *always*, not just on the worst case.

| Cost | Paid when | Why it matters on mobile |
|---|---|---|
| JIT compilation CPU | Every time a function gets hot enough to promote | Burns battery; competes with UI work; can spike thermals |
| JIT code in memory | As long as a JIT'd function exists | TurboFan output is 5–50× the size of equivalent bytecode |
| Type-feedback collection | Every property access in lower tiers, hot or cold | Adds per-op overhead even to functions that never get hot |
| Deopt guards | At every speculative assumption in TurboFan code | Each speculation costs a comparison even on the happy path |
| **iOS JIT entitlement** | At runtime, on iOS, for third-party apps | **Apple does not grant the JIT entitlement to third-party apps.** Only Safari/WebKit gets the dynamic-codesigning entitlement that allows runtime-generated machine code. Hermes can ship on iOS as a bytecode interpreter; V8's JIT cannot run inside a third-party RN app. This isn't a trade-off — it's an architectural constraint |
| Cold start | Every app launch | Tiered JIT means startup is interpreter-tier; warmup costs accumulate as functions promote |
| Predictability | When functions deopt | Performance cliffs — a function was fast, then suddenly 10× slower until re-optimised. Bad for frame-budget consistency |
| Security surface | At all times | JIT engines have a long history of CVEs. More tiers = more attack surface |

The iOS entitlement is the load-bearing one for RN specifically. RN apps can't ship a JIT engine inside their bundle on iOS, period — that's not Hermes's choice, it's Apple's. So the JIT-vs-no-JIT debate doesn't even arise; an interpreter-class engine is the only option.

Hermes maintainers have explored JIT multiple times (recent work: Static-Hermes, an AOT-to-native compiler). The recurring conclusion: RN workloads tend to be I/O-bound, bridge/JSI-bound, or React-reconciliation-bound — not compute-bound on hot JS loops. JIT speedups on raw JS arithmetic don't move the user-facing perf needle. The cost goes up, the benefit doesn't show up.

**For Riff, what matters:** the engine you have is fast enough that JS isn't the scroll bottleneck. The bottleneck is *how many times JS gets woken up* and *what work it has to do when it does*. Riff's design minimises both. The hot path during scroll is a few integer comparisons and an early return — identical speed in Hermes interpreter and V8 TurboFan.

### A.2 Object representation — hidden classes / shapes

This is the foundation under "monomorphic property access" and the reason React perf advice talks about "stable shapes."

A JS object isn't a hash table by default. That would be too slow. Engines lay objects out as **fixed-offset slot arrays**, with a separate descriptor (called a **hidden class** in V8 or **shape** in Hermes / SpiderMonkey) that maps property names to those offsets.

```
       JS code            engine memory

  const a = {x: 1, y: 2}            a (object)
                                    ┌────────────────────┐
                                    │ shape ptr → S1     │
                                    │ slot[0] = 1        │
                                    │ slot[1] = 2        │
                                    └────────────────────┘

                                    S1 (shape descriptor)
                                    ┌────────────────────┐
                                    │ "x" → offset 0     │
                                    │ "y" → offset 1     │
                                    └────────────────────┘
```

Two objects literally constructed the same way (same property names in the same order) share **the same shape pointer**. There's exactly one S1 in memory; both `a` and `b = {x: 9, y: 9}` point to it.

#### Shape transitions

If you mutate an object's structure, the shape changes. Adding a property:

```js
const a = {x: 1};        // shape S1: {x → 0}
a.y = 2;                 // shape transitions to S2: {x → 0, y → 1}
```

The engine doesn't allocate a new S2 from scratch — it walks a **transition tree** rooted at S1: "does S1 have a child for `+y`? If yes, use that shape; otherwise create one." This means objects built by the same code path always converge on the same shape regardless of which actual object you started with.

Deleting a property creates a fresh shape (transitions are not symmetric). Adding properties in a *different order* creates a different shape. So:

```js
const a = {x: 1, y: 2};   // shape A: {x → 0, y → 1}
const b = {y: 2, x: 1};   // shape B: {y → 0, x → 1}  ← different shape!
```

`a` and `b` look identical to a JS developer but the engine sees them as differently shaped. Code that reads `.x` from both will see two shapes, not one, at that call site.

### A.3 Inline caches — monomorphic / polymorphic / megamorphic

A property read `obj.x` compiles to bytecode `LoadProperty "x"`. The first time this instruction executes:

1. Slow path: read `obj`'s shape, walk the descriptor, find `"x"` is at offset 0, load slot 0.
2. Install an **inline cache (IC)** at this call site recording `(shape=S1, offset=0)`.

The next execution of the same `LoadProperty`:

1. Compare `obj`'s current shape to the cached `S1`.
2. If equal: load slot 0 directly — one comparison, one indirect load. *Done.*
3. If not equal: fall back to slow path, update the cache.

The IC state is observable through the developer-facing terms:

| State | What it means | Cost |
|---|---|---|
| **Uninitialised** | First execution at this site | One-time slow path |
| **Monomorphic** | Cache has seen one shape, comparison hits | ~2 instructions — fastest |
| **Polymorphic** | Cache holds 2–4 shapes; linear search | A few comparisons; still cache-line fast |
| **Megamorphic** | More than ~4 shapes; cache spills to a global shape→offset hash | Hash lookup; an order of magnitude slower than monomorphic |

#### Why React re-renders care

If a parent inline-creates an object on each render:

```jsx
<Child style={{ flex: 1 }} />
```

a new JS object is allocated every render, but its **shape is stable** (`{flex → 0}` always). The Child component's `props.style.flex` access stays monomorphic. No performance problem at the property-access level. *(There's a separate problem — `React.memo` won't prevent the Child from re-rendering because the object identity changed. But that's a reconciliation concern, not a property-access concern.)*

The slow case is **shape mutation** at a hot site. If somewhere in your render you do:

```js
const props = {color: 'red'};
if (someCondition) props.size = 'large';
```

then `props` has shape `S_red` on one render and `S_red_size` on the next. Any code consuming `props` sees two shapes; its inline caches go polymorphic; and if more conditional paths exist, megamorphic. The standing advice "construct your objects with all fields present, set unused fields to `undefined` rather than omitting them" is engine-level guidance — keeps the shape stable.

For Riff, this matters when defining cell components — *don't conditionally attach new fields to props mid-render*. Always pass the same prop keys, even if some values are null. The slot manager re-uses Fibers across cells via prop updates; stable prop shapes mean the engine's call sites stay monomorphic across recycle events.

### A.4 Value encoding — how every JS value fits in 8 bytes

Both V8 and Hermes pack every JS value — a number, a boolean, an object reference, undefined — into a single 64-bit machine word. They use different schemes.

#### Hermes — NaN-boxing

Hermes exploits an IEEE-754 quirk: any double-precision float whose top 13 bits are all 1 is a NaN. There's exactly one canonical NaN; the other 2^51 - 1 bit patterns are "free" to repurpose. Hermes uses them as tagged pointers and immediates.

```
 ┌──────────────────────────────────────────────────────────────────┐
 │ 64-bit value                                                     │
 ├──────────────────────────────────────────────────────────────────┤
 │ If top 13 bits ≠ all-1:    interpret as IEEE-754 double          │
 │                                                                  │
 │ If top 13 bits == all-1:   "NaN-boxed" non-double                │
 │   tag bits (3-4 bits)        type discriminator                  │
 │   payload bits (~48 bits)    pointer or immediate                │
 │                                                                  │
 │   Tag types:                                                     │
 │     Object       → payload is pointer to JS Object on heap       │
 │     String       → payload is pointer to StringPrimitive         │
 │     Bool         → payload is 0 or 1                             │
 │     Null         → singleton, payload ignored                    │
 │     Undefined    → singleton, payload ignored                    │
 │     Empty        → reserved (uninitialised slots)                │
 │     SymbolID     → engine-internal symbol                        │
 │     NativeValue  → engine-internal scratch                       │
 └──────────────────────────────────────────────────────────────────┘
```

**There is no separate "integer" type at the JS level.** All JS numbers are doubles. The interpreter sometimes keeps a transient int32 for hot arithmetic loops, but it boxes back to double the moment the value escapes to user code.

#### V8 — pointer tagging (Smi + HeapNumber)

V8 uses the *low bit* of every 64-bit value to discriminate between an integer and a pointer. "Low bit" = bit 0 = the least-significant bit = the rightmost bit in standard binary notation:

```
        bit 63                                                    bit 0
          ↓                                                          ↓
        ┌─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┐
        │ │ │ │ │ │ ...      (60 bits between)             │ │ │ │ │ │ │
        └─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┘
        ↑                                                              ↑
   "high bit" / MSB                                          "low bit" / LSB
```

Why bit 0? Because heap pointers on 64-bit systems are always **8-byte aligned** — their bottom 3 bits are guaranteed to be 0 in unmangled form. V8 sets bit 0 to 1 when storing a pointer (you mask it back to 0 to dereference); leaves bit 0 as 0 when storing an integer. So the test "integer or pointer?" is a single bit check.

```
 ┌─────────────────────────────────────────────────────────────┐
 │ 64-bit value                                                │
 ├─────────────────────────────────────────────────────────────┤
 │ Low bit == 0:  "Smi" (small integer)                        │
 │                value >> 1 is a 31-bit signed integer        │
 │                                                             │
 │ Low bit == 1:  tagged pointer to a heap object              │
 │                value & ~1 is the actual pointer             │
 │                heap object header says what it is:          │
 │                  - HeapNumber (a boxed double)              │
 │                  - String                                   │
 │                  - JSObject                                 │
 │                  - Oddball (singletons: true, false, null,  │
 │                             undefined, the_hole)            │
 │                  - ...                                      │
 └─────────────────────────────────────────────────────────────┘
```

So `42` is stored as the bits `0b1010100` (84 — i.e., `42 << 1`). `3.14` is stored as a pointer to a HeapNumber object on the GC heap. `true` is a tagged pointer to the singleton `true` oddball.

**Practical implications:**
- Integer arithmetic that fits in 31 bits never touches the GC heap. Fast.
- Floating-point arithmetic always allocates HeapNumbers — much slower. (V8 has unboxed double arrays as a special case, but ad-hoc number-heavy code pays this cost.)
- Comparing `true === true` is a pointer comparison. Free.

#### What this means for Riff

The C++ side passes integer indices around constantly (render range bounds, item counts, cache versions). On both Hermes and V8, these stay small enough that they live in the value-tag space — no heap allocation per scroll event. The hot path's "JS pays nothing per scroll frame" claim depends on this. A version of Riff that boxed render-range coordinates into a `{first, last}` object on every event would be measurably slower; Riff packs them into a Float32Array of frame data instead, keeping per-event JS work down to a few index comparisons.

### A.5 Memory — single GC heap, mark-sweep, why GC pauses matter

JS has exactly one heap, owned by the engine, and one garbage collector.

**Hermes GC** is a generational mark-sweep:
- Newly allocated objects live in a small **young generation** (a few MB).
- Most allocations die young; the young-gen GC is frequent but very fast.
- Survivors get promoted to the **old generation**, collected less often via a full mark-sweep with compaction.
- Mobile-tuned: tight memory budgets, predictable pause times, no concurrent collection.

**V8 GC** is similar but more elaborate:
- Generational (Scavenger for young, Mark-Compact for old).
- Modern V8 also has concurrent marking and incremental sweeping to keep pause times under ~5ms.

**For Riff:** GC pauses are the natural enemy of 120fps scrolling. A 16ms-budget frame can absorb maybe 3-4ms of GC pause without dropping. Hermes's young-gen pauses are typically sub-millisecond; full collections are rarer but can spike to 10-50ms on a stressed heap. Riff's design avoids this:

- The cell pool keeps Fibers alive instead of churning allocations on scroll
- The render-range fast path uses pre-allocated typed arrays (Float32Array of frames), not per-event object construction
- The C++ LayoutCache stores positions on the C++ heap — outside the JS GC's responsibility entirely

> **Takeaway for the talk:** the slot pool isn't just about not paying React's mount cost; it's also about not making the GC clean up React-element / cell-component allocations every time you scroll.

---

## Block B — How native objects enter JS

This is the substrate question: JS is a sealed runtime running inside a C++ host. How does the host hand JS access to native functionality?

### B.1 Embedding — who creates whom

Step back from RN. Imagine you're writing a desktop C++ app and you want to embed a JS engine for scripting.

```cpp
int main() {
  v8::Isolate*  isolate  = v8::Isolate::New(create_params);   // 1
  v8::Context*  context  = v8::Context::New(isolate);          // 2
  v8::Context::Scope ctx_scope(context);

  // 3. Inject something into JS global scope
  v8::Local<v8::Object> global = context->Global();
  global->Set(context, v8_str("hostFunction"), make_function());

  // 4. Run some JS that uses it
  v8::Script::Compile(context, v8_str("hostFunction(42)"))
    ->Run(context);
}
```

- An `Isolate` is a single-threaded JS execution context with its own heap and GC. (V8 was designed for Chrome tabs — each tab has its own isolate.)
- A `Context` is an instance of "global state" — has its own `globalThis`, its own built-ins. Multiple contexts can share an isolate but their JS objects can't cross.
- You install host-provided values onto the global object before running JS. From inside JS, those values look like normal globals.

In React Native:
- The native app (Java/Kotlin or ObjC/Swift) launches.
- A C++ subsystem (the React Native bridge layer, or in new-arch the TurboModule infrastructure) creates the JS engine — Hermes or V8.
- That subsystem registers React Native's built-in globals (`global.nativeCallSyncHook`, the TurboModule registry, etc.) onto the JS global object.
- It loads and executes your bundled `index.js`.

You, as a React Native developer, see `React`, `import { ... } from 'react-native'`, etc. — but those eventually trace back to globals installed by the C++ embedder, plus everything user-land JS builds on top.

### B.2 Internal slots — the engine's escape hatch

JS, as a language, doesn't have a notion of "this object is backed by a C++ pointer." Its specification only describes Objects, Functions, primitives, and the property-access protocol. There's no `External` type in the ECMAScript spec.

But every engine's implementation of an Object has space for additional, JS-invisible state. V8 calls these **internal fields**; Hermes provides them via the **HostObject** class directly. They serve the same purpose: a slot on a JS Object that JS cannot see, where C++ stores whatever it likes (typically: a pointer to a C++ object).

#### V8 example

```cpp
// Define a template for objects that will carry 1 internal field
v8::Local<v8::ObjectTemplate> tpl = v8::ObjectTemplate::New(isolate);
tpl->SetInternalFieldCount(1);

// Set up property access callbacks — when JS reads .foo on this object,
// our C++ function gets called instead of the default property lookup
tpl->SetHandler(v8::NamedPropertyHandlerConfiguration(
    onGetProperty,   // get  callback
    onSetProperty,   // set  callback
    /* query/deleter/enumerator/etc. */));

// Create an instance
v8::Local<v8::Object> obj = tpl->NewInstance(context).ToLocalChecked();

// Stash a C++ pointer in the internal field
obj->SetInternalField(0, v8::External::New(isolate, myCppPointer));
```

From JS:

```js
hostObj.foo          // calls onGetProperty("foo") in C++
hostObj.bar = 5      // calls onSetProperty("bar", 5) in C++
typeof hostObj       // → "object"     ← indistinguishable from regular object
hostObj instanceof Object  // → true
```

The C++ callbacks can:
- Look up the C++ pointer from the internal field (`obj->GetInternalField(0)` → cast to `External` → extract pointer)
- Do whatever native work needs doing
- Return a JS value (a number, a string, another host object, undefined, …)

#### How the property access actually dispatches

Inside the engine, an Object's hidden class records — for each property — *what to do on access*. The normal case is "load slot N from the value array." The host-object case is "call this C++ function pointer." So when bytecode interpreter hits a `LoadProperty` op:

1. Look up the property in the hidden class.
2. If the descriptor says "stored value," load it.
3. If the descriptor says "host-handled," call the registered C++ callback, push its return value onto the JS stack.

The interpreter doesn't know or care which path it took; both produce a tagged JS value. The IC at the call site caches the dispatch decision so the next access is just as fast.

#### The contract from each side

**From JS:** "I'm getting a property from an Object. The Object's `[[Get]]` internal method (per the ECMAScript spec) might be the default or a host-defined exotic one. I can't tell which, and I shouldn't care."

**From C++:** "I'm responsible for honouring the JS `[[Get]]`, `[[Set]]`, `[[OwnPropertyKeys]]`, and other internal methods. The engine gives me a hook for each. My return value must be a valid JS value; if I throw, JS sees a thrown exception."

This is the foundation under everything in RN's new architecture. TurboModules are host objects. ShadowNode wrappers exposed to JS are host objects. The LayoutCache `getAttributesInRect` you'd call from JS is a method on a host object.

### B.3 The old bridge — why it had to die

Pre-Fabric React Native had no equivalent of host objects in JS. Every native module call went through a message bus:

```
JS thread                              Native thread
─────────                              ─────────────

UIManager.measure(viewTag, callback)
  ↓
serialise to JSON:
{ module: "UIManager",
  method: "measure",
  args: [123, "<callback-id-7>"] }
  ↓
write to MessageQueue
                                       ┌─── poll the MessageQueue
                                       │     periodically (~ms scale)
                                       │
                                       ↓
                                       deserialise the JSON
                                       look up native module by name
                                       look up method by name
                                       invoke C++/Java/ObjC
                                       result available
                                       ↓
                                       serialise result + callback-id
                                       to JSON, push back to JS
                                       MessageQueue
poll MessageQueue ───────────────┐
  ↓                              │
deserialise                       
look up callback-id 7
invoke registered JS callback
```

Per call: two JSON serialisation steps, two thread hops, one queue write/read. Even at sub-millisecond per call, the cost compounds: a 60fps scroll wanted to call `scrollViewDidScroll`-equivalent every frame; the per-call overhead plus the queue-traversal latency meant scroll events arrived in JS 2-3 frames late, and any JS work in response landed even later.

The architectural decision behind JSI: **stop pretending JS and C++ have to talk through a message bus.** They share a process; they share memory; they can call each other directly if you give JS the ability to hold C++ references and call into C++ without ceremony. Host objects make that possible.

### B.4 JSI — the abstraction layer

JSI (JavaScript Interface) is Meta's name for the C++ abstraction layer that papers over the differences between JS engines. The core types:

```cpp
namespace facebook::jsi {

class Runtime {                          // abstract — implemented per engine
public:
  virtual Value evaluateJavaScript(...) = 0;
  virtual Object createObject() = 0;
  virtual ... lots of pure-virtual operations ...
};

class Value {                            // tagged union over all JS value types
public:
  Value();                                 // undefined
  Value(bool);                             // boolean
  Value(double);                           // number
  Value(Runtime&, const String&);          // string
  Value(Runtime&, const Object&);          // object
  // accessors: isUndefined(), isBool(), getBool(), isNumber(), ...
};

class Object {                           // a JS object handle
public:
  Value  getProperty(Runtime&, const PropNameID&) const;
  void   setProperty(Runtime&, const PropNameID&, const Value&);
  bool   hasProperty(Runtime&, const PropNameID&) const;
  bool   isFunction(Runtime&) const;
  Function getFunction(Runtime&);
  bool   isHostObject(Runtime&) const;
  std::shared_ptr<HostObject> getHostObject(Runtime&) const;
};

class Function : public Object {         // a callable JS object
public:
  Value call(Runtime&, const Value* args, size_t count) const;
  // create a Function backed by a C++ function:
  static Function createFromHostFunction(Runtime&, const PropNameID& name,
                                         unsigned int paramCount, HostFunctionType);
};

class HostObject {                       // base class for JS-visible C++ objects
public:
  virtual Value get(Runtime&, const PropNameID&);
  virtual void  set(Runtime&, const PropNameID&, const Value&);
  virtual std::vector<PropNameID> getPropertyNames(Runtime&);
  virtual ~HostObject();
};

}
```

The contract:
- Every engine that wants to participate implements `Runtime` for itself (`HermesRuntime`, `V8Runtime`, `JSCRuntime`).
- Code above JSI (React Native's TurboModule layer, Riff, anything else) talks to the abstract `Runtime` interface.
- `Value`, `Object`, `Function`, `String`, etc. are engine-agnostic handles. Their guts are engine-specific (a Hermes `Value` holds a Hermes-internal `HermesValue`; a V8 `Value` holds a `v8::Local<v8::Value>`), but the API surface is identical.

**Three properties worth highlighting:**

1. **Calls are synchronous.** `runtime.global().getPropertyAsObject(runtime, "foo").asFunction(runtime).call(runtime, ...)` runs to completion on the calling thread before returning. No queue, no event loop.

2. **`Value` wraps engine-tagged values.** Constructing a `Value(42.0)` doesn't allocate; it just packs the number into the tagged representation. So passing primitives across JSI is free.

3. **Object handles are scoped.** A `jsi::Object` in C++ holds the JS object alive (keeps the GC from collecting it) only as long as the C++ handle exists. If the C++ code stashes a `jsi::Object` in a long-lived data structure, GC won't free the underlying JS object. This is symmetric to JS holding C++ references via HostObject — both directions need explicit lifetime thinking.

### B.5 `jsi::HostObject` — the deep dive

The most important JSI primitive for our purposes. Here's a minimal working example:

```cpp
class LayoutCacheJsi : public facebook::jsi::HostObject {
public:
  LayoutCacheJsi(std::shared_ptr<LayoutCache> cache)
    : cache_(std::move(cache)) {}

  facebook::jsi::Value get(facebook::jsi::Runtime& rt,
                           const facebook::jsi::PropNameID& name) override {
    auto n = name.utf8(rt);

    if (n == "version") {
      // Read a value out of the C++ cache, return as JS number
      return facebook::jsi::Value((double)cache_->version());
    }

    if (n == "getAttributesInRect") {
      // Return a JS function backed by a C++ lambda
      return facebook::jsi::Function::createFromHostFunction(
        rt, facebook::jsi::PropNameID::forUtf8(rt, "getAttributesInRect"),
        4,  // expected arg count
        [cache = cache_](facebook::jsi::Runtime& rt,
                        const facebook::jsi::Value&,        // thisVal
                        const facebook::jsi::Value* args,
                        size_t /* count */) -> facebook::jsi::Value {
          double x = args[0].asNumber();
          double y = args[1].asNumber();
          double w = args[2].asNumber();
          double h = args[3].asNumber();
          // ... do the C++ work, build a result, return a jsi::Value ...
          return facebook::jsi::Value::undefined();
        });
    }

    return facebook::jsi::Value::undefined();
  }

  std::vector<facebook::jsi::PropNameID>
  getPropertyNames(facebook::jsi::Runtime& rt) override {
    return {
      facebook::jsi::PropNameID::forUtf8(rt, "version"),
      facebook::jsi::PropNameID::forUtf8(rt, "getAttributesInRect"),
    };
  }

private:
  std::shared_ptr<LayoutCache> cache_;
};
```

Binding it into JS scope:

```cpp
auto hostObj = std::make_shared<LayoutCacheJsi>(cache);
auto jsObj   = facebook::jsi::Object::createFromHostObject(runtime, hostObj);
runtime.global().setProperty(runtime, "nativeLayoutCache", jsi::Value(rt, jsObj));
```

From JS:

```js
const v = global.nativeLayoutCache.version;            // calls C++ get("version")
const r = global.nativeLayoutCache.getAttributesInRect(0, 0, 375, 800);  // C++ function
```

#### How JSI maps this to each engine

`createFromHostObject` is `Runtime`-virtual; each engine implements it:

| Engine | Implementation |
|---|---|
| **Hermes** | Constructs a `vm::HostObject` (Hermes's own internal type), stores the `shared_ptr<jsi::HostObject>` in its internal slot, hooks Hermes's property-access dispatch to call back into the shared_ptr. |
| **V8** | Constructs an Object from a V8 `ObjectTemplate` configured with `SetInternalFieldCount(1)` and a `NamedPropertyHandlerConfiguration`. Stores the `shared_ptr<jsi::HostObject>` (wrapped in a V8 `External`) in the internal field. The named-property handler unwraps the shared_ptr and calls `get`/`set`. |
| **JSC** | Constructs a `JSObjectRef` from a `JSObjectClass` configured with `getProperty`/`setProperty` callbacks; private data slot holds the shared_ptr. |

So **yes, every engine has an equivalent of HostObject** — but each engine names it differently and uses different internal mechanics. JSI's job is to make all three look the same to consumers.

#### Lifetime — the one-way bridge

This is the subtle part. When you call `Object::createFromHostObject`, the JSI implementation:

1. Wraps your `shared_ptr<HostObject>` so the engine's internal slot holds a copy.
2. Returns a `jsi::Object` to you (which itself holds a `jsi::Value` reference to the underlying JS Object).
3. As long as **either** something in JS-land holds the wrapper Object, **or** the C++ `jsi::Object` handle stays alive, the shared_ptr count stays ≥ 1, and your HostObject is alive.

When all references drop:
- JS-side: GC discovers the wrapper Object is unreachable, schedules it for collection.
- During collection, the engine calls a finalizer that releases the engine's copy of the shared_ptr.
- shared_ptr count drops to 0 (assuming no other C++ holders); your HostObject's destructor runs.

**The gotchas:**

- You don't get notified when the wrapper Object's GC happens. You only see the destructor run. If you need to do C++ cleanup, do it in your `~HostObject()`.
- If C++ code holds its own `shared_ptr<MyHostObject>` (e.g. you registered it in a global registry), the HostObject stays alive even after JS has lost the wrapper. That's usually a bug — JS-side code holding `nativeLayoutCache` now references a HostObject that JS thinks is gone.
- The opposite leak: if you stash a `jsi::Object` in a long-lived C++ data structure without thinking, the underlying JS Object can never be GC'd. JS-side this looks like a memory leak; the user can't see what's holding it alive.

Riff's pattern (`weak_ptr` in the registry, `cpp/CollectionViewModule.cpp:96`) breaks the cycle: the registry holds a `std::weak_ptr<LayoutCache>` keyed by `cacheId`, not a strong ref. The HostObject holds the strong ref; the registry only gets a non-null shared_ptr when it `lock()`s the weak_ptr and the HostObject is still alive. When the JS wrapper goes away, the HostObject destructs, the LayoutCache destructs, and the registry's weak_ptr cleanly returns null on the next `lock()`. No leaks, no stale references.

#### What you can build with HostObject

The whole "C++ objects exposed to JS" surface in RN's new architecture is HostObject under the hood:

- **TurboModules.** A TurboModule is a HostObject with a fixed schema generated from a TypeScript spec. The codegen produces a C++ class that subclasses HostObject and implements `get(propName)` to return JS Functions backed by your `cpp` methods. JS-side, `import { Foo } from 'react-native'` resolves to that HostObject.
- **Riff's `NativeCollectionViewModule`.** Same pattern — a HostObject exposing layout-cache methods.
- **Fabric ShadowNodes** are not exposed to JS as HostObjects directly (they live entirely in C++), but their *references* from JS (via the React reconciler's commit interface) go through JSI.

### B.6 TurboModules and Fabric — what JSI unlocked

JSI is a means; TurboModules and Fabric are the ends.

**TurboModules** replace the old "Native Modules" API. You write a TypeScript spec:

```ts
// NativeCollectionViewModule.ts
export interface Spec extends TurboModule {
  ping(): boolean;
  scrollTo(cacheId: number, x: number, y: number, animated: boolean): void;
  // ...
}
```

Codegen produces a C++ class skeleton you fill in. The runtime instantiates it as a HostObject. When JS calls `NativeCollectionViewModule.scrollTo(...)`, it's a synchronous JSI call into your C++ method. No serialise. No queue. The cost is roughly the cost of a virtual function dispatch — measured in tens of nanoseconds.

**Fabric** replaces the old UIManager. Where pre-Fabric had a JSON-message-based shadow tree on the native side that JS communicated with via the bridge, Fabric has the shadow tree living as real C++ objects (`ShadowNode` instances) that JSI lets JS reference directly. React's reconciler can build a new shadow tree by calling C++ functions; the diff happens in C++; the resulting mount instructions are delivered to the UI thread without ever leaving native memory.

> **The architectural shift in one sentence:** in the old arch, JS sent JSON descriptions of UI to native and waited for ACKs. In the new arch, JS *constructs* the native UI tree directly by calling C++ constructors, and synchronously commits it via JSI.

This is why Riff's hot path can live in C++ inside Fabric: there's no longer a serialisation barrier between the React reconciler and the C++ shadow nodes. The custom ShadowNode subclass Riff defines is just another C++ class that participates in the same commit pipeline.

---

## Block C — RN's four-object-graph + threads

Every `<View />` you write in JSX produces, over its lifetime, four separate objects living in different memory regions managed by different GCs (or none). Understanding which object owns which is the foundation for understanding Fabric, Riff's interception points, and why some operations are cheap and others aren't.

### C.1 React Element — the JS-heap leaf

```jsx
const e = <View style={{flex: 1}}><Text>Hi</Text></View>;
```

`e` is a plain JS object. It's the value returned by `React.createElement(View, {style: {flex: 1}}, React.createElement(Text, null, 'Hi'))`. Its shape, roughly:

```js
{
  $$typeof: Symbol(react.element),
  type:     View,                       // a reference to the View component
  props:    { style: {flex: 1}, children: [<Text>...</Text>] },
  key:      null,
  ref:      null,
}
```

**Lifetime:** very short. React Elements are created by the parent component's render function, consumed by the reconciler in the next reconciliation pass, and become unreferenced immediately after. Hermes's young-gen GC reclaims them within a few hundred milliseconds. If your render allocates thousands of elements per frame, your scroll FPS will be dominated by GC pressure — this is why Riff aggressively bounds the render-window and avoids re-creating element subtrees on every scroll event (the element-cache optimisation at CollectionView.tsx:3165).

**What lives alongside the React Element:** the **Fiber** — React's internal representation of an in-tree component. A Fiber is a longer-lived JS object that React reuses across renders. It holds the component's hooks state, the link to its parent/sibling/child Fibers, and effects to fire. The React reconciler walks Fibers, not Elements: Elements describe "what the user wants the tree to look like," Fibers track "what we currently have." Each render, the reconciler diffs Elements against the existing Fiber tree to determine what changed.

**Why this matters for Riff:** the slot pool preserves Fibers across scroll-off events. When `dataKeyToSlot` routes a returning data key back to its prior slot, the SAME Fiber is re-attached — its `useState` value persists, its `useRef` value persists, its `useEffect` cleanup hasn't run. From React's perspective the component just got new props. This is the architectural reason an `<ExpandableCard isExpanded={true}>` stays expanded across a brief scroll-off.

### C.2 ShadowNode — the Fabric C++ tree

For each React Element of a *host* component (a built-in like `<View>`, `<Text>`, `<Image>`, or a registered native component like `<RNCollectionViewContainer>`), Fabric constructs a corresponding `ShadowNode` in C++. Function components and HOCs don't have ShadowNodes — only host components do.

```
JS heap (React)                    C++ heap (Fabric)
───────────────                    ──────────────────

React Element                      ShadowNode (immutable)
{type: View, props, children}  ↔   ConcreteViewShadowNode
                                   ├── props (snapshot of JS props)
                                   ├── state (Fabric State, mutable via clone)
                                   ├── children: vector<shared_ptr<const ShadowNode>>
                                   └── layout output (Yoga results)
```

**ShadowNodes are immutable.** When React reconciles a prop change, Fabric *clones* the existing ShadowNode with new props, producing a new ShadowNode. The old one is discarded. This clone-on-write design serves a critical purpose: ShadowTree consistency. A commit is "swap the root pointer from the old tree to the new tree." Threads that observed the old tree during their work see a consistent snapshot; threads that observed the new tree see the next snapshot. No locking on the tree itself.

**Lifetime:** ShadowNodes are owned by `shared_ptr<const ShadowNode>`. The ShadowTree (held by the UIManager) holds the root. Each parent ShadowNode holds shared_ptrs to its children. When a clone replaces a parent, the old subtree's reference count drops to zero (assuming no other holders) and the old subtree is destructed in C++ — outside the JS GC's purview.

**For Riff:** `CollectionViewContainerShadowNode` is a custom ShadowNode subclass. Fabric instantiates it whenever it encounters the `RNCollectionViewContainer` host component in the React tree. Riff overrides its `layout()` method (cpp/CollectionViewContainerShadowNode.h:64) — that's the primary hook into the commit pipeline. Every commit that touches this container's subtree results in a clone of this ShadowNode, and Riff's `layout()` runs on the clone before the tree is committed.

The clone-on-write model is why the slot lifecycle in R4 talks about "Phase 2" and "Phase 4" — these are operations on the JS-side SlotManager state, but they're driven by ShadowNode reconciliations that produce clones with new child sets. The clone of `CollectionViewContainerShadowNode` has the new render-range children attached; the layout pass diffs the Yoga results against the prior state's positions and emits state updates.

### C.3 Yoga node — the layout engine's per-element state

Yoga is a separate C++ library — a flexbox layout engine, used by RN (and several other projects) to compute geometry from style declarations. Each `ShadowNode` in Fabric *owns a Yoga node* — a different C struct that holds the flexbox properties (`flex`, `padding`, `margin`, computed `width`/`height`, etc.) and participates in Yoga's layout algorithm.

```cpp
class ShadowNode {
  // ...
  YGNode* yogaNode_;   // wholly owned; co-allocated and lifetime-bound
  // ...
};
```

When Fabric runs the layout pass, it asks Yoga to traverse the tree of `YGNode*`s and compute geometry. Yoga assigns each node a `left`, `top`, `width`, `height`. Fabric reads those back from each ShadowNode's YGNode after the pass.

**For Riff:** the central trick in `correctChildPositionsIfNeeded` is reading the Yoga-measured height of each child ShadowNode's YGNode and diffing it against the height the LayoutCache previously stored. If they differ, the actual content rendered taller (or shorter) than the estimate; Riff records a correction. All of this happens inside `ShadowNode::layout()`, in a single commit, before any results reach the UI thread.

Yoga measure functions (for leaf nodes that need C++ to determine their intrinsic size) are how RN's `<Text>` and `<Image>` work. Riff doesn't use measure functions directly; it lets the cell content's React subtree drive Yoga via normal flexbox.

### C.4 UIView / Android View — the platform widget

The final object in the chain is the actual platform widget — an `UIView` on iOS, a `android.view.View` on Android. This is the only one of the four that can be *seen* by the user.

Fabric's "mounting layer" is responsible for translating commit results into platform mutations:

- **Insert:** create a UIView for a new ShadowNode, add it to its parent's subviews.
- **Delete:** remove a UIView whose ShadowNode is no longer in the tree.
- **Update:** call `updateProps:` / `updateLayoutMetrics:` / `updateState:` on a UIView when its corresponding ShadowNode changed.
- **Move:** reorder subviews when ShadowNode children reorder.

**The mounting layer runs on the main UI thread** (it has to — UIKit calls aren't thread-safe). The commit pipeline (where Yoga and ShadowNode layout ran) ran on whatever thread did the commit (often the JS thread, sometimes a background "shadow queue"). The handoff from "commit done" to "platform mutations ready to run" is a single mount-instruction list that gets queued onto the main thread.

**For Riff:** `RNCollectionViewContainerView` is the iOS UIView class. It's a `UIScrollView` subclass with extra hooks. The Fabric-generated mount instructions cause it to be created and inserted; subsequent `updateState:` calls deliver new `CollectionViewState` (Riff's custom state struct) to it; the override of `applyPositionsFromState:` reads the state and positions child UIViews.

`RNMeasuredCellView` is the cell wrapper UIView. There's one per cell that's currently mounted in the React tree (i.e., one per active SlotManager slot). Its `updateLayoutMetrics:` override is what protects the LayoutCache-set origin against Fabric's default behaviour.

The view-flattening optimisation (described in the README) means *not every ShadowNode produces a UIView*. Flat layout-only views (no event handlers, no visual properties) are absorbed into their parent's UIView. Riff's boundary components are intentionally non-flat — they all need real UIViews to host the position-setting behaviour.

### C.5 Two GC heaps, no shared knowledge — the lifetime bridge

Step back and look at the four objects:

| Object | Lives in | Managed by |
|---|---|---|
| React Element | JS heap | V8/Hermes GC |
| ShadowNode | C++ heap | `shared_ptr` reference counting |
| Yoga node | C++ heap | Owned by ShadowNode |
| UIView | UI-thread heap (ObjC) | Owned by parent UIView + mounting layer |

**The JS GC does not know about C++ objects.** From its perspective, when a React Element is no longer referenced, it can be collected — there's nothing to consult about whether a C++ ShadowNode references it.

**The C++ side does not know about JS GC.** A `shared_ptr<ShadowNode>` keeps its target alive regardless of what JS is doing.

**Bridging is JSI's job, and only at specific points:**

1. **Top-down (JS → C++):** when JS calls a TurboModule function, JSI receives `jsi::Value` parameters. If those values are JS objects, JSI holds them alive (via the engine's strong-reference mechanism) for the duration of the C++ call. When the call returns, the JS-side holders take over.

2. **Bottom-up (C++ → JS):** when C++ wants to keep a JS object alive across an event-loop iteration — say, a callback you registered from JS — it stashes a `jsi::Function` (which internally holds a strong reference) somewhere. As long as that handle stays alive, the JS function won't be collected.

3. **HostObject straddling:** the wrapper Object lives in JS; the underlying HostObject lives in C++. The shared_ptr in the engine's internal slot is the bridge. JS GC drops the wrapper → engine releases the shared_ptr → C++ object dies if no one else holds it.

The pattern that gets people into trouble: a C++ subsystem stashes a `jsi::Function` to "call this JS callback later" but never releases it, even after the component that registered it has unmounted. Result: the JS callback is alive forever, plus everything in its closure is alive forever, plus the unmounted React subtree those closures captured is alive forever. JS-side memory leak whose root cause is in C++. Hard to debug without thinking about both heaps.

The pattern that works: hold `weak_ptr` or weak engine references in C++ when "no one else has a stake in this object's life." Riff's registry of LayoutCaches uses `weak_ptr` for this reason — the registry observes lifetimes but doesn't keep things alive.

### C.6 Three threads, their permissions, why this matters

Fabric formalises three execution contexts:

| Context | Where work happens | Can touch UIKit/Views? | Can call JSI? |
|---|---|---|---|
| **JS thread** | React reconciliation, user JS code, RN event handlers | No | Yes — synchronous, ~zero cost |
| **Fabric commit pipeline** | ShadowNode `layout()`, Yoga, state writes | No | No — pure C++ (the commit isn't running JS) |
| **UI thread (main)** | UIView creation/update, scroll delegate callbacks, mounting layer execution | Yes — only thread that can | No |

"Fabric commit pipeline" isn't a single dedicated thread in current RN — commits happen on whatever thread triggered them (usually the JS thread for React-driven commits, sometimes a background "shadow queue" for native-driven state updates). The *capabilities* in the table are what matter, not the literal thread identity. When a commit is in progress:

- Whatever code runs (Yoga measure functions, ShadowNode overrides, state diffs) is pure C++.
- It can't call JS — there's no engine context active.
- It can't touch UIKit — that's a different thread's responsibility, with its own queues.

This isn't just a rule; it's the basis of Fabric's correctness model. If `ShadowNode::layout()` could call JS, it could trigger a re-entrant React reconciliation while a commit was in progress, and the commit's view of the world would become incoherent. Forbidding JS calls during commits is how Fabric guarantees a commit produces a stable result.

**For Riff:**

- The hot path's "JS doesn't run during scroll" property is enforced by the commit pipeline's structure. The UIScrollView delegate fires on the main thread; it writes to the LayoutCache via JSI from there *but only because no commit is in progress*. The commit-pipeline-style work (correctChildPositionsIfNeeded, applyMeasurements) runs in `ShadowNode::layout()` only when a commit is happening, and only on C++ values.
- The four-object-graph and three-thread model together explain why Riff has six interception points spread across all three contexts. Block R2 (slides) lists them with file:line; each one runs in the context where its work is permitted.

---

## Block D — Fabric commit cycle + interception surface

This block ties C and B together: where in the commit cycle Riff hooks in, what each hook does, and what you *can't* do at each point.

### D.1 One commit, step by step

Here's a commit in detail, from a JS state change to a pixel:

```
1. JS: React state update
   ────────────────────────
   setData(newItems);
   ↓
   React schedules a reconciliation pass (in startTransition: deferrable;
   otherwise immediate).

2. JS: React reconciliation
   ─────────────────────────
   React walks the Fiber tree.
   For each Fiber whose component's render produces different Elements,
   React calls into Fabric to update the corresponding ShadowNode.

3. JSI: ShadowNode cloning
   ────────────────────────
   Fabric clones the affected ShadowNodes with new props.
   For Riff: CollectionViewContainerShadowNode gets cloned with new children
   (the render-window slice).
   Clones happen as direct C++ calls from JSI. No serialisation.

4. C++: Layout pass
   ─────────────────
   Fabric walks the new tree and asks Yoga to compute layout.
   For each ShadowNode, Yoga measures and places its children.
   At the container ShadowNode, Fabric calls layout() — Riff's override
   runs here.
   In Riff's layout():
   - shouldSkipCorrection() — hash check, possibly skip entire pass
   - correctChildPositionsIfNeeded()
     - Bulk-read LayoutCache
     - Diff each Yoga-measured child height against cached height
     - Build a correction delta batch
     - Call layoutEngine.applyMeasurements(deltas) → cascade in C++
     - Re-read updated LayoutCache
   - updateStateIfNeeded() — write new CollectionViewState (positions[],
     childTags[], contentSize) via Fabric's setStateData() call

5. C++: Tree commit
   ─────────────────
   The new ShadowTree (with computed Yoga geometry, updated state) is
   atomically swapped in for the old one.

6. C++: Mount instruction generation
   ──────────────────────────────────
   Fabric diffs the new tree against the old tree.
   Produces a list of mount instructions:
   - Insert UIView for new ShadowNode at position N
   - Update props for UIView at tag T
   - Update state for UIView at tag T (delivers CollectionViewState)
   - Update layout metrics for UIView at tag T (delivers Yoga geometry)
   - Remove UIView for deleted ShadowNode
   - Reorder children
   The instruction list is queued onto the main thread.

7. Main thread: Mount execution
   ─────────────────────────────
   The queue runs.
   For each instruction, the platform-specific mounting layer:
   - Creates UIViews (calls -[MyView init])
   - Calls -updateProps: with new prop diff
   - Calls -updateState: with new state — this is where Riff's
     applyPositionsFromState: runs
   - Calls -updateLayoutMetrics: with new Yoga geometry — Riff's
     RNMeasuredCellView override runs here
   - Removes / reorders UIViews as needed

8. UIKit: Display
   ───────────────
   UIKit's next display cycle picks up the modified UIView tree and
   composes a frame.
```

Steps 1-2 happen on the JS thread. Steps 3-6 happen on whatever thread is committing (often JS thread, sometimes background). Steps 7-8 happen on the main thread.

### D.2 The five platform hooks Riff uses

Mapped to commit-cycle steps:

| # | Hook | Step | Runs on |
|---|---|---|---|
| ① | `ShadowNode::layout()` override | Step 4 | Commit thread (often JS thread) |
| ② | `applyPositionsFromState:` (responds to step 7's `updateState:`) | Step 7 | Main thread |
| ③ | `updateLayoutMetrics:` override on cell wrapper | Step 7 | Main thread |
| ④ | `UIScrollViewDelegate.scrollViewDidScroll:` | Out-of-cycle: scroll events on main thread | Main thread |
| ⑤ | KVO on `contentOffset` | Out-of-cycle: scroll events on main thread | Main thread |
| ⑥ | JSI bindings (TurboModule methods) | JS-to-C++ calls outside the commit | JS thread |

Note that *most of Riff's runtime work happens in step 4* — inside the commit pipeline. That's why the hot path can be "in C++" without JS involvement: the commit thread runs `ShadowNode::layout()` purely in C++, and most scrolls produce no commit at all (because the band-skip in JS short-circuits before triggering any state update that would cause a commit).

The "no commit per scroll" property is what gives Riff its CPU advantage. Scrolling moves the user's eyes, the UIScrollView's `contentOffset`, and the visible viewport — but it does NOT change any React state, does NOT clone any ShadowNodes, does NOT produce mount instructions. The C++ `processScroll` JSI call updates a scroll-offset field in the LayoutCache; JS reads it to decide whether the render range crossed a boundary; if not, nothing else happens. Only on render-range boundary crossings does a real React state update fire, triggering a real commit.

### D.3 What you can't do (and why)

Three things Fabric will not let you do, mapped to *why*:

**You can't call JS from inside `ShadowNode::layout()`.**
Reason: the commit is in progress. JS execution would trigger React reconciliation; React reconciliation would call back into Fabric to clone ShadowNodes; you'd have nested commits with overlapping views of the tree. The result would be either undefined behaviour or pathological re-entry. Fabric's invariant: commits are atomic; no JS during the commit pipeline.

**You can't touch UIKit from `ShadowNode::layout()`.**
Reason: wrong thread. UIKit isn't thread-safe; only the main thread can call into it. The commit thread isn't the main thread. If you have a result that needs to reach UIKit, write it to Fabric `State` and let the mounting layer pick it up on the main thread.

**You can't measure Yoga "out of band."**
Reason: Yoga state is part of the ShadowNode. Measuring a Yoga node outside of a layout pass is asking for stale, inconsistent results. If you need to measure something synthetic (e.g., the C++ layout engine wants to know how tall an item *would* be at width W), inject the measurement into the next commit by setting prop / state and let Fabric drive Yoga; or use a separate Yoga node that you allocate and manage yourself. Riff does the latter inside `applyMeasurements` cascades — those operate on the C++ LayoutCache's geometry math, not on Yoga nodes directly.

These three rules are why Riff's architecture is shaped the way it is. The interception points respect the platform's threading model and the commit-pipeline's atomicity; everything Riff does is within those rules. The cleverness is in choosing *which* rule-respecting hook to use for each piece of work.

---

---

# Part 2 — How RN core and other libraries use these mechanisms

Riff is not the first or only library to override `ShadowNode::layout()`, install custom `State`, exploit `UIScrollViewDelegate`, or wire JSI into the UI thread. RN core itself does all of these — every interesting platform widget in `react-native` uses one or more of the mechanisms described in Part 1. This part walks through the canonical examples, with file:line references into the RN source tree under `node_modules/react-native`, so you can see for yourself how Riff fits the architectural patterns RN encourages.

## Block E — Real-world uses of these mechanisms

### E.1 Custom `ShadowNode::layout()` override + custom `State` — `ScrollView`

RN's core `<ScrollView>` is structurally **the same pattern as Riff's `CollectionView`**. It has a custom ShadowNode that overrides `layout()`, a custom `State` type that carries scroll position from native back into the ShadowTree, and an iOS UIView class that wires UIScrollViewDelegate methods to write that state.

**`ScrollViewShadowNode::layout`** — `ReactCommon/react/renderer/components/scrollview/ScrollViewShadowNode.cpp:60`:

```cpp
void ScrollViewShadowNode::layout(LayoutContext layoutContext) {
  ConcreteViewShadowNode::layout(layoutContext);
  updateScrollContentOffsetIfNeeded();
  updateStateIfNeeded();
}
```

That's literally the same shape as Riff's override: call super, then run two custom methods that prepare the new state. `updateStateIfNeeded` (lines 18–32) computes the content bounding rect by union'ing the layout frames of all children, and writes it into the state via `setStateData()`:

```cpp
void ScrollViewShadowNode::updateStateIfNeeded() {
  // ...
  auto contentBoundingRect = Rect{};
  for (const auto& childNode : getLayoutableChildNodes()) {
    contentBoundingRect.unionInPlace(childNode->getLayoutMetrics().frame);
  }
  auto state = getStateData();
  if (state.contentBoundingRect != contentBoundingRect) {
    state.contentBoundingRect = contentBoundingRect;
    setStateData(std::move(state));
  }
}
```

**`ScrollViewState`** — `ReactCommon/react/renderer/components/scrollview/ScrollViewState.h:24`:

```cpp
class ScrollViewState final {
public:
  Point contentOffset;
  Rect  contentBoundingRect;
  int   scrollAwayPaddingTop;
  // ...
};
```

`contentOffset` is what flows *back* from the UIView into the ShadowTree. Native side, on every scroll event, writes the new offset into the state; the next Fabric commit picks it up; downstream consumers (sticky header logic, `maintainVisibleContentPosition`, JS-side `onScroll` handlers) see consistent values without race conditions.

**`RCTScrollViewComponentView` (iOS)** — `React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm`:

> **Aside on Riff's own scroll delegate vs C++ work:** the iOS V delegate (`RNCollectionViewContainerView.mm:346`) and H sub-container delegate (`RNCollectionSubContainerView.mm:1023`) are structurally the same — both throttle and fire a JS-side scroll event, neither calls C++ layout work directly from the delegate. JS then calls `nativeWindowController.processScroll` (V) or `processHScroll` (H) via JSI. What differs is *what `processScroll` does in C++ based on layout type*: for static layouts (`list`/`grid`/`masonry`/`flow`) it's an O(log n) render-range binary search with no position recomputation; for scroll-driven dynamic layouts (`radial`/`carousel3D`/`spiral`/`hex`, currently used only as H section types) it recomputes per-item frame/transform/alpha at the new scroll offset, because those layouts' geometry is a function of scroll position. The asymmetry in workload is layout-shape, not call-site.


- Line 728 — `scrollViewDidScroll:` (UIScrollViewDelegate method) calls `_updateStateWithContentOffset`
- Line 642 — `_updateStateWithContentOffset` reads `_scrollView.contentOffset` and writes it into the Fabric state via `_state->updateState(newState)`
- Line 451 — `updateState:oldState:` receives the state back when something else (sticky scroll-to, MVC adjustment) modifies it

**`maintainVisibleContentPosition`** — lines 1046–1100 of the same file. RN's own MVC implementation is in this UIView class. Same approach Riff takes: when items above the visible viewport change height, compute the delta and adjust `contentOffset` natively before the next display pass. The maintenance happens on the UI thread, not via JS. (Riff's MVC is more elaborate because it has to integrate with the C++ layout engine's `applyMeasurements` cascade, but the *idea* is identical.)

**The lesson:** Riff's "override layout(), use custom State, drive UI from C++ before reaching UIKit" pattern isn't novel — it's the patterns RN core uses for its own scroll view. Riff differs only in *what* it computes inside that pattern (a much more complex layout engine with windowing, slot management, and cascading height corrections).

### E.2 Yoga measure functions — `<Text>` (ParagraphShadowNode)

For leaf nodes whose intrinsic size depends on content the layout engine can't see — text, images, custom-drawn widgets — RN uses **Yoga measure callbacks**. The ShadowNode subclass implements `measureContent()`, Yoga calls it during the layout pass to ask "given these constraints (max width, etc.), what size do you want?", and the callback returns a `Size`.

**`ParagraphShadowNode::measureContent`** — `ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp:222`:

```cpp
Size ParagraphShadowNode::measureContent(
    const LayoutContext& layoutContext,
    const LayoutConstraints& layoutConstraints) const {
  // ...
  return textLayoutManager_->measure(attributedStringBox,
                                     paragraphAttributes,
                                     layoutContext,
                                     layoutConstraints);
}
```

`TextLayoutManager` is a C++ wrapper that delegates to the platform's native text engine — CoreText on iOS, `android.text.Layout` on Android. So during a Fabric commit, on the commit thread, `<Text>` runs **real text measurement** via native APIs and returns the result to Yoga. No JS roundtrip. No async. By the time the commit reaches the UI thread, the text has its final size baked into the layout metrics.

**This is also what makes `<Text>` slow** if you have lots of it. Each Paragraph runs a synchronous text measurement during the commit; many Paragraphs means many measurements; commits get longer. Riff sidesteps the issue by treating cell content as Yoga's responsibility — measuring it once when the cell first mounts in the render range, caching the result in LayoutCache, and consulting the cache thereafter.

**`<TextInput>` (TextInputShadowNode)** uses the same pattern (`textinput/platform/ios/.../TextInputShadowNode.cpp`) — text measurement + custom state for content/selection.

### E.3 Custom `State` for async-loaded data — `<Image>`

Image loading is fundamentally asynchronous (network fetch, decode), but the image's intrinsic size affects layout. RN handles this by carrying the image-request lifecycle in `State`.

**`ImageState`** — `ReactCommon/react/renderer/components/image/ImageState.h:25`:

```cpp
class ImageState final {
public:
  ImageState(const ImageSource& imageSource,
             ImageRequest        imageRequest,
             const ImageRequestParams& params);
  const ImageRequest& getImageRequest() const;
  const ImageRequestParams& getImageRequestParams() const;
  // ...
};
```

When the image starts loading, an `ImageRequest` (which has its own observer/callback mechanism) is created and stashed in state. When the image loads, decode happens off-thread; the resulting `UIImage`/`Bitmap` is delivered to the UIView; size is propagated back through state if it differs from the originally-declared size.

**The pattern:** *state is the channel for native subsystems to feed data back into the ShadowTree without going through JS*. Riff uses the same pattern for its position arrays and `childTags[]` — these are computed in C++ during `layout()` and delivered to native via state.

### E.4 `<SafeAreaView>` — state carrying platform-derived insets

iOS's safe-area insets depend on the device (notch height, home indicator, keyboard visibility) and aren't known until the UIView is in a real window. `<SafeAreaView>` discovers the insets from UIKit and writes them into ShadowTree state so Yoga can apply them as padding.

**`SafeAreaViewShadowNode`** — `ReactCommon/react/renderer/components/safeareaview/SafeAreaViewShadowNode.h:24`:

```cpp
class SafeAreaViewShadowNode final
    : public ConcreteViewShadowNode<
        SafeAreaViewComponentName,
        SafeAreaViewProps,
        ViewEventEmitter,
        SafeAreaViewState> {
};
```

**`SafeAreaViewState`** — `ReactCommon/react/renderer/components/safeareaview/SafeAreaViewState.h:24`:

```cpp
class SafeAreaViewState final {
public:
  EdgeInsets padding{};
};
```

Native side (iOS `RCTSafeAreaViewComponentView`), when `safeAreaInsetsDidChange` fires, reads the new insets and writes them into state. Fabric re-runs layout with the new padding; Yoga reflows children. All of this happens without a JS roundtrip — the UIView feeds the data straight into the ShadowTree and a new commit produces correctly-sized children.

**The pattern is identical to Riff:** Riff's `LayoutCache` plays a similar role for layout-engine-derived geometry that needs to make it back to the UIView. The difference is direction — `SafeAreaView` flows data UIView → ShadowTree, Riff flows data layout-engine → ShadowTree → UIView. Both use Fabric's `State` as the channel.

### E.5 `<Modal>` — custom ShadowNode and state for cross-window content

Modals on iOS are presented in a separate `UIWindow` (not as a subview of the main view hierarchy). RN models this with `ModalHostViewShadowNode` + `ModalHostViewState`, which carries the modal's intended size and presentation parameters.

**`ModalHostViewShadowNode`** — `ReactCommon/react/renderer/components/modal/ModalHostViewShadowNode.h:22`. Uses `ConcreteViewShadowNode<…, ModalHostViewState>`. Less of a hot-path concern than ScrollView, but the same pattern.

### E.6 What `KeyboardAvoidingView` does (and doesn't)

A trap to flag in the talk: `KeyboardAvoidingView` is **not** built on the ShadowNode/state mechanisms above. It's a pure JS component. Look at `react-native/Libraries/Components/Keyboard/KeyboardAvoidingView.js`: it subscribes to `Keyboard.addListener('keyboardWillChangeFrame', ...)`, computes a height delta in JS, and renders a normal `<View>` with adjusted padding. No native ShadowNode, no custom state, no UI-thread interception.

This is a deliberate design choice: keyboard appearance fires native events (which are forwarded to JS via the standard event system), and the resulting layout adjustment isn't on a scroll hot path — once per keyboard show/hide is fine. So spending complexity budget on a native subclass would be wasted. The right tool here is JS event listeners.

**The lesson for component authors:** not every UI mechanism needs a custom ShadowNode. Reach for the platform-hook toolbox only when (a) you need to coordinate with the commit pipeline atomically, (b) you need UI-thread responsiveness that crossing through JS can't deliver, or (c) you're managing state that has to survive across commits without re-rendering. Riff hits all three. KeyboardAvoidingView hits none.

### E.7 JSI for UI-thread JS — Reanimated 3, gesture-handler v2

A separate use of JSI worth knowing about: installing a **second JS runtime** that lives on the UI thread.

**Reanimated 3** ships a "worklet" runtime — a parallel Hermes/JSC instance bound to the main thread. JS code marked as a worklet (functions starting with `'worklet'` or decorated by the Reanimated Babel plugin) gets compiled into the UI runtime; it runs there at full UI-thread speed, with shared `SharedValue` objects bridging between the two runtimes via JSI. Animation drivers, scroll handlers, and gesture handlers can run entirely on the UI thread without paying any cross-thread cost.

**`react-native-gesture-handler` v2** uses the same Reanimated runtime — gesture state computed on the UI thread, propagated via shared values, never reaches the JS thread unless the consumer explicitly opts in via `runOnJS`.

**Why this is interesting in contrast to Riff's approach:** Reanimated keeps UI-thread JS *as JS*, running in a second runtime. Riff keeps the equivalent computation *in C++*, running inside Fabric's commit pipeline. Both achieve "no main-JS-thread involvement during scroll/animation," but they get there via different mechanisms. Reanimated is more accessible to consumers (you write JS, you get UI-thread perf); Riff is more performant for layout-specific work (C++ avoids the second runtime's overhead) but is harder to extend without C++.

For a list/collection view, the bottleneck isn't gesture computation — it's the *amount of React work per scroll frame*. Reanimated can't help with that because the work is React's, not the gesture's. So Riff's C++ approach is the right call for layout libraries; Reanimated is the right call for animation libraries.

### E.8 `react-native-screens` — replacing UIView with UINavigationController

`react-native-screens` defines custom ShadowNodes for `Screen`, `ScreenContainer`, `ScreenStack`, etc. Each one maps to native navigation primitives (`UINavigationController`/`UIViewController` on iOS, `Fragment` on Android) rather than UIViews. The Fabric mounting layer creates `UIViewController`s instead of `UIView`s for these components, which means iOS's built-in transitions and gestures work natively without JS-side animation code.

This is a non-`UIView` example of the same pattern: custom ShadowNode subclass + custom platform component class = bypass the default RN behaviour and substitute platform-native behaviour. Demonstrates that the interception surface in Part 1 isn't restricted to UIScrollView subclasses or visual widgets — anything Fabric can mount is fair game.

### E.9 The atoms / design-system package — general observations

I don't have specifics on the atoms package in this repo, but here's what to look for when auditing a design-system library against these mechanisms:

| Question | What you're looking for |
|---|---|
| Does the library define any custom native components? (check for `codegenNativeComponent` calls or any `.cpp`/`.mm` files) | If yes — it's using the ShadowNode/State surface and you can audit it against E.1–E.5. If no — everything is built on RN core primitives, and the perf characteristics are inherited from those. |
| Do layout primitives (`Box`, `Stack`, `Row`, `Column`) just compose `<View>` with flex styles? | If yes — Fabric's view flattening will collapse the wrapper Views, so the abstraction is "free" at the UIView level. |
| Do typography components delegate to RN `<Text>`? | If yes — they inherit Paragraph measure costs (E.2). If a screen has hundreds of typography nodes, this is the first thing to look at. |
| Are there any custom scrollable components, or do they wrap RN `<ScrollView>` / FlashList / Riff? | If they wrap, perf inherits from the underlying engine. If they're custom, audit them against ScrollView's pattern (E.1). |
| Do touchable / pressable components define their own gesture handlers, or do they wrap `<Pressable>` / `react-native-gesture-handler`? | gesture-handler-based components get UI-thread gesture handling for free (E.7). JS-only touchables have main-thread latency. |
| Are animated transitions implemented with `Animated` (legacy), `Reanimated`, or `LayoutAnimation`? | Reanimated → UI-thread (E.7). Animated → bridge-bound (slow on old arch, less bad on new arch). LayoutAnimation → native via Fabric mount transitions. |

If atoms is mostly thin wrappers around RN core (which is common), then its perf is RN core's perf, and the mechanisms in E.1–E.7 apply to it transitively. If atoms ships native ShadowNodes, you can apply the same audit pattern Riff was subjected to in the validation: what hook does each native piece use, what state does it carry, what thread does it run on.

---

## Block E recap — mechanisms by use case

| Use case | Mechanism | Riff example | RN core example |
|---|---|---|---|
| Custom layout pass | `ShadowNode::layout()` override | `CollectionViewContainerShadowNode::layout` | `ScrollViewShadowNode::layout` |
| Native → ShadowTree data flow | Custom `State` type written from UIView | `CollectionViewState.positions/childTags` | `ScrollViewState.contentOffset`, `SafeAreaViewState.padding`, `ImageState.imageRequest` |
| Intrinsic content sizing | Yoga `measureContent()` callback | (not used — cells are normal Yoga children) | `ParagraphShadowNode::measureContent` (text) |
| UI-thread scroll handling | `UIScrollViewDelegate` methods | `scrollViewDidScroll:` writes to LayoutCache | `RCTScrollViewComponentView.mm:728` writes to State |
| Maintain-visible-content-position | C++ layout engine + state-driven offset adjustment | Riff's full MVC pipeline | `RCTScrollViewComponentView.mm:1046–1100` (simpler, non-cascading) |
| Sticky views without JS | KVO on `contentOffset` + native transform | `RNScrollCoordinatedView` | RCTScrollView's own sticky-header implementation |
| JSI surface to JS | Custom `HostObject` (`NativeCollectionViewModule`) | LayoutCache + LayoutEngine registries | Every TurboModule in RN core |
| UI-thread JS execution | Not used (kept in C++ instead) | — | Reanimated 3 worklets, gesture-handler v2 |
| Bypass UIView for native widgets | Custom platform component class | — | react-native-screens (UIViewController) |

The takeaway: **every load-bearing mechanism Riff uses is also used somewhere in RN core or the popular ecosystem.** Riff is novel in *how many* of these it uses together and *how aggressively* it pushes computation into C++, not in inventing any single mechanism.

---

# Part 3 — Versioning, hashing, and skip-correction machinery

Several pieces of internal state are critical to scroll performance but not yet covered in either the slide deck or Part 1/2. They show up in code comments and diagnostic counters; engineers reading the codebase need to know what each means.

## The two-version model (JS LCV vs C++ cache version)

Riff has *two* monotonic "version" counters that look similar but serve different purposes. Confusing them produces real bugs (we've shipped one).

### C++ `LayoutCache._version`

A `uint64_t` counter in `cpp/LayoutCache.h:394`. Increments on every actual mutation of the cache:
- `setAttributes(attrs)` — line 112
- `setAttributesBatch(batch)` — line 125
- `removeAttributes(key)` — line 177
- `clear()` — line 193
- `endBatch()` — when batched writes commit

Reads (`getAttributes`, `getFramesForKeys`, `getAttributesForKeys`) do NOT bump.

This is the **authoritative** state-version. If `cache->version()` is different from what you last observed, the cache really has new data. Used by `CollectionViewContainerShadowNode::shouldSkipCorrection` and `CollectionSubContainerShadowNode::shouldSkipCorrection` to know when to re-run correction.

### JS-side `layoutCacheVersion` (React state)

A React state in `src/components/CollectionView.tsx:1475`. Bumped via `setLayoutCacheVersion(v => v + 1)` from eight call sites. It is **not authoritative state** — it's a **trigger** for Fabric to commit.

Why JS needs this: there's no other way for JS code to force a Fabric commit. React state changes → re-render → Fabric reconciles → ShadowNode clone → `layout()` fires. Without bumping LCV, JS-side changes don't propagate.

The eight bump sites split into two categories:

**Active bumps** — JS knows it needs to force a re-commit:
- `invalidateItem(section, index)` (lines 2123, 2149) — consumer requested cell re-measure
- `snapshot.apply(snap, setData)` data path (line 2160) — mutation needs commit
- `remeasureOnItemChange` detected via data comparison (line 2216)

**Passive bumps** — JS noticed the C++ cache version changed and wants to propagate that observation to other JS consumers (content-size readers, sticky-position computers, JS-side `useEffect`s that depend on layoutCacheVersion):
- Double-RAF post-layout poll (lines 1773, 1780)
- Initial post-mount check (line 1972)
- V scroll handler when scrollResult.cacheVersion changed AND content size changed (line 2346)

The bug we just fixed: H sub-containers' `shouldSkipCorrection` was treating every LCV change — passive or active — as a reason to re-run correction. But passive bumps are just downstream notifications of a C++ change that the sub-container can detect directly via `cache->version()` or Yoga hash. Reacting to passive LCV bumps caused 100% skip-rate failure on the first check, so the C++ checks never even ran.

The fix: in sub-container's `shouldSkipCorrection`, record the new LCV value (so the next call sees a stable value) but do not early-return. Fall through to the authoritative C++ checks below. Files: `cpp/CollectionSubContainerShadowNode.cpp` skip-correction function.

### Why both exist (the design tension)

You can't unify them because they live on opposite sides of the JSI boundary:
- C++ can mutate `_version` cheaply and atomically, but can't make React re-render
- JS can bump state to force a re-render, but doesn't observe C++ mutations until it explicitly reads them

The right abstraction would be: JS LCV is the **trigger**, C++ version is the **state**. Triggers can fire for any reason; consumers must check authoritative state to decide what to do. Our sub-container had been treating the trigger AS state — that's the bug pattern to avoid.

## The H-batch version (`hMvcVersion`)

A *second* monotonic counter in the cache, separate from `_version` (`cpp/LayoutCache.h`). Bumps only on H-section batched writes via `endHBatch()`.

The split exists because H sub-containers write their own cell positions during H scroll, and the main V container doesn't care. If H writes bumped `_version`, every H scroll tick would invalidate the V container's `shouldSkipCorrection` → V container would re-run correction for no reason.

The convention:
- Main V container's `shouldSkipCorrection` checks only `cache->version()` — doesn't care about `hMvcVersion`.
- H sub-containers check both — `cache->version()` for cross-cutting changes (data mutations, V-driven corrections) AND `cache->hMvcVersion()` for their own H-batch writes.
- V sub-containers (V layouts inside a compositional, e.g. a V grid section in a compositional layout) check only `cache->version()`.

Files: `cpp/LayoutCache.cpp:90` (where `endHBatch` increments `_hMvcVersion`), `cpp/CollectionSubContainerShadowNode.cpp` (where the `isH` branch checks it).

## The hash checks (`tagHash`, `yogaHash`)

After cache version checks, the sub-container computes two hashes across its children. Both are boost-style hash combines (XOR-rotate composition with the golden ratio constant `0x9e3779b9`).

### `tagHash`

XOR-combine of `children[i]->getTag()` for every child. Detects:
- Child added (new tag in the set → hash changes)
- Child removed (old tag missing → hash changes)
- Children reordered (different order → different XOR rotation → hash changes)

This is the structural-change detector. If `tagHash` differs from last commit, the sub-container's child set is structurally different and correction must re-run.

### `yogaHash`

XOR-combine of every child's Yoga-measured `frame` — origin.x, origin.y, size.width, size.height — each multiplied by 100 and rounded to integer (so 2-decimal precision: sub-pixel jitter is filtered, real changes are caught).

This is the content-change detector. Catches:
- Cell content state change (expand/collapse → Yoga measures taller/shorter → hash changes)
- Image loaded and cell resized → Yoga's new measurement → hash changes
- Font metric resolved on first paint → minor size change → hash changes (if above the 0.01pt rounding threshold)

The two hashes together are the catch-all for "did anything material change about the children that the version counters don't capture?" — content changes that don't write to the cache themselves but do show up in Yoga's measurement results.

## The skip-correction decision tree

Combining all of the above, `CollectionSubContainerShadowNode::shouldSkipCorrection` evaluates (post-LCV-fix):

```
                          shouldSkipCorrection()
                                    │
                                    ▼
                       cache available? ── no ── return false (run correction)
                                    │
                                    ▼ yes
                  cache->version() != lastCacheVersion_? ── yes ── failVer=true
                                    │
                                    ▼ (continue)
                 (isH AND hMvcVersion() != lastHMvcVersion_)? ── yes ── failHMvc=true
                                    │
                                    ▼ (continue)
                      N != lastChildCount_? ── yes ── failCnt=true
                                    │
                                    ▼ (continue)
              tagHash != last OR yogaHash != last? ── yes ── failHash=true
                                    │
                                    ▼ (continue)
                       any of {failVer, failHMvc, failCnt, failHash}?
                                    │
                            ┌───────┴───────┐
                            ▼               ▼
                          yes              no
                            │               │
                            ▼               ▼
                      return false     return true
                  (run correction)    (skip — nothing changed)
```

Every authoritative reason is checked. None of them are bypassed by an earlier "fail fast." The diagnostic (`RNCV_HSUB_SKIP_DIAG`) counts each independently, so the breakdown shows the real distribution of failure causes — not just whichever one happened to be first in source order.

## Why this matters for performance

A 0% skip rate means **every Fabric commit fans out into full Phase 1-4 correction on every sub-container in the React tree**, including pool-resident hidden ones. With ~4 H sub-containers on storefront and ~50 V commits per second during fling, that's ~200 sub-container corrections per second — bulk cache reads, child Yoga reads, hash compute, possibly `applyMeasurements`, state delivery. Even uncontended, that's measurable CPU.

A 90%+ skip rate (target after correctness fixes land) means most sub-container `layout()` calls bail out at the version check with zero further work — one cheap comparison, return, done. Only sub-containers whose cells actually changed run real correction.

The same machinery exists on `CollectionViewContainerShadowNode` (the V container) with its own `shouldSkipCorrection`. Its checks are: `cache->version()`, child count, tag hash, Yoga hash — no LCV check at all (V container can't be invalidated by itself), no `hMvcVersion` check (V doesn't care). Same principle, fewer signals.

## ShadowNode clone lifetime — the missing-clone-ctor trap

A subtle Fabric mechanic that bit `shouldSkipCorrection` for a long time. Documenting it here so the next custom-ShadowNode author doesn't trip on the same wire.

### Fabric clones ShadowNodes on every commit

Every Fabric commit produces a *new* `ShadowNode` instance — the previous instance is the read-only "source" and a fresh clone is produced that holds the new props/state/children. This is the [clone-on-write design] discussed earlier in this handout (Part 1, Block C). The clone is *not* an `std::shared_ptr` re-use; it's a brand-new object constructed in C++ heap.

### The clone path uses a specific constructor — NOT the default copy ctor

Inside `cpp/.../ShadowNode.cpp` (`node_modules/react-native/ReactCommon/react/renderer/core/ShadowNode.h:83`):

```cpp
ShadowNode(const ShadowNode &sourceShadowNode, const ShadowNodeFragment &fragment);
```

Fabric invokes this constructor via `clone(fragment)` whenever it produces a new ShadowNode. The base class implementation copies *base-class* state (props pointer, children vector, family, traits, layout metrics) from the source. **It cannot copy state belonging to derived classes** — that would require knowing about every possible subclass.

The C++ default copy constructor *would* copy derived-class state by virtue of how it's auto-generated. But the default copy constructor is on the `ShadowNode = delete` declaration list (line 88) — Fabric explicitly forbids it. So the derived state must be propagated explicitly in the derived class's own clone constructor, or it's lost.

### `using Base::Base;` doesn't solve this

The common shortcut in Fabric subclasses is:

```cpp
class MyShadowNode final : public ConcreteViewShadowNode<...> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;
  // ... member fields with default initializers ...
  uint64_t lastCacheVersion_{0};
};
```

The `using Base::Base;` declaration brings the base's constructors into the derived class's overload set. That includes the `(sourceShadowNode, fragment)` clone constructor — which is what Fabric calls. **But the inherited constructor still doesn't know about the derived fields.** Members declared in the derived class get their default initializers, regardless of what the source instance held.

So you end up with this exact pattern: a `MyShadowNode` whose `lastCacheVersion_` resets to `0` on every clone. Code compiles, tests don't catch it, the failure is silent.

### The fix — write the clone constructor explicitly

```cpp
class MyShadowNode final : public ConcreteViewShadowNode<...> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  // Explicit clone constructor — propagates derived-class tracking state.
  MyShadowNode(
      const ShadowNode& sourceShadowNode,
      const ShadowNodeFragment& fragment)
      : ConcreteViewShadowNode(sourceShadowNode, fragment) {
    const auto& source = static_cast<const MyShadowNode&>(sourceShadowNode);
    lastCacheVersion_ = source.lastCacheVersion_;
    // ... copy every other derived field that needs to survive cloning ...
  }

  uint64_t lastCacheVersion_{0};
};
```

The `static_cast` is safe because Fabric guarantees the source has the same dynamic type. The explicit constructor *overrides* the using-declaration's version for that specific signature, so Fabric's clone path picks ours up.

### What fields to propagate (and what not to)

Propagate fields that represent **state observed across commits** — version trackers, hash trackers, cached compute that survives layout. Do *not* propagate scratch buffers (e.g. position vectors that are rebuilt every correction pass) — those are intentionally re-built by the new commit's work; Fabric's state-delivery mechanism carries the *result* of the previous commit's work forward through `State` payloads, not through derived-class scratch.

Rule of thumb: anything you compare *current* to *last* belongs in propagation. Anything you re-compute from current inputs doesn't.

### How to catch this bug in your own custom ShadowNode

If you find yourself adding `lastSomething_` style fields to a `ShadowNode` subclass — fields that exist specifically to compare across commits — your next line should be the clone constructor that propagates them. Treat them as a unit.

A diagnostic that helps catch the silent failure: emit one log line per `shouldSkipCorrection` call showing `current → last` for each tracked field. If you see `last` stuck at the field's default initializer (`0` or `-1` or `{}`) on every line, you have the missing-clone-ctor bug. That's exactly the smoking gun this Riff bench produced before the fix landed.

---

# Notes on what's not yet in this handout

Blocks R1 through R7 (Riff-specific material) are covered in the slide deck at sufficient depth for now. They'll be brought into this handout when consumers signal a specific depth gap — likely candidates:

- **R2 deep-dive on each interception point.** The slide gives file:line; the handout would give *the contract each hook implements* (e.g., what `updateLayoutMetrics:` is *supposed* to do per Fabric's documentation, and what Riff overrides to change).
- **R3 four flows as sequence diagrams.** The slide gives ASCII flows; the handout would render them as proper sequence diagrams with thread lanes.
- **R4.2 lifecycle diagram with state transitions.** The slide gives ASCII; the handout would draw it as a state machine with edge conditions.

Add to this file as those needs surface.
