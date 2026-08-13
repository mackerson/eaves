import React from 'react';
import { FileText, X } from 'lucide-react';

/**
 * A file staged in a composer, not yet sent. Shared by the chat and channel
 * composers so both surfaces stage attachments identically.
 */
export interface PendingAttachment {
  path: string;
  filename: string;
  // Only images carry an inline preview; text/document files show a chip.
  previewUrl?: string;
}

/**
 * Pick files via the shared image/document dialog and map them into
 * PendingAttachment shape. Returns [] when the user cancels.
 */
export async function pickPendingAttachments(): Promise<PendingAttachment[]> {
  try {
    const result = await window.electron.pickImages();
    if (result.canceled || !result.files) return [];
    return result.files.map((file) => ({
      path: file.path,
      filename: file.filename,
      previewUrl: file.previewDataUrl,
    }));
  } catch (error) {
    console.error('Error picking attachments:', error);
    return [];
  }
}

/**
 * The staged-attachments preview strip above a composer: image thumbnails,
 * file chips, and per-item remove buttons. Renders nothing when empty.
 */
export const PendingAttachmentsStrip: React.FC<{
  attachments: PendingAttachment[];
  onRemove: (index: number) => void;
}> = ({ attachments, onRemove }) => {
  if (attachments.length === 0) return null;
  return (
    <div className="flex gap-2 mb-2 flex-wrap" data-testid="pending-attachments">
      {attachments.map((attachment, index) => (
        <div key={index} className="relative group">
          {attachment.previewUrl ? (
            <img
              src={attachment.previewUrl}
              alt={attachment.filename}
              className="h-16 w-16 object-cover rounded border border-border"
            />
          ) : (
            <div
              className="h-16 w-40 px-2 flex items-center gap-2 rounded border border-border bg-background text-xs text-muted-foreground overflow-hidden"
              title={attachment.filename}
            >
              <FileText className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">{attachment.filename}</span>
            </div>
          )}
          <button
            onClick={() => onRemove(index)}
            className="absolute -top-1 -right-1 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
};
