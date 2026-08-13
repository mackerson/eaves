import { useState, useCallback, useEffect } from 'react';
import { Folder, FolderOpen, FileText, Package, X } from 'lucide-react';
import { useProjectStore } from '@/stores';

export function FilesView() {
  const { currentProjectId } = useProjectStore();
  const [files, setFiles] = useState<any[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Load files when project changes
  useEffect(() => {
    if (currentProjectId) {
      loadFiles();
    } else {
      setFiles([]);
    }
  }, [currentProjectId]);

  const loadFiles = async () => {
    if (!currentProjectId) return;

    try {
      setIsLoading(true);
      const projectFiles = await window.electron.listFiles(currentProjectId);
      setFiles(projectFiles);
    } catch (error) {
      console.error('Failed to load files:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const addFilesToProject = async (filePaths: string[]) => {
    if (!currentProjectId || filePaths.length === 0) return;

    try {
      setIsLoading(true);
      await window.electron.addMultipleFiles(currentProjectId, filePaths);
      await loadFiles(); // Reload to show new files
    } catch (error) {
      console.error('Failed to add files:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    const filePaths = droppedFiles.map((f: any) => f.path).filter(Boolean);

    if (filePaths.length > 0) {
      addFilesToProject(filePaths);
    }
  }, [currentProjectId]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    const filePaths = selectedFiles.map((f: any) => f.path).filter(Boolean);

    if (filePaths.length > 0) {
      await addFilesToProject(filePaths);
    }
  };

  const handleFolderPick = async () => {
    try {
      const result = await window.electron.pickFolder();

      if (!result.canceled && result.paths.length > 0) {
        await addFilesToProject(result.paths);
      }
    } catch (error) {
      console.error('Failed to pick folder:', error);
    }
  };

  const handleRemoveFile = async (fileId: string) => {
    try {
      await window.electron.removeFile(fileId);
      await loadFiles();
    } catch (error) {
      console.error('Failed to remove file:', error);
    }
  };

  if (!currentProjectId) {
    return (
      <div className="p-8 text-center">
        <div className="mb-4 flex justify-center"><Folder size={64} /></div>
        <h2 className="text-2xl font-bold mb-2">No Project Selected</h2>
        <p className="text-text-secondary">Select or create a project to manage files</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Files & Folders</h1>
        <div className="flex gap-2">
          <label className="px-4 py-2 bg-bg-tertiary text-text-primary border border-border-primary rounded-md hover:bg-bg-hover transition-colors cursor-pointer">
            + Add Files
            <input
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>
          <button
            onClick={handleFolderPick}
            className="px-4 py-2 bg-accent-primary text-white rounded-md hover:bg-accent-secondary transition-colors"
          >
            + Add Folder
          </button>
        </div>
      </div>

      <div
        className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
          isDragging
            ? 'border-accent-primary bg-accent-primary/10'
            : 'border-border-secondary bg-bg-secondary'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isLoading ? (
          <div className="text-text-secondary">Loading files...</div>
        ) : files.length === 0 ? (
          <>
            <div className="mb-4 flex justify-center"><FolderOpen size={64} /></div>
            <h3 className="text-xl font-semibold mb-2">Drop files here</h3>
            <p className="text-text-secondary mb-4">
              or click "Add Files" to attach files, folders, or repositories to your project
            </p>
            <div className="flex gap-4 justify-center mt-6">
              <div className="text-text-tertiary text-sm">
                <div className="mb-1 flex justify-center"><FileText size={24} /></div>
                <div>Documents</div>
              </div>
              <div className="text-text-tertiary text-sm">
                <div className="mb-1 flex justify-center"><Folder size={24} /></div>
                <div>Folders</div>
              </div>
              <div className="text-text-tertiary text-sm">
                <div className="mb-1 flex justify-center"><Package size={24} /></div>
                <div>Repositories</div>
              </div>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-left">
            {files.map((file) => (
              <div
                key={file.id}
                className="p-4 bg-bg-primary border border-border-primary rounded-md hover:border-accent-primary transition-colors group"
              >
                <div className="flex items-start gap-3">
                  <span className="flex-shrink-0">
                    {file.type === 'repository' ? <Package size={30} /> : file.type === 'directory' ? <Folder size={30} /> : <FileText size={30} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="font-semibold truncate">{file.name}</h4>
                      <button
                        onClick={() => handleRemoveFile(file.id)}
                        className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-status-error transition-all text-sm"
                        title="Remove from project"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <p className="text-sm text-text-tertiary truncate" title={file.path}>
                      {file.path}
                    </p>
                    {file.size && (
                      <p className="text-xs text-text-tertiary mt-1">
                        {(file.size / 1024).toFixed(1)} KB
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
