import { ToastProvider } from './components/Toasts';
import { Workspace } from './features/workspace/Workspace';
import { ThemeProvider } from './theme/ThemeProvider';

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <Workspace />
      </ToastProvider>
    </ThemeProvider>
  );
}
