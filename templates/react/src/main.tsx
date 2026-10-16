import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, Link, Navigate, Outlet, RouterProvider, useParams } from 'react-router';
import { Thinger, type Device, type DeviceState } from '@thinger-io/dashboard-sdk';

function Layout() {
    return (
        <>
            <header>
                <Link to="/devices">Fleet</Link>
            </header>
            <main>
                <Outlet />
            </main>
        </>
    );
}

function DeviceList() {
    const [devices, setDevices] = useState<Device[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        Thinger.devices
            .list({ product: Thinger.context.product || undefined })
            .then(setDevices)
            .catch((e: Error) => setError(e.message));
    }, []);
    if (error) return <p className="error">{error}</p>;
    if (!devices) return <p>Loading…</p>;
    return (
        <>
            <h1>Devices</h1>
            <ul>
                {devices.map((d) => (
                    <li key={d.device}>
                        <Link to={`/devices/${d.device}`}>{d.name || d.device}</Link>
                    </li>
                ))}
            </ul>
        </>
    );
}

function DeviceDetail() {
    const { id } = useParams();
    const [device, setDevice] = useState<Device | null>(null);
    const [state, setState] = useState<DeviceState | null>(null);
    useEffect(() => {
        Thinger.devices.get(id!).then((d) => {
            setDevice(d);
            setState(d.connection?.active ? 'connected' : 'disconnected');
        });
        // live connection state; the returned function unsubscribes
        return Thinger.devices.subscribeState(id!, (event) => setState(event.state));
    }, [id]);
    if (!device) return <p>Loading…</p>;
    return (
        <>
            <Link to="/devices">← Devices</Link>
            <h1>{device.name || device.device}</h1>
            <p>
                {device.device} · {device.type} · {device.product || 'no product'} · {state}
            </p>
            <button onClick={() => Thinger.navigate({ device: device.device })}>Open in console</button>
        </>
    );
}

// Built after ready(): the start route depends on the dashboard context.
const createRouter = () =>
    createHashRouter([
        {
            path: '/',
            element: <Layout />,
            children: [
                {
                    index: true,
                    element: (
                        <Navigate
                            to={Thinger.context.device ? `/devices/${Thinger.context.device}` : '/devices'}
                            replace
                        />
                    ),
                },
                { path: 'devices', element: <DeviceList /> },
                { path: 'devices/:id', element: <DeviceDetail /> },
            ],
        },
    ]);

const root = createRoot(document.getElementById('root')!);

// Wait for the session (console handshake or standalone link) before rendering.
Thinger.ready().then(
    () =>
        root.render(
            <StrictMode>
                <RouterProvider router={createRouter()} />
            </StrictMode>,
        ),
    (err: Error) => root.render(<p className="error">{err.message}</p>),
);
