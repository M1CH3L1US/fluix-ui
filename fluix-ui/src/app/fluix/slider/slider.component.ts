import { FocusMonitor, FocusOrigin } from '@angular/cdk/a11y';
import { Directionality } from '@angular/cdk/bidi';
import { BooleanInput, coerceBooleanProperty, coerceNumberProperty, NumberInput } from '@angular/cdk/coercion';
import { hasModifierKey } from '@angular/cdk/keycodes';
import { normalizePassiveListenerOptions } from '@angular/cdk/platform';
import { DOCUMENT } from '@angular/common';
import {
  Attribute,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  forwardRef,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  Optional,
  Output,
  Provider,
  ViewChild,
} from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import { ANIMATION_MODULE_TYPE } from '@angular/platform-browser/animations';
import { Subscription } from 'rxjs';

import { getPointerPositionOnPage, isTouchEvent } from '../core';

export const FX_SLIDER_VALUE_ACCESSOR: Provider = {
  provide: NG_VALUE_ACCESSOR,
  useExisting: forwardRef(() => FxSliderComponent),
  multi: true,
};

export class FxSliderChange {
  source!: FxSliderComponent;
  value!: number;
}

/**
 * Visually, a 30px separation between tick marks looks best. This is very subjective but it is
 * the default separation we chose.
 */
const MIN_AUTO_TICK_SEPARATION = 30;

/** The thumb gap size for a disabled slider. */
const DISABLED_THUMB_GAP = 7;

/** The thumb gap size for a non-active slider at its minimum value. */
const MIN_VALUE_NONACTIVE_THUMB_GAP = 7;

/** The thumb gap size for an active slider at its minimum value. */
const MIN_VALUE_ACTIVE_THUMB_GAP = 10;

const activeEventOptions = normalizePassiveListenerOptions({ passive: false });

@Component({
  selector: 'fx-slider',
  exportAs: 'fxSlider',
  templateUrl: './slider.component.html',
  styleUrls: ['./slider.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(focus)': '_onFocus()',
    '(blur)': '_onBlur()',
    '(keydown)': '_onKeydown($event)',
    '(keyup)': '_onKeyup()',
    '(mouseenter)': '_onMouseenter()',

    // On Safari starting to slide temporarily triggers text selection mode which
    // show the wrong cursor. We prevent it by stopping the `selectstart` event.
    '(selectstart)': '$event.preventDefault()',
    class: 'mat-slider mat-focus-indicator',
    role: 'slider',
    '[tabIndex]': 'tabIndex',
    '[attr.aria-disabled]': 'disabled',
    '[attr.aria-valuemax]': 'max',
    '[attr.aria-valuemin]': 'min',
    '[attr.aria-valuenow]': 'value',

    // NVDA and Jaws appear to announce the `aria-valuenow` by calculating its percentage based
    // on its value between `aria-valuemin` and `aria-valuemax`. Due to how decimals are handled,
    // it can cause the slider to read out a very long value like 0.20000068 if the current value
    // is 0.2 with a min of 0 and max of 1. We work around the issue by setting `aria-valuetext`
    // to the same value that we set on the slider's thumb which will be truncated.
    '[attr.aria-valuetext]': 'valueText == null ? displayValue : valueText',
    '[attr.aria-orientation]': 'vertical ? "vertical" : "horizontal"',
    '[class.fx-slider-disabled]': 'disabled',
    '[class.fx-slider-has-ticks]': 'tickInterval',
    '[class.fx-slider-horizontal]': '!vertical',
    '[class.fx-slider-axis-inverted]': '_shouldInvertAxis()',
    // Class binding which is only used by the test harness as there is no other
    // way for the harness to detect if mouse coordinates need to be inverted.
    '[class.fx-slider-invert-mouse-coords]': '_shouldInvertMouseCoords()',
    '[class.fx-slider-sliding]': '_isSliding',
    '[class.fx-slider-thumb-label-showing]': 'thumbLabel',
    '[class.fx-slider-vertical]': 'vertical',
    '[class.fx-slider-min-value]': '_isMinValue()',
    '[class.fx-slider-hide-last-tick]':
      'disabled || _isMinValue() && _getThumbGap() && _shouldInvertAxis()',
    '[class._fx-animation-noopable]': '_animationMode === "NoopAnimations"',
  },
  providers: [FX_SLIDER_VALUE_ACCESSOR],
})
export class FxSliderComponent implements OnDestroy {
  /** Whether the slider is inverted. */
  @Input()
  get invert(): boolean {
    return this._invert;
  }
  set invert(value: boolean) {
    this._invert = coerceBooleanProperty(value);
  }
  private _invert = false;

