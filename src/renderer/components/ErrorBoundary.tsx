import { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo);

    this.setState({
      error,
      errorInfo,
    });

    // Call optional error handler
    this.props.onError?.(error, errorInfo);

    // Log to main process if available
    if (window.electron) {
      window.electron.logError?.({
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack ?? undefined,
        timestamp: Date.now(),
      });
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <div className="flex items-center justify-center h-screen bg-background">
          <div className="max-w-2xl p-8 space-y-6">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-destructive">Something went wrong</h1>
              <p className="text-muted-foreground">
                An error occurred while rendering this component. This has been logged for debugging.
              </p>
            </div>

            {this.state.error && (
              <div className="space-y-2">
                <h2 className="text-xl font-semibold">Error Details</h2>
                <div className="p-4 bg-muted rounded-md">
                  <p className="font-mono text-sm text-destructive">
                    {this.state.error.message}
                  </p>
                  {this.state.error.stack && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                        Stack trace
                      </summary>
                      <pre className="mt-2 p-2 bg-background rounded text-xs overflow-auto max-h-64">
                        {this.state.error.stack}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-4">
              <Button onClick={this.handleReset} variant="outline">
                Try Again
              </Button>
              <Button onClick={this.handleReload}>
                Reload Application
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              If this problem persists, check the logs in Settings → Developer → View Logs
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
