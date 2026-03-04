import { Component, type ReactNode } from "react";

type RouteErrorBoundaryProps = {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackMessage?: string;
};

type RouteErrorBoundaryState = {
  hasError: boolean;
  errorMessage: string;
};

export default class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = {
    hasError: false,
    errorMessage: ""
  };

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message
    };
  }

  componentDidCatch(error: Error, errorInfo: unknown) {
    console.error("RouteErrorBoundary captured a route error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const fallbackTitle = this.props.fallbackTitle ?? "Ops! Não foi possível abrir esta página.";
      const fallbackMessage =
        this.props.fallbackMessage ?? "Tente recarregar a página ou voltar para o dashboard.";

      return (
        <section className="mx-auto max-w-2xl rounded-2xl border border-amber-200 bg-amber-50 p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-amber-900">{fallbackTitle}</h1>
          <p className="mt-2 text-sm text-amber-800">{fallbackMessage}</p>

          <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white">Recarregar</button>

          {import.meta.env.DEV && this.state.errorMessage ? (
            <pre className="mt-4 overflow-auto rounded-lg border border-amber-300 bg-white p-3 text-xs text-red-700">
              {this.state.errorMessage}
            </pre>
          ) : null}
        </section>
      );
    }

    return this.props.children;
  }
}