  /** The maximum value that the slider can have. */
  @Input()
  get max(): number {
    return this._max;
  }
  set max(v: number) {
    this._max = coerceNumberProperty(v, this._max);
    this._percent = this._calculatePercentage(this._value);

    // Since this also modifies the percentage, we need to let the change detection know.
    this._changeDetectorRef.markForCheck();
  }
  private _max: number = 100;

  /** The minimum value that the slider can have. */
  @Input()
  get min(): number {
    return this._min;
  }
  set min(v: number) {
    this._min = coerceNumberProperty(v, this._min);

    // If the value wasn't explicitly set by the user, set it to the min.
    if (this._value === null) {
      this.value = this._min;
    }
    this._percent = this._calculatePercentage(this._value);

    // Since this also modifies the percentage, we need to let the change detection know.
    this._changeDetectorRef.markForCheck();
  }
  private _min: number = 0;

  /** The values at which the thumb will snap. */
  @Input()
  get step(): number {
    return this._step;
  }
  set step(v: number) {
    this._step = coerceNumberProperty(v, this._step);

    if (this._step % 1 !== 0) {
      this._roundToDecimal = this._step.toString().split('.').pop()!.length;
    }

    // Since this could modify the label, we need to notify the change detection.
    this._changeDetectorRef.markForCheck();
  }
  private _step: number = 1;

  @Input()
  public get disabled(): boolean {
    return this._disabled;
  }
  public set disabled(value: boolean) {
    this._disabled = value;
  }
  private _disabled: boolean = false;

  /** Whether or not to show the thumb label. */
  @Input()
  get thumbLabel(): boolean {
    return this._thumbLabel;
  }
  set thumbLabel(value: boolean) {
    this._thumbLabel = coerceBooleanProperty(value);
  }
  private _thumbLabel: boolean = false;

  /**
   * How often to show ticks. Relative to the step so that a tick always appears on a step.
   * Ex: Tick interval of 4 with a step of 3 will draw a tick every 4 steps (every 12 values).
   */
  @Input()
  get tickInterval() {
    return this._tickInterval;
  }
  set tickInterval(value: 'auto' | number) {
    if (value === 'auto') {
      this._tickInterval = 'auto';
    } else if (typeof value === 'number' || typeof value === 'string') {
      this._tickInterval = coerceNumberProperty(
        value,
        this._tickInterval as number
      );
    } else {
      this._tickInterval = 0;
    }
  }
  private _tickInterval: 'auto' | number = 0;

  /** Value of the slider. */
  @Input()
  get value(): number | null {
    // If the value needs to be read and it is still uninitialized, initialize it to the min.
    if (this._value === null) {
      this.value = this._min;
    }
    return this._value;
  }
  set value(v: number | null) {
    if (v !== this._value) {
      let value = coerceNumberProperty(v);

      // While incrementing by a decimal we can end up with values like 33.300000000000004.
      // Truncate it to ensure that it matches the label and to make it easier to work with.
      if (this._roundToDecimal && value !== this.min && value !== this.max) {
        value = parseFloat(value.toFixed(this._roundToDecimal));
      }

      this._value = value;
      this._percent = this._calculatePercentage(this._value);

      // Since this also modifies the percentage, we need to let the change detection know.
      this._changeDetectorRef.markForCheck();
    }
  }
  private _value: number | null = null;

