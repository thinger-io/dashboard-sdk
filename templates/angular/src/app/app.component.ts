import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { Thinger } from '@thinger-io/dashboard-sdk';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <header>
      <a routerLink="/devices">Fleet</a>
      @if (project) { <span class="muted">{{ project }}</span> }
    </header>
    <main><router-outlet /></main>
  `,
})
export class AppComponent {
  project = Thinger.context.project || Thinger.project?.name || null;
}
