"use strict";

import SerialPort from "serialport"; // https://serialport.io/docs/
import Events from "events"; // https://nodejs.org/api/events.html#events_class_eventemitter
import { LogLevel, Logger, make_logger, log_security_level } from "./logging";

// responses
const RESPONSE_OK = 1; // generic command ok/received
const RESPONSE_SEND_INPUT = 2; // command received, send input
const RESPONSE_REJECTED = 3; // user input rejected
const RESPONSE_OUTPUT = 4; // sending output
const RESPONSE_OUTPUT_END = 5; // end of output
const RESPONSE_ESC_SEQUENCE = 6; // output esc sequence
const RESPONSE_WAIT_USER_CONFIRM = 10; // user has to confirm action
const RESPONSE_LOCKED = 11; // device is locked, send PIN

// error responses
const response_errors: Record<number, string> = {
    255: "RESPONSE_ERROR_UNKNOWN_COMMAND",
    254: "RESPONSE_ERROR_NOT_INITIALIZED",
    253: "RESPONSE_ERROR_MEMORY_ERROR",
    252: "RESPONSE_ERROR_APP_DOMAIN_TOO_LONG",
    251: "RESPONSE_ERROR_APP_DOMAIN_INVALID",
    250: "RESPONSE_ERROR_MNEMONIC_TOO_LONG",
    249: "RESPONSE_ERROR_MNEMONIC_INVALID",
    248: "RESPONSE_ERROR_GENERATE_MNEMONIC",
    247: "RESPONSE_ERROR_INPUT_TIMEOUT",
    246: "RESPONSE_ERROR_NOT_IMPLEMENTED",
};

const enum State {
    IDLE,
    SENDING,
    READING,
}

const state_symbol = Symbol("state");
const lock_symbol = Symbol("ready");
const train_symbol = Symbol("train");
const watchdog_symbol = Symbol("watchdog");
const reconnect_symbol = Symbol("reconnect");

const WATCHDOG_TIMEOUT = 5000;

let id = 0;

export interface Options extends SerialPort.OpenOptions {
    log_level?: LogLevel;
    logger?: Logger;
    reject_on_locked?: boolean;
    reconnect_time?: number;
    debug?: boolean;
}

type TrainEntry = [
    string, // TrainEntry[0] -- data
    (value?: any) => void, // TrainEntry[1] -- resolve function
    (error?: Error) => void, // TrainEntry[2] -- reject function
    boolean, // TrainEntry[3] -- isEscapedByte
    // TODO: does TrainEntry[4] (output buffer) need to be refactored to type `Buffer`, `Array<Byte>`, or stay as `string`?
    string // TrainEntry[4] -- output buffer
];

export default class RyderSerial extends Events.EventEmitter {
    #log_level: LogLevel;
    #logger: Logger;

    /** the id of the `RyderSerial` instance */
    id: number;
    /** the port at which the Ryder device (or simulator) is connected */
    port: string;
    /** optional specifications for `RyderSerial`'s behavior (especially regarding connection)  */
    options: Options;
    /** true if `RyderSerial` is in the process of closing */
    closing: boolean;
    /** instantiated on successful connection; sticks around while connection is active */
    serial?: SerialPort;
    // TODO: refactor train into its own encapsulated class
    /** initial sequencer implementation for `RyderSerial` */
    [train_symbol]: TrainEntry[];
    /** current state of the RyderSerial -- either `IDLE`, `SENDING`, `READING` */
    [state_symbol]: State;
    /** array of resolve functions representing locks; locks are released when resolved */
    [lock_symbol]: Array<(value?: any) => void>;
    /** timeout that will invoke `this.serial_watchdog()` if we ever go over `SERIAL_WATCHDOG_TIMEOUT` */
    [watchdog_symbol]: NodeJS.Timeout;
    /** timeout that will invoke `this.open()` if we ever go over `this.options.reconnectTimeout` */
    [reconnect_symbol]: NodeJS.Timeout;

