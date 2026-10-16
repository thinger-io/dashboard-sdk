/**
 * Types of the global `Thinger` defined by the classic-script build. Reference them from a
 * TypeScript project that still loads the script:
 *
 *     /// <reference types="@thinger-io/dashboard-sdk/global" />
 *
 * `ThingerSDK.*` keeps the type names of SDK 0.1 (`ThingerSDK.Device`, `ThingerSDK.Unsubscribe`…).
 */
/* eslint-disable @typescript-eslint/no-namespace -- the global names of SDK 0.1 */
import type { ThingerClient } from './client.js';
import type * as T from './index.js';

declare global {
    const Thinger: ThingerClient;
    interface Window {
        Thinger: ThingerClient;
    }
    namespace ThingerSDK {
        type SDK = ThingerClient;
        type Time = T.Time;
        type Unsubscribe = T.Unsubscribe;
        type User = T.User;
        type Project = T.Project;
        type DashboardRef = T.DashboardRef;
        type Context = T.Context;
        type RequestOptions = T.RequestOptions;
        type NavigateTarget = T.NavigateTarget;
        type BucketQuery = T.BucketQuery;
        type BucketSubscribeOptions = T.BucketSubscribeOptions;
        type BucketChange<R = T.BucketRecord> = T.BucketChange<R>;
        type BucketRecord = T.BucketRecord;
        type Device = T.Device;
        type ListQuery = T.ListQuery;
        type DeviceQuery = T.DeviceQuery;
        type Property<V = unknown> = T.Property<V>;
        type StreamFrame = T.StreamFrame;
        type AlarmUpdateOptions = T.AlarmUpdateOptions;
        type AlarmInstance = T.AlarmInstance;
        type ResourceKind = T.ResourceKind;
        type PropertyKind = T.PropertyKind;
        type StorageFile = T.StorageFile;
        type ProjectRef = T.ProjectRef;
    }
}

export {};
