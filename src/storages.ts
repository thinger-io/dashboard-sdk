import type { ThingerClient } from './client.js';
import { MESSAGE } from './protocol.js';
import { buildQuery, enc } from './http.js';
import type { StorageFile } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- write results and JSON files are open */

/**
 * Files in file storages. Every call carries the viewer's token, so private storages work too.
 * A plain `<img src>` to a private file goes without the token: use `url()`.
 */
export class Storages {
    /** @internal */
    constructor(private readonly sdk: ThingerClient) {}

    private file(storageId: string, path: string, version = 'v1'): string {
        const file = String(path || '')
            .replace(/^\/+/, '')
            .split('/')
            .map(enc)
            .join('/');
        return (
            '/' +
            version +
            '/users/' +
            enc(this.sdk.userId()) +
            '/storages/' +
            enc(storageId) +
            '/files/' +
            file
        );
    }

    /** Files of a storage, optionally inside `path`. */
    async list(storageId: string, path?: string): Promise<StorageFile[]> {
        return this.sdk.request<StorageFile[]>(
            '/v1/users/' +
                enc(this.sdk.userId()) +
                '/storages/' +
                enc(storageId) +
                '/files' +
                buildQuery({ path }),
        );
    }

    /**
     * File contents. `opts.as`: 'json', 'text', 'blob' or 'arrayBuffer'; by default JSON when the
     * server says so and text otherwise. Use 'blob' / 'arrayBuffer' for binary files (PDF, images…).
     */
    read(storageId: string, path: string, opts: { as: 'blob' }): Promise<Blob>;
    read(storageId: string, path: string, opts: { as: 'arrayBuffer' }): Promise<ArrayBuffer>;
    read(storageId: string, path: string, opts: { as: 'text' }): Promise<string>;
    read<T = any>(storageId: string, path: string, opts?: { as?: 'json' }): Promise<T>;
    async read(
        storageId: string,
        path: string,
        opts?: { as?: 'json' | 'text' | 'blob' | 'arrayBuffer' },
    ): Promise<unknown> {
        return this.sdk.request(this.file(storageId, path), opts && opts.as ? { as: opts.as } : {});
    }

    /**
     * A temporary `blob:` URL with the file, for `<img>`, `<video>`, `<a href>`… Revoke it with
     * `URL.revokeObjectURL(url)` when no longer needed.
     */
    async url(storageId: string, path: string): Promise<string> {
        return this.sdk.env.URL.createObjectURL(await this.read(storageId, path, { as: 'blob' }));
    }

    /** Save the file on the viewer's computer (`filename` defaults to the file's name). */
    async download(storageId: string, path: string, filename?: string): Promise<void> {
        const href = await this.url(storageId, path);
        const doc = this.sdk.env.window!.document;
        const a = doc.createElement('a');
        a.href = href;
        a.download = filename || String(path).split('/').pop() || 'download';
        doc.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => this.sdk.env.URL.revokeObjectURL(href), 60000);
    }

    /**
     * Create or overwrite a file; folders on the path are created. `data`: a string, a Blob / File
     * (e.g. from `<input type="file">`), an ArrayBuffer / typed array, or any other value, stored
     * as JSON.
     */
    async write(storageId: string, path: string, data: unknown): Promise<any> {
        let body: unknown = data;
        let type = 'application/octet-stream';
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
            type = data.type || type;
        } else if (typeof data === 'string') {
            type = 'text/plain; charset=utf-8';
        } else if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
            body = JSON.stringify(data);
            type = 'application/json';
        }
        return this.sdk.request(this.file(storageId, path, 'v2'), {
            method: 'PUT',
            body,
            headers: { 'Content-Type': type },
        });
    }

    /**
     * Open the file in a new browser tab (PDFs, images…), through the console: the sandboxed
     * frame can neither open tabs nor show the browser's PDF viewer. Call it from a click
     * handler, so the browser does not block the new tab.
     */
    async open(storageId: string, path: string): Promise<void> {
        const win = this.sdk.env.window;
        if (!this.sdk.framed()) {
            const url = await this.url(storageId, path);
            win?.open(url, '_blank');
            return;
        }
        this.sdk.post({ type: MESSAGE.OPEN_FILE, storage: storageId, path: String(path) });
    }

    /** Delete a file, or a folder with everything in it. */
    async remove(storageId: string, path: string): Promise<any> {
        return this.sdk.request(this.file(storageId, path, 'v2'), { method: 'DELETE' });
    }

    /**
     * Direct URL of a file in a PUBLIC storage, for `<img src>` or links without the SDK. Private
     * storages need `url()`.
     */
    publicUrl(storageId: string, path: string): string {
        return (this.sdk.apiBase || '') + this.file(storageId, path);
    }
}
