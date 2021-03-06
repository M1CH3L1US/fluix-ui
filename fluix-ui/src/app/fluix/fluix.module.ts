import { NgModule } from '@angular/core';

import { FxButtonModule } from './button/button.module';
import { CardComponent } from './card/card.component';
import { FxIconModule } from './icon/icon.module';
import { FluixInputModule } from './input/input.module';
import { PopupComponent } from './popup/popup.component';

@NgModule({
  declarations: [CardComponent, PopupComponent],
  imports: [FluixInputModule, FxButtonModule, FxIconModule],
  exports: [FluixInputModule, FxButtonModule, FxIconModule],
})
export class FluixModule {}
