#import "RNRiffCollectionViewLayout.h"
#import "RNRiffCollectionView.h"

@implementation RNRiffCollectionViewLayout

- (CGSize)collectionViewContentSize
{
  return self.owningContainer ? self.owningContainer.cachedContentSize : CGSizeZero;
}

- (BOOL)shouldInvalidateLayoutForBoundsChange:(CGRect)newBounds
{
  // Static layout: cell positions are scroll-independent.
  return NO;
}

- (nullable UICollectionViewLayoutAttributes *)
    layoutAttributesForItemAtIndexPath:(NSIndexPath *)indexPath
{
  RNRiffCollectionView *container = self.owningContainer;
  if (!container) return nil;

  NSArray<NSNumber *> *positions = container.cachedPositions;
  NSInteger idx = indexPath.item;
  NSInteger base = idx * 4;
  if (base + 3 >= (NSInteger)positions.count) return nil;

  UICollectionViewLayoutAttributes *attrs =
      [UICollectionViewLayoutAttributes layoutAttributesForCellWithIndexPath:indexPath];
  attrs.frame = CGRectMake(
      positions[base].doubleValue,
      positions[base + 1].doubleValue,
      positions[base + 2].doubleValue,
      positions[base + 3].doubleValue);
  return attrs;
}

- (nullable NSArray<__kindof UICollectionViewLayoutAttributes *> *)
    layoutAttributesForElementsInRect:(CGRect)rect
{
  RNRiffCollectionView *container = self.owningContainer;
  if (!container) return @[];

  NSArray<NSNumber *> *positions = container.cachedPositions;
  NSInteger itemCount = (NSInteger)(positions.count / 4);
  NSMutableArray *result = [NSMutableArray array];

  for (NSInteger i = 0; i < itemCount; i++) {
    NSInteger base = i * 4;
    CGRect frame = CGRectMake(
        positions[base].doubleValue,
        positions[base + 1].doubleValue,
        positions[base + 2].doubleValue,
        positions[base + 3].doubleValue);
    if (CGRectIntersectsRect(frame, rect)) {
      NSIndexPath *ip = [NSIndexPath indexPathForItem:i inSection:0];
      UICollectionViewLayoutAttributes *attrs =
          [UICollectionViewLayoutAttributes layoutAttributesForCellWithIndexPath:ip];
      attrs.frame = frame;
      [result addObject:attrs];
    }
  }
  return result;
}

@end
