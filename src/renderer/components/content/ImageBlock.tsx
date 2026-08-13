import React, { useState, useRef, useEffect } from 'react';
import { Upload, ImageOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useToastStore } from '@/stores/useToastStore';

interface ImageBlockProps {
  url: string;
  alt?: string;
  metadata?: {
    width?: number;
    height?: number;
    size_bytes?: number;
    fovea?: number;
  };
  className?: string;
  messageId?: string; // For uploading replacement images
}

/**
 * Renders images with lazy loading and modal view support
 */
export function ImageBlock({ url, alt, metadata, className = '', messageId }: ImageBlockProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [, setUploadedUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const showToast = useToastStore((state) => state.showToast);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Lazy loading with IntersectionObserver
  useEffect(() => {
    if (!imgRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const img = entry.target as HTMLImageElement;
            if (img.dataset.src) {
              img.src = img.dataset.src;
              observer.unobserve(img);
            }
          }
        });
      },
      { rootMargin: '50px' }
    );

    observer.observe(imgRef.current);

    // disconnect(), not unobserve(imgRef.current): by cleanup time the ref may
    // already be null, in which case the old guard skipped teardown entirely
    // and leaked the observer. disconnect needs no element.
    return () => observer.disconnect();
  }, []);

  const handleLoad = () => {
    setLoaded(true);
  };

  const handleError = () => {
    setError(true);
  };

  const handleClick = () => {
    setShowModal(true);
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !messageId) return;

    setUploading(true);
    try {
      // Extract asset_pointer from URL (format: file-service://asset/XXXXX)
      const assetPointer = url.split('/').pop();
      const filePath = window.electron.getPathForFile(file);

      if (!assetPointer || !filePath) {
        showToast('Could not resolve the selected file', 'error');
        return;
      }

      const result = await window.electron.replaceAttachmentFile({
        assetPointer,
        filePath,
        messageId, // Include messageId so we can create attachment if it doesn't exist
      });

      if (result.success && result.newUrl) {
        setUploadedUrl(result.newUrl);
        setError(false);
        // Trigger reload
        if (imgRef.current) {
          imgRef.current.src = result.newUrl;
        }
      } else {
        showToast(`Failed to upload image: ${result.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      console.error('Upload error:', err);
      showToast('Failed to upload image', 'error');
    } finally {
      setUploading(false);
    }
  };

  // Format file size
  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <>
      <div className={`image-block ${className}`}>
        <div className="relative inline-block">
          {/* Loading skeleton */}
          {!loaded && !error && (
            <div
              className="absolute inset-0 bg-bg-tertiary animate-pulse rounded"
              style={{
                width: metadata?.width || 300,
                height: metadata?.height || 200,
              }}
            />
          )}

          {/* Error state */}
          {error ? (
            <div className="flex items-center justify-center p-8 bg-bg-tertiary border border-border-secondary rounded text-text-tertiary">
              <div className="text-center">
                <ImageOff className="h-7 w-7 mx-auto mb-2" />
                <div className="text-sm mb-2">Image not found</div>
                {metadata?.size_bytes && (
                  <div className="text-xs mb-3">{formatFileSize(metadata.size_bytes)}</div>
                )}
                {messageId && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleUploadClick}
                      disabled={uploading}
                      className="mt-2"
                    >
                      <Upload className="h-4 w-4 mr-2" />
                      {uploading ? 'Uploading...' : 'Upload Image'}
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              <img
                ref={imgRef}
                data-src={url}
                alt={alt || 'Image'}
                onLoad={handleLoad}
                onError={handleError}
                onClick={handleClick}
                className={`max-w-full h-auto rounded border border-border-secondary cursor-pointer hover:opacity-90 transition-opacity ${
                  loaded ? 'opacity-100' : 'opacity-0'
                }`}
                style={{
                  maxHeight: '500px',
                  objectFit: 'contain',
                }}
              />

              {/* Image metadata */}
              {loaded && metadata && (
                <div className="text-xs text-text-tertiary mt-1 space-x-2">
                  {metadata.width && metadata.height && (
                    <span>{metadata.width} × {metadata.height}</span>
                  )}
                  {metadata.size_bytes && (
                    <span>· {formatFileSize(metadata.size_bytes)}</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/*
        The lightbox is the shared Radix dialog, like every other modal in the
        app. Hand-rolled, it had no Escape handler, no focus trap, no focus
        restore and no role="dialog" — and because the inner container never
        stopped propagation, clicking the image itself dismissed it.
      */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="max-w-[95vw] w-auto border-0 bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">{alt || 'Image'}</DialogTitle>
          <img
            src={url}
            alt={alt || 'Image'}
            className="max-w-full max-h-[90vh] object-contain rounded"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