  /**
   * Function that will be used to format the value before it is displayed
   * in the thumb label. Can be used to format very large number in order
   * for them to fit into the slider thumb.
   */
  @Input() displayWith!: (value: number) => string | number;

  /** Text corresponding to the slider's value. Used primarily for improved accessibility. */
  @Input() valueText!: string;

  /** Whether the slider is vertical. */
  @Input()
  get vertical(): boolean {
    return this._vertical;
  }
  set vertical(value: boolean) {
    this._vertical = coerceBooleanProperty(value);
  }
  private _vertical = false;

  /** Event emitted when the slider value has changed. */
  @Output()
  readonly change: EventEmitter<FxSliderChange> = new EventEmitter<FxSliderChange>();

  /** Event emitted when the slider thumb moves. */
  @Output()
  readonly input: EventEmitter<FxSliderChange> = new EventEmitter<FxSliderChange>();

  @Input()
  get tabIndex(): number {
    return this._tabIndex;
  }
  set tabIndex(value: number) {
    this._invert = coerceBooleanProperty(value);
  }
  private _tabIndex!: number;

  /**
   * Emits when the raw value of the slider changes. This is here primarily
   * to facilitate the two-way binding for the `value` input.
   * @docs-private
   */
  @Output() readonly valueChange: EventEmitter<
    number | null
  > = new EventEmitter<number | null>();

  /** The value to be used for display purposes. */
  get displayValue(): string | number {
    if (this.displayWith) {
      // Value is never null but since setters and getters cannot have
      // different types, the value getter is also typed to return null.
      return this.displayWith(this.value!);
    }

    // Note that this could be improved further by rounding something like 0.999 to 1 or
    // 0.899 to 0.9, however it is very performance sensitive, because it gets called on
    // every change detection cycle.
    if (this._roundToDecimal && this.value && this.value % 1 !== 0) {
      return this.value.toFixed(this._roundToDecimal);
    }

    return this.value || 0;
  }

  /** set focus to the host element */
  focus(options?: FocusOptions) {
    this._focusHostElement(options);
  }

  /** blur the host element */
  blur() {
    this._blurHostElement();
  }

  /** onTouch function registered via registerOnTouch (ControlValueAccessor). */
  onTouched: () => any = () => {};

  /** The percentage of the slider that coincides with the value. */
  get percent(): number {
    return this._clamp(this._percent);
  }
  private _percent: number = 0;

  /**
   * Whether or not the thumb is sliding.
   * Used to determine if there should be a transition for the thumb and fill track.
   */
  _isSliding: boolean = false;

  /**
   * Whether or not the slider is active (clicked or sliding).
   * Used to shrink and grow the thumb as according to the Material Design spec.
   */
  _isActive: boolean = false;

  /**
   * Whether the axis of the slider is inverted.
   * (i.e. whether moving the thumb in the positive x or y direction decreases the slider's value).
   */
  _shouldInvertAxis() {
    // Standard non-inverted mode for a vertical slider should be dragging the thumb from bottom to
    // top. However from a y-axis standpoint this is inverted.
    return this.vertical ? !this.invert : this.invert;
  }

  /** Whether the slider is at its minimum value. */
  _isMinValue() {
    return this.percent === 0;
  }

  /**
   * The amount of space to leave between the slider thumb and the track fill & track background
   * elements.
   */
  _getThumbGap() {
    if (this.disabled) {
      return DISABLED_THUMB_GAP;
    }
    if (this._isMinValue() && !this.thumbLabel) {
      return this._isActive
        ? MIN_VALUE_ACTIVE_THUMB_GAP
        : MIN_VALUE_NONACTIVE_THUMB_GAP;
    }
    return 0;
  }

