declare module '@abandonware/noble' {
    interface Peripheral {
        id: string;
        advertisement: {
            localName?: string;
        };
    }

    const state: 'poweredOn' | 'poweredOff' | 'unknown';
    function on(event: 'stateChange', listener: (state: string) => void): void;
    function on(event: 'discover', listener: (peripheral: Peripheral) => void): void;
    function on(event: 'scanStart', listener: () => void): void;
    function on(event: 'scanStop', listener: () => void): void;
    function on(event: 'error', listener: (error: Error) => void): void;
    function once(event: 'stateChange', listener: (state: string) => void): void;
    function startScanningAsync(): Promise<void>;
    function stopScanningAsync(): Promise<void>;
} 