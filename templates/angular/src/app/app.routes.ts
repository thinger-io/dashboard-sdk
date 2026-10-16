import { Routes } from '@angular/router';
import { DeviceListComponent } from './device-list.component';
import { DeviceDetailComponent } from './device-detail.component';
import { Thinger } from '@thinger-io/dashboard-sdk';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    // Opened as a device dashboard: go straight to that device.
    redirectTo: () => Thinger.context.device ? `devices/${Thinger.context.device}` : 'devices',
  },
  { path: 'devices', component: DeviceListComponent },
  { path: 'devices/:id', component: DeviceDetailComponent },
  { path: '**', redirectTo: '' },
];
