#pragma once
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@class RNRiffCollectionView;

/**
 * RNRiffCollectionViewLayout — reads pre-computed positions from the owning
 * RNRiffCollectionView and serves them to UICollectionView as
 * UICollectionViewLayoutAttributes.
 *
 * All positioning is static: scroll does not change cell frames, so
 * shouldInvalidateLayoutForBoundsChange: returns NO.  The layout is
 * invalidated explicitly whenever updateWithPositions:... is called.
 */
@interface RNRiffCollectionViewLayout : UICollectionViewLayout

/// Weak reference to the owning container, which holds the positions array.
@property (nonatomic, weak, nullable) RNRiffCollectionView *owningContainer;

@end

NS_ASSUME_NONNULL_END
