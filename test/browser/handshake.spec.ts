import { expect, test, type Frame, type Page } from '@playwright/test';
import pkg from '../../package.json' with { type: 'json' };

async function appResult(frame: Frame) {
    await expect(frame.locator('body[data-result]')).toHaveCount(1);
    return JSON.parse((await frame.locator('body').getAttribute('data-result'))!);
}

async function appFrame(page: Page): Promise<Frame> {
    await expect.poll(() => page.frames().length).toBe(2);
    return page.frames()[1]!;
}

for (const app of ['app-esm.html', 'app-iife.html']) {
    test(`handshake with the console, sandboxed frame (${app})`, async ({ page, request }) => {
        await page.goto('/console.html?app=/' + app);
        const frame = await appFrame(page);
        const result = await appResult(frame);

        expect(result.error).toBeUndefined();
        expect(result.user).toEqual({ id: 'alice' });
        expect(result.project).toEqual({ id: 'p1', name: 'Plant' });
        expect(result.context).toEqual({ device: 'd1', project: 'p1' });
        expect(result.version).toBe(pkg.version);
        expect(result.serverVersion).toBe('7.5.0');
        expect(result.supportsList).toBe(true);
        expect(result.devices).toEqual([{ device: 'd1' }, { device: 'd2' }]);

        const received = await page.evaluate(() => (window as any).received);
        expect(received[0]).toEqual({ type: 'thinger:ready', sdk: pkg.version });
        expect(received.filter((m: any) => m.type === 'thinger:refresh-token')).toHaveLength(1);

        // the first device list got 401 with T1, then the retry carried T2; both scoped to p1
        const { T1, T2 } = await (await request.get('/test/tokens')).json();
        const calls = (await (await request.get('/test/calls')).json()) as Array<{
            path: string;
            auth: string;
        }>;
        const lists = calls.filter((c) => c.path.startsWith('/v1/users/alice/devices?')).slice(-3);
        expect(lists.map((c) => c.auth)).toEqual(['Bearer ' + T1, 'Bearer ' + T2, 'Bearer ' + T2]);
        expect(lists.every((c) => c.path.includes('project=p1'))).toBe(true);
        expect(calls.find((c) => c.path === '/v1/server/version')!.auth).toBeNull();
    });
}

test('route both ways between the app and the console', async ({ page }) => {
    await page.goto('/console.html?app=/app-esm.html');
    const frame = await appFrame(page);
    await appResult(frame);

    await frame.evaluate(() => history.pushState(null, '', '#/devices/d1'));
    await expect
        .poll(() =>
            page.evaluate(() =>
                (window as any).received.filter((m: any) => m.type === 'thinger:location').at(-1),
            ),
        )
        .toEqual({ type: 'thinger:location', path: '/devices/d1' });

    await page.evaluate(() => (window as any).route('/alarms'));
    await expect.poll(() => frame.evaluate(() => location.hash)).toBe('#/alarms');
});

test('forwards the app errors to the console', async ({ page }) => {
    await page.goto('/console.html?app=/app-esm.html');
    const frame = await appFrame(page);
    await appResult(frame);
    await frame.evaluate(() => console.error('broken widget'));
    await expect
        .poll(() =>
            page.evaluate(() =>
                (window as any).received
                    .filter((m: any) => m.type === 'thinger:error')
                    .map((m: any) => m.message),
            ),
        )
        .toContain('broken widget');
});

test('standalone link with thinger_api, top level', async ({ page, baseURL, request }) => {
    const { T2 } = await (await request.get('/test/tokens')).json();
    await page.goto(
        '/app-esm.html#/start&thinger_token=' +
            T2 +
            '&thinger_project=p1&thinger_api=' +
            encodeURIComponent(baseURL!),
    );
    const result = await appResult(page.mainFrame());
    expect(result.error).toBeUndefined();
    expect(result.user).toEqual({ id: 'alice' });
    expect(result.devices).toHaveLength(2);
    // the token left the address bar; the route stayed
    expect(result.hash).toBe('#/start');
    expect(page.url()).not.toContain('thinger_token');
});

test('README layout check: the app inside its own page at phone size', async ({
    page,
    baseURL,
    request,
}) => {
    const { T2 } = await (await request.get('/test/tokens')).json();
    const link =
        baseURL +
        '/app-esm.html#/start&thinger_token=' +
        T2 +
        '&thinger_api=' +
        encodeURIComponent(baseURL!);
    await page.goto(link);
    await appResult(page.mainFrame());
    // the snippet of README "Reviewing the layout"
    const ready = await page.evaluate(
        (src) =>
            new Promise<{ width: number; scrolls: boolean; devices: number }>((resolve) => {
                const frame = Object.assign(document.createElement('iframe'), { src });
                Object.assign(frame.style, {
                    width: '380px',
                    height: '598px',
                    position: 'fixed',
                    top: 0,
                    left: 0,
                });
                addEventListener('message', (ev) => {
                    if (
                        ev.source === frame.contentWindow &&
                        ev.data?.type === 'thinger:dashboard-ready'
                    ) {
                        const doc = frame.contentDocument!;
                        const poll = (): void => {
                            const result = doc.body.dataset['result'];
                            if (!result) {
                                setTimeout(poll, 50);
                                return;
                            }
                            resolve({
                                width: frame.contentWindow!.innerWidth,
                                scrolls:
                                    doc.documentElement.scrollWidth >
                                    frame.contentWindow!.innerWidth,
                                devices: JSON.parse(result).devices.length,
                            });
                        };
                        poll();
                    }
                });
                document.body.append(frame);
            }),
        link,
    );
    expect(ready).toEqual({ width: 380, scrolls: false, devices: 2 });
});
