  ---                                                                                                                                                                                            
  Complete Lifecycle Trace                                                                                                                                                                       
                                                                                                                                                                                                 
  On Load                                                                                                                                                                                        
                                                                                                                                                                                                 
  1. onContainerLayout fires → setViewportWidth/Height → eager initial range from stride estimates → setRenderRange + setContentHeight (estimated values)                                        
  2. React renders initial cells                                                                                                                                                                 
  3. Fabric commit → Yoga measures all children → ShadowNode correctChildPositionsIfNeeded:                                                                                                      
    - Compares Yoga size vs cache (0.5pt threshold) → builds deltas                                                                                                                              
    - beginBatch → engine->applyMeasurements → endBatch → 1 version bump                                                                                                                         
    - updateStateIfNeeded → sends positions + contentSize to native view                                                                                                                         
  4. rAF useEffect (line 1562, deps: [layoutContext, extraData]) → detects version bump → setLayoutCacheVersion(v+1) → re-render                                                                 
  5. useLayoutEffect (deps include layoutCacheVersion) → scrollHandledCVRef is false → runs full processScroll → updates contentHeight + renderRange with real measurements                      
  6. 100ms timer (line 1747, deps: []) → one-shot safety net, fires once → catches any missed version bump from initial Fabric commit                                                            
                                                                                                                                                                                                 
  Verdict: Load path is clean. Each step serves a purpose. The rAF + 100ms timer are both needed to bridge the gap between native Fabric commit and JS state.                                    
                                                                                                                                                                                                 
  ---                                                                                                                                                                                            
  On V Scroll Tick                                                                                                                                                                               
                                                                                                                                                                                                 
  1. Native onScroll fires → JS scroll handler (line 1969)                                                                                                                                       
  2. processScroll (C++ JSI, single call) → reads latest cache, spatial query → returns render/visible ranges + frame data + cacheVersion                                                        
  3. State updates in scroll handler (all batched by React into 1 render):                                                                                                                       
    - If cacheVersion changed: scrollHandledCVRef = true, setLayoutCacheVersion(v+1)                                                                                                             
    - If renderRange changed: setRenderRange(budgetedR)                                                                                                                                          
    - If measureRange changed: setMeasureRange(newMR)                                                                                                                                            
  4. React renders → mounts/unmounts cells                                                                                                                                                       
  5. Fabric commit → ShadowNode layout():                                                                                                                                                        
    - correctChildPositionsIfNeeded() → Yoga deltas → beginBatch → applyMeasurements → endBatch                                                                                                  
    - updateStateIfNeeded() → native view applies positions                                                                                                                                      
  6. useLayoutEffect fires (layoutCacheVersion dep changed):                                                                                                                                     
    - H-6 guard: scrollHandledCVRef.current === true → skips processScroll → only syncs contentHeight if changed → returns early                                                                 
                                                                                                                                                                                                 
  Key insight: Steps 3's state updates are in the same event handler → React batches them into 1 render. The useLayoutEffect (step 6) fires in the commit phase of that render, and H-6 guard    
  prevents a second render (unless contentHeight actually changed, which leCH showed is rare).                                                                                                   
                                                                                                                                                                                                 
  ---                                                                                                                                                                                            
  On H Scroll Tick                                                                                                                                                                           
                  
  1. Native onHScroll → handleHSubScroll → handleHScroll (line 2175)
  2. processHScroll (C++ JSI) → H-4 stable-band check:                                                                                                                                           
    - If range + cacheVersion match previous: returns {unchanged: true} → return early (>80% of ticks)                                                                                           
    - Otherwise: returns new range + frame data                                                                                                                                                  
  3. Updates hRenderRangesRef (ref, not state)                                                                                                                                                   
  4. If range changed: H-5 rAF coalesce → requestAnimationFrame(() => setHRangeVersion(v+1))                                                                                                     
    - Multiple H sections scrolling per frame → single setHRangeVersion bump                                                                                                                     
  5. React re-render → H cells excluded/included based on hExcludeIndices                                                                                                                        
                                                                                                                                                                                                 
  ---                                                                                                                                                                                            
  On Each Fabric Commit (Background Thread)                                                                                                                                                      
                                                                                                                                                                                                 
  Main container (CollectionViewContainerShadowNode):                                                                                                                                        
  1. layout() called → no short-circuit (always runs full pipeline)                                                                                                                              
  2. Phase 0: RTTI pass — classify each child (MeasuredCell, SubContainer, etc.)                                                                                                                 
  3. Phase 1: Bulk cache read (getFramesForKeys)                                                                                                                                                 
  4. Phase 2: Compare Yoga-measured sizes vs cache, build deltas (0.5pt threshold)                                                                                                               
  5. Phase 3: If deltas → beginBatch → applyMeasurements → endBatch (1 version bump)                                                                                                             
  6. Phase 4: Read content size                                                                                                                                                                  
  7. updateStateIfNeeded() → if positions/contentSize/tags changed → setStateData                                                                                                                
                                                                                                                                                                                                 
  Sub-container (CollectionSubContainerShadowNode):                                                                                                                                              
  1. layout() called                                                                                                                                                                             
  2. H-4b guard: shouldSkipCorrection() — checks cache version + child count + child tag hash → if all match, skip entirely                                                                      
  3. Same 5-phase pipeline as main container (but with section-local Y shift)                                                                                                                    
  4. updateStateIfNeeded() → if children/contentSize changed → setStateData                                                                                                                      
                                                                                                                                                                                                 
  ---                                                                                                                                                                                            
  Issues and Risks                                                                                                                                                                               
                                                                                                                                                                                                 
  1. Main container has NO short-circuit guard                                                                                                                                                   
                                                                                                                                                                                                 
  The sub-container has H-4b (shouldSkipCorrection), but the main container always runs the full correctChildPositionsIfNeeded() — Phase 0 RTTI pass + Phase 1 bulk read + Phase 2 delta         
  comparison + Phase 3 apply + Phase 4 content size — on every Fabric commit. With 30-50 children, this is O(N) work per frame on the background thread.                                         
                                                                                                                                                                                                 
  Should we add a similar guard? Yes, conceptually. But it's harder for the main container because:                                                                                              
  - Children change more frequently (cells mount/unmount during scroll)                                                                                                                          
  - The main container doesn't have the "stable children" pattern that sub-containers have during H scroll                                                                                       
                                                                                                                                                                                                 
  A guard would help during idle (no scroll, no data change) and during inertial decel (range is stable, same children). Worth adding.                                                           
                                                                                                                                                                                                 
  2. Why vLCV is 2-15/sec even on repeat scroll                                                                                                                                                  
                                                                                                                                                                                                 
  Batching (N bumps → 1) is correct but doesn't eliminate the bump. If there's even ONE delta in a Fabric commit, the batch produces 1 version bump. During scroll through already-measured      
  content, deltas should be zero. The fact that vLCV is 2-15/sec suggests:                                                                                                                       
                                                                                                                                                                                                 
  Possible causes:                                                                                                                                                                               
  - H sub-containers being recycled → their cells get re-measured on re-entry                                                                                                                
  - Compositional layout sections with variable content → text wrapping produces slightly different heights on different layout passes                                                           
  - Sub-pixel Yoga measurement drift — float arithmetic with different parent bounds                                                                                                             
                                                                                                                                                                                                 
  This needs investigation. If we can eliminate spurious deltas, vLCV drops to ~0 during steady-state scroll → renders drop to vRR only.                                                         
                                                                                                                                                                                                 
  3. H-6 guard is correct but has a subtle timing assumption                                                                                                                                     
                                                                                                                                                                                                 
  The guard assumes scrollHandledCVRef.current = true is set and read within the same React render cycle. This works because:                                                                    
  - Scroll handler sets the flag synchronously                                                                                                                                                   
  - setLayoutCacheVersion(v+1) triggers a re-render                                                                                                                                              
  - React runs the component body (reads the flag) in the same microtask                                                                                                                         
  - useLayoutEffect fires in the commit phase of that same render                                                                                                                                
                                                                                                                                                                                                 
  If React ever defers the render (concurrent mode), the flag could be stale. For now, this is safe because RN's scroll events run in legacy sync mode.                                          
                                                                                                                                                                                                 
  4. H-cell LCV memo invalidation may be outdated                                                                                                                                                
                                                                                                                                                                                                 
  Line 3008: (!slotIsHCell || prev.lcv === layoutCacheVersion) — invalidates ALL H cells on every LCV bump. The comment says "positions are set via CSS style (not ShadowNode)." But with H-2,   
  the sub-container ShadowNode handles positioning natively. This LCV check might be unnecessary now, causing needless H cell re-renders.                                                        
                                                                                                                                                                                                 
  Worth investigating: remove the LCV check for H cells and verify H cell positions still update correctly. If they do (via ShadowNode), removing it eliminates hCellCount × vLCV_bumps wasted   
  re-renders per second.                                                                                                                                                                         
                                                                                                                                                                                                 
  5. setContentHeight is called unconditionally in the non-scroll useLayoutEffect path                                                                                                           
                                                                                                                                                                                                 
  Line 1649: setContentHeight(layoutContentHeight) — always called, even if value is same. React does an eager bailout for same-value setState, so this shouldn't cause extra renders. But it's  
  sloppy — worth guarding like the H-6 path does (line 1633: if (layoutContentHeight !== contentHeightRef.current)).                                                                             
                                                                                                                                                                                                 
  6. The batch mode thread safety is adequate but not ideal                                                                                                                                      
                                                                                                                                                                                                 
  beginBatch/endBatch each acquire the mutex independently. Between them, _batchDepth persists as a member field. A concurrent thread calling setAttributes between beginBatch and endBatch would
   see _batchDepth > 0 and defer its version bump to some other thread's endBatch. In practice this is safe because:                                                                             
  - ShadowNode layout runs on a single Fabric background thread                                                                                                                                  
  - JS thread calls are serialized by the JS runtime                                                                                                                                             
  - The two threads don't overlap on the same batch window                                                                                                                                       
                                                                                                                                                                                                 
  ---                                                                                                                                                                                            
  Summary Assessment                                                                                                                                                                             
                                                                                                                                                                                                 
  ┌───────────────────────────┬──────────┬───────────────────────────────────┬────────────────────────────────────────────────────┐                                                              
  │       Optimization        │ Correct? │               Risk                │                   Recommendation                   │                                                              
  ├───────────────────────────┼──────────┼───────────────────────────────────┼────────────────────────────────────────────────────┤                                                              
  │ C++ batch mode            │ Yes      │ Low (thread-safe in practice)     │ Keep — this is the right fix for N→1 version bumps │                                                              
  ├───────────────────────────┼──────────┼───────────────────────────────────┼────────────────────────────────────────────────────┤                                                              
  │ H-6 useLayoutEffect guard │ Yes      │ Low (timing is safe in sync mode) │ Keep — prevents redundant processScroll            │                                                              
  ├───────────────────────────┼──────────┼───────────────────────────────────┼────────────────────────────────────────────────────┤                                                              
  │ H-4 stable-band skip      │ Yes      │ None                              │ Keep — well-guarded, >80% hit rate                 │                                                              
  ├───────────────────────────┼──────────┼───────────────────────────────────┼────────────────────────────────────────────────────┤                                                              
  │ H-4b ShadowNode skip      │ Yes      │ Low                               │ Keep — correct hash-based guard                    │                                                              
  ├───────────────────────────┼──────────┼───────────────────────────────────┼────────────────────────────────────────────────────┤                                                              
  │ H-5 rAF coalesce          │ Yes      │ Very low (1-frame delay)          │ Keep — correct batching of H re-renders            │                                                              
  ├───────────────────────────┼──────────┼───────────────────────────────────┼────────────────────────────────────────────────────┤                                                              
  │ H-cell LCV memo           │ Suspect  │ Medium                            │ Investigate removing — may be pre-H-2 artifact     │                                                              
  ├───────────────────────────┼──────────┼───────────────────────────────────┼────────────────────────────────────────────────────┤                                                              
  │ Main container no guard   │ Gap      │ Medium perf impact                │ Consider adding cache-version + child-tag guard    │                                                              
  └───────────────────────────┴──────────┴───────────────────────────────────┴────────────────────────────────────────────────────┘                                                              
                                                                                                                                                                                                 
  The architecture is sound. The remaining perf question is: why do Yoga deltas appear on repeat scroll? That's the root cause of persistent vLCV bumps. Everything else is correctly guarding   
  against the effects of those bumps.                                                                                                                                                            

