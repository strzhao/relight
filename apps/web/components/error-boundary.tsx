"use client";

import type { ReactNode } from "react";
import { Component } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="flex min-h-[200px] items-center justify-center p-8">
            <div className="text-center">
              <h2 className="text-lg font-semibold text-foreground">出错了</h2>
              <p className="mt-2 text-sm text-muted-foreground">{this.state.error.message}</p>
            </div>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
