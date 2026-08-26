/**
 * Sections whose contents arrive over IPC — plugin views, workshop drafts —
 * compute `isExpandedByDefault` from data that is empty on the first render.
 * Getting this wrong hides a freshly installed plugin behind a shut section,
 * which reads as "the plugin did not install".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsibleSection } from './CollapsibleSection';

const section = (expanded: boolean) => (
  <CollapsibleSection title="PLUGINS" onTitleClick={() => {}} isExpandedByDefault={expanded}>
    <div>Snowglobe</div>
  </CollapsibleSection>
);

describe('CollapsibleSection', () => {
  it('opens when its contents turn up after the first render', () => {
    const { rerender } = render(section(false));
    expect(screen.queryByText('Snowglobe')).toBeNull();

    // The IPC call resolves and the section now has something in it.
    rerender(section(true));
    expect(screen.getByText('Snowglobe')).toBeTruthy();
  });

  it('respects an explicit collapse even when the contents change', () => {
    const { rerender } = render(section(true));
    expect(screen.getByText('Snowglobe')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Collapse'));
    expect(screen.queryByText('Snowglobe')).toBeNull();

    // More views arrive; the section stays shut because a person shut it.
    rerender(section(true));
    expect(screen.queryByText('Snowglobe')).toBeNull();
  });

  it('respects an explicit expand of an empty section', () => {
    const { rerender } = render(section(false));
    fireEvent.click(screen.getByTitle('Expand'));
    expect(screen.getByText('Snowglobe')).toBeTruthy();

    rerender(section(false));
    expect(screen.getByText('Snowglobe')).toBeTruthy();
  });

  it('leaves the title click to navigation, not expansion', () => {
    const onTitleClick = vi.fn();
    render(
      <CollapsibleSection title="PLUGINS" onTitleClick={onTitleClick} isExpandedByDefault={false}>
        <div>Snowglobe</div>
      </CollapsibleSection>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'PLUGINS' }));
    expect(onTitleClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Snowglobe')).toBeNull();
  });
});
