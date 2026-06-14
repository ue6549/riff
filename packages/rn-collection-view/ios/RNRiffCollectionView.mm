#import "RNRiffCollectionView.h"
#import "RNRiffCell.h"
#import "RNRiffCollectionViewLayout.h"
#import "RNFabricLayoutInterceptor.h"

static NSString * const kRiffCellReuseID = @"RNRiffCell";

// Tell the Fabric origin guard that this view's position is now owned by
// UICollectionView — prevents Fabric from clobbering the {0,0} cell-local origin.
static inline void setExternallyPositioned(UIView *view, BOOL value) {
  if ([view conformsToProtocol:@protocol(RNExternallyPositioned)]) {
    ((id<RNExternallyPositioned>)view).shadowNodePositioned = value;
  }
}

@implementation RNRiffCollectionView {
  UICollectionView         *_collectionView;
  RNRiffCollectionViewLayout *_layout;

  // 4 bridge maps (see header).
  NSMutableDictionary<NSNumber *, UIView *>      *_tagToView;
  NSArray<NSNumber *>                            *_dataIndexToTag;
  NSMutableDictionary<NSIndexPath *, NSNumber *> *_indexPathToAdoptedTag;
  NSMutableDictionary<NSNumber *, RNRiffCell *>  *_tagToCell;

  // Cached state received from the Fabric ShadowNode.
  NSArray<NSNumber *> *_positions;  // flat [x,y,w,h, ...]
  CGSize               _contentSize;

  // Deferred reload: positions may arrive before Fabric children are mounted.
  // We coalesce multiple adoptFabricChild: calls into one reloadData on the
  // next runloop tick so cellForItemAtIndexPath: finds populated _tagToView.
  BOOL _pendingReload;
}

@synthesize limboContainer  = _limboContainer;
@synthesize cachedPositions = _positions;
@synthesize cachedContentSize = _contentSize;

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    // Limbo container: hidden, non-interactive, sits behind the UICollectionView.
    _limboContainer = [[UIView alloc] initWithFrame:CGRectZero];
    _limboContainer.alpha = 0;
    _limboContainer.userInteractionEnabled = NO;
    _limboContainer.clipsToBounds = NO;
    [self addSubview:_limboContainer];

    // UICollectionView backed by our static layout.
    _layout = [[RNRiffCollectionViewLayout alloc] init];
    _layout.owningContainer = self;

    _collectionView = [[UICollectionView alloc] initWithFrame:CGRectZero
                                        collectionViewLayout:_layout];
    _collectionView.dataSource = self;
    _collectionView.delegate   = self;
    _collectionView.backgroundColor = [UIColor clearColor];
    [_collectionView registerClass:[RNRiffCell class] forCellWithReuseIdentifier:kRiffCellReuseID];
    [self addSubview:_collectionView];

    // Bridge maps.
    _tagToView            = [NSMutableDictionary dictionary];
    _dataIndexToTag       = @[];
    _indexPathToAdoptedTag = [NSMutableDictionary dictionary];
    _tagToCell            = [NSMutableDictionary dictionary];

    _positions   = @[];
    _contentSize = CGSizeZero;
  }
  return self;
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  _collectionView.frame = self.bounds;
  // Limbo is zero-sized but must be in the view hierarchy for Fabric to
  // call layoutSubviews on adopted views (Fabric keeps views alive via
  // the hierarchy even when they're in limbo).
  _limboContainer.frame = CGRectZero;
}

// ── State update ──────────────────────────────────────────────────────────────

- (void)updateWithPositions:(NSArray<NSNumber *> *)positions
                  childTags:(NSArray<NSNumber *> *)childTags
                contentSize:(CGSize)contentSize
{
  _positions      = positions;
  _contentSize    = contentSize;
  _dataIndexToTag = childTags;
  [_layout invalidateLayout];
  // Defer reloadData — Fabric may deliver updateState: before mountChildComponentView:
  // completes for all children. Dispatching to next runloop ensures _tagToView is
  // fully populated before cellForItemAtIndexPath: runs.
  [self _scheduleReload];
}

