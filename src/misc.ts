import type { ThingerClient } from './client.js';
import { enc } from './http.js';
import type { ListQuery, Product, ProjectRef } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- API results are open */

/** Products and their API. */
export class Products {
    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    list(query?: ListQuery): Promise<Product[]> {
        return this.sdk.resources.list<Product>('product', query);
    }

    get(productId: string): Promise<Product> {
        return this.sdk.resources.get<Product>('product', productId);
    }

    /**
     * Call a resource of the product API (the functions of the product profile) with `input` as
     * its JSON body. It reaches a device only if the resource defines a `device_id_resolver`.
     */
    call<T = any>(productId: string, resource: string, input?: unknown): Promise<T> {
        return this.sdk.request<T>(
            '/v1/users/' +
                enc(this.sdk.userId()) +
                '/products/' +
                enc(productId) +
                '/resources/' +
                enc(resource),
            { method: 'POST', body: input === undefined ? null : input },
        );
    }
}

/** Endpoints: email, webhooks, notifications… */
export class Endpoints {
    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    /** Trigger an endpoint with an optional JSON payload. */
    call<T = any>(endpointId: string, payload?: unknown): Promise<T> {
        return this.sdk.request<T>(
            '/v1/users/' + enc(this.sdk.userId()) + '/endpoints/' + enc(endpointId) + '/call',
            { method: 'POST', body: payload === undefined ? {} : payload },
        );
    }
}

/** Projects the viewer can open. Not scoped to the console's current project. */
export class Projects {
    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    /** The viewer's own projects and the ones shared with them (those carry `owner`). */
    list(): Promise<ProjectRef[]> {
        return this.sdk.request<ProjectRef[]>('/v1/users/' + enc(this.sdk.userId()) + '/projects', {
            project: false,
        });
    }

    get(projectId: string): Promise<ProjectRef> {
        return this.sdk.request<ProjectRef>(
            '/v1/users/' + enc(this.sdk.userId()) + '/projects/' + enc(projectId),
            { project: false },
        );
    }
}

/** Account and traffic statistics. */
export class Stats {
    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    /** Account statistics. */
    account(): Promise<any> {
        return this.sdk.request('/v1/users/' + enc(this.sdk.userId()) + '/stats');
    }

    /** Traffic usage over the last 30 days: all devices, or one with `deviceId`. */
    usage(deviceId?: string): Promise<any> {
        if (deviceId) return this.sdk.devices.stats(deviceId);
        return this.sdk.request('/v1/users/' + enc(this.sdk.userId()) + '/info/devices/stats');
    }
}
