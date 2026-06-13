#pragma once
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * RNRiffCell — UICollectionViewCell shell for Riff's UICollectionView POC.
 *
 * Each cell adopts exactly one Fabric-mounted UIView.  Adoption moves the
 * view from the limbo container (hidden) into this cell's contentView.
 * Release moves it back to limbo.
 *
 * prepareForReuse does NOT release the adopted view — the container
 * coordinates that via explicit releaseAdoptedView calls before reuse,
 * because the adoption mapping (tag ↔ cell) lives in the container.
 */
@interface RNRiffCell : UICollectionViewCell

@property (nonatomic, weak, readonly, nullable) UIView *adoptedView;

/// Moves view into self.contentView, sized to fill it.
- (void)adoptView:(UIView *)view;

/// Removes adoptedView from self.contentView and returns it.
/// Caller must re-parent the returned view (typically back to limbo).
- (nullable UIView *)releaseAdoptedView;

@end

NS_ASSUME_NONNULL_END
