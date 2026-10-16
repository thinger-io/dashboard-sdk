import { Component, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Thinger, type Device } from '@thinger-io/dashboard-sdk';

@Component({
  selector: 'app-device-list',
  imports: [RouterLink],
  template: `
    <h1>Devices</h1>
    @if (error()) { <p class="error">{{ error() }}</p> }
    @if (devices() === null) { <p class="muted">Loading…</p> }
    @else {
      <p class="muted">{{ devices()!.length }} devices</p>
      <ul class="list">
        @for (d of devices(); track d.device) {
          <li>
            <a [routerLink]="['/devices', d.device]">
              <span class="dot" [class.on]="d.connection?.active"></span>
              <strong>{{ d.name || d.device }}</strong>
              <span class="muted">{{ d.device }}</span>
            </a>
          </li>
        }
      </ul>
    }
  `,
})
export class DeviceListComponent implements OnInit {
  devices = signal<Device[] | null>(null);
  error = signal<string | null>(null);

  async ngOnInit() {
    try {
      this.devices.set(await Thinger.devices.list({ product: Thinger.context.product || undefined }));
    } catch (e: any) {
      this.error.set(e.message);
      this.devices.set([]);
    }
  }
}
