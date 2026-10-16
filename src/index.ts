/**
 * Thinger dashboard SDK. `Thinger` starts when this module is imported: inside the console it
 * runs the handshake, and with a `thinger_token` in the URL fragment it runs standalone.
 *
 *     import { Thinger } from '@thinger-io/dashboard-sdk';
 *     await Thinger.ready();
 *     const devices = await Thinger.devices.list();
 */
import { ThingerClient } from './client.js';

/** The SDK, ready to use after `await Thinger.ready()`. */
export const Thinger: ThingerClient = new ThingerClient();

export { ThingerClient, type ClientOptions } from './client.js';
export { ThingerError, type ThingerErrorCode } from './errors.js';
export { BASE_SERVER_VERSION } from './compat.js';
export { ALARM_STATE, ALARM_SEVERITY, ALARM_INSTANCE_EVENTS } from './alarms.js';
export { SDK_VERSION } from './version.js';
export { parseTime } from './time.js';

export type { Events } from './events.js';
export type { Buckets } from './buckets.js';
export type { Devices } from './devices.js';
export type { Alarms, AlarmRules } from './alarms.js';
export type { Resources, Properties } from './resources.js';
export type { Storages } from './storages.js';
export type { Products, Endpoints, Projects, Stats } from './misc.js';
export type * from './types.js';
export type {
    AppMessage,
    ConsoleMessage,
    EmbedMessage,
    ProtocolMessage,
    ReadyMessage,
    InitMessage,
    StandaloneParams,
} from './protocol.js';