  /** CSS styles for the track background element. */
  _getTrackBackgroundStyles(): { [key: string]: string } {
    const axis = this.vertical ? 'Y' : 'X';
    const scale = this.vertical
      ? `1, ${1 - this.percent}, 1`
      : `${1 - this.percent}, 1, 1`;
    const sign = this._shouldInvertMouseCoords() ? '-' : '';

    return {
      // scale3d avoids some rendering issues in Chrome. See #12071.
      transform: `translate${axis}(${sign}${this._getThumbGap()}px) scale3d(${scale})`,
    };
  }

  /** CSS styles for the track fill element. */
  _getTrackFillStyles(): { [key: string]: string } {
    const percent = this.percent;
    const axis = this.vertical ? 'Y' : 'X';
    const scale = this.vertical ? `1, ${percent}, 1` : `${percent}, 1, 1`;
    const sign = this._shouldInvertMouseCoords() ? '' : '-';

    return {
      // scale3d avoids some rendering issues in Chrome. See #12071.
      transform: `translate${axis}(${sign}${this._getThumbGap()}px) scale3d(${scale})`,
      // iOS Safari has a bug where it won't re-render elements which start of as `scale(0)` until
      // something forces a style recalculation on it. Since we'll end up with `scale(0)` when
      // the value of the slider is 0, we can easily get into this situation. We force a
      // recalculation by changing the element's `display` when it goes from 0 to any other value.
      display: percent === 0 ? 'none' : '',
    };
  }

  /** CSS styles for the ticks container element. */
  _getTicksContainerStyles(): { [key: string]: string } {
    let axis = this.vertical ? 'Y' : 'X';
    // For a horizontal slider in RTL languages we push the ticks container off the left edge
    // instead of the right edge to avoid causing a horizontal scrollbar to appear.
    let sign = !this.vertical && this._getDirection() == 'rtl' ? '' : '-';
    let offset = (this._tickIntervalPercent / 2) * 100;
    return {
      transform: `translate${axis}(${sign}${offset}%)`,
    };
  }

  /** CSS styles for the ticks element. */
  _getTicksStyles(): { [key: string]: string } {
    let tickSize = this._tickIntervalPercent * 100;
    let backgroundSize = this.vertical
      ? `2px ${tickSize}%`
      : `${tickSize}% 2px`;
    let axis = this.vertical ? 'Y' : 'X';
    // Depending on the direction we pushed the ticks container, push the ticks the opposite
    // direction to re-center them but clip off the end edge. In RTL languages we need to flip the
    // ticks 180 degrees so we're really cutting off the end edge abd not the start.
    let sign = !this.vertical && this._getDirection() == 'rtl' ? '-' : '';
    let rotate =
      !this.vertical && this._getDirection() == 'rtl' ? ' rotate(180deg)' : '';
    let styles: { [key: string]: string } = {
      backgroundSize: backgroundSize,
      // Without translateZ ticks sometimes jitter as the slider moves on Chrome & Firefox.
      transform: `translateZ(0) translate${axis}(${sign}${
        tickSize / 2
      }%)${rotate}`,
    };

    if (this._isMinValue() && this._getThumbGap()) {
      const shouldInvertAxis = this._shouldInvertAxis();
      let side: string;

      if (this.vertical) {
        side = shouldInvertAxis ? 'Bottom' : 'Top';
      } else {
        side = shouldInvertAxis ? 'Right' : 'Left';
      }

      styles[`padding${side}`] = `${this._getThumbGap()}px`;
    }

    return styles;
  }

  _getThumbContainerStyles(): { [key: string]: string } {
    const shouldInvertAxis = this._shouldInvertAxis();
    let axis = this.vertical ? 'Y' : 'X';
    // For a horizontal slider in RTL languages we push the thumb container off the left edge
    // instead of the right edge to avoid causing a horizontal scrollbar to appear.
    let invertOffset =
      this._getDirection() == 'rtl' && !this.vertical
        ? !shouldInvertAxis
        : shouldInvertAxis;
    let offset = (invertOffset ? this.percent : 1 - this.percent) * 100;
    return {
      transform: `translate${axis}(-${offset}%)`,
    };
  }

