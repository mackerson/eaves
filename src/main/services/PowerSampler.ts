import { readFile, readdir } from 'fs/promises';
import { spawn, execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

/**
 * Measured power draw, for local inference only.
 *
 * A model running on the user's own hardware is the one case where energy is a
 * fact rather than an estimate, so it is worth the platform-specific effort to
 * read it. Two sources, both read-only and both unprivileged:
 *
 *   RAPL        `/sys/class/powercap/intel-rapl:N/energy_uj` — a monotonically
 *               increasing microjoule counter covering the CPU package and,
 *               on most parts, the integrated GPU and DRAM. Present on Intel
 *               and on AMD from Zen 2 onward. Some distributions restrict it
 *               to root after the PLATYPUS side-channel disclosure, which is
 *               why every read here is allowed to fail quietly.
 *   nvidia-smi  Instantaneous board power for NVIDIA GPUs, streamed from one
 *               long-lived `-lms` process rather than a spawn per sample.
 *
 * Not implemented on macOS or Windows, deliberately. macOS `powermetrics`
 * requires root, and prompting a desktop app's user for a sudo password to
 * draw a nicer chart is not a trade worth making. Windows needs vendor SDKs
 * per CPU family. On those platforms local energy falls back to the estimate,
 * marked as such — which is the honest outcome, not a degraded one.
 *
 * Why a ring buffer rather than bracketing each call: the alternative is
 * wrapping every streamAIResponse call site in a measurement, which spreads
 * power-metering code through the turn path for a number only local turns
 * use. Sampling continuously and answering `energyBetween(t0, t1)` after the
 * fact keeps all of it in one file, and the ledger already knows a turn's
 * start and end from its duration.
 *
 * The marginal-energy model. Whole-system draw includes everything else the
 * machine is doing, so attributing all of it to an inference would be wrong on
 * a busy workstation. The idle baseline is taken as a low percentile of recent
 * samples and subtracted, leaving the defensible number: what running this
 * model actually added. On a machine pinned at 100% for the whole buffer that
 * percentile overestimates idle and the result understates the turn — the
 * direction that cannot inflate a total.
 */

/** Sampling period. 1Hz is well inside RAPL's update granularity and cheap. */
const SAMPLE_INTERVAL_MS = 1000;

/** How much history to keep. Bounds memory and the answerable window. */
const BUFFER_WINDOW_MS = 15 * 60 * 1000;

/** Percentile of recent samples treated as idle draw. */
const BASELINE_PERCENTILE = 0.1;

/** Below this, sampling granularity dominates and the answer is noise. */
const MIN_MEASURABLE_MS = 1500;

interface RaplZone {
  path: string;
  /** Counter wrap point in microjoules; RAPL counters are narrow and do wrap. */
  maxRange: number;
}

interface Sample {
  at: number;
  /** Whole-system marginal-capable draw in watts at this instant. */
  watts: number;
}

export interface MeasuredEnergy {
  wh: number;
  /**
   * Which sources contributed. A CPU-only measurement on a machine with a
   * discrete GPU is a serious undercount, so the caller needs to know what was
   * actually in the number rather than just receiving a figure.
   */
  sources: Array<'rapl' | 'nvidia'>;
}

export class PowerSampler {
  private zones: RaplZone[] = [];
  private gpuProcess: ChildProcess | null = null;
  private latestGpuWatts: number | null = null;
  private lastCpuJoules: number | null = null;
  private lastCpuAt: number | null = null;
  private samples: Sample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  get available(): boolean {
    return this.running && this.samples.length > 0;
  }

  /** Which sources are actually live, for the settings UI to report honestly. */
  get sources(): Array<'rapl' | 'nvidia'> {
    const out: Array<'rapl' | 'nvidia'> = [];
    if (this.zones.length > 0) out.push('rapl');
    if (this.gpuProcess) out.push('nvidia');
    return out;
  }

  /**
   * Probe for readable counters and begin sampling. Safe to call twice.
   * Returns whether anything is actually measurable.
   */
  async start(): Promise<boolean> {
    if (this.running) return this.zones.length > 0 || this.gpuProcess != null;

    if (process.platform !== 'linux') {
      logger.info('[PowerSampler] Not Linux — local energy will be estimated, not measured');
      return false;
    }

    this.zones = await this.discoverRaplZones();
    await this.startGpuStream();

    if (this.zones.length === 0 && !this.gpuProcess) {
      logger.info('[PowerSampler] No readable power counters — local energy will be estimated');
      return false;
    }

    this.running = true;
    logger.info(
      `[PowerSampler] Sampling ${this.zones.length} RAPL zone(s)${this.gpuProcess ? ' + nvidia-smi' : ''}`
    );

    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
    void this.sample(); // prime lastCpuJoules so the next tick has a delta
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.gpuProcess) {
      this.gpuProcess.kill();
      this.gpuProcess = null;
    }
    this.samples = [];
    this.lastCpuJoules = null;
    this.lastCpuAt = null;
  }

  /**
   * Discover top-level RAPL domains.
   *
   * Only `intel-rapl:N`, never the `intel-rapl:N:M` subzones — a subzone
   * (core, uncore, dram) is *contained* in its parent's counter, so summing
   * both double-counts the same joules.
   */
  private async discoverRaplZones(): Promise<RaplZone[]> {
    const root = '/sys/class/powercap';
    try {
      const entries = await readdir(root);
      const zones: RaplZone[] = [];

      for (const entry of entries) {
        if (!/^intel-rapl:\d+$/.test(entry)) continue;
        const path = `${root}/${entry}`;
        try {
          // Read once up front: if it throws here (the post-PLATYPUS 0400
          // permissions), it would throw on every sample too.
          await readFile(`${path}/energy_uj`, 'utf8');
          const maxRange = Number((await readFile(`${path}/max_energy_range_uj`, 'utf8')).trim());
          zones.push({ path, maxRange: Number.isFinite(maxRange) ? maxRange : 0 });
        } catch {
          // Unreadable zone — usually permissions. Skip it silently.
        }
      }
      return zones;
    } catch {
      return [];
    }
  }

  /**
   * One long-lived nvidia-smi streaming samples, rather than a spawn per tick.
   * A spawn per second is ~30ms of CPU each time — measurable overhead added
   * by the thing measuring overhead.
   */
  private async startGpuStream(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        ['--query-gpu=power.draw', '--format=csv,noheader,nounits'],
        { timeout: 2000 },
      );
      if (!Number.isFinite(Number(stdout.trim().split('\n')[0]))) return;
    } catch {
      return; // no NVIDIA GPU, or nvidia-smi absent
    }

    try {
      const child = spawn('nvidia-smi', [
        '--query-gpu=power.draw',
        '--format=csv,noheader,nounits',
        `-lms`, String(SAMPLE_INTERVAL_MS),
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      child.stdout?.setEncoding('utf8');
      let pending = '';
      child.stdout?.on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        // Each emission is one line per GPU. Sum them — a multi-GPU box may
        // shard a model across all of them.
        const watts = lines.map(l => Number(l.trim())).filter(Number.isFinite);
        if (watts.length > 0) this.latestGpuWatts = watts.reduce((a, b) => a + b, 0);
      });
      child.on('error', () => { this.gpuProcess = null; this.latestGpuWatts = null; });
      child.on('exit', () => { this.gpuProcess = null; this.latestGpuWatts = null; });
      child.unref?.();
      this.gpuProcess = child;
    } catch {
      this.gpuProcess = null;
    }
  }

  /** Read the counters once and append a watts sample. */
  private async sample(): Promise<void> {
    const at = Date.now();
    let watts = 0;
    let any = false;

    if (this.zones.length > 0) {
      let joules = 0;
      let read = false;
      for (const zone of this.zones) {
        try {
          const uj = Number((await readFile(`${zone.path}/energy_uj`, 'utf8')).trim());
          if (Number.isFinite(uj)) {
            joules += uj / 1_000_000;
            read = true;
          }
        } catch {
          // A zone that disappears mid-run (hotplug, suspend) is not fatal.
        }
      }

      if (read) {
        if (this.lastCpuJoules != null && this.lastCpuAt != null) {
          const seconds = (at - this.lastCpuAt) / 1000;
          let delta = joules - this.lastCpuJoules;
          // The counter wrapped. Recover using the domain's declared range
          // rather than discarding the sample — a wrap is routine, not an
          // error. Without a usable range, drop this interval instead of
          // recording a negative one.
          if (delta < 0) {
            const range = this.zones.reduce((sum, z) => sum + z.maxRange, 0) / 1_000_000;
            delta = range > 0 ? delta + range : NaN;
          }
          if (seconds > 0 && Number.isFinite(delta)) {
            watts += delta / seconds;
            any = true;
          }
        }
        this.lastCpuJoules = joules;
        this.lastCpuAt = at;
      }
    }

    if (this.latestGpuWatts != null) {
      watts += this.latestGpuWatts;
      any = true;
    }

    if (!any) return;

    this.samples.push({ at, watts });
    const cutoff = at - BUFFER_WINDOW_MS;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift();
  }

  /** Idle draw, as a low percentile of everything still in the buffer. */
  private baselineWatts(): number | null {
    if (this.samples.length < 5) return null;
    const sorted = this.samples.map(s => s.watts).sort((a, b) => a - b);
    const index = Math.floor(sorted.length * BASELINE_PERCENTILE);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  /**
   * Energy attributable to work running between two timestamps.
   *
   * Returns null whenever the measurement cannot be trusted — nothing
   * sampled, the window predates the buffer, too few samples inside it, or no
   * baseline yet — and the caller falls back to the estimate. Returning a bad
   * measurement labelled 'measured' would be strictly worse than returning an
   * honest estimate.
   */
  energyBetween(startMs: number, endMs: number): MeasuredEnergy | null {
    if (!this.running) return null;
    if (endMs - startMs < MIN_MEASURABLE_MS) return null;

    // The window must be fully covered by the buffer. A partially covered one
    // would silently report only the part we happened to keep.
    if (this.samples.length === 0) return null;
    if (this.samples[0].at > startMs) return null;

    const inWindow = this.samples.filter(s => s.at >= startMs && s.at <= endMs);
    if (inWindow.length < 2) return null;

    const baseline = this.baselineWatts();
    if (baseline == null) return null;

    // Trapezoidal integration over the marginal draw. Clamped at zero per
    // interval: a turn that overlaps some heavier background job finishing can
    // read below baseline, and negative energy is not a thing to put in a
    // ledger.
    let joules = 0;
    for (let i = 1; i < inWindow.length; i++) {
      const seconds = (inWindow[i].at - inWindow[i - 1].at) / 1000;
      const marginal = Math.max(0, (inWindow[i].watts + inWindow[i - 1].watts) / 2 - baseline);
      joules += marginal * seconds;
    }

    return { wh: joules / 3600, sources: this.sources };
  }
}

let sampler: PowerSampler | null = null;

export function getPowerSampler(): PowerSampler {
  if (!sampler) sampler = new PowerSampler();
  return sampler;
}
