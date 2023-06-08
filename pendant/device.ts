import { EventEmitter } from "node:events";
import { Device, HID, devices } from "node-hid";
import { ControlReport, DisplayFlags } from "./control";
import { DeviceReport, SelectedAxis, SelectedFeedRate } from "./report";

const PENDANT_VID = 0x10ce;
const PENDANT_PID = 0xeb93;

export const enum StepMode {
    STEP_MODE_CONT    = DisplayFlags.STEP_MODE_CONT,
    STEP_MODE_STEP    = DisplayFlags.STEP_MODE_STEP,
    STEP_MODE_MPG     = DisplayFlags.STEP_MODE_MPG,
    STEP_MODE_PERCENT = DisplayFlags.STEP_MODE_PERCENT,
}

export const enum CoordinateMode {
    MACHINE_COORDS = DisplayFlags.MACHINE_COORDS,
    WORK_COORDS    = DisplayFlags.WORK_COORDS,
}

export interface JogReport {
    stepMode: StepMode;
    axis: SelectedAxis;
    rate: SelectedFeedRate;
    delta: number;
}

const DISPLAY_AXIS_XYZ = [SelectedAxis.X, SelectedAxis.Y, SelectedAxis.Z];
const DISPLAY_AXIS_ABC = [SelectedAxis.A, SelectedAxis.B, SelectedAxis.C];

export class PendantDevice extends EventEmitter {
    // Displayed data
    public axisCoordinates: { [key in SelectedAxis]: number } = {
        [SelectedAxis.X]: 0,
        [SelectedAxis.Y]: 0,
        [SelectedAxis.Z]: 0,
        [SelectedAxis.A]: 0,
        [SelectedAxis.B]: 0,
        [SelectedAxis.C]: 0,
    };
    public feedRate: number = 0;
    public spindleSpeed: number = 0;

    public coordinateMode: CoordinateMode = CoordinateMode.MACHINE_COORDS;
    public stepMode: StepMode = StepMode.STEP_MODE_CONT;

    // Control state
    private pressedButtons: Set<number> = new Set();

    // Internal state
    private axisLines: SelectedAxis[] = DISPLAY_AXIS_XYZ;

    private writeDevice?: HID;
    private readDevice?: HID;

    public constructor() {
        super();
    }

    public async control(packet: ControlReport) {
        if (!this.writeDevice) {
            throw new Error('Cannot control unopened device');
        }
        packet.writeTo(this.writeDevice);
    }

    public async refreshDisplay() {
        const packet = new ControlReport();
        packet.flags = this.stepMode | this.coordinateMode;
        packet.feedRate = this.feedRate;
        packet.spindleSpeed = this.spindleSpeed;
        packet.coordinates = this.axisLines.map(axis => this.axisCoordinates[axis]);
        await this.control(packet);
    }

    public async init() {
        const deviceInfos = devices().filter((d: Device) => {
            return d.vendorId == PENDANT_VID && d.productId == PENDANT_PID;
        });

        const report = new ControlReport();
        report.flags |= DisplayFlags.RESET;

        return new Promise<void>((resolve, reject) => {
            let startupDoneCalled = false;
            let startupDone = () => {
                if (startupDoneCalled) {
                    return;
                }
                startupDoneCalled = true;

                if (!this.readDevice) {
                    reject(new Error('Could not find READ device'));
                    return;
                }
                if (!this.writeDevice) {
                    reject(new Error('Could not find WRITE device'));
                    return;
                }

                this.readDevice.removeAllListeners('error');
                this.writeDevice.removeAllListeners('error');

                this.readDevice.on('data', this.handleData.bind(this));
                this.readDevice.on('error', this.handleError.bind(this));
                if (this.writeDevice !== this.readDevice) {
                    this.writeDevice.on('error', this.handleError.bind(this));
                }

                resolve();
            };
        
            for (const deviceInfo of deviceInfos) {
                if (!deviceInfo.path) {
                    continue;
                }
                const candidateDevice = new HID(deviceInfo.path);
                try {
                    report.writeTo(candidateDevice);
                    this.writeDevice = candidateDevice;
                } catch {}
        
                candidateDevice.once('data', (_: Buffer) => {
                    this.readDevice = candidateDevice;
                    startupDone();
                });
                candidateDevice.on('error', () => { });
            }
        
            setTimeout(startupDone, 1000);
        });
    }

    private refreshDisplayOneshot() {
        this.refreshDisplay().catch(this.handleError.bind(this));
    }

    private handleReport(report: DeviceReport) {
        let needsRedraw = false;

        let targetAxisOffset = DISPLAY_AXIS_XYZ;
        switch (report.axis) {
            case SelectedAxis.A:
            case SelectedAxis.B:
            case SelectedAxis.C:
                targetAxisOffset = DISPLAY_AXIS_ABC;
                break;
            default:
                targetAxisOffset = DISPLAY_AXIS_XYZ;
        }

        if (targetAxisOffset !== this.axisLines) {
            needsRedraw = true;
            this.axisLines = targetAxisOffset;
        }

        for (const button of report.buttons) {
            if (!this.pressedButtons.has(button)) {
                this.emit('button_down', button);
            }
        }

        for (const oldButton of this.pressedButtons) {
            if (!report.buttons.has(oldButton)) {
                this.emit('button_up', oldButton);
            }
        }

        if (report.jog && report.axis) {
            const jogReport: JogReport = {
                axis: report.axis,
                delta: report.jog,
                rate: report.feedRate,
                stepMode: this.stepMode,
            };
            this.emit('jog', jogReport);
        }

        this.pressedButtons = report.buttons;

        if (needsRedraw) {
            this.refreshDisplayOneshot();
        }
    }

    private handleData(data: Buffer) {
        const reportID = data[0];
        data = data.subarray(1);
        if (reportID == 0x04) {
            const report = new DeviceReport(data);
            this.handleReport(report);
            this.emit('report', report);
        } else {
            this.handleError(new Error(`Unknown report ${reportID} with data ${data}`));
        }
    }

    private handleError(err: any) {
        this.emit('error', err);
    }
}