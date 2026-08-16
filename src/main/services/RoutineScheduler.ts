import {
  getRoutineRepository,
  getWorkflowRepository,
  getSettingsRepository,
  getProjectRepository,
} from '../repositories';
import { textFromResult } from '../utils/resultText';
import { Routine } from '../types';
import { getWorkflowExecutor } from './WorkflowExecutor';
import { logger } from './logger';
import { getActiveWorkRegistry } from './ActiveWorkRegistry';
import { eventBus } from './EventBus';

/**
 * Simple cron parser for basic cron expressions
 * Supports: minute hour day month dayOfWeek
 * Example: "0 9 * * *" = every day at 9:00 AM
 */
class CronParser {
  /**
   * Calculate next run time from a cron expression
   */
  static getNextRunTime(cronExpression: string, fromTime: number = Date.now()): number {
    const parts = cronExpression.trim().split(/\s+/);

    if (parts.length !== 5) {
      throw new Error('Invalid cron expression. Expected format: minute hour day month dayOfWeek');
    }

    const [minutePart, hourPart, dayPart, monthPart, dowPart] = parts;

    const now = new Date(fromTime);
    const next = new Date(now.getTime() + 60000); // Start from next minute

    // Parse cron parts
    const minute = this.parseCronField(minutePart, 0, 59);
    const hour = this.parseCronField(hourPart, 0, 23);
    const day = this.parseCronField(dayPart, 1, 31);
    const month = this.parseCronField(monthPart, 1, 12);
    const dow = this.parseDowField(dowPart);

    // Find next matching time
    // This is a simplified implementation - full cron would be more complex
    const maxIterations = 365 * 24 * 60; // Prevent infinite loops
    let iterations = 0;

    while (iterations < maxIterations) {
      // Cron standard: when both day-of-month and day-of-week are restricted
      // (neither is '*'), the two are OR'd, not AND'd. Either field left at
      // '*' just falls out of its side of the OR/AND, so a single-restricted
      // field behaves as a plain AND against the other (always-true) field.
      const domRestricted = day !== '*';
      const dowRestricted = dow !== '*';
      const domMatches = this.matches(day, next.getDate());
      const dowMatches = this.matches(dow, next.getDay());
      const dayMatches =
        domRestricted && dowRestricted ? domMatches || dowMatches : domMatches && dowMatches;

      const matches =
        this.matches(minute, next.getMinutes()) &&
        this.matches(hour, next.getHours()) &&
        dayMatches &&
        this.matches(month, next.getMonth() + 1); // JS months are 0-indexed

      if (matches) {
        return next.getTime();
      }

      next.setMinutes(next.getMinutes() + 1);
      iterations++;
    }

    throw new Error('Could not find next run time for cron expression');
  }

  /**
   * Parse a cron field (supports *, numbers, and ranges)
   */
  private static parseCronField(field: string, min: number, max: number): number[] | '*' {
    if (field === '*') {
      return '*';
    }

    if (field.includes(',')) {
      return field.split(',').flatMap(f => this.parseCronField(f, min, max) as number[]);
    }

    if (field.includes('-')) {
      const [start, end] = field.split('-').map(Number);
      const values: number[] = [];
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
      return values;
    }

    if (field.includes('/')) {
      const [range, step] = field.split('/');
      const values = range === '*' ? Array.from({ length: max - min + 1 }, (_, i) => min + i) : this.parseCronField(range, min, max) as number[];
      return values.filter((_, i) => i % Number(step) === 0);
    }

    return [Number(field)];
  }

  /**
   * Parse the day-of-week field. Same syntax as the other fields, over 0-7,
   * with 7 folded into 0 (both mean Sunday) so `getDay()`'s 0-6 range still
   * matches a `7` written by the user.
   */
  private static parseDowField(field: string): number[] | '*' {
    const parsed = this.parseCronField(field, 0, 7);
    if (parsed === '*') return '*';
    return parsed.map(v => (v === 7 ? 0 : v));
  }

