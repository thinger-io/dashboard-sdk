import { ApplicationConfig, provideAppInitializer, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';

import { routes } from './app.routes';
import { Thinger } from '@thinger-io/dashboard-sdk';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    // Hash routing: the storage only serves real files, so deep paths would 404 on reload.
    provideRouter(routes, withHashLocation()),
    // Wait for the console handshake (token + context) before rendering anything.
    provideAppInitializer(() => Thinger.ready()),
  ],
};