- (void)reloadCells
{
  [_layout invalidateLayout];
  [_collectionView reloadData];
}

- (void)_scheduleReload
{
  if (_pendingReload) return;
  _pendingReload = YES;
  __weak RNRiffCollectionView *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    RNRiffCollectionView *s = weakSelf;
    if (!s) return;
    s->_pendingReload = NO;
    [s->_layout invalidateLayout];
    [s->_collectionView reloadData];
  });
}

// ── Fabric child lifecycle ────────────────────────────────────────────────────

- (void)adoptFabricChild:(UIView *)child tag:(int32_t)tag
{
  NSNumber *key = @(tag);
  _tagToView[key] = child;
  // Schedule a coalesced reload so cells are claimed once all mounts have landed.
  // This handles the race where updateState: fires before mountChildComponentView:.
  if (_dataIndexToTag.count > 0) {
    [self _scheduleReload];
  }
}

- (void)releaseFabricChild:(UIView *)child tag:(int32_t)tag
{
  NSNumber *key = @(tag);

  // If the child is currently adopted by a cell, release it first.
  RNRiffCell *cell = _tagToCell[key];
  if (cell) {
    [cell releaseAdoptedView];
    // Remove all indexPath→tag mappings for this cell.
    NSMutableArray<NSIndexPath *> *keysToRemove = [NSMutableArray array];
    [_indexPathToAdoptedTag enumerateKeysAndObjectsUsingBlock:^(NSIndexPath *ip, NSNumber *t, BOOL *stop) {
      if ([t isEqualToNumber:key]) [keysToRemove addObject:ip];
    }];
    [_indexPathToAdoptedTag removeObjectsForKeys:keysToRemove];
    [_tagToCell removeObjectForKey:key];
  }

  setExternallyPositioned(child, NO);
  [child removeFromSuperview];
  [_tagToView removeObjectForKey:key];
}

// ── UICollectionViewDataSource ────────────────────────────────────────────────

- (NSInteger)collectionView:(UICollectionView *)collectionView
     numberOfItemsInSection:(NSInteger)section
{
  return (NSInteger)(_positions.count / 4);
}

- (UICollectionViewCell *)collectionView:(UICollectionView *)collectionView
                  cellForItemAtIndexPath:(NSIndexPath *)indexPath
{
  RNRiffCell *cell = [collectionView dequeueReusableCellWithReuseIdentifier:kRiffCellReuseID
                                                               forIndexPath:indexPath];

  // If this cell was previously holding a different Fabric view, release it back to limbo.
  if (cell.adoptedView) {
    UIView *prev = [cell releaseAdoptedView];
    if (prev) {
      NSNumber *prevKey = @(prev.tag);
      setExternallyPositioned(prev, NO);  // Fabric may reposition it in limbo
      [_limboContainer addSubview:prev];
      NSMutableArray<NSIndexPath *> *keysToRemove = [NSMutableArray array];
      [_indexPathToAdoptedTag enumerateKeysAndObjectsUsingBlock:^(NSIndexPath *ip, NSNumber *t, BOOL *stop) {
        if ([t isEqualToNumber:prevKey]) [keysToRemove addObject:ip];
      }];
      [_indexPathToAdoptedTag removeObjectsForKeys:keysToRemove];
      [_tagToCell removeObjectForKey:prevKey];
    }
  }

  // Find the Fabric view for this index.
  if ((NSUInteger)indexPath.item >= _dataIndexToTag.count) return cell;
  NSNumber *targetTag = _dataIndexToTag[indexPath.item];
  UIView *targetView  = _tagToView[targetTag];
  if (!targetView) return cell;  // Fabric hasn't mounted this child yet

  // Adopt the Fabric view into the cell.
  [cell adoptView:targetView];
  // Mark as externally positioned so the origin guard in RNFabricLayoutInterceptor
  // preserves the {0,0} cell-local origin and Fabric doesn't clobber it with
  // the content-space y-coordinate of this item.
  setExternallyPositioned(targetView, YES);
  _indexPathToAdoptedTag[indexPath] = targetTag;
  _tagToCell[targetTag] = cell;

  return cell;
}

@end