    // command constants
    // lifecycle commands
    static readonly COMMAND_WAKE = 1;
    static readonly COMMAND_INFO = 2;
    static readonly COMMAND_SETUP = 10;
    static readonly COMMAND_RESTORE_FROM_SEED = 11;
    static readonly COMMAND_RESTORE_FROM_MNEMONIC = 12;
    static readonly COMMAND_ERASE = 13;
    // export commands
    static readonly COMMAND_EXPORT_OWNER_KEY = 18;
    static readonly COMMAND_EXPORT_OWNER_KEY_PRIVATE_KEY = 19;
    static readonly COMMAND_EXPORT_APP_KEY = 20;
    static readonly COMMAND_EXPORT_APP_KEY_PRIVATE_KEY = 21;
    static readonly COMMAND_EXPORT_OWNER_APP_KEY_PRIVATE_KEY = 23;
    static readonly COMMAND_EXPORT_PUBLIC_IDENTITIES = 30;
    static readonly COMMAND_EXPORT_PUBLIC_IDENTITY = 31;
    // encrypt/decrypt commands
    static readonly COMMAND_START_ENCRYPT = 40;
    static readonly COMMAND_START_DECRYPT = 41;
    // cancel command
    static readonly COMMAND_CANCEL = 100;

    // response constants
    static readonly RESPONSE_OK = RESPONSE_OK;
    static readonly RESPONSE_SEND_INPUT = RESPONSE_SEND_INPUT;
    static readonly RESPONSE_REJECTED = RESPONSE_REJECTED;
    static readonly RESPONSE_LOCKED = RESPONSE_LOCKED;

    /**
     * Construct a new instance of RyderSerial and try to open connection at given port
     * @param port The port at which Ryder device (or simulator) is connected
     * @param options Optional specifications to customize RyderSerial behavior — especially regarding connection
     */
    constructor(port: string, options?: Options) {
        super();
        this.#log_level = options?.log_level ?? LogLevel.SILENT;
        this.#logger = options?.logger ?? make_logger(this.constructor.name);
        this.id = id++;
        this.port = port;
        this.options = options || {};
        if (this.options.debug && !this.options.log_level) {
            this.#log_level = LogLevel.DEBUG;
        }
        this[train_symbol] = [];
        this[state_symbol] = State.IDLE;
        this[lock_symbol] = [];
        this.closing = false;
        this.open();
    }

    private log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
        const instance_log_level = log_security_level(this.#log_level);
        if (instance_log_level > 0 && log_security_level(level) >= instance_log_level) {
            this.#logger(level, message, extra);
        }
    }

    private serial_error(error: Error): void {
        this.emit("error", error);
        if (this[train_symbol][0]) {
            const [, , reject] = this[train_symbol].shift()!;
            reject(error);
        }
        clearTimeout(this[watchdog_symbol]);
        this[state_symbol] = State.IDLE;
        this.next();
    }