  /** The size of a tick interval as a percentage of the size of the track. */
  private _tickIntervalPercent: number = 0;

  /** The dimensions of the slider. */
  private _sliderDimensions: ClientRect | null = null;

  private _controlValueAccessorChangeFn: (value: any) => void = () => {};

  /** Decimal places to round to, based on the step amount. */
  private _roundToDecimal!: number;

  /** Subscription to the Directionality change EventEmitter. */
  private _dirChangeSubscription = Subscription.EMPTY;

  /** The value of the slider when the slide start event fires. */
  private _valueOnSlideStart!: number | null;

  /** Reference to the inner slider wrapper element. */
  @ViewChild('sliderWrapper') private _sliderWrapper!: ElementRef;

  /**
   * Whether mouse events should be converted to a slider position by calculating their distance
   * from the right or bottom edge of the slider as opposed to the top or left.
   */
  _shouldInvertMouseCoords() {
    const shouldInvertAxis = this._shouldInvertAxis();
    return this._getDirection() == 'rtl' && !this.vertical
      ? !shouldInvertAxis
      : shouldInvertAxis;
  }

  /** The language direction for this slider element. */
  private _getDirection() {
    return this._dir && this._dir.value == 'rtl' ? 'rtl' : 'ltr';
  }

  /** Keeps track of the last pointer event that was captured by the slider. */
  private _lastPointerEvent!: MouseEvent | TouchEvent | null;

  constructor(
    private readonly _elementRef: ElementRef,
    private _focusMonitor: FocusMonitor,
    private _changeDetectorRef: ChangeDetectorRef,
    @Optional() private _dir: Directionality,
    @Attribute('tabindex') tabIndex: string,
    private _ngZone: NgZone,
    @Inject(DOCUMENT) private readonly _document: any,
    @Optional() @Inject(ANIMATION_MODULE_TYPE) public _animationMode?: string
  ) {
    this.tabIndex = parseInt(tabIndex) || 0;

    _ngZone.runOutsideAngular(() => {
      const element = _elementRef.nativeElement;
      element.addEventListener(
        'mousedown',
        this._pointerDown,
        activeEventOptions
      );
      element.addEventListener(
        'touchstart',
        this._pointerDown,
        activeEventOptions
      );
    });
  }

  ngAfterViewInit() {
    this._focusMonitor
      .monitor(this._elementRef, true)
      .subscribe((origin: FocusOrigin) => {
        this._isActive = !!origin && origin !== 'keyboard';
        this._changeDetectorRef.detectChanges();
      });
    if (this._dir) {
      this._dirChangeSubscription = this._dir.change.subscribe(() => {
        this._changeDetectorRef.markForCheck();
      });
    }
  }

  ngOnDestroy() {
    const element = this._elementRef.nativeElement;
    element.removeEventListener(
      'mousedown',
      this._pointerDown,
      activeEventOptions
    );
    element.removeEventListener(
      'touchstart',
      this._pointerDown,
      activeEventOptions
    );
    this._lastPointerEvent = null;
    this._removeGlobalEvents();
    this._focusMonitor.stopMonitoring(this._elementRef);
    this._dirChangeSubscription.unsubscribe();
  }

  _onMouseenter() {
    if (this.disabled) {
      return;
    }

    // We save the dimensions of the slider here so we can use them to update the spacing of the
    // ticks and determine where on the slider click and slide events happen.
    this._sliderDimensions = this._getSliderDimensions();
    this._updateTickIntervalPercent();
  }

  _onFocus() {
    // We save the dimensions of the slider here so we can use them to update the spacing of the
    // ticks and determine where on the slider click and slide events happen.
    this._sliderDimensions = this._getSliderDimensions();
    this._updateTickIntervalPercent();
  }

  _onBlur() {
    this.onTouched();
  }

