declare module '@novnc/novnc' {
  export default class RFB {
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>);
    addEventListener(type: string, listener: (event: Event) => void): void;
    disconnect(): void;
    sendCtrlAltDel(): void;
  }
}
