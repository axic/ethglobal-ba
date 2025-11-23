declare module "ws" {
  export class WebSocket {
    static readonly OPEN: number;
    readyState: number;
    send(data: string | Buffer): void;
    close(): void;
    on(event: "message", listener: (data: Buffer) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
  }

  export class WebSocketServer {
    constructor(options: { port: number });
    on(event: "connection", listener: (socket: WebSocket) => void): void;
  }
}