  _onKeydown(event: KeyboardEvent) {
    if (this.disabled || hasModifierKey(event)) {
      return;
    }

    const oldValue = this.value;

    switch (event.code) {
      case 'PageUp':
        this._increment(10);
        break;
      case 'PageDown':
        this._increment(-10);
        break;
      case 'End':
        this.value = this.max;
        break;
      case 'Home':
        this.value = this.min;
        break;
      case 'ArrowLeft':
        // NOTE: For a sighted user it would make more sense that when they press an arrow key on an
        // inverted slider the thumb moves in that direction. However for a blind user, nothing
        // about the slider indicates that it is inverted. They will expect left to be decrement,
        // regardless of how it appears on the screen. For speakers ofRTL languages, they probably
        // expect left to mean increment. Therefore we flip the meaning of the side arrow keys for
        // RTL. For inverted sliders we prefer a good a11y experience to having it "look right" for
        // sighted users, therefore we do not swap the meaning.
        this._increment(this._getDirection() == 'rtl' ? 1 : -1);
        break;
      case 'ArrowUp':
        this._increment(1);
        break;
      case 'ArrowRight':
        // See comment on LEFT_ARROW about the conditions under which we flip the meaning.
        this._increment(this._getDirection() == 'rtl' ? -1 : 1);
        break;
      case 'ArrowDown':
        this._increment(-1);
        break;
      default:
        // Return if the key is not one that we explicitly handle to avoid calling preventDefault on
        // it.
        return;
    }

    if (oldValue != this.value) {
      this._emitInputEvent();
      this._emitChangeEvent();
    }

    this._isSliding = true;
    event.preventDefault();
  }

  _onKeyup() {
    this._isSliding = false;
  }

  /** Called when the user has put their pointer down on the slider. */
  private _pointerDown = (event: TouchEvent | MouseEvent) => {
    // Don't do anything if the slider is disabled or the
    // user is using anything other than the main mouse button.
    if (
      this.disabled ||
      this._isSliding ||
      (!isTouchEvent(event) && event.button !== 0)
    ) {
      return;
    }

    this._ngZone.run(() => {
      const oldValue = this.value;
      const pointerPosition = getPointerPositionOnPage(event);
      this._isSliding = true;
      this._lastPointerEvent = event;
      event.preventDefault();
      this._focusHostElement();
      this._onMouseenter(); // Simulate mouseenter in case this is a mobile device.
      this._bindGlobalEvents(event);
      this._focusHostElement();
      this._updateValueFromPosition(pointerPosition);
      this._valueOnSlideStart = oldValue;

      // Emit a change and input event if the value changed.
      if (oldValue != this.value) {
        this._emitInputEvent();
      }
    });
  };

  /**
   * Called when the user has moved their pointer after
   * starting to drag. Bound on the document level.
   */
  private _pointerMove = (event: TouchEvent | MouseEvent) => {
    if (this._isSliding) {
      // Prevent the slide from selecting anything else.
      event.preventDefault();
      const oldValue = this.value;
      this._lastPointerEvent = event;
      this._updateValueFromPosition(getPointerPositionOnPage(event));

      // Native range elements always emit `input` events when the value changed while sliding.
      if (oldValue != this.value) {
        this._emitInputEvent();
      }
    }
  };

  /** Called when the user has lifted their pointer. Bound on the document level. */
  private _pointerUp = (event: TouchEvent | MouseEvent) => {
    if (this._isSliding) {
      event.preventDefault();
      this._removeGlobalEvents();
      this._isSliding = false;

      if (this._valueOnSlideStart != this.value && !this.disabled) {
        this._emitChangeEvent();
      }

      this._valueOnSlideStart = this._lastPointerEvent = null;
    }
  };

  /** Called when the window has lost focus. */
  private _windowBlur = () => {
    // If the window is blurred while dragging we need to stop dragging because the
    // browser won't dispatch the `mouseup` and `touchend` events anymore.
    if (this._lastPointerEvent) {
      this._pointerUp(this._lastPointerEvent);
    }
  };

