import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, color: '#f87171', background: '#0b0e12', zIndex: 9999, position: 'fixed', inset: 0, fontFamily: 'system-ui, sans-serif' }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, color: '#e8eaed' }}>Something went wrong</h1>
          <p style={{ marginTop: 8, fontSize: 13 }}>{this.state.error?.message}</p>
          <pre style={{ marginTop: 12, fontSize: 11, color: '#9aa0a6', overflow: 'auto' }}>{this.state.error?.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
