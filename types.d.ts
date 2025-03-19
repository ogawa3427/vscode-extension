declare module 'noble' {
    interface Peripheral {
        advertisement: {
            localName?: string;
        };
        connectAsync(): Promise<void>;
        disconnectAsync(): Promise<void>;
        discoverServicesAsync(): Promise<any[]>;
        disconnect(): void;
        once(event: string, listener: Function): void;
    }
}

declare module '@abandonware/noble' {
    export * from 'noble';
    export function on(event: string, listener: Function): void;
    export function startScanningAsync(serviceUUIDs?: string[], allowDuplicates?: boolean): Promise<void>;
    export function stopScanningAsync(): Promise<void>;
} 