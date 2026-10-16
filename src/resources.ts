import type { ThingerClient } from './client.js';
import { ThingerError } from './errors.js';
import { appendParam, buildQuery, enc } from './http.js';
import type { ListQuery, Property, PropertyKind, PropertyQuery, ResourceKind } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- resource documents are open */

const RESOURCE_PATHS: Record<ResourceKind, string> = {
    device: 'devices',
    product: 'products',
    bucket: 'buckets',
    group: 'groups',
    type: 'types',
    project: 'projects',
    dashboard: 'dashboards',
    endpoint: 'endpoints',
    storage: 'storages',
    alarm_rule: 'alarms/rules',
};

const PROPERTY_KINDS: readonly PropertyKind[] = ['device', 'product', 'project', 'group', 'type'];

const PAGE_SIZE = 100;

function resourcePath(kind: ResourceKind): string {
    const path = RESOURCE_PATHS[kind];
    if (!path)
        throw new ThingerError('Unknown resource kind: ' + String(kind), {
            code: 'invalid-argument',
        });
    return path;
}

/** Any kind of resource, listed or read by id. */
export class Resources {
    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    /**
     * Resources of a kind, following pagination. `query` is sent as filters (`labels` as in
     * `devices.list`); `query.limit` caps how many are returned.
     */
    async list<T = any>(kind: ResourceKind, query?: ListQuery): Promise<T[]> {
        const { limit: max, labels, ...filters } = query || {};
        const limit = typeof max === 'number' ? max : Infinity;
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(filters)) appendParam(params, k, v);
        if (Array.isArray(labels)) {
            for (const k of labels) params.append('labels', String(k));
        } else if (labels && typeof labels === 'object') {
            for (const [k, v] of Object.entries(labels)) appendParam(params, 'labels.' + k, v);
        }
        const base = '/v1/users/' + enc(this.sdk.userId()) + '/' + resourcePath(kind);
        const out: T[] = [];
        // stop on an empty page rather than a short one, in case the server caps the page size
        while (out.length < limit) {
            params.set('index', String(out.length));
            params.set('count', String(Math.min(PAGE_SIZE, limit - out.length)));
            const page = await this.sdk.request<unknown>(base + '?' + params.toString());
            if (!Array.isArray(page)) return page as T[];
            if (page.length === 0) break;
            out.push(...(page as T[]));
        }
        return out;
    }

    /** One resource document. */
    get<T = any>(kind: ResourceKind, id: string): Promise<T> {
        return this.sdk.request<T>(
            '/v1/users/' + enc(this.sdk.userId()) + '/' + resourcePath(kind) + '/' + enc(id),
        );
    }
}

/**
 * Properties of devices, products, projects, groups and types. Also a place for the dashboard's
 * own settings (e.g. a project or product property).
 */
export class Properties {
    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    private base(kind: PropertyKind, id: string): string {
        if (!PROPERTY_KINDS.includes(kind)) {
            throw new ThingerError('Properties are not supported for: ' + String(kind), {
                code: 'invalid-argument',
            });
        }
        const version = kind === 'device' ? 'v3' : 'v1';
        return (
            '/' +
            version +
            '/users/' +
            enc(this.sdk.userId()) +
            '/' +
            resourcePath(kind) +
            '/' +
            enc(id) +
            '/properties'
        );
    }

    /** `query.id` accepts a pattern matching several properties ('temp*'). */
    list(kind: PropertyKind, id: string, query?: PropertyQuery): Promise<Property[]> {
        return this.sdk.request<Property[]>(this.base(kind, id) + buildQuery(query));
    }

    /** The full document `{ property, value, created, modified, … }`. */
    get<T = any>(kind: PropertyKind, id: string, propertyId: string): Promise<Property<T>> {
        return this.sdk.request<Property<T>>(this.base(kind, id) + '/' + enc(propertyId));
    }

    /** Create or update a property. */
    async set(kind: PropertyKind, id: string, propertyId: string, value: unknown): Promise<any> {
        const base = this.base(kind, id);
        try {
            return await this.sdk.request(base + '/' + enc(propertyId), {
                method: 'PUT',
                body: { value },
            });
        } catch (e) {
            if ((e as ThingerError).status !== 404) throw e;
        }
        return this.sdk.request(base, { method: 'POST', body: { property: propertyId, value } });
    }

    /** Remove a property (true also when it did not exist). */
    async delete(kind: PropertyKind, id: string, propertyId: string): Promise<boolean> {
        try {
            await this.sdk.request(this.base(kind, id) + '/' + enc(propertyId), {
                method: 'DELETE',
            });
        } catch (e) {
            if ((e as ThingerError).status !== 404) throw e;
        }
        return true;
    }
}