    private serial_data(data: Uint8Array): void {
        this.log(LogLevel.DEBUG, "data from Ryder", {
            data: "0x" + Buffer.from(data).toString("hex"),
        });

        if (this[state_symbol] === State.IDLE) {
            this.log(LogLevel.WARN, "Got data from Ryder without asking, discarding.");
        } else {
            clearTimeout(this[watchdog_symbol]);
            if (!this[train_symbol][0]) return;
            const [, resolve, reject] = this[train_symbol][0]!;
            let offset = 0;
            if (this[state_symbol] === State.SENDING) {
                this.log(LogLevel.DEBUG, "-> SENDING... ryderserial is trying to send data");
                if (data[0] === RESPONSE_LOCKED) {
                    this.log(
                        LogLevel.WARN,
                        "!! WARNING: RESPONSE_LOCKED -- RYDER DEVICE IS NEVER SUPPOSED TO EMIT THIS EVENT"
                    );
                    if (this.options.reject_on_locked) {
                        const error = new Error("ERROR_LOCKED");
                        for (let i = 0; i < this[train_symbol].length; ++i) {
                            const [, , reject] = this[train_symbol][i];
                            reject(error);
                        }
                        this[state_symbol] = State.IDLE;
                        this.emit("locked");
                        return;
                    } else {
                        this.emit("locked");
                    }
                }
                if (
                    data[0] === RESPONSE_OK ||
                    data[0] === RESPONSE_SEND_INPUT ||
                    data[0] === RESPONSE_REJECTED
                ) {
                    this.log(
                        LogLevel.DEBUG,
                        "---> (while sending): RESPONSE_OK or RESPONSE_SEND_INPUT or RESPONSE_REJECTED"
                    );
                    this[train_symbol].shift();
                    resolve(data[0]);
                    if (data.length > 1) {
                        this.log(LogLevel.DEBUG, "ryderserial more in buffer");
                        return this.serial_data.bind(this)(data.slice(1)); // more responses in the buffer
                    }
                    this[state_symbol] = State.IDLE;
                    this.next();
                    return;
                } else if (data[0] === RESPONSE_OUTPUT) {
                    this.log(
                        LogLevel.DEBUG,
                        "---> (while sending): RESPONSE_OUTPUT... ryderserial is ready to read"
                    );
                    this[state_symbol] = State.READING;
                    ++offset;
                } else if (data[0] === RESPONSE_WAIT_USER_CONFIRM) {
                    // wait for user to confirm
                    this.emit("wait_user_confirm");
                    this.log(LogLevel.DEBUG, "waiting for user confirm on device");
                    if (data.length > 1) {
                        this.log(LogLevel.DEBUG, "ryderserial more in buffer");
                        return this.serial_data.bind(this)(data.slice(1)); // more responses in the buffer
                    }
                    return;
                } else {
                    // error
                    const error = new Error(
                        data[0] in response_errors
                            ? response_errors[data[0]] // known error
                            : "ERROR_UNKNOWN_RESPONSE" // unknown error
                    );
                    this.log(
                        LogLevel.ERROR,
                        "---> (while sending): ryderserial ran into an error",
                        { error }
                    );
                    reject(error);
                    this[train_symbol].shift();
                    this[state_symbol] = State.IDLE;
                    if (data.length > 1) {
                        this.log(LogLevel.DEBUG, "ryderserial more in buffer");
                        return this.serial_data.bind(this)(data.slice(1)); // more responses in the buffer
                    }
                    this.next();
                    return;
                }
            }
            if (this[state_symbol] === State.READING) {
                this.log(
                    LogLevel.INFO,
                    "---> (during response_output): READING... ryderserial is trying to read data"
                );
                this[watchdog_symbol] = setTimeout(
                    this.serial_watchdog.bind(this),
                    WATCHDOG_TIMEOUT
                );
                for (let i = offset; i < data.byteLength; ++i) {
                    const b = data[i];
                    if (!this[train_symbol][0][3]) {
                        // previous was not escape byte
                        if (b === RESPONSE_ESC_SEQUENCE) {
                            this[train_symbol][0][3] = true; // esc byte
                            continue; // skip esc byte
                        } else if (b === RESPONSE_OUTPUT_END) {
                            this.log(
                                LogLevel.DEBUG,
                                "---> READING SUCCESS resolving output buffer",
                                {
                                    output_buffer:
                                        "0x" +
                                        Buffer.from(this[train_symbol][0][4]).toString("hex"),
                                }
                            );
                            resolve(this[train_symbol][0][4]); // resolve output buffer (string)
                            this[train_symbol].shift();
                            this[state_symbol] = State.IDLE;
                            this.next();
                            return;
                        }
                    }
                    // else, previous was escape byte
                    this[train_symbol][0][3] = false; // esc byte
                    this[train_symbol][0][4] += String.fromCharCode(b);
                }
            }
        }
    }

    private serial_watchdog(): void {
        if (!this[train_symbol][0]) return;
        const [, , reject] = this[train_symbol][0]!;
        this[train_symbol].shift();
        reject(new Error("ERROR_WATCHDOG"));
        this[state_symbol] = State.IDLE;
        this.next();
    }