  /** Use defaultView of injected document if available or fallback to global window reference */
  private _getWindow(): Window {
    return this._document.defaultView || window;
  }

  /**
   * Binds our global move and end events. They're bound at the document level and only while
   * dragging so that the user doesn't have to keep their pointer exactly over the slider
   * as they're swiping across the screen.
   */
  private _bindGlobalEvents(triggerEvent: TouchEvent | MouseEvent) {
    // Note that we bind the events to the `document`, because it allows us to capture
    // drag cancel events where the user's pointer is outside the browser window.
    const document = this._document;
    const isTouch = isTouchEvent(triggerEvent);
    const moveEventName = isTouch ? 'touchmove' : 'mousemove';
    const endEventName = isTouch ? 'touchend' : 'mouseup';
    document.addEventListener(
      moveEventName,
      this._pointerMove,
      activeEventOptions
    );
    document.addEventListener(
      endEventName,
      this._pointerUp,
      activeEventOptions
    );

    if (isTouch) {
      document.addEventListener(
        'touchcancel',
        this._pointerUp,
        activeEventOptions
      );
    }

    const window = this._getWindow();

    if (typeof window !== 'undefined' && window) {
      window.addEventListener('blur', this._windowBlur);
    }
  }

  /** Removes any global event listeners that we may have added. */
  private _removeGlobalEvents() {
    const document = this._document;
    document.removeEventListener(
      'mousemove',
      this._pointerMove,
      activeEventOptions
    );
    document.removeEventListener(
      'mouseup',
      this._pointerUp,
      activeEventOptions
    );
    document.removeEventListener(
      'touchmove',
      this._pointerMove,
      activeEventOptions
    );
    document.removeEventListener(
      'touchend',
      this._pointerUp,
      activeEventOptions
    );
    document.removeEventListener(
      'touchcancel',
      this._pointerUp,
      activeEventOptions
    );

    const window = this._getWindow();

    if (typeof window !== 'undefined' && window) {
      window.removeEventListener('blur', this._windowBlur);
    }
  }

  /** Increments the slider by the given number of steps (negative number decrements). */
  private _increment(numSteps: number) {
    this.value = this._clamp(
      (this.value || 0) + this.step * numSteps,
      this.min,
      this.max
    );
  }

  /** Calculate the new value from the new physical location. The value will always be snapped. */
  private _updateValueFromPosition(pos: { x: number; y: number }) {
    if (!this._sliderDimensions) {
      return;
    }

    let offset = this.vertical
      ? this._sliderDimensions.top
      : this._sliderDimensions.left;
    let size = this.vertical
      ? this._sliderDimensions.height
      : this._sliderDimensions.width;
    let posComponent = this.vertical ? pos.y : pos.x;

    // The exact value is calculated from the event and used to find the closest snap value.
    let percent = this._clamp((posComponent - offset) / size);

    if (this._shouldInvertMouseCoords()) {
      percent = 1 - percent;
    }

    // Since the steps may not divide cleanly into the max value, if the user
    // slid to 0 or 100 percent, we jump to the min/max value. This approach
    // is slightly more intuitive than using `Math.ceil` below, because it
    // follows the user's pointer closer.
    if (percent === 0) {
      this.value = this.min;
    } else if (percent === 1) {
      this.value = this.max;
    } else {
      const exactValue = this._calculateValue(percent);

      // This calculation finds the closest step by finding the closest
      // whole number divisible by the step relative to the min.
      const closestValue =
        Math.round((exactValue - this.min) / this.step) * this.step + this.min;

      // The value needs to snap to the min and max.
      this.value = this._clamp(closestValue, this.min, this.max);
    }
  }

  /** Emits a change event if the current value is different from the last emitted value. */
  private _emitChangeEvent() {
    this._controlValueAccessorChangeFn(this.value);
    this.valueChange.emit(this.value);
    this.change.emit(this._createChangeEvent());
  }

