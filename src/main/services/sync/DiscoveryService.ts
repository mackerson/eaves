import { EventEmitter } from 'events';
import { logger } from '../logger';

/**
 * mDNS advertise + browse for `_enclave-sync._tcp` on the local network.
 * Pure-JS via bonjour-service — no native bindings.
 *
 * Events:
 *   'device-up'   (device: DiscoveredDevice)
 *   'device-down' (deviceId: string)
 */

export interface DiscoveredDevice {
  deviceId: string;
  deviceName: string;
  host: string;
  port: number;
}

type BonjourModule = typeof import('bonjour-service');

export class DiscoveryService extends EventEmitter {
  private bonjour: InstanceType<BonjourModule['Bonjour']> | null = null;
  private browser: ReturnType<InstanceType<BonjourModule['Bonjour']>['find']> | null = null;
  private devices = new Map<string, DiscoveredDevice>();
  private ownDeviceId: string;

  constructor(ownDeviceId: string) {
    super();
    this.ownDeviceId = ownDeviceId;
  }

  async start(deviceName: string, port: number): Promise<void> {
    const { Bonjour } = await import('bonjour-service');
    this.bonjour = new Bonjour();

    this.bonjour.publish({
      // Service-instance names must be network-unique; the id suffix keeps two
      // devices with the same hostname from colliding.
      name: `${deviceName.slice(0, 40)}-${this.ownDeviceId.slice(0, 8)}`,
      type: 'enclave-sync',
      port,
      txt: { deviceid: this.ownDeviceId, devicename: deviceName },
    });

    this.browser = this.bonjour.find({ type: 'enclave-sync' }, (service) => {
      const txt = (service.txt ?? {}) as Record<string, string>;
      const deviceId = txt.deviceid;
      if (!deviceId || deviceId === this.ownDeviceId) return;

      const host = pickAddress(service.addresses) ?? service.host;
      if (!host) return;

      const device: DiscoveredDevice = {
        deviceId,
        deviceName: txt.devicename || service.name || 'Unknown device',
        host,
        port: service.port,
      };
      this.devices.set(deviceId, device);
      logger.info('[sync] Discovered device', device);
      this.emit('device-up', device);
    });

    this.browser.on('down', (service) => {
      const txt = (service.txt ?? {}) as Record<string, string>;
      const deviceId = txt.deviceid;
      if (deviceId && this.devices.delete(deviceId)) {
        logger.info('[sync] Device left', { deviceId });
        this.emit('device-down', deviceId);
      }
    });
  }

  list(): DiscoveredDevice[] {
    return [...this.devices.values()];
  }

  get(deviceId: string): DiscoveredDevice | undefined {
    return this.devices.get(deviceId);
  }

  stop(): void {
    this.browser?.stop?.();
    this.browser = null;
    this.devices.clear();
    if (this.bonjour) {
      // unpublishAll then destroy releases the multicast socket.
      this.bonjour.unpublishAll(() => this.bonjour?.destroy());
      this.bonjour = null;
    }
  }
}

/** Prefer IPv4; link-local IPv6 needs zone ids that tls.connect won't have. */
function pickAddress(addresses: string[] | undefined): string | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  return addresses.find(a => a.includes('.')) ?? addresses[0];
}