    /**
     * Attempts to (re)open a new connection to serial port and initialize Event listeners.
     *
     * NOTE that a connection is opened automatically when a `RyderSerial` object is constructed.
     *
     * @param port The port to connect to. If omitted, fallback to `this.port`
     * @param options Specific options to drive behavior. If omitted, fallback to `this.options` or `DEFAULT_OPTIONS`
     */
    public open(port?: string, options?: Options): void {
        this.log(LogLevel.DEBUG, "ryderserial attempt open");
        this.closing = false;

        // if serial is already open
        if (this.serial?.isOpen) {
            // TODO: what if client code is intentionally trying to open connection to a new port for some reason? Or passed in new options?
            return; // return out, we don't need to open a new connection
        }
        // if serial is defined, but it's actively closed
        if (this.serial) {
            // close RyderSerial b/c client is trying to open a new connection.
            // `this.close()` will clear all interval timeouts, set destroy `this.serial`, reject all pending processes, and unlock all locks.
            this.close();
        }
        this.port = port || this.port;
        this.options = options || this.options || {};
        if (!this.options.baudRate) this.options.baudRate = 115_200;
        if (!this.options.lock) this.options.lock = true;
        if (!this.options.reconnect_time) this.options.reconnect_time = 1_000;
        this.serial = new SerialPort(this.port, this.options);
        this.serial.on("data", this.serial_data.bind(this));
        this.serial.on("error", error => {
            this.log(LogLevel.WARN, `\`this.serial\` encountered an error: ${error}`);
            if (this.serial && !this.serial.isOpen) {
                clearInterval(this[reconnect_symbol]);
                this[reconnect_symbol] = setInterval(
                    this.open.bind(this),
                    this.options.reconnect_time
                );
                this.emit("failed", error);
            }
            this.serial_error.bind(this);
        });
        this.serial.on("close", () => {
            this.log(LogLevel.DEBUG, "ryderserial close");
            this.emit("close");
            clearInterval(this[reconnect_symbol]);
            if (!this.closing) {
                this[reconnect_symbol] = setInterval(
                    this.open.bind(this),
                    this.options.reconnect_time
                );
            }
        });
        this.serial.on("open", () => {
            this.log(LogLevel.DEBUG, "ryderserial open");
            clearInterval(this[reconnect_symbol]);
            this.emit("open");
            this.next();
        });
    }

    /**
     * Close down `this.serial` connection and reset `RyderSerial`
     *
     * All tasks include:
     * - clear watchdog timeout,
     * - reject pending processes,
     * - release all locks.
     * - close serial connection,
     * - clear reconnect interval
     * - destroy `this.serial`
     */
    public close(): void {
        if (this.closing) {
            return;
        }
        this.closing = true;
        this.clear(); // clears watchdog timeout, rejects all pending processes, and releases all locks.
        this.serial?.close(); // close serial if it exists
        clearInterval(this[reconnect_symbol]); // clear reconnect interval
        this.serial = undefined; // destroy serial
    }

    /**
     * @returns `true` if RyderSerial is currently locked; `false` otherwise
     */
    public locked(): boolean {
        return !!this[lock_symbol].length;
    }

    /**
     * Requests a lock to be placed so that commands can be sent in sequence.
     *
     * @returns a `Promise` that resolves when the lock is released.
     */
    public lock(): Promise<void> {
        this.log(LogLevel.DEBUG, "\tLOCK... ryderserial lock");
        this[lock_symbol].push(Promise.resolve);
        return Promise.resolve();
    }

    /**
     * Releases the last lock that was requested.
     *
     * Be sure to call this after calling `lock()`, otherwise the serial connection may be blocked until your
     * app exits or the Ryder disconnects.
     */
    public unlock(): void {
        if (this[lock_symbol].length) {
            this.log(LogLevel.DEBUG, "ryderserial unlock");
            const resolve = this[lock_symbol].shift();
            resolve && resolve();
        }
    }

    /**
     * A utility function that requests a lock and executes the callback once the lock has been granted.
     *
     * Once the callback resolves, it will then release the lock.
     *
     * Useful to chain commands whilst making your application less error-prone (forgetting to call `unlock()`).
     *
     * @returns a `Promise` that resolves to whatever the given `callback` returns.
     */
    public sequence<T>(callback: () => T): Promise<T> {
        if (typeof callback !== "function" || callback.constructor.name !== "AsyncFunction") {
            return Promise.reject(new Error("ERROR_SEQUENCE_NOT_ASYNC"));
        }
        return this.lock().then(callback).finally(this.unlock.bind(this));
    }