  /**
   * Check if a value matches a cron field
   */
  private static matches(cronField: number[] | '*', value: number): boolean {
    if (cronField === '*') {
      return true;
    }
    return cronField.includes(value);
  }
}

/**
 * Result of one routine run. `skipped` covers a disabled routine or one whose
 * workflow is still awaiting review — neither is a failure, and neither is
 * recorded as a run outcome.
 */
export interface RoutineRunOutcome {
  status: 'success' | 'failure' | 'skipped';
  error?: string;
  /**
   * What the run actually did, when it ran at all. Callers used to get a bare
   * status, so "run it and tell me what happened" was unanswerable — an agent
   * could trigger a routine and had no way to see the output, or which node
   * failed. Absent for skips, where nothing executed.
   */
  execution?: {
    executionId: string;
    durationMs: number;
    outputs: Record<string, unknown>;
    nodeResults: Record<string, { success: boolean; output?: unknown; error?: string; durationMs: number }>;
  };
}

/**
 * RoutineScheduler Service
 *
 * Manages scheduled execution of routines and their associated workflows.
 * Checks for due routines on a regular interval and triggers workflow execution.
 */
export class RoutineScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
  private isRunning = false;
  /**
   * Routines currently mid-run, guarding against a tick (or a manual/tool
   * trigger) re-dispatching a routine whose workflow outlasts the 30s poll
   * interval. Released in `executeRoutine`'s `finally`, so a throw can't wedge
   * a routine as permanently in-flight.
   */
  private readonly inFlightRoutineIds = new Set<string>();

  /**
   * Start the routine scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('[RoutineScheduler] Scheduler already running');
      return;
    }

    logger.info('[RoutineScheduler] Starting scheduler', {
      checkInterval: this.CHECK_INTERVAL_MS,
    });

    this.isRunning = true;

    // Run initial check
    this.checkAndExecuteDueRoutines();

    // Set up interval for periodic checks
    this.intervalId = setInterval(() => {
      this.checkAndExecuteDueRoutines();
    }, this.CHECK_INTERVAL_MS);

    eventBus.emitEvent('routine:scheduler:started', {
      checkInterval: this.CHECK_INTERVAL_MS,
    });
  }

  /**
   * Stop the routine scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn('[RoutineScheduler] Scheduler not running');
      return;
    }

    logger.info('[RoutineScheduler] Stopping scheduler');

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;

    eventBus.emitEvent('routine:scheduler:stopped', {});
  }

  /**
   * Check for due routines and execute them
   */
  /** Global pause. Read from settings each tick so it survives a restart. */
  isPaused(): boolean {
    try {
      return getSettingsRepository().get().routinesPaused === true;
    } catch {
      return false;
    }
  }

  /**
   * Pause or resume the scheduler. On resume, anything that came due while
   * paused is pushed to its next cron slot rather than firing at once — a long
   * pause would otherwise stampede every routine the moment it lifts.
   */
  setPaused(paused: boolean): { rescheduled: number } {
    getSettingsRepository().update({ routinesPaused: paused });

    let rescheduled = 0;
    if (!paused) {
      const routinesRepo = getRoutineRepository();
      const now = Date.now();
      for (const routine of routinesRepo.getDueRoutines()) {
        try {
          routinesRepo.updateRunTimes(
            routine.id,
            routine.lastRun ?? 0,
            CronParser.getNextRunTime(routine.cronSchedule, now)
          );
          rescheduled++;
        } catch (error) {
          logger.warn('[RoutineScheduler] Could not reschedule on resume', {
            routineId: routine.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    logger.info(`[RoutineScheduler] ${paused ? 'Paused' : 'Resumed'}`, { rescheduled });
    eventBus.emitEvent(paused ? 'routine:scheduler:paused' : 'routine:scheduler:resumed', {
      rescheduled,
    });
    return { rescheduled };
  }

  /**
   * Reduce a run's per-node outputs to the text worth delivering.
   *
   * The last node to complete is the one that produced the answer, so its text
   * wins. Node outputs are objects rather than strings — an agent node returns
   * `{ response }`, a sink returns `{ content }` — so unwrap the known shapes
   * before falling back to JSON, which is a legible last resort rather than
   * the normal case.
   */
  private static extractText(value: unknown): string {
    return textFromResult(value);
  }

  /** The delivered body, or '' when the run produced nothing worth sending. */
  private static summarizeOutputs(outputs: Record<string, unknown>, nodeIds: string[]): string {
    // Keyed on the workflow's node ids rather than everything in the context,
    // which also holds the variables the scheduler seeded the run with.
    const texts = nodeIds
      .map(id => RoutineScheduler.extractText((outputs ?? {})[id]))
      .filter(Boolean);

    const last = texts[texts.length - 1] ?? '';
    const LIMIT = 4000;
    return last.length > LIMIT ? `${last.slice(0, LIMIT)}\n\n… (truncated)` : last;
  }

  /**
   * Deliver a successful run's result to the routine's configured target.
   *
   * Never throws into the run: the routine *did* run, and reporting it failed
   * because delivery failed would misattribute the fault and trip the
   * consecutive-failure badge on an otherwise healthy routine.
   */
  private async deliverOutput(
    routine: Routine,
    outputs: Record<string, unknown>,
    nodeIds: string[],
  ): Promise<void> {
    const output = routine.output;
    if (!output) return;

    const content = RoutineScheduler.summarizeOutputs(outputs, nodeIds);
    if (!content) {
      logger.info('[RoutineScheduler] Run produced no deliverable output', { routineId: routine.id });
      return;
    }

    try {
      if (output.type === 'note') {
        getProjectRepository().createNote(routine.projectId, { content, title: routine.name });
      } else if (output.type === 'task') {
        getProjectRepository().createTask(routine.projectId, { content });
      }

      logger.info('[RoutineScheduler] Delivered routine output', {
        routineId: routine.id,
        target: output.type,
      });
    } catch (error) {
      logger.error('[RoutineScheduler] Failed to deliver routine output', {
        routineId: routine.id,
        target: output.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async checkAndExecuteDueRoutines(): Promise<void> {
    try {
      // Short-circuit rather than stopping the interval, so scheduler status and
      // next-run times stay accurate while paused and resuming is instant.
      if (this.isPaused()) return;

      const routinesRepo = getRoutineRepository();
      const dueRoutines = routinesRepo.getDueRoutines();

      if (dueRoutines.length === 0) {
        return;
      }

      logger.info('[RoutineScheduler] Found due routines', {
        count: dueRoutines.length,
      });

      // Execute each due routine
      for (const routine of dueRoutines) {
        this.executeRoutine(routine.id).catch(error => {
          logger.error('[RoutineScheduler] Failed to execute routine', {
            routineId: routine.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      logger.error('[RoutineScheduler] Error checking for due routines', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Execute a specific routine
   */
  /**
   * Returns the run outcome. A workflow whose nodes fail resolves rather than
   * throwing, so callers that only catch exceptions would report success for a
   * run that failed — check the returned status instead.
   */
  async executeRoutine(routineId: string): Promise<RoutineRunOutcome> {
    const routinesRepo = getRoutineRepository();
    const routine = routinesRepo.getById(routineId);

    if (!routine) {
      throw new Error(`Routine not found: ${routineId}`);
    }

    if (!routine.enabled) {
      logger.info('[RoutineScheduler] Skipping disabled routine', {
        routineId: routine.id,
        routineName: routine.name,
      });
      return { status: 'skipped', error: 'Routine is disabled' };
    }

    // In-flight guard: a run still in progress (from a prior tick, a manual
    // "run now", or the run_routine tool) must finish before this routine can
    // be dispatched again — otherwise a run that outlasts the 30s poll
    // interval accumulates concurrent copies of the same workflow.
    if (this.inFlightRoutineIds.has(routine.id)) {
      logger.warn('[RoutineScheduler] Skipping routine — previous run still in flight', {
        routineId: routine.id,
        routineName: routine.name,
      });
      return { status: 'skipped', error: 'Previous run still in progress' };
    }

    logger.info('[RoutineScheduler] Executing routine', {
      routineId: routine.id,
      routineName: routine.name,
      workflowId: routine.workflowId,
    });

    const now = Date.now();
    // Recorded on the routine row at the end of the run, whichever path we
    // leave by. A routine with no workflow attached simply has nothing to fail.
    let outcome: RoutineRunOutcome = { status: 'success' };

    const work = getActiveWorkRegistry().start({
      kind: 'routine',
      containerId: routine.id,
      label: routine.name,
    });

    // Emit routine started event
    eventBus.emitEvent('routine:execution:started', {
      routineId: routine.id,
      routineName: routine.name,
      projectId: routine.projectId,
      startTime: now,
    });

    // Claimed last, immediately before the `try` whose `finally` releases it:
    // everything above is synchronous, so nothing can interleave, and a throw
    // from the registry or the bus can no longer wedge the routine as
    // permanently in flight.
    this.inFlightRoutineIds.add(routine.id);

    try {
      // If routine has a workflow, execute it
      if (routine.workflowId) {
        const workflowsRepo = getWorkflowRepository();
        const workflow = workflowsRepo.getById(routine.workflowId);

        if (!workflow) {
          throw new Error(`Workflow not found: ${routine.workflowId}`);
        }

        // Review gate: fail closed. Only explicitly-approved workflows execute.
        if (workflow.reviewStatus !== 'approved') {
          logger.warn('[RoutineScheduler] Skipping routine — workflow is pending human review', {
            routineId: routine.id,
            workflowId: workflow.id,
          });
          eventBus.emitEvent('workflow:blocked:pending-review', {
            workflowId: workflow.id,
            workflowName: workflow.name,
            projectId: workflow.projectId,
            routineId: routine.id,
            routineName: routine.name,
          });

          // Still schedule next run so the routine keeps checking after approval
          const nextRun = CronParser.getNextRunTime(routine.cronSchedule, now);
          routinesRepo.updateRunTimes(routineId, now, nextRun);
          return { status: 'skipped', error: 'Workflow is awaiting human review' };
        }

        // Execute the workflow
        const executor = getWorkflowExecutor();
        const result = await executor.executeWorkflow(workflow, {
          routineId: routine.id,
          routineName: routine.name,
          scheduledTime: now,
        });

        // Shape the executor's per-node record into the outcome. Trimmed of
        // internals (breakLoop is a control-flow signal, not a result) so the
        // shape stays stable for tool callers.
        const execution = {
          executionId: result.executionId,
          durationMs: result.duration,
          outputs: result.outputs as Record<string, unknown>,
          nodeResults: Object.fromEntries(
            Object.entries(result.nodeResults ?? {}).map(([nodeId, r]) => [
              nodeId,
              { success: r.success, output: r.output, error: r.error, durationMs: r.duration },
            ]),
          ),
        };

        logger.info('[RoutineScheduler] Workflow execution completed', {
          routineId: routine.id,
          workflowId: workflow.id,
          success: result.success,
          duration: result.duration,
        });

        // A workflow that ran and failed is a failed routine run. Emitting
        // 'completed' with success:false meant a routine could fail for weeks
        // while every surface that counted events called it healthy.
        eventBus.emitEvent(
          result.success ? 'routine:execution:completed' : 'routine:execution:failed',
          {
            routineId: routine.id,
            routineName: routine.name,
            projectId: routine.projectId,
            workflowId: workflow.id,
            success: result.success,
            duration: result.duration,
            ...(result.success ? {} : { error: result.error ?? 'Workflow execution failed' }),
          }
        );

        // Deliver the result somewhere a person will see it. Without this a
        // routine could run correctly for weeks with its output visible only
        // in the run record — which is what made "create a daily weather
        // routine" have no good answer to "and where should it go?".
        if (result.success && routine.output) {
          // Only the nodes' own results. The executor's context also carries
          // the variables seeded below (routineId, routineName, scheduledTime),
          // and summarising over those made a workflow that produced no text
          // deliver the routine's own name instead of nothing.
          await this.deliverOutput(
            routine,
            result.outputs as Record<string, unknown>,
            (workflow.dagDefinition?.nodes ?? []).map(node => node.id),
          );
        }

        outcome = result.success
          ? { status: 'success', execution }
          : { status: 'failure', error: result.error ?? 'Workflow execution failed', execution };
      } else {
        // A routine with no workflow attached runs nothing at all. It used to
        // fall through as a success, which is how a no-op routine could look
        // healthy forever. Reported as a skip — and like the other skip paths
        // (disabled, awaiting review) it advances the schedule without
        // recording a run status: last_status means "when it last actually
        // ran, how did it go", and a skip did not run.
        logger.info('[RoutineScheduler] Routine has no workflow, skipping execution', {
          routineId: routine.id,
        });
        const nextRunNoWorkflow = CronParser.getNextRunTime(routine.cronSchedule, now);
        routinesRepo.updateRunTimes(routineId, now, nextRunNoWorkflow);
        return { status: 'skipped', error: 'Routine has no workflow attached — nothing to run' };
      }

      // Calculate next run time from *completion*, not the `now` captured at
      // run start — for a run longer than the cron period, a next-run computed
      // from the start time is already in the past, so the routine would
      // re-arm and fire again immediately on the very next tick.
      const nextRun = CronParser.getNextRunTime(routine.cronSchedule, Date.now());

      // Only a run that actually executed carries a status. Every skip path
      // returns before here, so `outcome` is success or failure by this point —
      // narrowed rather than cast so a future skip added above fails to compile
      // instead of tripping the last_status CHECK constraint at runtime.
      if (outcome.status === 'skipped') {
        routinesRepo.updateRunTimes(routineId, now, nextRun);
      } else {
        routinesRepo.recordRun(routineId, now, nextRun, { status: outcome.status, error: outcome.error });
      }

      logger.info('[RoutineScheduler] Updated routine run times', {
        routineId: routine.id,
        lastRun: now,
        nextRun,
        nextRunDate: new Date(nextRun).toISOString(),
      });

      return outcome;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('[RoutineScheduler] Routine execution failed', {
        routineId: routine.id,
        error: errorMessage,
      });

      // Emit routine failed event
      eventBus.emitEvent('routine:execution:failed', {
        routineId: routine.id,
        routineName: routine.name,
        projectId: routine.projectId,
        error: errorMessage,
      });

      // Still update last run time and calculate next run — from completion,
      // same reasoning as the success path above.
      try {
        const nextRun = CronParser.getNextRunTime(routine.cronSchedule, Date.now());
        routinesRepo.recordRun(routineId, now, nextRun, {
          status: 'failure',
          error: errorMessage,
        });
      } catch (updateError) {
        logger.error('[RoutineScheduler] Failed to update routine run times', {
          routineId: routine.id,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });
      }

      throw error;
    } finally {
      work.done();
      this.inFlightRoutineIds.delete(routine.id);
    }
  }

  /**
   * Calculate next run time for a cron expression
   */
  static calculateNextRun(cronExpression: string, fromTime?: number): number {
    return CronParser.getNextRunTime(cronExpression, fromTime);
  }

  /**
   * Check if the scheduler is running
   */
  isSchedulerRunning(): boolean {
    return this.isRunning;
  }
}

// Singleton instance
let routineScheduler: RoutineScheduler | null = null;

export function getRoutineScheduler(): RoutineScheduler {
  if (!routineScheduler) {
    routineScheduler = new RoutineScheduler();
  }
  return routineScheduler;
}
