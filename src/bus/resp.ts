import net from "node:net";

type Resp = string | number | null | Resp[];

/** Parse one RESP value. Returns null when the buffer holds an incomplete value. */
function parse(buf: Buffer, at: number): { value: Resp; next: number } | null {
  if (at >= buf.length) return null;
  const end = buf.indexOf("\r\n", at);
  if (end === -1) return null;

  const type = buf[at];
  const head = buf.toString("utf8", at + 1, end);
  const after = end + 2;

  switch (type) {
    case 0x2b: // '+' simple string
      return { value: head, next: after };
    case 0x2d: // '-' error
      throw new Error(`redis: ${head}`);
    case 0x3a: // ':' integer
      return { value: Number(head), next: after };
    case 0x24: { // '$' bulk string
      const len = Number(head);
      if (len === -1) return { value: null, next: after };
      if (buf.length < after + len + 2) return null;
      return { value: buf.toString("utf8", after, after + len), next: after + len + 2 };
    }
    case 0x2a: { // '*' array
      const count = Number(head);
      if (count === -1) return { value: null, next: after };
      const items: Resp[] = [];
      let cursor = after;
      for (let i = 0; i < count; i++) {
        const item = parse(buf, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`redis: unexpected reply byte 0x${type?.toString(16)}`);
  }
}

function encode(args: string[]): Buffer {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    parts.push(Buffer.from(`$${Buffer.byteLength(a)}\r\n${a}\r\n`));
  }
  return Buffer.concat(parts);
}

/**
 * Just enough Redis for pub/sub: one connection, RESP framing, auto-reconnect.
 * Written against node:net so the tracker keeps a zero-dependency install.
 */
export class RedisConnection {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private reconnectDelay = 250;

  private readonly url: URL;
  private readonly onMessage: (channel: string, payload: string) => void;
  private readonly onReady: (conn: RedisConnection) => void;
  private readonly onError: (err: Error) => void;

  constructor(
    url: URL,
    onMessage: (channel: string, payload: string) => void,
    onReady: (conn: RedisConnection) => void,
    onError: (err: Error) => void,
  ) {
    this.url = url;
    this.onMessage = onMessage;
    this.onReady = onReady;
    this.onError = onError;
  }

  connect(): void {
    if (this.closed) return;
    const socket = net.createConnection({
      host: this.url.hostname,
      port: Number(this.url.port || 6379),
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.reconnectDelay = 250;
      if (this.url.password) this.send("AUTH", this.url.password);
      this.onReady(this);
    });

    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        for (;;) {
          const parsed = parse(this.buffer, 0);
          if (!parsed) break;
          this.buffer = this.buffer.subarray(parsed.next);
          this.dispatch(parsed.value);
        }
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
        this.buffer = Buffer.alloc(0);
      }
    });

    socket.on("error", (err) => this.onError(err));
    socket.on("close", () => {
      if (this.closed) return;
      // Reconnect with capped backoff; the bus falls back to in-process delivery
      // while the connection is down, so a Redis blip never drops the API.
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    });
  }

  private dispatch(value: Resp): void {
    if (!Array.isArray(value) || value.length < 3) return;
    if (value[0] !== "message") return;
    const [, channel, payload] = value;
    if (typeof channel === "string" && typeof payload === "string") {
      this.onMessage(channel, payload);
    }
  }

  send(...args: string[]): void {
    this.socket?.write(encode(args));
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}