    /**
     * Send a command and/or data to the Ryder device.
     * The command will be queued and executed once preceding commands have completed.
     *
     * Data can be passed in as a number (as byte), string
     * Set `prepend` to `true` to put the data on the top of the queue.
     *
     * @param data A command or data to send to the Ryder device
     * @param prepend Set to `true` to put data on top of the queue.
     * @returns A `Promise` that resolves with response from the Ryder device (includes waiting for a possible user confirm). The returned data may be a single byte (see static members of this class) and/or resulting data, like an identity or app key.
     */
    // TODO: add support for data being of type `buffer`, `Array<T>`
    public send(data: string | number, prepend?: boolean): Promise<string> {
        // if `this.serial` is `undefined` or NOT open, then we do not have a connection
        if (!this.serial?.isOpen) {
            // reject because we do not have a connection
            return Promise.reject(new Error("ERROR_DISCONNECTED"));
        }
        if (typeof data === "number") {
            data = String.fromCharCode(data);
        }
        this.log(LogLevel.DEBUG, "queue data for Ryder: " + data.length + " byte(s)", {
            bytes: Buffer.from(data).toString("hex"),
        });
        return new Promise((resolve, reject) => {
            const c: TrainEntry = [data as string, resolve, reject, false, ""];
            prepend ? this[train_symbol].unshift(c) : this[train_symbol].push(c);
            this.next();
        });
    }

    /**
     * Moves on to the next command in the queue.
     *
     * This method should ordinarily **not** be called directly.
     * The library takes care of queueing and will call `next()` at the right time.
     */
    private next(): void {
        if (this[state_symbol] === State.IDLE && this[train_symbol].length) {
            this.log(LogLevel.INFO, "-> NEXT... ryderserial is moving to next task");
            if (!this.serial?.isOpen) {
                // `this.serial` is undefined or not open
                this.log(LogLevel.ERROR, "ryderserial connection to port has shut down");
                const [, , reject] = this[train_symbol][0];
                this.clear();
                reject(new Error("ERROR_DISCONNECTED"));
                return;
            }
            this[state_symbol] = State.SENDING;
            try {
                this.log(
                    LogLevel.DEBUG,
                    "send data to Ryder: " + this[train_symbol][0][0].length + " byte(s)",
                    {
                        bytes: Buffer.from(this[train_symbol][0][0]).toString("hex"),
                    }
                );
                this.serial.write(this[train_symbol][0][0]);
            } catch (error) {
                this.log(LogLevel.ERROR, `encountered error while sending data: ${error}`);
                this.serial_error(error);
                return;
            }
            clearTimeout(this[watchdog_symbol]);
            this[watchdog_symbol] = setTimeout(this.serial_watchdog.bind(this), WATCHDOG_TIMEOUT);
        } else {
            this.log(LogLevel.INFO, "-> IDLE... ryderserial is waiting for next task.");
        }
    }

    /**
     * Reset `RyderSerial` processes and locks.
     *
     * All tasks include:
     * - clear watchdog timeout
     * - reject all pending processes
     * - set state to `IDLE`
     * - release all locks
     */
    public clear(): void {
        clearTimeout(this[watchdog_symbol]);
        for (let i = 0; i < this[train_symbol].length; ++i) {
            this[train_symbol][i][2](new Error("ERROR_CLEARED")); // reject all pending
        }
        this[train_symbol] = [];
        this[state_symbol] = State.IDLE;
        for (let i = 0; i < this[lock_symbol].length; ++i)
            this[lock_symbol][i] && this[lock_symbol][i](); // release all locks
        this[lock_symbol] = [];
    }
}

/**
 * Retrieve all Ryder devices from SerialPort connection.
 */
export async function enumerate_devices(): Promise<SerialPort.PortInfo[]> {
    const devices = await SerialPort.list();
    const ryder_devices = devices.filter(
        device => device.vendorId === "10c4" && device.productId === "ea60"
    );
    return Promise.resolve(ryder_devices);
}

module.exports = RyderSerial;
module.exports.enumerate_devices = enumerate_devices;
