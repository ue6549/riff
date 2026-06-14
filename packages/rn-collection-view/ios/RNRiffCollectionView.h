#pragma once
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * RNRiffCollectionView — UICollectionView-backed rendering surface for Riff's
 * V-list UICollectionView POC.
 *
 * Not a Fabric component — this is an internal UIView owned by
 * RNCollectionViewContainerView when experimental_useUICollectionView = YES.
 *
 * Bridge bookkeeping:
 *   tagToView            tag  → Fabric UIView (in limbo or adopted by a cell)
 *   dataIndexToTag       data index → tag (parallel to positions)
 *   indexPathToAdoptedTag cell IndexPath → adopted tag
 *   tagToCell            tag → cell currently holding it
 *
 * Fabric children are mounted into limboContainer (hidden) by the owning
 * Fabric view, then adopted into UICollectionViewCells on demand by the
 * UICollectionView's data source callbacks.
 */
@interface RNRiffCollectionView : UIView <UICollectionViewDataSource, UICollectionViewDelegate>

/// Hidden UIView that holds Fabric-mounted views before adoption.
/// The owning RNCollectionViewContainerView inserts Fabric children here.
@property (nonatomic, readonly) UIView *limboContainer;

/// Last content size received from state — exposed to the layout subclass.
@property (nonatomic, readonly) CGSize cachedContentSize;

/// Flat positions array [x0,y0,w0,h0, x1,y1,w1,h1, ...]
/// Exposed to RNRiffCollectionViewLayout for attribute computation.
@property (nonatomic, readonly) NSArray<NSNumber *> *cachedPositions;

/// Called by RNCollectionViewContainerView.updateState: when new positions arrive.
- (void)updateWithPositions:(NSArray<NSNumber *> *)positions
                  childTags:(NSArray<NSNumber *> *)childTags
                contentSize:(CGSize)contentSize;

/// Force a reload — call after all Fabric children have been mounted into limbo.
- (void)reloadCells;

/// Called by RNCollectionViewContainerView.mountChildComponentView:.
- (void)adoptFabricChild:(UIView *)child tag:(int32_t)tag;

/// Called by RNCollectionViewContainerView.unmountChildComponentView:.
- (void)releaseFabricChild:(UIView *)child tag:(int32_t)tag;

@end

NS_ASSUME_NONNULL_END
