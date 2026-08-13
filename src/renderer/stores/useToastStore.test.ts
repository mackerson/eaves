import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useToastStore } from './useToastStore';

describe('useToastStore', () => {
  beforeEach(() => {
    // Reset store before each test
    useToastStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('showToast', () => {
    it('should add a toast to the store', () => {
      const { showToast } = useToastStore.getState();

      showToast('Test message', 'info');

      const currentToasts = useToastStore.getState().toasts;
      expect(currentToasts).toHaveLength(1);
      expect(currentToasts[0].message).toBe('Test message');
      expect(currentToasts[0].type).toBe('info');
    });

    it('should generate unique IDs for toasts', () => {
      const { showToast } = useToastStore.getState();

      showToast('Message 1');
      showToast('Message 2');

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(2);
      expect(toasts[0].id).not.toBe(toasts[1].id);
    });

    it('should use default type "info"', () => {
      const { showToast } = useToastStore.getState();

      showToast('Default message');

      const toasts = useToastStore.getState().toasts;
      expect(toasts[0].type).toBe('info');
    });

    it('should use default duration 4000ms', () => {
      const { showToast } = useToastStore.getState();

      showToast('Timed message');

      const toasts = useToastStore.getState().toasts;
      expect(toasts[0].duration).toBe(4000);
    });

    it('should support different toast types', () => {
      const { showToast } = useToastStore.getState();

      showToast('Success!', 'success');
      showToast('Error!', 'error');
      showToast('Warning!', 'warning');
      showToast('Info!', 'info');

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(4);
      expect(toasts[0].type).toBe('success');
      expect(toasts[1].type).toBe('error');
      expect(toasts[2].type).toBe('warning');
      expect(toasts[3].type).toBe('info');
    });

    it('should auto-remove toast after duration', () => {
      const { showToast } = useToastStore.getState();

      showToast('Will disappear', 'info', 1000);

      expect(useToastStore.getState().toasts).toHaveLength(1);

      // Fast forward time
      vi.advanceTimersByTime(1000);

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it('should not auto-remove toast with duration 0', () => {
      const { showToast } = useToastStore.getState();

      showToast('Persistent', 'info', 0);

      expect(useToastStore.getState().toasts).toHaveLength(1);

      // Fast forward time significantly
      vi.advanceTimersByTime(10000);

      // Toast should still be there
      expect(useToastStore.getState().toasts).toHaveLength(1);
    });

    it('should allow custom duration', () => {
      const { showToast } = useToastStore.getState();

      showToast('Custom duration', 'info', 500);

      expect(useToastStore.getState().toasts).toHaveLength(1);

      vi.advanceTimersByTime(499);
      expect(useToastStore.getState().toasts).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });

  describe('removeToast', () => {
    it('should remove a specific toast by ID', () => {
      const { showToast, removeToast } = useToastStore.getState();

      showToast('Toast 1');
      showToast('Toast 2');
      showToast('Toast 3');

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(3);

      const middleToastId = toasts[1].id;
      removeToast(middleToastId);

      const remainingToasts = useToastStore.getState().toasts;
      expect(remainingToasts).toHaveLength(2);
      expect(remainingToasts.find(t => t.id === middleToastId)).toBeUndefined();
    });

    it('should do nothing if toast ID does not exist', () => {
      const { showToast, removeToast } = useToastStore.getState();

      showToast('Toast 1');

      const beforeToasts = useToastStore.getState().toasts;
      expect(beforeToasts).toHaveLength(1);

      removeToast('non-existent-id');

      const afterToasts = useToastStore.getState().toasts;
      expect(afterToasts).toHaveLength(1);
    });
  });

  describe('clearToasts', () => {
    it('should remove all toasts', () => {
      const { showToast, clearToasts } = useToastStore.getState();

      showToast('Toast 1');
      showToast('Toast 2');
      showToast('Toast 3');

      expect(useToastStore.getState().toasts).toHaveLength(3);

      clearToasts();

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it('should work on empty toast list', () => {
      const { clearToasts } = useToastStore.getState();

      expect(useToastStore.getState().toasts).toHaveLength(0);

      clearToasts();

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });

  describe('Multiple toasts', () => {
    it('should maintain multiple toasts simultaneously', () => {
      const { showToast } = useToastStore.getState();

      showToast('First', 'info', 5000);
      showToast('Second', 'success', 5000);
      showToast('Third', 'error', 5000);

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(3);
      expect(toasts.map(t => t.message)).toEqual(['First', 'Second', 'Third']);
    });

    it('should remove toasts independently based on duration', () => {
      const { showToast } = useToastStore.getState();

      showToast('Quick', 'info', 1000);
      showToast('Medium', 'info', 2000);
      showToast('Slow', 'info', 3000);

      expect(useToastStore.getState().toasts).toHaveLength(3);

      vi.advanceTimersByTime(1000);
      expect(useToastStore.getState().toasts).toHaveLength(2);

      vi.advanceTimersByTime(1000);
      expect(useToastStore.getState().toasts).toHaveLength(1);

      vi.advanceTimersByTime(1000);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });
});
