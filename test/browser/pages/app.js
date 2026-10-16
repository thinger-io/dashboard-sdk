// The test app: waits for the session, lists devices and publishes what it saw in the DOM,
// where the test reads it.
export async function run(Thinger) {
    const out = {};
    try {
        await Thinger.ready();
        out.user = Thinger.user;
        out.project = Thinger.project;
        out.context = Thinger.context;
        out.version = Thinger.version;
        out.serverVersion = Thinger.serverVersion;
        out.supportsList = Thinger.supports('devices.list');
        out.devices = await Thinger.devices.list();
        out.hash = location.hash;
    } catch (e) {
        out.error = String(e && e.message);
    }
    document.body.dataset.result = JSON.stringify(out);
}
