import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Thinger, type Device, type Property, type Unsubscribe } from '@thinger-io/dashboard-sdk';

@Component({
  selector: 'app-device-detail',
  imports: [RouterLink],
  template: `
    <a routerLink="/devices">← Devices</a>
    @if (error()) { <p class="error">{{ error() }}</p> }
    @if (device(); as d) {
      <h1><span class="dot" [class.on]="online()"></span> {{ d.name || d.device }}</h1>
      <p class="muted">{{ d.description }}</p>
      <dl>
        <dt>Id</dt><dd>{{ d.device }}</dd>
        <dt>Type</dt><dd>{{ d.type }}</dd>
        <dt>Product</dt><dd>{{ d.product || '—' }}</dd>
      </dl>
      <h2>Properties</h2>
      @for (p of properties(); track p.property) {
        <details><summary>{{ p.property }}</summary><pre>{{ json(p.value) }}</pre></details>
      } @empty { <p class="muted">No properties</p> }
      <button (click)="openInConsole(d.device)">Open in console</button>
    }
  `,
})
export class DeviceDetailComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  device = signal<Device | null>(null);
  online = signal(false);
  properties = signal<Property[]>([]);
  error = signal<string | null>(null);
  private unsubscribe?: Unsubscribe;

  ngOnInit() {
    this.route.paramMap.subscribe(params => this.load(params.get('id')!));
  }

  ngOnDestroy() {
    this.unsubscribe?.();
  }

  private async load(id: string) {
    this.unsubscribe?.();
    this.error.set(null);
    try {
      const [device, properties] = await Promise.all([
        Thinger.devices.get(id),
        Thinger.devices.listProperties(id),
      ]);
      this.device.set(device);
      this.online.set(!!device.connection?.active);
      this.properties.set(properties);
      this.unsubscribe = Thinger.devices.subscribeState(id, (event) => this.online.set(event.state === 'connected'));
    } catch (e: any) {
      this.error.set(e.message);
    }
  }

  json(v: unknown) { return JSON.stringify(v, null, 2); }

  openInConsole(id: string) { Thinger.navigate({ device: id }); }
}
