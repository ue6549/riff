#pragma once

#import <React/RCTBridgeModule.h>

/**
 * Objective-C bridge header.
 * The actual implementation is in CollectionViewModule.mm (ObjC++)
 * which wires the C++ module to the RN New Arch TurboModule registry.
 */
@interface RNCollectionViewModule : NSObject <RCTBridgeModule>
@end
