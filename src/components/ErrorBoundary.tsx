import React from "react";
import { Button, ConfigProvider, Result } from "antd";
import { buildIllustrationTheme } from "../theme/illustrationTheme";
import type { ThemeMode } from "../types";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Unhandled render error", error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    // The app's ConfigProvider lives inside <App/>, which is what crashed, so
    // the fallback supplies its own. Theme is mirrored onto document.body.
    const themeMode: ThemeMode =
      document.body.dataset.theme === "dark" ? "dark" : "light";

    return (
      <ConfigProvider {...buildIllustrationTheme(themeMode)}>
        <div className="app-screen">
          <Result
            status="error"
            title="Something went wrong"
            subTitle="Friday hit an unexpected error. Reloading usually fixes it."
            extra={
              <Button type="primary" onClick={this.handleReload}>
                Reload Friday
              </Button>
            }
          />
        </div>
      </ConfigProvider>
    );
  }
}