  /** Emits an input event when the current value is different from the last emitted value. */
  private _emitInputEvent() {
    this.input.emit(this._createChangeEvent());
  }

  /** Updates the amount of space between ticks as a percentage of the width of the slider. */
  private _updateTickIntervalPercent() {
    if (!this.tickInterval || !this._sliderDimensions) {
      return;
    }

    if (this.tickInterval == 'auto') {
      let trackSize = this.vertical
        ? this._sliderDimensions.height
        : this._sliderDimensions.width;
      let pixelsPerStep = (trackSize * this.step) / (this.max - this.min);
      let stepsPerTick = Math.ceil(MIN_AUTO_TICK_SEPARATION / pixelsPerStep);
      let pixelsPerTick = stepsPerTick * this.step;
      this._tickIntervalPercent = pixelsPerTick / trackSize;
    } else {
      this._tickIntervalPercent =
        (this.tickInterval * this.step) / (this.max - this.min);
    }
  }

  /** Creates a slider change object from the specified value. */
  private _createChangeEvent(value = this.value): FxSliderChange {
    let event = new FxSliderChange();

    event.source = this;
    event.value = value as number;

    return event;
  }

  /** Calculates the percentage of the slider that a value is. */
  private _calculatePercentage(value: number | null) {
    return ((value || 0) - this.min) / (this.max - this.min);
  }

  /** Calculates the value a percentage of the slider corresponds to. */
  private _calculateValue(percentage: number) {
    return this.min + percentage * (this.max - this.min);
  }

  /** Return a number between two numbers. */
  private _clamp(value: number, min = 0, max = 1) {
    return Math.max(min, Math.min(value, max));
  }

  /**
   * Get the bounding client rect of the slider track element.
   * The track is used rather than the native element to ignore the extra space that the thumb can
   * take up.
   */
  private _getSliderDimensions() {
    return this._sliderWrapper
      ? this._sliderWrapper.nativeElement.getBoundingClientRect()
      : null;
  }

  /**
   * Focuses the native element.
   * Currently only used to allow a blur event to fire but will be used with keyboard input later.
   */
  private _focusHostElement(options?: FocusOptions) {
    this._elementRef.nativeElement.focus(options);
  }

  /** Blurs the native element. */
  private _blurHostElement() {
    this._elementRef.nativeElement.blur();
  }

  /**
   * Sets the model value. Implemented as part of ControlValueAccessor.
   * @param value
   */
  writeValue(value: any) {
    this.value = value;
  }

  /**
   * Registers a callback to be triggered when the value has changed.
   * Implemented as part of ControlValueAccessor.
   * @param fn Callback to be registered.
   */
  registerOnChange(fn: (value: any) => void) {
    this._controlValueAccessorChangeFn = fn;
  }

  /**
   * Registers a callback to be triggered when the component is touched.
   * Implemented as part of ControlValueAccessor.
   * @param fn Callback to be registered.
   */
  registerOnTouched(fn: any) {
    this.onTouched = fn;
  }

  /**
   * Sets whether the component should be disabled.
   * Implemented as part of ControlValueAccessor.
   * @param isDisabled
   */
  setDisabledState(isDisabled: boolean) {
    this.disabled = isDisabled;
  }

  static ngAcceptInputType_invert: BooleanInput;
  static ngAcceptInputType_max: NumberInput;
  static ngAcceptInputType_min: NumberInput;
  static ngAcceptInputType_step: NumberInput;
  static ngAcceptInputType_thumbLabel: BooleanInput;
  static ngAcceptInputType_tickInterval: NumberInput;
  static ngAcceptInputType_value: NumberInput;
  static ngAcceptInputType_vertical: BooleanInput;
  static ngAcceptInputType_disabled: BooleanInput;
  static ngAcceptInputType_tabIndex: NumberInput;
}
