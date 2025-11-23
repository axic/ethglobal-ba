declare module "ws" {
  export type RawData = string | Buffer | ArrayBuffer | Buffer[];

  export default class WebSocket {
    static readonly OPEN: number;
    readyState: number;
    constructor(address: string, protocols?: string | string[]);
    send(data: string | Buffer): void;
    close(): void;
    on(event: "open", listener: () => void): void;
    on(event: "message", listener: (data: RawData) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
  }
}
